import { Keypair, PublicKey, Pubky, SigninDeepLink, SignupDeepLink } from '@synonymdev/pubky'
import type { Session } from '@synonymdev/pubky'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'

const TESTNET_HOMESERVER = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
const TESTNET_HOMESERVER_ADMIN_URL = `http://${import.meta.env.VITE_PUBKY_TESTNET_HOST || '127.0.0.1'}:6288`
const TESTNET_HOMESERVER_ADMIN_PASSWORD = 'admin'
const IS_TESTNET = import.meta.env.VITE_PUBKY_TESTNET !== 'false'
export const DEFAULT_HOMESERVER = IS_TESTNET ? TESTNET_HOMESERVER : ''
export const DEFAULT_HOMESERVER_ADMIN_URL = IS_TESTNET ? TESTNET_HOMESERVER_ADMIN_URL : ''
export const DEFAULT_HOMESERVER_ADMIN_PASSWORD = IS_TESTNET ? TESTNET_HOMESERVER_ADMIN_PASSWORD : ''

const STORAGE_NAMESPACE = import.meta.env.VITE_PUBKY_STORAGE_NAMESPACE?.trim()
const IDENTITIES_KEY = identityManagerStorageKey('pubky-key-manager:identities')

export function identityManagerStorageKey(key: string) {
  return STORAGE_NAMESPACE ? `${STORAGE_NAMESPACE}:${key}` : key
}

interface SavedSigner {
  createdAt: string
  homeserver?: string
  id?: string
  recoveryPhrase?: string
  secret: string
}

export interface SignerIdentity {
  createdAt: string
  homeserver?: string
  id: string
  keypair: Keypair
  publicKey: string
  recoveryPhrase?: string
}

export interface SignupSettings {
  adminPassword: string
  adminUrl: string
  homeserver: string
}

export interface SignupResult {
  identity: SignerIdentity
  inviteCodeUsed: boolean
  session: Session
}

export type AuthRequestKind = 'signin' | 'signup'

export interface AuthRequestPreview {
  capabilities: string[]
  homeserver?: string
  kind: AuthRequestKind
  relay: string
  signupToken?: string
  url: string
}

export const pubky = IS_TESTNET
  ? Pubky.testnet(import.meta.env.VITE_PUBKY_TESTNET_HOST || undefined)
  : new Pubky()

export function createIdentity() {
  const recoveryPhrase = generateMnemonic(englishWordlist, 128)
  return saveIdentity(keypairFromRecoveryPhrase(recoveryPhrase), undefined, recoveryPhrase)
}

export async function importIdentity(recoveryPhraseInput: string, homeserver?: string) {
  const recoveryPhrase = normalizeRecoveryPhrase(recoveryPhraseInput)
  const keypair = keypairFromRecoveryPhrase(recoveryPhrase)
  const resolvedHomeserver =
    normalizedOptional(homeserver) || (await pubky.getHomeserverOf(keypair.publicKey))?.toString()

  return saveIdentity(keypair, resolvedHomeserver, recoveryPhrase)
}

export function restoreSavedIdentities() {
  return restoreSavedSigners()
    .map((saved) => {
      try {
        const keypair = Keypair.fromSecret(decodeSecret(saved.secret))
        return toIdentity(keypair, saved)
      } catch {
        return undefined
      }
    })
    .filter((identity): identity is SignerIdentity => Boolean(identity))
}

export function saveIdentity(keypair: Keypair, homeserver?: string, recoveryPhrase?: string) {
  const id = keypair.publicKey.toString()
  const savedSigners = restoreSavedSigners()
  const previous = savedSigners.find((signer) => signer.id === id)
  const saved: SavedSigner = {
    createdAt: previous?.createdAt || new Date().toISOString(),
    homeserver: normalizedOptional(homeserver) || previous?.homeserver,
    id,
    recoveryPhrase: recoveryPhrase || previous?.recoveryPhrase,
    secret: encodeSecret(keypair.secret()),
  }

  persistSigners([saved, ...savedSigners.filter((signer) => signer.id !== id)])
  return toIdentity(keypair, saved)
}

