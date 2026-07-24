# Pubky App Templates

Starter templates for building Pubky apps.

Live previews are published at
[pubky.github.io/pubky-app-templates](https://pubky.github.io/pubky-app-templates/).
The Basic Pubky App and Pubky Identity Manager are both available as mainnet and local testnet
builds.

## Templates

- [basic-pubky-app](basic-pubky-app/) - Minimal Vite + TypeScript app with Pubky Auth, file storage, and an event stream subscription:
  `npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app`

- [pubky-signer-app](pubky-signer-app/) - Pubky Identity Manager template for testing Pubky Ring auth flows:
  `npx tiged pubky/pubky-app-templates/pubky-signer-app pubky-signer-app`

  Hosted builds store recovery phrases and keypair secrets unencrypted in browser local storage.
  Use disposable identities only.

- [vite-starter](vite-starter/) - Plain Vite + TypeScript starter for tutorial. No Pubky aspects included:
  `npx tiged pubky/pubky-app-templates/vite-starter my-pubky-app`
