import * as openpgp from 'openpgp'

// SonarSource's primary key. It only certifies the subkeys that sign the scanner's releases, which
// change every year.
export const SONARSOURCE_KEY = '679f1ee92b19609de816fde81db198f93525ec1a'

// Both serve the key with every subkey and revocation. A key server can withhold a revocation, but it
// can't forge one, nor add a subkey: each needs the primary key's signature.
export function keyServers(fingerprint: string): string[] {
  const upper = fingerprint.toUpperCase()
  return [
    `https://keys.openpgp.org/vks/v1/by-fingerprint/${upper}`,
    `https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x${upper}`
  ]
}

// The key a server answered with, only if it is the one asked for.
export async function readSigningKey(
  armored: string,
  fingerprint: string
): Promise<openpgp.PublicKey> {
  const keys = await openpgp.readKeys({ armoredKeys: armored })
  const [key] = keys
  if (keys.length !== 1 || key?.getFingerprint() !== fingerprint) {
    const found = keys.map((each) => each.getFingerprint()).join(', ')
    throw new Error(`Expected the key ${fingerprint}, got ${found || 'none'}`)
  }
  return key.toPublic()
}

// One key from both copies, so a revocation in either of them counts.
export async function mergeKeys(
  first: openpgp.PublicKey,
  second?: openpgp.PublicKey
): Promise<openpgp.PublicKey> {
  return second ? first.update(second) : first
}

// Throws unless the data carries exactly one signature, made by a subkey the key still vouches for.
// OpenPGP.js refuses a subkey revoked as compromised whatever date its signature claims.
export async function checkSignature(
  data: Uint8Array,
  armoredSignature: string,
  key: openpgp.PublicKey,
  name: string
): Promise<void> {
  const signature = await openpgp.readSignature({ armoredSignature })
  const [packet] = signature.packets
  if (!packet || signature.packets.length !== 1)
    throw new Error(
      `The signature of ${name} holds ${String(signature.packets.length)} signatures, expected one`
    )
  try {
    const { signatures } = await openpgp.verify({
      message: await openpgp.createMessage({ binary: data }),
      signature,
      verificationKeys: key,
      expectSigned: true,
      format: 'binary'
    })
    // expectSigned already throws on a bad signature; this throws too, should a release stop doing so.
    await Promise.all(signatures.map((each) => each.verified))
  } catch (error) {
    throw new Error(await explain(packet, key, name, error), { cause: error })
  }
}

const REASONS: Partial<Record<openpgp.enums.reasonForRevocation, string>> = {
  [openpgp.enums.reasonForRevocation.noReason]: 'no reason given',
  [openpgp.enums.reasonForRevocation.keySuperseded]: 'key superseded',
  [openpgp.enums.reasonForRevocation.keyCompromised]: 'key compromised',
  [openpgp.enums.reasonForRevocation.keyRetired]: 'key retired'
}

// Why a check failed, from the key itself rather than OpenPGP.js's wording, which may change.
async function explain(
  signature: openpgp.SignaturePacket,
  key: openpgp.PublicKey,
  name: string,
  error: unknown
): Promise<string> {
  const signer = signature.issuerKeyID.toHex().toUpperCase()
  const [subkey] = key.getSubkeys(signature.issuerKeyID)
  if (!subkey)
    return `${name} isn't signed with SonarSource's key, but with ${signer}`
  const revocation = await validRevocation(subkey, key)
  if (revocation) {
    const flag = revocation.reasonForRevocationFlag
    const reason =
      (flag === null ? undefined : REASONS[flag]) ?? `reason ${String(flag)}`
    return `${name} is signed with the subkey ${signer}, which SonarSource revoked on ${revocation.created?.toISOString().slice(0, 10) ?? 'an unknown date'}: ${reason}`
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `${name} doesn't match its signature by the subkey ${signer}: ${detail}`
}

// A revocation the primary key really signed: a key server could add any packet to its copy.
async function validRevocation(
  subkey: openpgp.Subkey,
  key: openpgp.PublicKey
): Promise<openpgp.SignaturePacket | undefined> {
  for (const revocation of subkey.revocationSignatures) {
    try {
      await revocation.verify(
        key.keyPacket,
        openpgp.enums.signature.subkeyRevocation,
        { key: key.keyPacket, bind: subkey.keyPacket }
      )
      return revocation
    } catch {
      // Not signed by the primary key: it says nothing.
    }
  }
  return undefined
}
