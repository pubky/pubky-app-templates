# Pubky App Templates

Starter templates for building Pubky apps.

Live previews are published at
[pubky.github.io/pubky-app-templates](https://pubky.github.io/pubky-app-templates/).

## Templates

- [basic-pubky-app](basic-pubky-app/) - Minimal Vite + TypeScript app with auth, storage, and event streaming:
  `npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app`

- [pubky-signer-app](pubky-signer-app/) - Pubky Identity Manager template for testing Pubky Ring auth flows against local Pubky apps:
  `npx tiged pubky/pubky-app-templates/pubky-signer-app pubky-signer-app`

  This template is not hosted on GitHub Pages because it stores recovery phrases and identity
  secrets in browser local storage. Run it locally for development and testing.

- [vite-starter](vite-starter/) - Plain Vite + TypeScript starter for tutorial. No Pubky aspects included:
  `npx tiged pubky/pubky-app-templates/vite-starter my-pubky-app`
