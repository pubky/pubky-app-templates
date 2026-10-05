import type { StorageSpace } from './config'
import { disabledAttr } from './html'

export function storageSpacesHtml(space: StorageSpace, busy?: string) {
  return `
    <section class="storage-spaces" aria-label="Storage space">
      <div class="space-buttons" role="group" aria-label="Choose a storage space" aria-describedby="space-description">
        <button type="button" data-storage-space="public" aria-pressed="${space === 'public'}" ${disabledAttr(Boolean(busy))}>Public storage</button>
        <button type="button" data-storage-space="private" aria-pressed="${space === 'private'}" ${disabledAttr(Boolean(busy))}>Private storage</button>
      </div>
      <p id="space-description" class="muted">${space === 'public' ? 'Anyone can read.' : 'Authorized apps only.'}</p>
    </section>
  `
}
