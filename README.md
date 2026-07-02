# Pubky App Template

A minimal Vite + TypeScript starter for regular user Pubky apps.

It uses `@synonymdev/pubky@0.9.3` and keeps the app code small on purpose.

## What's Included

- Sign in with `startAuthFlow`.
- A small create-user helper for homeserver signup plus direct signin.
- Session restore and sign out.
- Simple CRUD helpers under the app path.
- A small event stream tester for the app path.
- Dependabot updates for npm dependencies and the Pubky stack.

## What's Not Included

- Full recovery or seed management.
- Homeserver admin tools.
- A backend.
- A UI framework or QR dependency.

## Quick Start

```bash
npm install
npm run dev
```

The app shows the Pubky auth URL as a link and copyable text. Add a QR renderer later if your app needs desktop-to-mobile sign in.

## Local Testnet

Run a local testnet in another terminal:

```bash
cargo install pubky-testnet
pubky-testnet
```

Then start the app with:

```bash
VITE_PUBKY_TESTNET=true npm run dev
```

Default testnet homeserver:

```text
pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo
```

Optional environment variables:

```bash
VITE_PUBKY_TESTNET_HOST=localhost
VITE_PUBKY_RELAY_URL=https://httprelay.pubky.app/inbox/
```

## App Settings

The app namespace and client id live in `src/pubky.ts`:

```ts
export const APP_CLIENT_ID = 'template.app'
export const APP_PATH = `/pub/${APP_CLIENT_ID}/`
```

Change those first when starting a real app.

## Create User Helper

`createUser()` in `src/pubky.ts` generates a keypair and signs up on a homeserver.

For production signup, add a recovery/export flow for the generated keypair before relying on it as a user account.
