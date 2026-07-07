# Basic Pubky App

A minimal Vite + TypeScript starter for regular user Pubky apps.

It uses `@synonymdev/pubky@0.9.3` and keeps the app code small on purpose.

## What's Included

- Pubky Ring sign-in with a QR code, magic link button and copy-to-clipboard action.
- A new identity helper that creates a key pair, then signs up and signs in on a homeserver in one go.
- Session restore and sign out.
- Simple CRUD helpers under the app path.
- A small event stream tester for the app path.
- Dependabot updates for npm dependencies and the Pubky stack.

## What's Not Included

- Full recovery or seed management.
- Homeserver admin tools.
- An aggregator or indexer. This basic app talks directly to the user's homeserver as its data layer; add an aggregator for multi-homeserver access or an indexer for backend-like querying.
- A production signup flow.
- A UI framework.

## Quick Start

```bash
npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app
cd my-pubky-app
npm install
npm run dev
```

Use **Sign in with Pubky Ring** to approve the app session from Ring. Use **New identity** to create a key pair, sign up and sign in on the configured homeserver, in one go. The new identity helper is primarily for development, to move through auth quickly.

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
VITE_PUBKY_HTTP_RELAY=https://httprelay.pubky.app/inbox/
```

## App Settings

The app namespace and client id live in `src/pubky.ts`:

```ts
export const APP_CLIENT_ID = 'template.app'
export const APP_PATH = `/pub/${APP_CLIENT_ID}/`
```

Change those first when starting a real app.

## New Identity Helper

`createUser()` in `src/pubky.ts` generates a keypair and signs up on a homeserver.

For production signup, add recovery and export flows for the generated keypair before relying on it as a user account.
