import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky'
import type { GrantAuthFlow, Session } from '@synonymdev/pubky'
import {
  APP_CAPABILITIES,
  APP_CLIENT_ID,
  HTTP_RELAY,
  IS_TESTNET,
  STORAGE_NAMESPACE,
  SHOW_DEVELOPMENT_SIGNUP,
  TESTNET_HOST,
} from './config'

const SESSION_KEY = STORAGE_NAMESPACE
  ? `${STORAGE_NAMESPACE}:${APP_CLIENT_ID}:session`
  : `${APP_CLIENT_ID}:session`
const ACCOUNTS_KEY = `${SESSION_KEY}:accounts`
const PENDING_AUTH_KEY = `${SESSION_KEY}:pending-auth`
const sessionIds = new WeakMap<Session, string>()
const RING_AUTH_CANCELED_ERROR_NAME = 'RingAuthCanceled'
const RING_AUTH_EXPIRED_ERROR_NAME = 'RingAuthExpired'
const CLOSED_SIGNUP_MESSAGE =
  'This homeserver does not allow open signup. Start it with \'signup_mode = "open"\' for creating new identities.'

export const pubky = IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()

export interface RingAuthFlow {
  authorizationUrl: string
  awaitApproval: Promise<Session>
  /** Explicitly abandon this link. Do not call on page reload. */
  cancel: () => void
  /** Stop this page's waiter while retaining the tab's resumable state. */
  suspend: () => void
}

export interface SavedAccount {
  id: string
  publicKey: string
  homeserver: string
  storageMode: string
  grantExpiresAt: number
}

export interface SavedSessionChange {
  type: 'invalidated' | 'selected' | 'accounts'
}

export async function signupDevelopmentUser(homeserver: string) {
  if (!SHOW_DEVELOPMENT_SIGNUP) {
    throw new Error('Development identity creation is available only in development on testnet.')
  }
  const signer = pubky.signer(Keypair.random())
  const homeserverKey = PublicKey.from(homeserver.trim())

  try {
    await signer.signup(homeserverKey, null)
  } catch (error) {
    throw closedSignupError(error)
  }

  return signer.signin(APP_CLIENT_ID)
}

export async function startRingAuthFlow(options: { fresh?: boolean } = {}): Promise<RingAuthFlow> {
  if (!(await pubky.browserSessionStore.isAvailable())) {
    throw new Error('Sign-in requires a secure browser context with IndexedDB and Web Locks.')
  }
  if (options.fresh) sessionStorage.removeItem(PENDING_AUTH_KEY)
  const pending = sessionStorage.getItem(PENDING_AUTH_KEY)
  if (pending) {
    try {
      const saved: unknown = JSON.parse(pending)
      if (!isRecord(saved) || typeof saved.state !== 'string')
        throw new Error('Invalid saved sign-in link')
      const flow =
        saved.mode === 'delegated'
          ? await pubky.resumeDelegatedGrantAuthFlow(saved.state)
          : saved.mode === 'local'
            ? pubky.resumeGrantAuthFlow(saved.state)
            : undefined
      if (!flow) throw new Error('Invalid saved sign-in mode')
      return awaitRingApproval(flow, pending)
    } catch (error) {
      // Preserve transient storage/network failures for retry; malformed or expired
      // links can be replaced. Refresh explicitly abandons any unusable saved link.
      if (
        error instanceof SyntaxError ||
        isInvalidSavedSessionError(error) ||
        isExpiredAuthError(error)
      ) {
        clearPendingAuth(pending)
      } else {
        throw error
      }
    }
  }

  const flow = await pubky.startGrantAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), {
    clientId: APP_CLIENT_ID,
    relay: HTTP_RELAY,
  })
  let saved: string
  try {
    try {
      saved = JSON.stringify({ mode: 'delegated', state: flow.saveDelegated() })
    } catch (error) {
      if (!isErrorNamed(error, 'ClientStateError') || !errorText(error).includes('not delegated'))
        throw error
      saved = JSON.stringify({ mode: 'local', state: flow.saveLocal() })
    }
    // Contains a relay secret (and a PoP secret for the local fallback). Keep it
    // tab-scoped and never log it or copy it into permanent application storage.
    sessionStorage.setItem(PENDING_AUTH_KEY, saved)
  } catch (error) {
    flow.free()
    throw error
  }
  return awaitRingApproval(flow, saved)
}

