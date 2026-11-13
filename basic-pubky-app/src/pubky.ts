import { AuthFlowKind, Keypair, PublicKey, validateCapabilities } from '@synonymdev/pubky'
import type { Capabilities, GrantAuthFlow, Session } from '@synonymdev/pubky'
import { encryptionScopes, hasAccountAccess, hasCapability, hasEncryptionAccess } from './access'
import { pubky } from './client'
export { pubky } from './client'
import {
  APP_CAPABILITIES,
  APP_CLIENT_ID,
  APP_PATHS,
  HTTP_RELAY,
  STORAGE_NAMESPACE,
  SHOW_DEVELOPMENT_SIGNUP,
  type StorageSpace,
} from './config'

const SESSION_KEY = STORAGE_NAMESPACE
  ? `${STORAGE_NAMESPACE}:${APP_CLIENT_ID}:session`
  : `${APP_CLIENT_ID}:session`
const PENDING_AUTH_KEY = `${SESSION_KEY}:pending-auth`
const PENDING_REVOCATION_PREFIX = `${SESSION_KEY}:pending-revocation:`
const sessionIds = new WeakMap<Session, string>()
const localSignouts = new Map<symbol, string>()
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

export interface PermissionRequest {
  encryptionSpace?: StorageSpace
  account?: boolean
}

export interface RingAuthOptions extends PermissionRequest {
  fresh?: boolean
  session?: Session
}

