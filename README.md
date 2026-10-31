# Pubky App Templates

Starter templates for building Pubky apps.

Live previews are published at
[pubky.github.io/pubky-app-templates](https://pubky.github.io/pubky-app-templates/).
The Basic Pubky App is available as mainnet and local testnet builds.

## Templates

Templates require Node.js 20.19+ or 22.12+.

- [basic-pubky-app](basic-pubky-app/) - Vite + TypeScript app with Pubky Auth, shared browser sessions, public/private storage, file locks, optional encrypted uploads and local key recovery, custom proofs, and event history/live updates:
  `npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app`

- [vite-starter](vite-starter/) - Plain Vite + TypeScript starter for tutorial. No Pubky aspects included:
  `npx tiged pubky/pubky-app-templates/vite-starter my-pubky-app`

## Browser Regression Tests

From the repository root, install the repository and Basic Pubky App dependencies, then run:

```bash
npm ci
npm ci --prefix basic-pubky-app
npx playwright install --with-deps chromium firefox
npm run test:browser
```

The suite starts its own loopback-only test server and runs in Chromium and Firefox. It uses the real UI and SDK resource parsing with test-only storage/session responses, so it needs no Homeserver, credentials, or external service. Unexpected external HTTP requests fail the tests. CI runs the same command and retains reports and traces for failed runs.

Browser dependencies, configuration, and fixtures stay at the repository root, outside the copyable templates. The Basic Pubky App's `npm test` command remains an independent unit suite.
