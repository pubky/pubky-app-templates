import { AuthFlowKind, Keypair, PublicKey } from '@synonymdev/pubky'
import type { GrantAuthFlow, Session } from '@synonymdev/pubky'
import { pubky } from './client'
export { pubky } from './client'
import {
  APP_CAPABILITIES,
  APP_CLIENT_ID,
  HTTP_RELAY,
  STORAGE_NAMESPACE,
  SHOW_DEVELOPMENT_SIGNUP,
} from './config'

const SESSION_KEY = STORAGE_NAMESPACE
  ? `${STORAGE_NAMESPACE}:${APP_CLIENT_ID}:session`
  : `${APP_CLIENT_ID}:session`
const PENDING_AUTH_KEY = `${SESSION_KEY}:pending-auth`
const PENDING_REVOCATION_PREFIX = `${SESSION_KEY}:pending-revocation:`
const sessionIds = new WeakMap<Session, string>()
const RING_AUTH_CANCELED_ERROR_NAME = 'RingAuthCanceled'
const RING_AUTH_EXPIRED_ERROR_NAME = 'RingAuthExpired'
const CLOSED_SIGNUP_MESSAGE =
  'This homeserver does not allow open signup. Start it with \'signup_mode = "open"\' for creating new identities.'

export interface RingAuthFlow {
  authorizationUrl: string
  awaitApproval: Promise<Session>
  /** Explicitly abandon this link. Do not call on page reload. */
  cancel: () => void
  /** Stop this page's waiter while retaining the tab's resumable state. */
  suspend: () => void
}

export interface SavedSessionChange {
  type: 'invalidated' | 'selected'
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

export async function startRingAuthFlow(
  options: { fresh?: boolean } = {},
  isCurrent: () => boolean = () => true,
): Promise<RingAuthFlow> {
  const available = await pubky.browserSessionStore.isAvailable()
  if (!isCurrent()) throw ringAuthCanceledError()
  if (!available) {
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
      if (!isCurrent()) {
        flow.free()
        throw ringAuthCanceledError()
      }
      return awaitRingApproval(flow, pending)
    } catch (error) {
      if (!isCurrent()) throw ringAuthCanceledError()
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
    if (!isCurrent()) throw ringAuthCanceledError()
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

/** The saved record this session actually came from, independent of tab selection. */
export function getSessionId(session: Session) {
  return sessionIds.get(session)
}

export async function saveSession(
  session: Session,
  isCurrent: () => boolean = () => true,
  beforeSelect?: () => Promise<unknown>,
) {
  const stored = await pubky.browserSessionStore.save(session)
  try {
    sessionIds.set(session, stored.id)
    const cleanupKey = `${PENDING_REVOCATION_PREFIX}${stored.id}`
    await withSessionSelection(async () => {
      if (getSavedSessionId() !== stored.id) localStorage.setItem(cleanupKey, '1')
    })
    // A cached page must not hold the cross-tab selection lock while hidden.
    try {
      if (beforeSelect) await beforeSelect()
    } catch (error) {
      await withSessionSelection(() => discardSavedSession(session, stored.id))
      throw error
    }
    return await withSessionSelection(async () => {
      let selected = false
      try {
        if (isCurrent()) {
          // Cleanup in another tab may have revoked this grant while its save completed.
          const restored = await pubky.browserSessionStore.restore(stored.id)
          restored.free()
          if (isCurrent()) {
            localStorage.setItem(SESSION_KEY, stored.id)
            localStorage.removeItem(cleanupKey)
            selected = true
          }
        }
        return selected
      } finally {
        if (!selected) await discardSavedSession(session, stored.id)
      }
    })
  } finally {
    stored.free()
  }
}

async function discardSavedSession(session: Session, id: string) {
  // Another tab may have selected this exact grant while its save was pending.
  const key = `${PENDING_REVOCATION_PREFIX}${id}`
  if (getSavedSessionId() === id) {
    localStorage.removeItem(key)
    return
  }
  localStorage.setItem(key, '1')
  try {
    await session.signout()
  } catch (error) {
    if (!isInvalidSavedSessionError(error)) throw error
  }
  localStorage.removeItem(key)
}

/** Keep abandoned approvals durable until their remote grant has been revoked. */
export function discardSession(session: Session) {
  return saveSession(session, () => false)
}

export function hasPendingSessionCleanup() {
  return pendingRevocationIds().length > 0
}

export async function restoreSavedSession() {
  if (hasPendingSessionCleanup())
    await withSessionSelection(async () => {
      for (const id of pendingRevocationIds()) {
        if (id !== getSavedSessionId()) {
          try {
            // Restore retries a pending SDK logout, or returns a grant still needing revocation.
            const session = await pubky.browserSessionStore.restore(id)
            await session.signout()
          } catch (error) {
            if (!isInvalidSavedSessionError(error)) throw error
          }
        }
        localStorage.removeItem(`${PENDING_REVOCATION_PREFIX}${id}`)
      }
    })
  const savedId = getSavedSessionId()
  if (!savedId) return undefined
  try {
    // The SDK migrates older browser records and coordinates the bearer itself.
    const session = await pubky.browserSessionStore.restore(savedId)
    sessionIds.set(session, savedId)
    return session
  } catch (error) {
    if (isInvalidSavedSessionError(error)) {
      await forgetSavedSession(savedId)
      return undefined
    }
    throw error
  }
}

async function withSessionSelection<T>(task: () => Promise<T>) {
  // Firefox can report a rejected lock callback as uncaught even when request() is caught.
  const result = await navigator.locks.request(`${SESSION_KEY}:selection`, async () => {
    try {
      return { ok: true as const, value: await task() }
    } catch (error) {
      return { ok: false as const, error }
    }
  })
  if (!result.ok) throw result.error
  return result.value
}

function pendingRevocationIds() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(PENDING_REVOCATION_PREFIX)))
    .map((key) => key.slice(PENDING_REVOCATION_PREFIX.length))
}

