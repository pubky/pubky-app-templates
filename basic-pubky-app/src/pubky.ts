import { AuthFlowKind, Keypair, Pubky, PublicKey, validateCapabilities } from '@synonymdev/pubky'
import type { AuthFlow, Capabilities, Session } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template.app' as const
export const APP_PATH = `/pub/${APP_CLIENT_ID}/` as const
export const APP_CAPABILITIES = `${APP_PATH}:rw` as Capabilities
export const TESTNET_HOMESERVER =
  'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'

const SESSION_KEY = `${APP_CLIENT_ID}:session`
const AUTH_FLOW_KEY = `${APP_CLIENT_ID}:auth-flow`

export const pubky = createPubky()

function createPubky() {
  if (import.meta.env.VITE_PUBKY_TESTNET === 'true') {
    return Pubky.testnet(import.meta.env.VITE_PUBKY_TESTNET_HOST || undefined)
  }

  return new Pubky()
}

function authRelay() {
  return import.meta.env.VITE_PUBKY_RELAY_URL || null
}

export function startSigninFlow() {
  const capabilities = validateCapabilities(APP_CAPABILITIES) as Capabilities
  const flow = pubky.startAuthFlow(capabilities, AuthFlowKind.signin(), authRelay())

  savePendingSigninFlow(flow)
  return flow
}

export function resumePendingSigninFlow() {
  const savedFlow = sessionStorage.getItem(AUTH_FLOW_KEY)
  if (!savedFlow) return undefined

  try {
    return pubky.resumeAuthFlow(savedFlow)
  } catch {
    clearPendingSigninFlow()
    return undefined
  }
}

function savePendingSigninFlow(flow: AuthFlow) {
  sessionStorage.setItem(AUTH_FLOW_KEY, flow.authorizationUrl)
}

export function clearPendingSigninFlow() {
  sessionStorage.removeItem(AUTH_FLOW_KEY)
}

export async function createUser(homeserver: string) {
  const signer = pubky.signer(Keypair.random())
  const homeserverKey = PublicKey.from(homeserver.trim())

  return signer.signup(homeserverKey, null)
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
    clearPendingSigninFlow()
  }
}
