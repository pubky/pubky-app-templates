import type { ResourceStats } from '@synonymdev/pubky'
import { escapeHtml, formatError } from './html'
import { pubky } from './pubky'
import { downloadBytes } from './storage-download'
import { readPublicFile } from './storage-tools-data'

export function storageToolsPanelHtml() {
  return `
    <section id="storage-tools" class="grid storage-tools">
      <section class="panel">
        <h2>Read a public file</h2>
        <p class="muted">Read anyone’s public Pubky file without signing in. Private files cannot be shared this way.</p>
        <form id="public-reader" class="form-grid">
          <label>Pubky file address <input name="address" type="text" placeholder="pubky://&lt;key&gt;/pub/app/file.json" required spellcheck="false" autocomplete="off" /></label>
          <button type="submit">Read public file</button>
        </form>
        <div id="public-file-result"></div>
      </section>
      <p id="storage-tools-status" class="status" role="status"></p>
    </section>
  `
}

/** A view owns this controller and must dispose it before replacing its DOM. */
export function createStorageTools(root: HTMLElement) {
  let disposed = false
  let busy = false
  let publicFile: Awaited<ReturnType<typeof readPublicFile>> | undefined

  function active() {
    return !disposed && root.isConnected
  }

  function message(text: string, error = false) {
    if (!active()) return
    const status = root.querySelector<HTMLElement>('#storage-tools-status')
    if (!status) return
    status.textContent = text
    status.classList.toggle('error', error)
  }

  function syncControls() {
    if (!active()) return
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button,input',
    )) {
      control.disabled = busy
    }
  }

  async function run(label: string, task: () => Promise<void>) {
    if (disposed || busy) return
    busy = true
    message(label)
    syncControls()
    try {
      await task()
    } catch (error) {
      message(formatError(error), true)
    } finally {
      busy = false
      syncControls()
    }
  }

  function handleSubmit(event: Event) {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    event.preventDefault()
    event.stopPropagation()
    if (form.id === 'public-reader') {
      const address = String(new FormData(form).get('address') || '')
      void run('Reading public file...', async () => {
        // Drop old bytes immediately; a failed new read must not show an old file.
        publicFile = undefined
        const result = root.querySelector('#public-file-result')
        if (result) result.replaceChildren()
        const file = await readPublicFile(pubky.publicStorage, address, active)
        if (!active()) return
        publicFile = file
        if (result) result.innerHTML = publicResultHtml(file)
        message('Public file loaded without authentication.')
      })
    }
  }

  function handleClick(event: Event) {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('button[data-storage-action]')
    if (!button || !root.contains(button)) return
    event.stopPropagation()
    if (busy) return
    const action = button.dataset.storageAction
    void run('Working...', async () => {
      if (action === 'public-download' && publicFile) {
        downloadBytes(publicFile.bytes, publicFile.filename)
        message('Public file downloaded.')
      }
    })
  }

  root.addEventListener('submit', handleSubmit)
  root.addEventListener('click', handleClick)
  syncControls()

  return {
    dispose() {
      disposed = true
      publicFile = undefined
      root.removeEventListener('submit', handleSubmit)
      root.removeEventListener('click', handleClick)
    },
  }
}

function publicResultHtml(file: Awaited<ReturnType<typeof readPublicFile>>) {
  const textType = /^(text\/|application\/(json|[^;]+\+json)(;|$))/.test(
    file.metadata.contentType || '',
  )
  const preview = textType ? new TextDecoder().decode(file.bytes.slice(0, 4000)) : ''
  return `
    <p><strong>${escapeHtml(file.filename)}</strong></p>
    <p class="muted">${escapeHtml(metadataLabel(file.metadata))}</p>
    ${textType ? `<pre class="file-preview">${escapeHtml(preview)}${file.bytes.byteLength > 4000 ? '\n… (preview truncated)' : ''}</pre>` : '<p>Binary content is available as a download.</p>'}
    <button type="button" data-storage-action="public-download">Download public file</button>
  `
}

function metadataLabel(metadata?: ResourceStats) {
  if (!metadata) return ''
  return [
    metadata.contentLength === undefined ? '' : `${metadata.contentLength.toLocaleString()} bytes`,
    metadata.contentType || '',
    metadata.etag ? `ETag: ${metadata.etag}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
