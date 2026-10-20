import { describe, it, expect, beforeAll } from 'vitest'
import * as openpgp from 'openpgp'
import { checkSignature, mergeKeys, readSigningKey } from '../src/signature.js'

// The real-scanner checks run the same code on SonarSource's own key and signatures.
const data = new TextEncoder().encode('the scanner')

type Signer = { key: openpgp.PrivateKey; subkey: openpgp.Subkey }

// A key shaped like SonarSource's: a primary key and a subkey that signs.
async function signer(): Promise<Signer> {
  const { privateKey } = await openpgp.generateKey({
    userIDs: [{ name: 'Test' }],
    subkeys: [{ sign: true }],
    // Old enough for the signatures dated a day back below.
    date: new Date(Date.now() - 7 * 86_400_000),
    format: 'object'
  })
  return { key: privateKey, subkey: privateKey.subkeys[0] }
}

async function sign(
  { key, subkey }: Signer,
  content: Uint8Array,
  date = new Date()
): Promise<string> {
  return openpgp.sign({
    message: await openpgp.createMessage({ binary: content }),
    signingKeys: key,
    signingKeyIDs: subkey.getKeyID(),
    detached: true,
    date
  })
}

// The signer's key with its subkey revoked, as a key server would serve it.
async function revoked(
  { key, subkey }: Signer,
  flag: openpgp.enums.reasonForRevocation,
  date: Date
): Promise<openpgp.PublicKey> {
  const copy = await openpgp.readPrivateKey({ armoredKey: key.armor() })
  const index = copy.subkeys.findIndex(
    (each) => each.getFingerprint() === subkey.getFingerprint()
  )
  const secret = copy.keyPacket
  if (!(secret instanceof openpgp.SecretKeyPacket))
    throw new Error('Not a secret key')
  copy.subkeys[index] = await copy.subkeys[index].revoke(secret, { flag }, date)
  return copy.toPublic()
}

const keyID = ({ subkey }: Signer): string =>
  subkey.getKeyID().toHex().toUpperCase()

describe('readSigningKey', () => {
  let ours: openpgp.PublicKey
  let fingerprint: string

  beforeAll(async () => {
    ours = (await signer()).key.toPublic()
    fingerprint = ours.getFingerprint()
  })

  it('reads the key with the fingerprint asked for', async () => {
    const read = await readSigningKey(ours.armor(), fingerprint)
    expect(read.getFingerprint()).toBe(fingerprint)
  })

  it('keeps only the public part of a private key', async () => {
    const { key } = await signer()
    const read = await readSigningKey(key.armor(), key.getFingerprint())
    expect(read.isPrivate()).toBe(false)
  })

  it('refuses another key', async () => {
    const other = (await signer()).key.toPublic().armor()
    await expect(readSigningKey(other, fingerprint)).rejects.toThrow(
      `Expected the key ${fingerprint}`
    )
  })

  it('refuses the key next to another one', async () => {
    const other = (await signer()).key.toPublic()
    const both = openpgp.armor(
      openpgp.enums.armor.publicKey,
      new Uint8Array([...ours.write(), ...other.write()])
    )
    await expect(readSigningKey(both, fingerprint)).rejects.toThrow(
      `Expected the key ${fingerprint}`
    )
  })

  it('refuses an answer that holds no key', async () => {
    await expect(
      readSigningKey('<html>Not found</html>', fingerprint)
    ).rejects.toThrow()
  })
})

describe('checkSignature', () => {
  let ours: Signer

  beforeAll(async () => {
    ours = await signer()
  })

  it('accepts data signed by a subkey of the key', async () => {
    await expect(
      checkSignature(data, await sign(ours, data), ours.key.toPublic(), 'cli')
    ).resolves.toBeUndefined()
  })

  it('refuses data changed after signing', async () => {
    const changed = Uint8Array.from(data)
    changed[0] ^= 1
    await expect(
      checkSignature(
        changed,
        await sign(ours, data),
        ours.key.toPublic(),
        'cli'
      )
    ).rejects.toThrow(
      `cli doesn't match its signature by the subkey ${keyID(ours)}`
    )
  })

  it('refuses a signature by another key', async () => {
    const other = await signer()
    await expect(
      checkSignature(data, await sign(other, data), ours.key.toPublic(), 'cli')
    ).rejects.toThrow(
      `cli isn't signed with SonarSource's key, but with ${keyID(other)}`
    )
  })

  it('refuses a signature file holding more than one signature', async () => {
    const one = await openpgp.readSignature({
      armoredSignature: await sign(ours, data)
    })
    const two = await openpgp.readSignature({
      armoredSignature: await sign(ours, data)
    })
    const packets = new openpgp.PacketList<openpgp.SignaturePacket>()
    packets.push(...one.packets, ...two.packets)
    const both = new openpgp.Signature(packets)
    await expect(
      checkSignature(data, both.armor(), ours.key.toPublic(), 'cli')
    ).rejects.toThrow('holds 2 signatures, expected one')
  })

  it('refuses a subkey revoked as compromised, whatever date its signature claims', async () => {
    const before = new Date(Date.now() - 86_400_000)
    const signature = await sign(ours, data, before)
    const key = await revoked(
      ours,
      openpgp.enums.reasonForRevocation.keyCompromised,
      new Date()
    )
    await expect(checkSignature(data, signature, key, 'cli')).rejects.toThrow(
      `cli is signed with the subkey ${keyID(ours)}, which SonarSource revoked on ${new Date().toISOString().slice(0, 10)}: key compromised`
    )
  })

  it('accepts what a superseded subkey signed before its revocation', async () => {
    const before = new Date(Date.now() - 86_400_000)
    const signature = await sign(ours, data, before)
    const key = await revoked(
      ours,
      openpgp.enums.reasonForRevocation.keySuperseded,
      new Date()
    )
    await expect(
      checkSignature(data, signature, key, 'cli')
    ).resolves.toBeUndefined()
  })
})

describe('mergeKeys', () => {
  it('keeps a revocation only one copy holds', async () => {
    const ours = await signer()
    const signature = await sign(ours, data)
    const plain = ours.key.toPublic()
    const withRevocation = await revoked(
      ours,
      openpgp.enums.reasonForRevocation.keyCompromised,
      new Date()
    )
    await expect(
      checkSignature(data, signature, plain, 'cli')
    ).resolves.toBeUndefined()
    await expect(
      checkSignature(
        data,
        signature,
        await mergeKeys(plain, withRevocation),
        'cli'
      )
    ).rejects.toThrow('key compromised')
  })
})
