[![Pubky](https://img.shields.io/badge/Pubky-0.15.0-blue)](https://www.npmjs.com/package/@synonymdev/pubky/v/0.15.0)

# Basic Pubky App

A Vite + TypeScript starter for standalone Pubky apps that use Homeservers directly as their data layer—without indexers, aggregators, or integration with pubky.app’s social data.

This template focuses on Pubky’s core building blocks. The included vanilla HTML, TypeScript, and CSS are deliberately kept simple and exist only to demonstrate those features; the template does not prescribe a UI framework, frontend architecture, or styling system.

## What's Included

- Grant-based Pubky Ring sign-in with a QR code, authorization link, and pending authorization that resumes after a reload.
- A development-only authentication shortcut that removes sign-in friction on a local testnet. It requires `signup_mode = "open"` and is not intended as a pattern for production apps.
- Session persistence, saved account switching, and sign-out synchronization across tabs via the SDK browser session store.
- Public and private file storage under configured paths on the user’s Homeserver, using the same editor and file operations.
- File editing with WebDAV locks, byte uploads in the same editor section, metadata, downloads, and an anonymous public file reader.
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

The hosted GitHub Pages builds are available for
[mainnet](https://pubky.github.io/pubky-app-templates/mainnet/basic-pubky-app/) and a
[local testnet](https://pubky.github.io/pubky-app-templates/testnet/basic-pubky-app/). Both are
production builds and expose only Pubky Ring sign-in.

## Browser Sessions

Use HTTPS or localhost: browser persistence requires a secure context, IndexedDB, and Web Locks. The app saves an approved session before making authenticated requests, allowing the SDK to coordinate its credentials across tabs. Saved accounts and the selected account are scoped to the configured storage namespace. Switching the selected account updates other tabs using that namespace.

Pending Ring authorization is saved temporarily in the current tab's session storage so reloading can resume it. Refreshing the sign-in request abandons the previous request. Completed or abandoned requests are removed from session storage.

Signing out revokes the session and clears affected tabs, including their private data and subscriptions. If remote sign-out fails, the app retains the saved session and offers a retry; other authenticated actions stay disabled while logout is pending. A previous SDK session is migrated by the SDK when restored. Reload older open tabs after upgrading so every tab uses the same session lifecycle.

## Public and Private Storage

Use **Public storage** and **Private storage** to choose where files are stored. Each space has its own file list and editor draft. The editor shows the destination folder for a new file and the full path when editing an existing file.

| Space   | Path                    | Who can read?                                     | Who can write?                       |
| ------- | ----------------------- | ------------------------------------------------- | ------------------------------------ |
| Public  | `/pub/template/files/`  | Anyone, without signing in                        | Apps you authorize with write access |
| Private | `/priv/template/files/` | Apps you authorize with read access to the folder | Apps you authorize with write access |

**Private means access-controlled, not encrypted.** Files are stored as unencrypted JSON, so the Homeserver operator can read them. `/priv` does not provide sharing with selected people. Deleting a public file cannot retract copies that were already downloaded.

The selector briefly explains who can read each folder. The event stream follows the selected space: public event requests work without a session, while private requests use your session and read access. Events contain metadata, not file contents.

The template requests read and write access to both app folders during sign-in. If you have a session saved from the public-only template, sign out and authorize the app again to grant access to the private folder.

### File Locks

Editing an existing note acquires a WebDAV lock and reads the current file before opening it in the editor. Locks last up to 60 seconds; you can renew or release them explicitly. Save writes with the lock and releases it. Changing files, storage spaces, or accounts also releases the app's held lock. One-off deletion acquires its own lock when necessary.

Locks prevent competing writes while held; they do not merge edits. Contention, expired locks, and unsupported Homeservers are reported instead of silently writing without a lock. If a lock expires, acquire a new lock and reread the file before editing again. If the connection is lost during acquisition, a server-side lock may remain until its timeout. This example requires a Homeserver with WebDAV lock support, available in version 0.15.

### Uploads and Public Reads

The Editor offers **Write a file** or **Choose a file**, with one **Upload** button at the bottom. The selected mode uploads either the title and body as a JSON note or the selected file's bytes, never both. Switching modes preserves your draft and file selection while keeping the inactive fields disabled. The public/private selector above the editor sets the destination for either mode.

Both appear in the same Files list. Notes support editing with locks; uploads can be downloaded or deleted without interpreting their contents as note JSON, even if the uploaded filename ends in `.json`. Uploading a file preserves the current note draft.

The reusable `uploadFileBytes(session, space, file)` function in [`src/storage-tools-data.ts`](src/storage-tools-data.ts) demonstrates `session.storage.putBytes`; note creation in [`src/storage.ts`](src/storage.ts) demonstrates `session.storage.putJson`. Uploads and public reads have a 5 MiB limit. Uploaded files keep unique names under `/pub/template/attachments/` or `/priv/template/attachments/` so previous uploads remain accessible. Those folder names are a template convention, not a distinct SDK storage type; the public/private access rules apply to notes and uploads equally. File metadata describes the stored resource; downloaded content is treated as a file rather than executed in the page.

Copy a public file's Pubky address to share it. The public reader works without signing in and accepts public Pubky resource addresses. It does not grant access to private resources or provide selected-recipient sharing.

### Event History

Use **Recent history** for the latest 12 changes, newest first. **Start live** follows new changes; on first use it starts with the most recent event, and restarting resumes after the last received cursor for the selected space. Signing out or switching accounts clears the remembered cursors. The stream is stopped when leaving its storage space or session.

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

Run `npm test` for session persistence and cancellation, capability boundaries, file locks and storage, public resource validation, and event history/stream cleanup. These tests use the existing Vite tooling and Node's test runner; they do not need a running Homeserver. Run `npm run build` to type-check and build the app.
