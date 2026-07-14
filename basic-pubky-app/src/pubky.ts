import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky'
import type { AuthFlow, Capabilities, Session } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template.app' as const
export const APP_PATH = `/pub/${APP_CLIENT_ID}/` as const
export const APP_CAPABILITIES = `${APP_PATH}:rw` as Capabilities
export const TESTNET_HOMESERVER = 'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
export const PRODUCTION_HOMESERVER = 'pubky8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty'
export const IS_TESTNET = import.meta.env.VITE_PUBKY_TESTNET === 'true'
export const SHOW_DEVELOPMENT_SIGNUP = import.meta.env.VITE_SHOW_DEVELOPMENT_SIGNUP !== 'false'
export const DEFAULT_HOMESERVER = IS_TESTNET ? TESTNET_HOMESERVER : PRODUCTION_HOMESERVER

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
    return Pubky.testnet(import.meta.env.VITE_PUBKY_TESTNET_HOST || undefined)
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
  const relay = import.meta.env.VITE_PUBKY_HTTP_RELAY
  return typeof relay === 'string' && relay.trim() ? relay.trim() : undefined
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
