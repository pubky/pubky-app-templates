import { verifyCustomGrantPop } from '@synonymdev/pubky'
import type { CustomPop, Session } from '@synonymdev/pubky'
import { APP_CLIENT_ID } from './config'

export const MAX_PROOF_MESSAGE_BYTES = 4 * 1024
const MAX_CREDENTIAL_BYTES = 32 * 1024
const PROOF_PURPOSE = 'template-proof-demo'
const MAX_PROOF_AGE_SECONDS = 60
const CLOCK_SKEW_SECONDS = 30

export interface ProofExpectation {
  identity: string
  audience: string
  challenge: string
}

function checkMessage(message: string) {
  if (
    message.length > MAX_PROOF_MESSAGE_BYTES ||
    new TextEncoder().encode(message).byteLength > MAX_PROOF_MESSAGE_BYTES
  ) {
    throw new Error('Use a message of at most 4 KiB.')
  }
}

/** Sign application data with the delegated client key; no network request is needed. */
export async function createAppProof(
  session: Session,
  message: string,
  audience: string,
  challenge: string,
): Promise<CustomPop> {
  checkMessage(message)
  const grant = session.grant
  if (!grant) throw new Error('Custom proofs require a grant session. Sign in with Pubky Ring.')
  try {
    return await grant.createCustomPop({ audience, purpose: PROOF_PURPOSE, challenge, message })
  } finally {
    grant.free()
  }
}

/**
 * Verify the SDK identity chain, then this example's application contract.
 * A service must keep its own durable, atomic challenge/replay state and permissions.
 */
export function verifyAppProof(
  credentials: CustomPop,
  expected: ProofExpectation,
  seenNonces: Map<string, number>,
) {
  if (
    typeof credentials?.grant !== 'string' ||
    typeof credentials?.pop !== 'string' ||
    credentials.grant.length + credentials.pop.length > MAX_CREDENTIAL_BYTES ||
    new TextEncoder().encode(credentials.grant + credentials.pop).byteLength > MAX_CREDENTIAL_BYTES
  ) {
    throw new Error('Invalid or oversized proof bundle.')
  }
  const verified = verifyCustomGrantPop(credentials, { clockSkewSeconds: CLOCK_SKEW_SECONDS })
  if (verified.identity !== expected.identity || verified.grantClaims.client_id !== APP_CLIENT_ID) {
    throw new Error('The proof belongs to a different identity or application.')
  }
  const data = verified.data
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data) ||
    Object.keys(data).length !== 4 ||
    data.audience !== expected.audience ||
    data.purpose !== PROOF_PURPOSE ||
    data.challenge !== expected.challenge ||
    typeof data.message !== 'string'
  ) {
    throw new Error('The proof does not match this message exchange.')
  }
  checkMessage(data.message)
  const now = Math.floor(Date.now() / 1000)
  if (verified.iat < now - MAX_PROOF_AGE_SECONDS || verified.iat > now + CLOCK_SKEW_SECONDS) {
    throw new Error('The proof is outside the allowed time window.')
  }
  // Qualify the nonce by identity and grant; retain it until that grant expires.
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(nonce)
  }
  const nonce = `${verified.identity}:${verified.grantClaims.jti}:${verified.nonce}`
  if (seenNonces.has(nonce)) throw new Error('This proof has already been used.')
  seenNonces.set(nonce, verified.grantClaims.exp)
  return { identity: verified.identity, message: data.message, signedAt: verified.iat }
}
