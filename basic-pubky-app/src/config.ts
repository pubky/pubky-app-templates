import type { Capabilities } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template' as const
export const APP_PATH = `/pub/${APP_CLIENT_ID}/` as const
export const APP_CAPABILITIES = `${APP_PATH}:rw` as Capabilities

export const IS_TESTNET = import.meta.env.VITE_PUBKY_TESTNET === 'true'
export const TESTNET_HOST = import.meta.env.VITE_PUBKY_TESTNET_HOST || undefined
export const HTTP_RELAY = import.meta.env.VITE_PUBKY_HTTP_RELAY?.trim() || undefined
export const SHOW_DEVELOPMENT_SIGNUP = import.meta.env.VITE_SHOW_DEVELOPMENT_SIGNUP !== 'false'

const TESTNET_HOMESERVER = 'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
const PRODUCTION_HOMESERVER = 'pubky8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty'

export const DEFAULT_HOMESERVER = IS_TESTNET ? TESTNET_HOMESERVER : PRODUCTION_HOMESERVER
