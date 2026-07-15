# Pubky Identity Manager

A Vite + TypeScript template for a local Pubky identity manager.

It is meant to stand in for Pubky Ring while testing auth flows against local Pubky apps and a local testnet. It accepts pasted auth links and can scan a QR code from another tab via screen capture.

## What's Included

- Local testnet Pubky client by default.
- Two tabs: **Identity** for keypair and homeserver setup, and **Auth** for Pubky Ring-style approvals.
- Multiple Pubky identities, with one active identity used for homeserver and auth actions.
- Pubky identity creation and import.
- Automatic signup-token fallback: open signup is tried first, then a homeserver invite code is generated and used if required.
- 12-word recovery phrase import/export for repeatable local testing.
- `pubkyauth://signin`, `pubkyauth://signup`, `pubkyring://signin`, and `pubkyring://signup` parsing through `@synonymdev/pubky`.
- Pasted auth link approval using `Signer.approveAuthRequest()`.
- Screen capture QR scanning with the browser `BarcodeDetector` API.
- Dependabot updates for npm dependencies and the Pubky stack.

## What's Not Included

- Production key custody.
- Mobile deeplink registration.
- A camera QR scanner.
- A UI framework.

## Quick Start

```bash
npx tiged pubky/pubky-app-templates/pubky-signer-app pubky-signer-app
cd pubky-signer-app
npm install
npm run dev
```

Run a local Pubky testnet in another terminal:

```bash
cargo install pubky-testnet
pubky-testnet
```

Open the identity manager on the **Identity** tab. The left side creates and imports identities with recovery phrases; the right side shows active identity details, signs the active identity up to a homeserver, and publishes its PKARR homeserver record. The default homeserver is the local testnet homeserver, and the default admin settings match `pubky-testnet`.

Then move to the **Auth** tab and start the app you want to test. Auth requests are approved with the active identity. When that app shows a Pubky Ring auth QR code, either:

- paste the auth deeplink into **Auth request**, or
- click **Capture**, choose the browser tab/window containing the QR code, wait for the signer to fill the auth link, then approve it.

The app requesting auth should resolve its pending auth flow once the signer approves the request.

## Local Testnet

This template defaults to the local testnet client:

```ts
Pubky.testnet()
```

Optional environment variables:

```bash
VITE_PUBKY_TESTNET_HOST=localhost
VITE_PUBKY_TESTNET=false
```

Set `VITE_PUBKY_TESTNET=false` only when you intentionally want mainnet defaults.

Mainnet mode defaults to the production homeserver:

```text
8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty
```

Its PKDNS record advertises the browser-compatible `homeserver.pubky.app` endpoint. The Pubky SDK
resolves that transport from the homeserver public key, so no production admin URL or password is
configured in this template.

Default testnet homeserver:

```text
8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo
```

Default testnet homeserver admin endpoint:

```text
http://127.0.0.1:6288
```

Default testnet homeserver admin password:

```text
admin
```

## Signup Tokens

Signup does not require a manual invite-code step. The signer first calls `signer.signup(homeserver, null)`. If the homeserver rejects open signup, it calls `GET /generate_signup_token` on the configured homeserver admin URL with `X-Admin-Password`, then retries signup with the generated token.

## Browser Notes

Screen QR scanning uses `navigator.mediaDevices.getDisplayMedia()` and `BarcodeDetector`.

Chrome and Edge support this flow on `localhost`. If your browser does not expose `BarcodeDetector`, paste the auth deeplink instead.

## Security Notes

This template stores recovery phrases and derived identity secrets in `localStorage` for local developer convenience. Do not use that storage pattern for a production signer or a real user wallet.
