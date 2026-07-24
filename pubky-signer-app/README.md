# Pubky Identity Manager

> [!WARNING]
> Browser storage is not safe for production identity management. This template stores recovery phrases and keypair secrets unencrypted in `localStorage` and is intended for demonstration and prototyping only. Do not use it to manage real identities.

A Vite + TypeScript template for building a Pubky identity manager. It demonstrates identity creation and import, signup on a homeserver, and approval of app auth requests.

## What's Included

- Local testnet client by default.
- Two pages: **Identity** for keypair and homeserver setup, and **Auth** for Pubky Ring-style approvals.
- Multiple Pubky identities, with one active identity used for homeserver and auth actions.
- Identity creation, backup, and recovery using a 12-word recovery phrase.
- Signup on a homeserver that attempts open signup first and, when required, generates a signup token through the configured admin endpoint.
- `pubkyauth://signin`, `pubkyauth://signup`, `pubkyring://signin`, and `pubkyring://signup` parsing through `@synonymdev/pubky`.
- Pasted Pubky Auth deep link approval using `Signer.approveAuthRequest()`.
- Screen capture QR scanning with the browser `BarcodeDetector` API.
- Preconfigured weekly Dependabot updates for all npm dependencies, with Pubky stack packages grouped together.

## What's Not Included

- Native app packaging and deep link handling.
- A camera QR scanner.
- A UI framework.

## Quick Start

```bash
npx tiged pubky/pubky-app-templates/pubky-signer-app pubky-signer-app
cd pubky-signer-app
npm install
npm run dev
```

For complete local homeserver, testnet, and authentication setup, follow the [Pubky Developer Guide](https://pubky.org/explore/pubkycore/getting-started/).

Open the identity manager on the **Identity** page. The left side creates and imports identities with recovery phrases; the right side shows active identity details, signs the active identity up to a homeserver, and publishes its PKARR homeserver record. The homeserver and admin defaults match `pubky-testnet`.

The **Auth** page receives, previews, and approves app auth requests with the active identity. Load a request by either:

- paste the Pubky Auth deep link into **Auth request**, or
- click **Capture**, choose the browser tab/window containing the QR code, wait for the signer to fill the deep link, then approve it.

Screen capture requires a secure browser context with `getDisplayMedia()` and `BarcodeDetector`; paste the deep link when unavailable.

The app requesting auth should resolve its pending auth flow once the signer approves the request.

## Network Configuration

The template uses the local testnet by default and resolves homeserver public keys through its local PKARR relay.

- Set `VITE_PUBKY_TESTNET_HOST` when the testnet runs somewhere other than `localhost`.
- Set `VITE_PUBKY_TESTNET=false` to use the mainnet client without preconfigured homeserver or admin settings.
- Set `VITE_PUBKY_STORAGE_NAMESPACE` when multiple builds share an origin and should keep their
  saved identities separate.
