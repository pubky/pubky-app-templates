import type { ResourceStats, Session } from '@synonymdev/pubky'
import { hasStorageAccess } from './access'
import type { StorageSpace } from './config'
import { copyTextToClipboard, escapeHtml, formatError } from './html'
import { pubky } from './pubky'
import { downloadBytes } from './storage-download'
import {
  listAttachments,
  publicAttachmentAddress,
  readAttachment,
  readPublicFile,
  removeAttachment,
  uploadAttachment,
  type Attachment,
} from './storage-tools-data'

export function storageToolsPanelHtml(hasSession: boolean, space: StorageSpace) {
  return `
    <section id="storage-tools" class="grid storage-tools">
      ${
        hasSession
          ? `<section class="panel">
        <h2>${space === 'private' ? 'Private' : 'Public'} attachments</h2>
        <p class="muted">Upload any file, up to 5 MiB. Downloads preserve its bytes.</p>
        <form id="attachment-upload" class="form-grid">
          <label>File <input type="file" name="attachment" required /></label>
          <button type="submit">Upload ${space} attachment</button>
        </form>
        <div id="attachments-list"></div>
        <button type="button" data-storage-action="refresh">Refresh attachments</button>
      </section>`
          : ''
      }
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
export function createStorageTools(
  root: HTMLElement,
  options: { session?: Session; space: StorageSpace },
) {
  const { session, space } = options
  let disposed = false
  let busy = false
  let publicFile: Awaited<ReturnType<typeof readPublicFile>> | undefined
  const canWrite = Boolean(session && hasStorageAccess(session, space))

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
      const isPublicReader = Boolean(control.closest('#public-reader, #public-file-result'))
      control.disabled = busy || (!isPublicReader && !canWrite)
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

  async function refresh() {
    if (!session || !canWrite) return
    const attachments = await listAttachments(session, space, active)
    if (!active()) return
    const list = root.querySelector('#attachments-list')
    if (list) list.innerHTML = attachmentListHtml(attachments, space)
    syncControls()
  }

  function handleSubmit(event: Event) {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    event.preventDefault()
    event.stopPropagation()
    if (form.id === 'attachment-upload' && session && canWrite) {
      const file = new FormData(form).get('attachment')
      if (!(file instanceof File) || !file.name) return
      void run('Uploading attachment...', async () => {
        const name = await uploadAttachment(session, space, file, active)
        if (!active()) return
        form.reset()
        await refresh()
        message(`Uploaded ${name}.`)
      })
    } else if (form.id === 'public-reader') {
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
    const name = button.dataset.attachment
    const action = button.dataset.storageAction
    void run('Working...', async () => {
      if (action === 'public-download' && publicFile) {
        downloadBytes(publicFile.bytes, publicFile.filename)
        message('Public file downloaded.')
      } else if (action === 'refresh') {
        await refresh()
        message('Attachments refreshed.')
      } else if (session && canWrite && name) {
        if (action === 'download') {
          const bytes = await readAttachment(session, space, name, active)
          if (!active()) return
          downloadBytes(bytes, name)
          message('Attachment downloaded.')
        } else if (action === 'delete') {
          await removeAttachment(session, space, name)
          if (!active()) return
          await refresh()
          message('Attachment deleted.')
        } else if (action === 'copy' && space === 'public') {
          await copyTextToClipboard(publicAttachmentAddress(session, name))
          message('Public address copied.')
        }
      }
    })
  }

  root.addEventListener('submit', handleSubmit)
  root.addEventListener('click', handleClick)
  syncControls()
  if (session && canWrite)
    void run('Loading attachments...', async () => {
      await refresh()
      message('')
    })

  return {
    dispose() {
      disposed = true
      publicFile = undefined
      root.removeEventListener('submit', handleSubmit)
      root.removeEventListener('click', handleClick)
    },
  }
}

function attachmentListHtml(files: Attachment[], space: StorageSpace) {
  if (!files.length) return '<p class="empty">No attachments yet.</p>'
  return `<ul class="file-list">${files
    .map(
      (file) => `
    <li>
      <div><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(metadataLabel(file.metadata))}</small></div>
      <div class="actions">
        <button type="button" data-storage-action="download" data-attachment="${escapeHtml(file.name)}">Download</button>
        <button type="button" data-storage-action="delete" data-attachment="${escapeHtml(file.name)}">Delete</button>
        ${space === 'public' ? `<button type="button" data-storage-action="copy" data-attachment="${escapeHtml(file.name)}">Copy public address</button>` : ''}
      </div>
    </li>`,
    )
    .join('')}</ul>`
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
