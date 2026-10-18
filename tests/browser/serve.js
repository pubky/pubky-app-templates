import { build, preview } from '../../basic-pubky-app/node_modules/vite/dist/node/index.js'
import { fileURLToPath, URL } from 'node:url'

// A static fixture build exercises production navigation without Vite's HMR connection.
const configFile = fileURLToPath(new URL('./vite.config.js', import.meta.url))
await build({ configFile })
const server = await preview({ configFile })
server.printUrls()
