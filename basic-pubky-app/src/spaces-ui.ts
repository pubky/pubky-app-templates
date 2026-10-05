import { APP_PATHS, type StorageSpace } from './config'
import { disabledAttr, escapeHtml } from './html'

export function storageSpacesHtml(space: StorageSpace, busy?: string) {
  return `
    <section class="panel storage-spaces" aria-label="Storage space">
      <div class="space-buttons" role="group" aria-label="Choose a storage space" aria-describedby="space-description">
        <button type="button" data-storage-space="public" aria-pressed="${space === 'public'}" ${disabledAttr(Boolean(busy))}>Public <code>/pub</code></button>
        <button type="button" data-storage-space="private" aria-pressed="${space === 'private'}" ${disabledAttr(Boolean(busy))}>Private <code>/priv</code></button>
      </div>
      <p class="space-path"><code>${escapeHtml(APP_PATHS[space])}</code></p>
      <p id="space-description">${space === 'public' ? 'Anyone can read these files. Apps need your authorization and write access to change them.' : 'Apps need your authorization and read access to this folder to read these files. Files are stored unencrypted, so your homeserver operator can read them.'}</p>
      <details class="space-details muted">
        <summary>About public and private storage</summary>
        <p>Private storage controls access through your homeserver. It does not encrypt files or provide sharing with selected people.</p>
        <p>Deleting a public file cannot retract copies someone has already downloaded.</p>
      </details>
    </section>
  `
}