export function deleteIdentity(id: string) {
  persistSigners(restoreSavedSigners().filter((signer) => signer.id !== id))
}

export async function publishHomeserver(keypair: Keypair, homeserver: string) {
  const signer = pubky.signer(keypair)
  await signer.pkdns.publishHomeserverForce(PublicKey.from(homeserver.trim()))
}

export async function signUpSavedIdentity(
  identity: SignerIdentity,
  settings: SignupSettings,
): Promise<SignupResult> {
  const signup = await signUpIdentity(identity.keypair, settings)

  return {
    identity: saveIdentity(identity.keypair, settings.homeserver),
    inviteCodeUsed: signup.inviteCodeUsed,
    session: signup.session,
  }
}

export async function approveAuthRequest(identity: SignerIdentity, input: string) {
  const request = parseAuthRequest(input)
  await pubky.signer(identity.keypair).approveAuthRequest(request.url)

  return request
}

export function parseAuthRequest(input: string): AuthRequestPreview {
  const link = extractAuthLink(input)
  const candidates = unique([link, normalizeLooseAuthLink(link)])
  const errors: string[] = []

  for (const candidate of candidates) {
    const signupFirst = candidate.toLowerCase().includes('signup')
    const parsers = signupFirst
      ? [tryParseSignup, tryParseSignin]
      : [tryParseSignin, tryParseSignup]

    for (const parse of parsers) {
      const result = parse(candidate)
      if (result.preview) return result.preview
      if (result.error) errors.push(result.error)
    }
  }

  throw new Error(errors[0] || 'Expected a Pubky auth deeplink.')
}

async function signUpIdentity(keypair: Keypair, settings: SignupSettings) {
  const signer = pubky.signer(keypair)
  const homeserver = PublicKey.from(settings.homeserver.trim())

  try {
    return {
      inviteCodeUsed: false,
      session: await signer.signup(homeserver, null),
    }
  } catch (withoutInviteError) {
    if (!isSignupTokenRequired(withoutInviteError)) throw withoutInviteError

    const signupToken = await generateSignupToken(settings).catch((tokenError: unknown) => {
      throw new Error(
        `Signup without an invite failed (${formatError(withoutInviteError)}), and generating an invite code failed (${formatError(tokenError)}).`,
        { cause: tokenError },
      )
    })

    try {
      return {
        inviteCodeUsed: true,
        session: await signer.signup(homeserver, signupToken),
      }
    } catch (withInviteError) {
      throw new Error(
        `Signup failed without an invite (${formatError(withoutInviteError)}) and with a generated invite (${formatError(withInviteError)}).`,
        { cause: withInviteError },
      )
    }
  }
}

async function generateSignupToken(settings: SignupSettings) {
  const url = new URL('/generate_signup_token', normalizeAdminUrl(settings.adminUrl))
  const response = await pubky.client.fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Admin-Password':
        normalizedOptional(settings.adminPassword) || DEFAULT_HOMESERVER_ADMIN_PASSWORD,
    },
  })

  if (!response.ok) {
    throw new Error(`Homeserver admin returned ${response.status} ${response.statusText}.`)
  }

  const token = (await response.text()).trim()
  if (!token) throw new Error('Homeserver admin returned an empty invite code.')

  return token
}

function normalizeAdminUrl(value: string) {
  const adminUrl = normalizedOptional(value) || DEFAULT_HOMESERVER_ADMIN_URL
  if (!adminUrl) {
    throw new Error('No homeserver admin endpoint is configured for signup-token generation.')
  }

  return adminUrl
}

function tryParseSignin(url: string) {
  try {
    const link = SigninDeepLink.parse(url)
    return {
      preview: {
        capabilities: splitCapabilities(link.capabilities),
        kind: 'signin' as const,
        relay: link.baseRelayUrl,
        url: link.toString(),
      },
    }
  } catch (error) {
    return { error: formatError(error) }
  }
}

