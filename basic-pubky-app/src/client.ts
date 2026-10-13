import { Pubky } from '@synonymdev/pubky'
import { IS_TESTNET, TESTNET_HOST } from './config'

export const pubky = IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()
