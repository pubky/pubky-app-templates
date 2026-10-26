[![Pubky](https://img.shields.io/badge/Pubky-0.17.1-blue)](https://www.npmjs.com/package/@synonymdev/pubky/v/0.17.1)

# Basic Pubky App

Template version: **0.1.0** (`package.json`). The badge above tracks the separate Pubky SDK version.

A Vite + TypeScript starter for standalone Pubky apps that use Homeservers directly as their data layer—without indexers, aggregators, or integration with pubky.app’s social data.

This template focuses on Pubky’s core building blocks. The included vanilla HTML, TypeScript, and CSS are deliberately kept simple and exist only to demonstrate those features; the template does not prescribe a UI framework, frontend architecture, or styling system.

## What's Included

- Grant-based Pubky Ring sign-in with a QR code, authorization link, and pending authorization that resumes after a reload.
- A development-only authentication shortcut that removes sign-in friction on a local testnet. It requires `signup_mode = "open"` and is not intended as a pattern for production apps.
- Session persistence and sign-out synchronization across tabs via the SDK browser session store.
- Public and private file storage under configured paths on the user’s Homeserver, using the same editor and file operations.
- File editing with WebDAV locks, direct File uploads in the same editor section, metadata, downloads, and an anonymous public file reader.
- Optional encryption for private uploads using scoped keys, plus local decryption with saved browser keys.
- Custom grant proofs that sign and verify a message locally.
- Recent event history and live updates that resume from the last received cursor, scoped to the selected public or private folder.
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

Signed approvals and encryption keys require a compatible signer and Homeserver. Local testnet relays default to a 2 KiB approval body limit, which can reject a signed approval with HTTP 413 while the app continues waiting. Run a relay with a larger limit, such as `http-relay --max-body-size 16384`, and point `VITE_PUBKY_HTTP_RELAY` to its inbox URL. The app cannot change a remote relay’s limit. See the [SDK relay guidance](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/scoped-encryption-keys.md#relay-limits).

The hosted GitHub Pages builds are available for
[mainnet](https://pubky.github.io/pubky-app-templates/mainnet/basic-pubky-app/) and a
[local testnet](https://pubky.github.io/pubky-app-templates/testnet/basic-pubky-app/). Both are
production builds and expose only Pubky Ring sign-in.

## Browser Sessions

Use HTTPS or localhost: browser persistence requires a secure context, IndexedDB, and Web Locks. The app saves an approved session before making authenticated requests, allowing the SDK to coordinate its credentials across tabs. The app remembers one session per configured storage namespace. To use a different account, sign out and sign in again with Pubky Ring. Session changes update other tabs using that namespace.

Pending Ring authorization is saved temporarily in the current tab's session storage so reloading can resume it. Refreshing the sign-in request abandons the previous request. Completed or abandoned requests are removed from session storage.

Signing out revokes the session and clears affected tabs, including their private data and subscriptions. If remote sign-out fails, the app retains the saved session and offers a retry; other authenticated actions stay disabled while logout is pending. A previous SDK session is migrated by the SDK when restored. Signed approvals use V2 browser records that older SDKs cannot safely share: upgrade every app sharing the origin and reload its open tabs together.

If restoring a saved session fails, use **Retry session recovery** before signing in again. This also retries a pending sign-out after a reload, keeping its revocation tracked until the SDK confirms completion. Sign-ins superseded by another tab are revoked; if that cleanup fails, the same recovery action retries it without replacing the selected session.

## Public and Private Storage

Use **Public storage** and **Private storage** to choose where files are stored. Each space has its own file list and editor draft. The editor shows the destination folder for a new file and the full path when editing an existing file.

| Space   | Path                    | Who can read?                                     | Who can write?                       |
| ------- | ----------------------- | ------------------------------------------------- | ------------------------------------ |
| Public  | `/pub/template/files/`  | Anyone, without signing in                        | Apps you authorize with write access |
| Private | `/priv/template/files/` | Apps you authorize with read access to the folder | Apps you authorize with write access |

**Private storage is access-controlled.** Notes and ordinary uploads remain unencrypted, so the Homeserver operator can read them. The optional encrypted upload example below protects file contents separately. `/priv` does not provide sharing with selected people. Deleting a public file cannot retract copies that were already downloaded.

The selector briefly explains who can read each folder. The event stream follows the selected space: public event requests work without a session, while private requests use your session and read access. Events contain metadata, not file contents.

The template requests read and write access to both app folders and encryption keys only for `/priv/template/attachments/`. Sign-in selects `approvalFormat: 'signedApprovalV1'`. The signer may narrow the approved folders or decline encryption keys; normal storage still works in approved folders. Read-only grants allow listing, downloads, and events while editing stays disabled. To add permissions to an older session, sign out to revoke its grant, then authorize the app again. Deleting a local session record alone does not revoke a grant.

### File Locks

Editing an existing note acquires a WebDAV lock and reads the current file before opening it in the editor. Locks last up to 60 seconds; you can renew or release them explicitly. Save writes with the lock and releases it. Changing files or storage spaces, and signing out, also releases the app's held lock. One-off deletion acquires its own lock when necessary.

Locks prevent competing writes while held; they do not merge edits. Contention, expired locks, and unsupported Homeservers are reported instead of silently writing without a lock. If a lock expires, acquire a new lock and reread the file before editing again. If the connection is lost during acquisition, a server-side lock may remain until its timeout. This example requires a Homeserver with WebDAV lock support, available in version 0.15.

Reacquiring a lock preserves your unsaved draft if the file has not changed, including after switching storage spaces. If the file changed, the editor keeps your text visible and blocks saving. Copy your draft, select **New**, then **Lock & edit** to review the latest file before applying your changes.

### Uploads and Public Reads

The Editor offers **Write a file** or **Choose a file**, with one **Upload** button at the bottom. The selected mode uploads either the title and body as a JSON note or the selected file's bytes, never both. Switching modes preserves your draft and file selection while keeping the inactive fields disabled. The public/private selector above the editor sets the destination for either mode.

Both appear in the same Files list. Notes support editing with locks; uploads can be downloaded or deleted without interpreting their contents as note JSON, even if the uploaded filename ends in `.json`. Uploading a file preserves the current note draft.

A completed save, upload, or deletion updates the form and file list immediately. If refreshing the list then fails, the app keeps the success message and reports the refresh failure separately; the completed operation does not need to be repeated.

SDK request errors distinguish transport failures from HTTP responses; credential refresh failures are reported separately. An interrupted write may have reached the Homeserver, so the app does not retry writes automatically. Check the file before repeating an uncertain operation.

File-list metadata is optional: if its request fails, the file stays in the list with a **Metadata unavailable** notice and its normal controls.

The reusable `uploadFileBytes(session, space, file)` function in [`src/storage-tools-data.ts`](src/storage-tools-data.ts) sends ordinary `File` objects through `session.storage.putBlob`; encrypted uploads use `putBytes` for their ciphertext. Note creation in [`src/storage.ts`](src/storage.ts) demonstrates `session.storage.putJson`. Uploads and public reads have a 5 MiB limit. Uploaded files keep unique names under `/pub/template/attachments/` or `/priv/template/attachments/` so previous uploads remain accessible. Those folder names are a template convention, not a distinct SDK storage type; the public/private access rules apply to notes and uploads equally. File metadata describes the stored resource; downloaded content is treated as a file rather than executed in the page.

Copy a public file's Pubky address to share it. Open **Public file reader** in the navigation to read it on a separate page, without signing in. The reader accepts public Pubky resource addresses; it does not grant access to private resources or provide selected-recipient sharing. **Your files** returns to the account workspace or sign-in screen. These are ordinary page links, so save editor changes before switching pages.

### Encrypted Uploads

Choose **Private storage**, then **Choose a file**, and enable **Encrypt this upload** before uploading. Encryption needs a fresh Ring authorization that approves the attachments folder’s `e` capability; the development identity shortcut does not supply encryption keys. Missing or narrowed key permissions produce an error without uploading plaintext. The 5 MiB stored-file limit includes the encryption envelope.

The encrypted file appears in the normal list with a `.pubkyenc` suffix. **Decrypt & download** reads and decrypts it. **Download ciphertext** saves its encrypted bytes; keep that download’s original filename. In **Recover an encrypted download**, choose the ciphertext and select **Decrypt with saved keys** to decrypt locally. This uses `browserSessionStore.restoreEncryptionKeys(recordId)` without restoring an authenticated session or making a network request. The panel uses the currently selected account’s saved record.

[`src/encryption.ts`](src/encryption.ts) derives a non-extractable AES-GCM key using `deriveCryptoKeyForPath`, generates a fresh 12-byte IV for every encryption, binds the envelope to its account and storage path, and frees the owned SDK key bundle. This envelope and filename suffix are template conventions. Renaming or moving encrypted files breaks decryption. File names, sizes, and other resource metadata remain visible to the Homeserver.

Scoped keys remain usable after grant expiry or revocation and have no rotation mechanism. The SDK stores key recovery material as plaintext in IndexedDB, accessible to scripts on the same origin. Signing out removes this session’s browser record; a ciphertext download by itself is not a key backup. A production app needs an explicit recovery design before deleting saved key material. See the [scoped encryption guide](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/scoped-encryption-keys.md).

### Event History

Use **Recent history** for the latest 12 changes, newest first. **Start live** follows new changes; on first use it starts with the most recent event, and restarting resumes after the last received cursor for the selected space. Signing out clears the remembered cursors. The stream is stopped when leaving its storage space or session.

## Custom Grant Proofs

Use **Sign and verify a message** to sign up to 4 KiB of text with the session’s delegated key and verify the root-signed grant and client proof locally. [`src/proofs.ts`](src/proofs.ts) demonstrates `createCustomPop` and `verifyCustomGrantPop`; the UI displays the verified identity and message. It checks the expected identity, client ID, audience, purpose, challenge, and a 60-second maximum proof age, and remembers used nonces until the grant expires.

Replay tracking lasts only while this panel remains mounted. Offline verification cannot check current revocation, and storage capabilities do not authorize service actions. A real service must enforce its own permissions and maintain durable, atomic challenge and replay state. See the [custom proof contract](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/CUSTOM_POP.md).

## App Settings

App-specific configuration lives in `src/config.ts`:

```ts
import { validateCapabilities } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template'
export const APP_PATHS = {
  public: `/pub/${APP_CLIENT_ID}/`,
  private: `/priv/${APP_CLIENT_ID}/`,
}
export const APP_CAPABILITIES = validateCapabilities(
  `${APP_PATHS.public}:rw,${APP_PATHS.private}:rw,${APP_PATHS.private}attachments/:e`,
)
export const MAX_EVENT_BYTES = 8 * 1024
```

Change `APP_CLIENT_ID` first when starting a real app; the paths and capabilities are derived from it. The file also centralizes testnet and relay settings.

`MAX_EVENT_BYTES` sets the event payload limit (8 KiB by default); oversized payloads stop the stream and display an error.

Set `VITE_PUBKY_STORAGE_NAMESPACE` when multiple builds share an origin and should keep their saved
sessions separate.

## Checks

Run `npm test` for session persistence and cancellation, capability boundaries, file locks and storage, encryption and proof validation, public resource validation, and event history/stream cleanup. These tests use the existing Vite tooling and Node's test runner; they do not need a running Homeserver. Run `npm run build` to type-check and build the app.

The parent repository also runs Chromium and Firefox regression tests in CI. They exercise the real UI with controlled SDK responses, including failed writes, successful writes followed by failed refreshes, downloads, and page navigation. Dedicated Chromium tests verify actual back-forward cache restoration, including draft preservation and session invalidation while away. The browser tooling and fixtures live outside this template, so copying it does not add browser-test dependencies. These tests complement live testnet checks; they do not replace SDK/Homeserver integration testing.

## Keeping Only the Examples You Need

`src/client.ts` creates the shared SDK client; `src/pubky.ts` contains account and sign-in functions. The public reader and event helpers use the client directly and do not import the account controller.

- To remove the public reader, delete `public-reader.html`, `src/public-reader.ts`, and `src/storage-tools.ts`; remove its navigation link in `src/app.ts` and its entry in `vite.config.js`.
- To keep only the public reader, delete `index.html`, `src/main.ts`, `src/app.ts`, and `tests/browser-cache.test.js` (the account controller tests). Rename `public-reader.html` to `index.html` so the reader opens at `/`. In `vite.config.js`, remove the `app` input and change the remaining input to `reader: resolve(import.meta.dirname, 'index.html')`. Remove the **Your files** link and its separator from `src/public-reader.ts`. Run `npm test` and `npm run build` to check the remaining template. The reader imports only the shared SDK setup and file helpers; unused account helpers and their tests can also be deleted together.
- To remove an account-page example, remove its panel, imports, and event handlers together. Shared file helpers are ordinary functions, with no feature registry or required initialization order. Panel update functions tolerate absent panel elements.
