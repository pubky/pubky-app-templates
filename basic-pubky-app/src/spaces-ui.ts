import type { StorageSpace } from './config'
import { disabledAttr } from './html'

export function storageSpacesHtml(space: StorageSpace, busy?: string) {
  return `
    <section class="storage-spaces" aria-label="Storage space">
      <div class="space-buttons" role="group" aria-label="Choose a storage space" aria-describedby="space-description">
        <button type="button" data-storage-space="public" aria-pressed="${space === 'public'}" ${disabledAttr(Boolean(busy))}>Public <code>/pub</code></button>
        <button type="button" data-storage-space="private" aria-pressed="${space === 'private'}" ${disabledAttr(Boolean(busy))}>Private <code>/priv</code></button>
      </div>
      <p id="space-description" class="muted">${space === 'public' ? 'Anyone can read.' : 'Authorized apps only. Unencrypted.'}</p>
      <details class="space-details muted">
        <summary>About</summary>
        <div class="space-help">
          <p>Public files are readable by anyone. Private files require your authorization; your homeserver operator can still read them. Writing to either folder requires authorization.</p>
          <p>Events follow the selected folder and contain metadata only.</p>
          <p>Private storage does not encrypt files or share them with selected people. Deleting public files cannot retract downloaded copies.</p>
        </div>
      </details>
    </section>
  `
}
