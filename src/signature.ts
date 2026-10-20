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

// One key from both copies, so a revocation in either of them counts. Every signature of either copy
// is kept unchecked: OpenPGP.js checks each one when it uses it. Key.update won't do, as it keeps only
// the newest binding of a subkey: after SonarSource extends a subkey, what it signed before would fail.
export function mergeKeys(
  first: openpgp.PublicKey,
  second?: openpgp.PublicKey
): openpgp.PublicKey {
  if (!second) return first
  // Each part of the key, by its bytes: the primary key, a user or a subkey, with its signatures.
  const parts = new Map<string, Map<string, openpgp.AnyPacket>>()
  for (const key of [first, second]) {
    let part: Map<string, openpgp.AnyPacket> | undefined
    for (const packet of key.toPacketList()) {
      const bytes = Buffer.from(packet.write()).toString('base64')
      if (packet instanceof openpgp.SignaturePacket) part?.set(bytes, packet)
      else {
        part = parts.get(bytes) ?? new Map([[bytes, packet]])
        parts.set(bytes, part)
      }
    }
  }
  const packets = new openpgp.PacketList<openpgp.AnyPacket>()
  for (const part of parts.values()) packets.push(...part.values())
  return new openpgp.PublicKey(packets)
}

// Throws unless the data carries exactly one signature, made by a subkey the key still vouches for.
// OpenPGP.js refuses a subkey revoked as compromised whatever date its signature claims.
export async function checkSignature(
  data: Uint8Array,
  armoredSignature: string,
  key: openpgp.PublicKey,
  name: string
): Promise<void> {
  const signature = await openpgp
    .readSignature({ armoredSignature })
    .catch((error: unknown) => {
      throw new Error(
        `The signature of ${name} can't be read: ${message(error)}`,
        { cause: error }
      )
    })
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
  const issuer = signature.issuerKeyID
  const signer = issuer.toHex().toUpperCase()
  if (issuer.equals(key.getKeyID()))
    return `${name} is signed with SonarSource's primary key ${signer}, which only vouches for the subkeys that sign`
  // Not getSubkeys, which also matches a signature that names no signer.
  const subkey = key.subkeys.find((each) => each.getKeyID().equals(issuer))
  if (!subkey)
    return `${name} isn't signed with SonarSource's key, but with ${signer}`
  const revocation = await validRevocation(subkey, key, signature)
  if (revocation) {
    const flag = revocation.reasonForRevocationFlag
    const reason =
      (flag === null ? undefined : REASONS[flag]) ?? `reason ${String(flag)}`
    return `${name} is signed with the subkey ${signer}, which SonarSource revoked on ${revocation.created?.toISOString().slice(0, 10) ?? 'an unknown date'}: ${reason}`
  }
  return `${name} doesn't match its signature by the subkey ${signer}: ${message(error)}`
}

const SOFT_REASONS = new Set<openpgp.enums.reasonForRevocation | null>([
  openpgp.enums.reasonForRevocation.keySuperseded,
  openpgp.enums.reasonForRevocation.keyRetired,
  openpgp.enums.reasonForRevocation.userIDInvalid
])

// The revocation that refuses this signature, as OpenPGP.js decides. Only one the primary key really
// signed counts, as a key server could add any packet. A soft one counts only if it came before the
// signature. A hard one counts whatever its date and wins over a soft one.
async function validRevocation(
  subkey: openpgp.Subkey,
  key: openpgp.PublicKey,
  signature: openpgp.SignaturePacket
): Promise<openpgp.SignaturePacket | undefined> {
  const checked = await Promise.all(
    subkey.revocationSignatures.map(async (revocation) => {
      const soft = SOFT_REASONS.has(revocation.reasonForRevocationFlag)
      const date = soft ? signature.created : revocation.created
      try {
        await revocation.verify(
          key.keyPacket,
          openpgp.enums.signature.subkeyRevocation,
          { key: key.keyPacket, bind: subkey.keyPacket },
          date ?? undefined
        )
        return revocation
      } catch {
        // Not signed by the primary key, or soft and after the signature: it says nothing.
        return undefined
      }
    })
  )
  const valid = checked.filter((each) => each !== undefined)
  return (
    valid.find((each) => !SOFT_REASONS.has(each.reasonForRevocationFlag)) ??
    valid[0]
  )
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
