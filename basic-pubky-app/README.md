[![Pubky](https://img.shields.io/badge/Pubky-0.14.0-blue)](https://www.npmjs.com/package/@synonymdev/pubky/v/0.14.0)

# Basic Pubky App

A minimal Vite + TypeScript starter for standalone Pubky apps that use Homeservers directly as their data layer—without indexers, aggregators, or integration with pubky.app’s social data.

This template focuses on Pubky’s core building blocks. The included vanilla HTML, TypeScript, and CSS are deliberately kept simple and exist only to demonstrate those features; the template does not prescribe a UI framework, frontend architecture, or styling system.

## What's Included

- Grant-based Pubky Ring sign-in with a QR code, authorization link, and copy-to-clipboard action.
- A development-only authentication shortcut that removes sign-in friction on a local testnet. It requires `signup_mode = "open"` and is not intended as a pattern for production apps.
- Session persistence across page reloads via the SDK browser session store, plus sign out.
- Public and private file storage under configured paths on the user’s Homeserver, using the same editor and file operations.
- A live event stream subscription scoped to the selected public or private folder.
- Preconfigured weekly Dependabot updates for all npm dependencies, with Pubky stack packages grouped together.

## What's Not Included

- Identity key and recovery phrase management. Pubky apps should delegate these responsibilities to a dedicated identity manager such as Pubky Ring, keeping keypairs outside the app.
- Homeserver admin tools.
- An aggregator or indexer. This template talks directly to the user’s Homeserver and does not provide cross-Homeserver aggregation or data indexing.

## Quick Start

Requires Node.js 20.19+ or 22.12+.

```bash
npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app
cd my-pubky-app
npm install
npm run dev
```

Local testnet is the default. Set `VITE_PUBKY_TESTNET=false` to use mainnet.

Use **Sign in with [Pubky Ring](https://pubkyring.app/)** to authorize an app session. For local
testnet development, the [Pubky Ring Simulator](https://simulator.pubkyring.app) can
approve sign-in requests. With `vite dev` on testnet, **New identity** provides a
development auth shortcut; the homeserver must run with `signup_mode = "open"`.

For complete local Homeserver, testnet, and authentication setup, follow the [Pubky Developer Guide](https://pubky.org/explore/pubkycore/getting-started/).

The hosted GitHub Pages builds are available for
[mainnet](https://pubky.github.io/pubky-app-templates/mainnet/basic-pubky-app/) and a
[local testnet](https://pubky.github.io/pubky-app-templates/testnet/basic-pubky-app/). Both are
production builds and expose only Pubky Ring sign-in.

## Public and Private Storage

Use **Public storage** and **Private storage** to choose where files are stored. Each space has its own file list and editor draft. The editor shows the destination folder for a new file and the full path when editing an existing file.

| Space   | Path                    | Who can read?                                     | Who can write?                       |
| ------- | ----------------------- | ------------------------------------------------- | ------------------------------------ |
| Public  | `/pub/template/files/`  | Anyone, without signing in                        | Apps you authorize with write access |
| Private | `/priv/template/files/` | Apps you authorize with read access to the folder | Apps you authorize with write access |

**Private means access-controlled, not encrypted.** Files are stored as unencrypted JSON, so the Homeserver operator can read them. `/priv` does not provide sharing with selected people. Deleting a public file cannot retract copies that were already downloaded.

The selector briefly explains who can read each folder. The event stream follows the selected space: the public stream is readable without a session, while the private stream requires your session and read access. Events contain metadata, not file contents.

The template requests read and write access to both app folders during sign-in. If you have a session saved from the public-only template, sign out and authorize the app again to grant access to the private folder.

## App Settings

App-specific configuration lives in `src/config.ts`:

```ts
export const APP_CLIENT_ID = 'template'
export const APP_PATHS = {
  public: `/pub/${APP_CLIENT_ID}/`,
  private: `/priv/${APP_CLIENT_ID}/`,
}
export const APP_CAPABILITIES = `${APP_PATHS.public}:rw,${APP_PATHS.private}:rw`
export const MAX_EVENT_BYTES = 8 * 1024
```

Change `APP_CLIENT_ID` first when starting a real app; the paths and capabilities are derived from it. The file also centralizes testnet and relay settings.

`MAX_EVENT_BYTES` sets the event payload limit (8 KiB by default); oversized payloads stop the stream and display an error.

Set `VITE_PUBKY_STORAGE_NAMESPACE` when multiple builds share an origin and should keep their saved
sessions separate.

## Checks

Run `npm test` for storage and capability regressions. These tests use the existing Vite tooling and Node's test runner; they do not need a running Homeserver. Run `npm run build` to type-check and build the app.
