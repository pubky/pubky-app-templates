import { pubky } from './client'
import { recoverEncryptedUpload } from './encryption-recovery'
import { formatError } from './html'
import { downloadBytes } from './storage-download'

export function encryptionRecoveryPanelHtml() {
  return `
    <section id="encryption-recovery" class="panel">
      <h2>Recover an encrypted download</h2>
      <p class="muted">Choose a ciphertext download with its original filename. Decrypt locally using this account's saved browser keys, without a network request.</p>
      <form class="form-grid">
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
  const controls = root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')
  const submit = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!active() || busy || !(event.target instanceof HTMLFormElement)) return
    const form = event.target
    const file = new FormData(form).get('ciphertext')
    if (!(file instanceof File) || !file.name) return
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
