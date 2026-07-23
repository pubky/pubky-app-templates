[![Pubky](https://img.shields.io/badge/Pubky-0.9.3-blue)](https://www.npmjs.com/package/@synonymdev/pubky/v/0.9.3)

# Basic Pubky App

A minimal Vite + TypeScript starter for standalone Pubky apps that use Homeservers directly as their data layer—without indexers, aggregators, or integration with pubky.app’s social data.

This template focuses on Pubky’s core building blocks. The included vanilla HTML, TypeScript, and CSS are deliberately kept simple and exist only to demonstrate those features; the template does not prescribe a UI framework, frontend architecture, or styling system.

## What's Included

- Pubky Ring sign-in with a QR code, magic link button and copy-to-clipboard action.
- A development-only authentication shortcut that removes sign-in friction on a local testnet. It is not intended as a pattern for production apps.
- Session persistence across page reloads, plus sign out.
- CRUD helpers for data under a configured path on the user’s Homeserver.
- A live event stream subscription scoped to the configured path.
- Preconfigured weekly Dependabot updates for all npm dependencies, with Pubky stack packages grouped together.

## What's Not Included

- Identity key and recovery phrase management. Pubky apps should delegate these responsibilities to a dedicated identity manager such as Pubky Ring, keeping identity keys outside the app.
- Homeserver admin tools.
- An aggregator or indexer. This template talks directly to the user’s Homeserver and does not provide cross-Homeserver aggregation or data indexing.

## Quick Start

```bash
npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app
cd my-pubky-app
npm install
npm run dev
```

Use **Sign in with [Pubky Ring](https://pubkyring.app/)** to authorize an app session. For local testnet development, use the [Pubky Identity Manager template](https://github.com/pubky/pubky-app-templates/tree/main/pubky-signer-app) as a stand-in. With `vite dev` and `VITE_PUBKY_TESTNET=true`, **New identity** provides a development auth shortcut.

For complete local Homeserver, testnet, and authentication setup, follow the [Pubky Developer Guide](https://pubky.org/explore/pubkycore/getting-started/).

The hosted GitHub Pages builds are available for
[mainnet](https://pubky.github.io/pubky-app-templates/mainnet/basic-pubky-app/) and a
[local testnet](https://pubky.github.io/pubky-app-templates/testnet/basic-pubky-app/). Both are
production builds and expose only Pubky Ring sign-in.

## App Settings

App-specific configuration lives in `src/config.ts`:

```ts
export const APP_CLIENT_ID = 'template'
export const APP_PATH = `/pub/${APP_CLIENT_ID}/`
export const APP_CAPABILITIES = `${APP_PATH}:rw`
```

Change `APP_CLIENT_ID` first when starting a real app; the path and capabilities are derived from it. The file also centralizes testnet and relay settings.

Set `VITE_PUBKY_STORAGE_NAMESPACE` when multiple builds share an origin and should keep their saved
sessions separate.
