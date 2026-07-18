import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky'
import type { AuthFlow, Session } from '@synonymdev/pubky'
import { APP_CAPABILITIES, APP_CLIENT_ID, HTTP_RELAY, IS_TESTNET, TESTNET_HOST } from './config'

const SESSION_KEY = `${APP_CLIENT_ID}:session`
const RING_AUTH_CANCELED_ERROR_NAME = 'RingAuthCanceled'
const RING_AUTH_POLL_INTERVAL_MS = 1200
const RING_AUTH_MAX_POLL_ATTEMPTS = 250

export const pubky = createPubky()

export interface RingLoginFlow {
  authorizationUrl: string
  awaitApproval: Promise<Session>
  cancel: () => void
}

function createPubky() {
  if (IS_TESTNET) {
    return Pubky.testnet(TESTNET_HOST)
  }

  return new Pubky()
}

export async function createUser(homeserver: string) {
  const signer = pubky.signer(Keypair.random())
  const homeserverKey = PublicKey.from(homeserver.trim())

  return signer.signup(homeserverKey, null)
}

export function startRingLogin(): RingLoginFlow {
  const flow = pubky.startAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), authRelay())
  const approval = awaitRingApproval(flow)

  return {
    authorizationUrl: flow.authorizationUrl,
    awaitApproval: approval.awaitApproval,
    cancel: approval.cancel,
  }
}

export async function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, session.export())
}

export async function restoreSavedSession() {
  const savedSession = localStorage.getItem(SESSION_KEY)
  if (!savedSession) return undefined

  try {
    return await pubky.restoreSession(savedSession)
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return undefined
  }
}

export async function signOut(session: Session) {
  try {
    await session.signout()
  } finally {
    localStorage.removeItem(SESSION_KEY)
  }
}

export function isRingAuthCanceled(error: unknown) {
  return error instanceof Error && error.name === RING_AUTH_CANCELED_ERROR_NAME
}

function authRelay() {
  return HTTP_RELAY
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
    let attempts = 0

    for (;;) {
      if (canceled) throw ringAuthCanceledError()
      if (++attempts > RING_AUTH_MAX_POLL_ATTEMPTS) {
        throw new Error('Pubky Ring sign-in link expired. Generate a fresh link and try again.')
      }

      const session = await flow.tryPollOnce()
      if (session) return session

      await sleep(RING_AUTH_POLL_INTERVAL_MS)
    }
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