export function getSavedSessionId() {
  return localStorage.getItem(SESSION_KEY)
}

export async function saveSession(session: Session, isCurrent: () => boolean = () => true) {
  const stored = await pubky.browserSessionStore.save(session)
  try {
    rememberAccount(stored.id)
    if (isCurrent()) localStorage.setItem(SESSION_KEY, stored.id)
    sessionIds.set(session, stored.id)
  } finally {
    stored.free()
  }
}

export async function listSavedAccounts(): Promise<SavedAccount[]> {
  const ids = savedAccountIds()
  const records = await pubky.browserSessionStore.list()
  try {
    // The SDK's store spans the whole origin. Only show records this namespace
    // saved, so mainnet/testnet demos hosted on one origin cannot mix accounts.
    return records
      .filter((record) => ids.includes(record.id) && record.clientId === APP_CLIENT_ID)
      .map(({ id, publicKey, homeserver, storageMode, grantExpiresAt }) => ({
        id,
        publicKey,
        homeserver,
        storageMode,
        grantExpiresAt,
      }))
  } finally {
    records.forEach((record) => record.free())
  }
}

export async function restoreSavedSession() {
  const savedId = getSavedSessionId()
  return savedId ? restoreAccount(savedId) : undefined
}

export async function selectSavedAccount(id: string, isCurrent: () => boolean = () => true) {
  if (!(await listSavedAccounts()).some((account) => account.id === id)) {
    throw new Error('This account was not saved by this app in this network namespace.')
  }
  const session = await restoreAccount(id)
  if (session && isCurrent()) localStorage.setItem(SESSION_KEY, id)
  return session
}

/** Leave the saved account available while adding a different account. */
export function deselectSavedAccount() {
  localStorage.removeItem(SESSION_KEY)
}

async function restoreAccount(savedId: string) {
  try {
    // The SDK migrates older browser records and coordinates the bearer itself.
    const session = await pubky.browserSessionStore.restore(savedId)
    sessionIds.set(session, savedId)
    rememberAccount(savedId)
    return session
  } catch (error) {
    if (isInvalidSavedSessionError(error)) {
      await forgetSavedSession(savedId)
      return undefined
    }
    throw error
  }
}

export async function signOut(session: Session) {
  const savedId = sessionIds.get(session)
  // A failed remote logout must retain the SDK record: it contains the pending
  // revocation marker and blocks authenticated requests until retry succeeds.
  await session.signout()
  if (savedId) forgetAccountPointer(savedId)
}

export function subscribeSavedSessionChanges(callback: (change: SavedSessionChange) => void) {
  const onSdkChange = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail
    if (!isRecord(detail)) return
    const active = getSavedSessionId()
    if (detail.action === 'removed' && typeof detail.id === 'string') {
      if (!savedAccountIds().includes(detail.id)) return
      forgetAccountPointer(detail.id)
      callback({ type: detail.id === active ? 'invalidated' : 'accounts' })
    } else if (detail.action === 'cleared' && detail.id === null) {
      localStorage.removeItem(SESSION_KEY)
      localStorage.removeItem(ACCOUNTS_KEY)
      callback({ type: active ? 'invalidated' : 'accounts' })
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return
    if (event.key === SESSION_KEY || event.key === null) callback({ type: 'selected' })
    else if (event.key === ACCOUNTS_KEY) callback({ type: 'accounts' })
  }
  window.addEventListener('pubky-session-changed', onSdkChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener('pubky-session-changed', onSdkChange)
    window.removeEventListener('storage', onStorage)
  }
}

function savedAccountIds(): string[] {
  let ids: unknown = []
  try {
    ids = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]')
  } catch {
    /* Ignore a malformed index. */
  }
  const active = getSavedSessionId()
  return [
    ...new Set([
      ...(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []),
      ...(active ? [active] : []),
    ]),
  ]
}

function rememberAccount(id: string) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([...new Set([...savedAccountIds(), id])]))
}

function forgetAccountPointer(id: string) {
  const remaining = savedAccountIds().filter((candidate) => candidate !== id)
  if (getSavedSessionId() === id) localStorage.removeItem(SESSION_KEY)
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(remaining))
}

