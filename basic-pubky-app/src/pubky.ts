import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky'
import type { AuthFlow, Session } from '@synonymdev/pubky'
import { APP_CAPABILITIES, APP_CLIENT_ID, HTTP_RELAY, IS_TESTNET, TESTNET_HOST } from './config'

const SESSION_KEY = `${APP_CLIENT_ID}:session`
const RING_AUTH_CANCELED_ERROR_NAME = 'RingAuthCanceled'
const RING_AUTH_EXPIRED_ERROR_NAME = 'RingAuthExpired'
const RING_AUTH_POLL_INTERVAL_MS = 1200
const RING_AUTH_MAX_POLL_ATTEMPTS = 250

export const pubky = IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()

export interface RingLoginFlow {
  authorizationUrl: string
  awaitApproval: Promise<Session>
  cancel: () => void
}

export async function createUser(homeserver: string) {
  const signer = pubky.signer(Keypair.random())
  const homeserverKey = PublicKey.from(homeserver.trim())

  return signer.signup(homeserverKey, null)
}

export function startRingLogin(): RingLoginFlow {
  const flow = pubky.startAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), HTTP_RELAY)
  const approval = awaitRingApproval(flow)

  return {
    authorizationUrl: flow.authorizationUrl,
    awaitApproval: approval.awaitApproval,
    cancel: approval.cancel,
  }
}

export function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, session.export())
}

export async function restoreSavedSession() {
  const savedSession = localStorage.getItem(SESSION_KEY)
  if (!savedSession) return undefined

  try {
    return await pubky.restoreSession(savedSession)
  } catch (error) {
    if (isInvalidSavedSessionError(error)) {
      localStorage.removeItem(SESSION_KEY)
      return undefined
    }

    throw error
  }
}

export async function signOut(session: Session) {
  await session.signout()
  localStorage.removeItem(SESSION_KEY)
}

export function isRingAuthCanceled(error: unknown) {
  return isErrorNamed(error, RING_AUTH_CANCELED_ERROR_NAME)
}

export function isRingAuthExpired(error: unknown) {
  return isErrorNamed(error, RING_AUTH_EXPIRED_ERROR_NAME)
}

function awaitRingApproval(flow: AuthFlow) {
  let canceled = false
  let freed = false

  const cancel = () => {
    canceled = true
    if (freed) return
    freed = true

    try {
      flow.free()
    } catch {
      // The WASM handle can already be consumed or freed by the time cleanup runs.
    }
  }

  const awaitApproval = (async () => {
    for (let attempt = 1; attempt <= RING_AUTH_MAX_POLL_ATTEMPTS; attempt++) {
      if (canceled) throw ringAuthCanceledError()

      try {
        const session = await flow.tryPollOnce()
        if (session) return session
      } catch (error) {
        if (canceled) throw ringAuthCanceledError()
        throw error
      }

      if (attempt < RING_AUTH_MAX_POLL_ATTEMPTS) {
        await sleep(RING_AUTH_POLL_INTERVAL_MS)
      }
    }

    throw ringAuthExpiredError()
  })()

  return {
    awaitApproval: awaitApproval.finally(cancel),
    cancel,
  }
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

function isInvalidSavedSessionError(error: unknown) {
  return isErrorNamed(error, 'AuthenticationError') || isErrorNamed(error, 'InvalidInput')
}

function isErrorNamed(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