interface PendingAuthContext extends PermissionRequest {
  purpose: 'signin' | 'permissions'
  capabilities: string
  sessionId?: string
  expectedSigner?: string
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
  options: RingAuthOptions = {},
  stillCurrent: () => boolean = () => true,
): Promise<RingAuthFlow> {
  const context = authContext(options)
  const isCurrent = () =>
    stillCurrent() && (!context.sessionId || getSavedSessionId() === context.sessionId)
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
      if (!matchesAuthContext(saved.context, context)) {
        // A first sign-in and an account-bound permission request must never
        // resume one another, even when the tab still has a saved link.
        clearPendingAuth(pending)
        return startRingAuthFlow(options, stillCurrent)
      }
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

  const flow = await pubky.startGrantAuthFlow(
    context.capabilities as Capabilities,
    AuthFlowKind.signin(),
    {
      clientId: APP_CLIENT_ID,
      relay: HTTP_RELAY,
      approvalFormat: 'signedApprovalV1',
      ...(context.expectedSigner ? { expectedSigner: context.expectedSigner } : {}),
    },
  )
  let saved: string
  try {
    if (!isCurrent()) throw ringAuthCanceledError()
    try {
      saved = JSON.stringify({ mode: 'delegated', state: flow.saveDelegated(), context })
    } catch (error) {
      if (!isErrorNamed(error, 'ClientStateError') || !errorText(error).includes('not delegated'))
        throw error
      saved = JSON.stringify({ mode: 'local', state: flow.saveLocal(), context })
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

function authContext(options: RingAuthOptions): PendingAuthContext {
  const { session, encryptionSpace, account } = options
  if (!session && (encryptionSpace || account))
    throw new Error('Sign in before requesting additional permissions.')
  if (!session) return { purpose: 'signin', capabilities: APP_CAPABILITIES }
  const sessionId = getSessionId(session)
  if (!sessionId || getSavedSessionId() !== sessionId) throw ringAuthCanceledError()
  const additions = [...APP_CAPABILITIES.split(','), ...session.info.capabilities]
  if (encryptionSpace) additions.push(`${APP_PATHS[encryptionSpace]}attachments/:e`)
  if (account) additions.push('/:r')
  const capabilities = validateCapabilities([...new Set(additions)].sort().join(','))
  return {
    purpose: 'permissions',
    capabilities,
    sessionId,
    expectedSigner: session.info.publicKey.z32(),
    ...(encryptionSpace ? { encryptionSpace } : {}),
    ...(account ? { account: true } : {}),
  }
}

function matchesAuthContext(saved: unknown, current: PendingAuthContext) {
  // Older template versions stored only initial sign-in flows.
  if (saved === undefined) return current.purpose === 'signin'
  if (!isRecord(saved)) return false
  return (
    saved.purpose === current.purpose &&
    saved.capabilities === current.capabilities &&
    saved.sessionId === current.sessionId &&
    saved.expectedSigner === current.expectedSigner &&
    saved.encryptionSpace === current.encryptionSpace &&
    saved.account === current.account
  )
}

/** Resume only a permission flow bound to this exact saved account and grant. */
export function getPendingPermissionAuth(session: Session): PermissionRequest | undefined {
  const pending = sessionStorage.getItem(PENDING_AUTH_KEY)
  if (!pending) return undefined
  if (getSessionId(session) !== getSavedSessionId()) return undefined
  try {
    const saved: unknown = JSON.parse(pending)
    if (!isRecord(saved) || !isRecord(saved.context) || saved.context.purpose !== 'permissions')
      return undefined
    const { encryptionSpace, account } = saved.context
    if (
      encryptionSpace !== undefined &&
      encryptionSpace !== 'public' &&
      encryptionSpace !== 'private'
    )
      return undefined
    if (account !== undefined && account !== true) return undefined
    const request: PermissionRequest = {
      ...(encryptionSpace ? { encryptionSpace } : {}),
      ...(account ? { account: true } : {}),
    }
    if (matchesAuthContext(saved.context, authContext({ session, ...request }))) return request
    clearPendingAuth(pending)
    return undefined
  } catch {
    return undefined
  }
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
  return persistAndSelectSession(session, isCurrent, beforeSelect)
}

async function persistAndSelectSession(
  session: Session,
  isCurrent: () => boolean,
  beforeSelect?: () => Promise<unknown>,
  replacedId?: string,
) {
  const stored = await pubky.browserSessionStore.save(session)
  try {
    if (replacedId === stored.id)
      throw new Error('Authorize a new grant to change permissions. Your current session was kept.')
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
            // Save the revocation intent before switching the selected record.
            // A lost tab must not leave the old grant silently authorized.
            if (replacedId && replacedId !== stored.id)
              localStorage.setItem(`${PENDING_REVOCATION_PREFIX}${replacedId}`, 'replaced')
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

/** Replace a grant only after the signer approved this account and all needed access. */
export async function replaceSession(
  previous: Session,
  candidate: Session,
  requirement: PermissionRequest = {},
  isCurrent: () => boolean = () => true,
  beforeSelect?: () => Promise<unknown>,
) {
  const previousId = getSessionId(previous)
  if (!previousId) {
    await discardSession(candidate)
    throw new Error('The previous session must be saved before changing permissions.')
  }
  try {
    validateReplacement(previous, candidate, requirement)
  } catch (error) {
    await discardSession(candidate)
    throw error
  }
  const selected = await persistAndSelectSession(
    candidate,
    () => getSavedSessionId() === previousId && isCurrent(),
    beforeSelect,
    previousId,
  )
  if (selected) {
    // A cleanup failure does not undo a successful authorization. The durable
    // marker survives reload, and the UI can offer an explicit cleanup retry.
    await retrySessionCleanup().catch(() => undefined)
  }
  return selected
}

function validateReplacement(previous: Session, candidate: Session, request: PermissionRequest) {
  if (candidate.info.publicKey.z32() !== previous.info.publicKey.z32())
    throw new Error('Pubky Ring approved a different account. Your current session was kept.')
  for (const capability of previous.info.capabilities) {
    const separator = capability.lastIndexOf(':')
    if (
      separator < 1 ||
      !hasCapability(candidate, capability.slice(0, separator), capability.slice(separator + 1))
    ) {
      throw new Error('The approval omitted existing permissions. Your current session was kept.')
    }
  }
  const scopes = encryptionScopes(candidate)
  const retainedKeys = encryptionScopes(previous).every((path) =>
    scopes.some((scope) => scope === path || (scope.endsWith('/') && path.startsWith(scope))),
  )
  if (!retainedKeys)
    throw new Error('The approval omitted existing encryption keys. Your current session was kept.')
  if (request.encryptionSpace && !hasEncryptionAccess(candidate, request.encryptionSpace))
    throw new Error('Encryption access was not approved. Your current session was kept.')
  if (
    request.encryptionSpace &&
    !hasCapability(candidate, APP_PATHS[request.encryptionSpace], 'rw')
  )
    throw new Error(
      'Storage access for the upload folder was not approved. Your current session was kept.',
    )
  if (request.account && !hasAccountAccess(candidate))
    throw new Error('Account read access was not approved. Your current session was kept.')
  if (!request.encryptionSpace && !request.account) {
    for (const path of Object.values(APP_PATHS)) {
      if (!hasCapability(candidate, path, 'rw'))
        throw new Error('Storage access was not fully approved. Your current session was kept.')
    }
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
  if (hasPendingSessionCleanup()) {
    try {
      await retrySessionCleanup()
    } catch (error) {
      // Replaced grants must not prevent use of an already selected new grant.
      // Abandoned approvals retain the existing explicit recovery behavior.
      if (
        !getSavedSessionId() ||
        pendingRevocationIds().some(
          (id) => localStorage.getItem(`${PENDING_REVOCATION_PREFIX}${id}`) !== 'replaced',
        )
      )
        throw error
    }
  }
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

export async function retrySessionCleanup() {
  await withSessionSelection(async () => {
    for (const id of pendingRevocationIds()) {
      if (id !== getSavedSessionId()) {
        let session: Session | undefined
        try {
          // Restore retries a pending SDK logout, or returns a grant still needing revocation.
          session = await pubky.browserSessionStore.restore(id)
          await session.signout()
        } catch (error) {
          if (!isInvalidSavedSessionError(error)) throw error
        } finally {
          session?.free?.()
        }
      }
      localStorage.removeItem(`${PENDING_REVOCATION_PREFIX}${id}`)
    }
  })
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
  const operation = Symbol('signout')
  if (savedId) localSignouts.set(operation, savedId)
  // A failed remote logout must retain the SDK record: it contains the pending
  // revocation marker and blocks authenticated requests until retry succeeds.
  try {
    await session.signout()
    if (savedId) forgetSessionPointer(savedId)
  } finally {
    localSignouts.delete(operation)
  }
}

export function subscribeSavedSessionChanges(callback: (change: SavedSessionChange) => void) {
  const onSdkChange = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail
    if (!isRecord(detail)) return
    const active = getSavedSessionId()
    if (detail.action === 'removed' && typeof detail.id === 'string' && detail.id === active) {
      // The SDK notifies this tab before signout resolves; its caller owns that transition.
      if ([...localSignouts.values()].includes(detail.id)) return
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