function tryParseSignup(url: string) {
  try {
    const link = SignupDeepLink.parse(url)
    return {
      preview: {
        capabilities: splitCapabilities(link.capabilities),
        homeserver: link.homeserver.toString(),
        kind: 'signup' as const,
        relay: link.baseRelayUrl,
        signupToken: link.signupToken,
        url: link.toString(),
      },
    }
  } catch (error) {
    return { error: formatError(error) }
  }
}

function extractAuthLink(input: string) {
  const cleanInput = input.trim().replace(/&amp;/g, '&')
  const match = cleanInput.match(/(?:pubkyauth|pubkyring):\/\/[^\s<>"'`]+/i)
  const link = match ? match[0] : cleanInput
  const trimmed = link.replace(/[),.;]+$/, '')

  if (!trimmed) throw new Error('Paste or scan a Pubky auth link first.')
  return trimmed
}

function normalizeLooseAuthLink(link: string) {
  return link.replace(/^pubkyauth:\/\/\/?\?/i, 'pubkyauth://signin?')
}

function splitCapabilities(capabilities: string) {
  if (!capabilities) return []
  return capabilities.split(',').filter(Boolean)
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function toIdentity(keypair: Keypair, saved: SavedSigner): SignerIdentity {
  const publicKey = keypair.publicKey.toString()

  return {
    createdAt: saved.createdAt,
    homeserver: saved.homeserver,
    id: saved.id || publicKey,
    keypair,
    publicKey,
    recoveryPhrase: saved.recoveryPhrase,
  }
}

function restoreSavedSigners() {
  const saved = localStorage.getItem(IDENTITIES_KEY)
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as unknown
      if (!Array.isArray(parsed)) throw new Error('Invalid saved identities')

      return parsed.map(parseSavedSigner).filter((signer): signer is SavedSigner => Boolean(signer))
    } catch {
      localStorage.removeItem(IDENTITIES_KEY)
    }
  }

  return []
}

function persistSigners(signers: SavedSigner[]) {
  localStorage.setItem(IDENTITIES_KEY, JSON.stringify(signers))
}

function parseSavedSigner(value: unknown): SavedSigner | undefined {
  if (!isRecord(value) || typeof value.secret !== 'string') return undefined

  return {
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    homeserver: typeof value.homeserver === 'string' ? value.homeserver : undefined,
    id: typeof value.id === 'string' ? value.id : undefined,
    recoveryPhrase: typeof value.recoveryPhrase === 'string' ? value.recoveryPhrase : undefined,
    secret: value.secret,
  }
}

function keypairFromRecoveryPhrase(recoveryPhrase: string) {
  const seed = mnemonicToSeedSync(recoveryPhrase, '')
  return Keypair.fromSecret(seed.slice(0, 32))
}

function normalizeRecoveryPhrase(input: string) {
  const recoveryPhrase = input
    .trim()
    .toLowerCase()
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')

  if (recoveryPhrase.split(' ').length !== 12) {
    throw new Error('Recovery phrase must contain 12 words.')
  }

  if (!validateMnemonic(recoveryPhrase, englishWordlist)) {
    throw new Error('Recovery phrase is not a valid 12-word phrase.')
  }

  return recoveryPhrase
}

function encodeSecret(bytes: Uint8Array) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeSecret(input: string) {
  const compact = input.trim().replace(/\s+/g, '')
  const bytes = compact.startsWith('[') ? parseByteArray(compact) : parseEncodedSecret(compact)

  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte secret, got ${bytes.length} bytes.`)
  }

  return bytes
}

function parseEncodedSecret(value: string) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return parseHexSecret(value)
  }

  return parseBase64Secret(value)
}

function parseHexSecret(value: string) {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }

  return bytes
}

function parseBase64Secret(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)

  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function parseByteArray(value: string) {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error('Secret byte array must be a JSON array.')

  return Uint8Array.from(
    parsed.map((byte) => {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error('Secret byte array values must be integers from 0 to 255.')
      }

      return byte
    }),
  )
}

function normalizedOptional(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function isSignupTokenRequired(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'RequestError') return false

  const data = isRecord(error) ? error.data : undefined
  return (
    isRecord(data) &&
    data.statusCode === 400 &&
    error.message.toLowerCase().includes('token required')
  )
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
