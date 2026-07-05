import { Keypair, Pubky, PublicKey } from '@synonymdev/pubky'
import type { Session } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template.app' as const
export const APP_PATH = `/pub/${APP_CLIENT_ID}/` as const
export const TESTNET_HOMESERVER = 'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'

const SESSION_KEY = `${APP_CLIENT_ID}:session`

export const pubky = createPubky()

function createPubky() {
  if (import.meta.env.VITE_PUBKY_TESTNET === 'true') {
    return Pubky.testnet(import.meta.env.VITE_PUBKY_TESTNET_HOST || undefined)
  }

  return new Pubky()
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
  }
}
