import { pubky } from './client'
import type { StorageSpace } from './config'
import { recoverEncryptedUpload } from './encryption-recovery'
import { formatError } from './html'
import { downloadBytes } from './storage-download'

export function encryptionRecoveryPanelHtml(space: StorageSpace = 'private') {
  return `
    <section id="encryption-recovery" class="panel">
      <h2>Recover an encrypted download</h2>
      <p class="muted">Choose a ciphertext download with its original filename. Decrypt locally using this account's saved browser keys, without a network request.</p>
      <form class="form-grid">
        <label>Original storage
          <select name="space">
            <option value="public" ${space === 'public' ? 'selected' : ''}>Public storage</option>
            <option value="private" ${space === 'private' ? 'selected' : ''}>Private storage</option>
          </select>
        </label>
        <label>Encrypted file <input type="file" name="ciphertext" accept=".pubkyenc" required /></label>
        <button type="submit">Decrypt with saved keys</button>
      </form>
      <p class="status" role="status"></p>
    </section>
  `
}

export function createEncryptionRecovery(root: HTMLElement, recordId: string, owner: string) {
  let disposed = false
  let busy = false
  const active = () => !disposed && root.isConnected
  const status = root.querySelector<HTMLElement>('[role="status"]')!
  const controls = root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
    'input,button,select',
  )
  const submit = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!active() || busy || !(event.target instanceof HTMLFormElement)) return
    const form = event.target
    const data = new FormData(form)
    const file = data.get('ciphertext')
    const space = data.get('space')
    if (!(file instanceof File) || !file.name) return
    if (space !== 'public' && space !== 'private') return
    busy = true
    controls.forEach((control) => (control.disabled = true))
    status.textContent = 'Recovering encryption keys...'
    void (async () => {
      try {
        const result = await recoverEncryptedUpload(
          pubky.browserSessionStore,
          recordId,
          owner,
          file,
          active,
          space,
        )
        if (!active()) return
        downloadBytes(result.bytes, result.filename)
        status.textContent = 'Decrypted locally with saved browser keys.'
        form.reset()
      } catch (error) {
        if (active()) status.textContent = formatError(error)
      } finally {
        busy = false
        if (active()) controls.forEach((control) => (control.disabled = false))
      }
    })()
  }
  root.addEventListener('submit', submit)
  return {
    dispose() {
      disposed = true
      root.removeEventListener('submit', submit)
      root.querySelector('form')?.reset()
      status.textContent = ''
    },
  }
}