export function isRingAuthCanceled(error: unknown) {
  return isErrorNamed(error, RING_AUTH_CANCELED_ERROR_NAME)
}

export function isRingAuthExpired(error: unknown) {
  return isErrorNamed(error, RING_AUTH_EXPIRED_ERROR_NAME)
}

function awaitRingApproval(flow: GrantAuthFlow, pending: string): RingAuthFlow {
  let canceled = false
  let freed = false
  let rejectCanceled: (error: Error) => void = () => {}
  const cancellation = new Promise<never>((_, reject) => {
    rejectCanceled = reject
  })
  const release = () => {
    if (freed) return
    freed = true
    try {
      flow.free()
    } catch {
      /* The SDK may have consumed the handle. */
    }
  }
  const stop = (abandon: boolean) => {
    canceled = true
    if (abandon) clearPendingAuth(pending)
    rejectCanceled(ringAuthCanceledError())
    release()
  }
  const authorizationUrl = flow.authorizationUrl
  const approval = (async () => {
    try {
      const session = await flow.awaitApproval()
      if (canceled) throw ringAuthCanceledError()
      clearPendingAuth(pending)
      return session
    } catch (error) {
      if (canceled) throw ringAuthCanceledError()
      if (isExpiredAuthError(error)) {
        clearPendingAuth(pending)
        throw ringAuthExpiredError()
      }
      throw error
    }
  })()
  const awaitApproval = Promise.race([approval, cancellation]).finally(release)
  // A caller may cancel a stale flow before attaching its approval callback.
  void awaitApproval.catch(() => {})
  return { authorizationUrl, awaitApproval, cancel: () => stop(true), suspend: () => stop(false) }
}

function clearPendingAuth(pending: string) {
  if (sessionStorage.getItem(PENDING_AUTH_KEY) === pending)
    sessionStorage.removeItem(PENDING_AUTH_KEY)
}

async function forgetSavedSession(savedId: string) {
  forgetAccountPointer(savedId)
  try {
    await pubky.browserSessionStore.remove(savedId)
  } catch {
    // A missing SDK record needs no further local cleanup.
  }
}

function closedSignupError(error: unknown) {
  if (!isClosedSignupError(error)) {
    return error instanceof Error ? error : new Error(String(error))
  }

  const wrapped = new Error(CLOSED_SIGNUP_MESSAGE)
  wrapped.cause = error
  return wrapped
}

function isClosedSignupError(error: unknown) {
  const statusCode = errorStatusCode(error)
  const text = errorText(error).toLowerCase()

  if (statusCode === 400) return true
  if ((statusCode === 401 || statusCode === 403) && /signup|token|invite/.test(text)) {
    return true
  }

  return (
    isErrorNamed(error, 'AuthenticationError') ||
    text.includes('signup token required') ||
    text.includes('signup_mode') ||
    text.includes('token required')
  )
}

function isExpiredAuthError(error: unknown) {
  const text = errorText(error).toLowerCase()
  return text.includes('expired') || text.includes('timed out') || text.includes('timeout')
}

function isInvalidSavedSessionError(error: unknown) {
  return (
    isErrorNamed(error, 'AuthenticationError') ||
    isErrorNamed(error, 'InvalidInput') ||
    (isErrorNamed(error, 'ClientStateError') &&
      /Stored Pubky session not found:|Invalid stored session record:|Browser session was signed out\.|Browser session is no longer valid\.|Stored session identity does not match its grant\.|Delegated grant key public key does not match saved (session|flow)\./.test(
        errorText(error),
      ))
  )
}

function isErrorNamed(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function errorStatusCode(error: unknown) {
  if (!isRecord(error) || !isRecord(error.data)) return undefined
  const statusCode = error.data.statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : ` ${errorText(error.cause)}`
    return `${error.name} ${error.message}${cause}`
  }

  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function ringAuthCanceledError() {
  const error = new Error('Pubky Ring sign-in canceled')
  error.name = RING_AUTH_CANCELED_ERROR_NAME
  return error
}

function ringAuthExpiredError() {
  const error = new Error('Pubky Ring sign-in link expired. Generate a fresh link and try again.')
  error.name = RING_AUTH_EXPIRED_ERROR_NAME
  return error
}