export async function signOut(session: Session) {
  const savedId = sessionIds.get(session)
  // A failed remote logout must retain the SDK record: it contains the pending
  // revocation marker and blocks authenticated requests until retry succeeds.
  await session.signout()
  if (savedId) forgetSessionPointer(savedId)
}

export function subscribeSavedSessionChanges(callback: (change: SavedSessionChange) => void) {
  const onSdkChange = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail
    if (!isRecord(detail)) return
    const active = getSavedSessionId()
    if (detail.action === 'removed' && typeof detail.id === 'string' && detail.id === active) {
      forgetSessionPointer(detail.id)
      callback({ type: 'invalidated' })
    } else if (detail.action === 'cleared' && detail.id === null && active) {
      localStorage.removeItem(SESSION_KEY)
      callback({ type: 'invalidated' })
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return
    if (event.key === SESSION_KEY || event.key === null) callback({ type: 'selected' })
  }
  window.addEventListener('pubky-session-changed', onSdkChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener('pubky-session-changed', onSdkChange)
    window.removeEventListener('storage', onStorage)
  }
}

function forgetSessionPointer(id: string) {
  if (getSavedSessionId() === id) localStorage.removeItem(SESSION_KEY)
}

export function isRingAuthCanceled(error: unknown) {
  return isErrorNamed(error, RING_AUTH_CANCELED_ERROR_NAME)
}

export function isRingAuthExpired(error: unknown) {
  return isErrorNamed(error, RING_AUTH_EXPIRED_ERROR_NAME)
}

function awaitRingApproval(flow: GrantAuthFlow, pending: string): RingAuthFlow {
  let canceled = false
  let abandoned = false
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
    abandoned ||= abandon
    if (abandon) clearPendingAuth(pending)
    rejectCanceled(ringAuthCanceledError())
    release()
  }
  const authorizationUrl = flow.authorizationUrl
  const approval = (async () => {
    try {
      const session = await flow.awaitApproval()
      if (canceled) {
        if (abandoned) await discardSession(session)
        throw ringAuthCanceledError()
      }
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
  forgetSessionPointer(savedId)
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
  // The SDK reports relay expiry as AuthenticationError. Request errors such as
  // a proxy's 504 Gateway Timeout leave the pending authorization resumable.
  return (
    isErrorNamed(error, 'AuthenticationError') &&
    errorText(error).toLowerCase().includes('auth request has expired or was cancelled')
  )
}

function isInvalidSavedSessionError(error: unknown) {
  // SDK 0.15 also wraps browser coordination failures as AuthenticationError.
  // Keep those records for retry; revoked sessions are reported explicitly as
  // ClientStateError ("Browser session is no longer valid.").
  return (
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
