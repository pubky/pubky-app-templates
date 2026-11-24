# Pubky App Templates

Starter templates for building Pubky apps.

Live previews are published at [templates.pubky.org](https://templates.pubky.org/).
The Basic Pubky App is available as mainnet and local testnet builds.

## Templates

Templates require Node.js 20.19+ or 22.12+.

- [basic-pubky-app](basic-pubky-app/) - Vite + TypeScript app with Pubky Auth, shared browser sessions, public/private storage, on-demand encryption authorization, optional account inspection, file locks, encrypted uploads and local key recovery, custom proofs, and event history/live updates:
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

## Cloud Run Deployment

[The deployment workflow](.github/workflows/deploy.yml) replaces GitHub Pages.
Pushes to `main` and manual runs build and push a commit-SHA-tagged container,
then deploy `templates-pubky-org` in `europe-west6`.

The registry is `europe-west6-docker.pkg.dev/infra-464608/synonym-private-repo`.
Make the Actions secrets `GRC_INFRA_READ_WRITE` (Artifact Registry push credentials)
and `CLOUDRUN_INFRA` (Cloud Run deployment credentials) available to this repository.
The deployment account needs permission to deploy the service, act as its runtime
service account, and configure unauthenticated invocation.

The Dockerfile preserves the landing page and all preview paths:

- `/mainnet/basic-pubky-app/`
- `/testnet/basic-pubky-app/`
- `/vite-starter/`
- `/basic-pubky-app/`, which redirects to the mainnet preview

The container runs a non-root Node.js static server on port `8080`, without Nginx.
Runtime dependencies stay at the repository root, outside the copyable templates.
Mainnet and testnet remain separate production builds; the testnet build retains
its `testnet` storage namespace and connects to the visitor's local testnet.
CI retains the template and browser checks and also tests production-server routing.

Cloud Run ingress allows internal traffic and Cloud Load Balancing.
Unauthenticated invocation lets the load balancer's serverless NEG reach the service.
The existing load balancer must route `templates.pubky.org` to `templates-pubky-org`
in `europe-west6`. DNS, TLS, and load-balancer resources are managed separately.
Disable GitHub Pages in repository settings at cutover; removing its workflow does
not unpublish an existing Pages deployment.

To build and test the production container locally:

```bash
docker build -t templates-pubky-org .
docker run --rm -p 8080:8080 templates-pubky-org
```

Open `http://localhost:8080/`.
