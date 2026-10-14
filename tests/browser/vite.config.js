import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const app = resolve(root, 'basic-pubky-app')

// This configuration is used only by Playwright. Production builds have no fixture alias.
export default {
  root: app,
  envDir: false,
  define: {
    'import.meta.env.VITE_PUBKY_TESTNET': JSON.stringify('true'),
    'import.meta.env.VITE_PUBKY_TESTNET_HOST': JSON.stringify('127.0.0.1'),
    'import.meta.env.VITE_PUBKY_STORAGE_NAMESPACE': 'undefined',
    'import.meta.env.VITE_PUBKY_HTTP_RELAY': JSON.stringify('http://127.0.0.1:4175/inbox/'),
    'import.meta.env.VITE_SHOW_DEVELOPMENT_SIGNUP': JSON.stringify('false'),
  },
  resolve: {
    alias: [
      { find: /^@synonymdev\/pubky$/, replacement: resolve(import.meta.dirname, 'sdk-fixture.js') },
      {
        find: 'pubky-test-real',
        replacement: resolve(root, 'basic-pubky-app/node_modules/@synonymdev/pubky/index.js'),
      },
    ],
  },
  build: {
    outDir: resolve(root, 'node_modules/.cache/pubky-browser-preview'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        app: resolve(app, 'index.html'),
        reader: resolve(app, 'public-reader.html'),
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
  },
}
