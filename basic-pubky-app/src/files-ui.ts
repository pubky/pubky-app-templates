import { APP_PATHS, type StorageSpace } from './config'
import { disabledAttr, escapeHtml, formatDate } from './html'
import { filePath, type AppFile } from './storage'

export interface FileDraft {
  title: string
  body: string
}

export function editorPanelHtml(
  files: AppFile[],
  editingId: string | undefined,
  space: StorageSpace,
  busy?: string,
  draft?: FileDraft,
) {
  return `
    <section class="panel">
      <div class="section-header">
        <h2>Editor</h2>
        <span id="new-file-slot">${newFileButtonHtml(editingId, busy)}</span>
      </div>
      <div id="editor">${fileFormHtml(files, editingId, space, busy, draft)}</div>
    </section>
  `
}

export function filesPanelHtml(files: AppFile[], space: StorageSpace, busy?: string) {
  return `
    <section class="panel">
      <h2>${space === 'public' ? 'Public' : 'Private'} files</h2>
      <p class="muted">Test public access attempts a read without your session.</p>
      <div id="files-list">${filesListHtml(files, space, busy)}</div>
    </section>
  `
}

export function updateEditor(
  files: AppFile[],
  editingId: string | undefined,
  space: StorageSpace,
  busy?: string,
  draft?: FileDraft,
) {
  const editor = document.querySelector('#editor')
  if (editor) editor.innerHTML = fileFormHtml(files, editingId, space, busy, draft)

  const slot = document.querySelector('#new-file-slot')
  if (slot) slot.innerHTML = newFileButtonHtml(editingId, busy)
}

export function updateFilesList(files: AppFile[], space: StorageSpace, busy?: string) {
  const list = document.querySelector('#files-list')
  if (!list) return
  list.innerHTML = filesListHtml(files, space, busy)
}

function newFileButtonHtml(editingId: string | undefined, busy?: string) {
  if (!editingId) return ''
  return `<button id="new-file" type="button" ${disabledAttr(Boolean(busy))}>New</button>`
}

function fileFormHtml(
  files: AppFile[],
  editingId: string | undefined,
  space: StorageSpace,
  busy?: string,
  draft?: FileDraft,
) {
  const file = files.find((item) => item.id === editingId)
  const destination = file ? filePath(space, file.id) : `${APP_PATHS[space]}files/`

  return `
    <form id="file-form" class="form-grid">
      <p class="file-destination muted">${file ? 'File' : 'Destination folder'}: <code>${escapeHtml(destination)}</code></p>
      <label>
        Title
        <input name="title" value="${escapeHtml(draft?.title ?? file?.title ?? '')}" autocomplete="off" />
      </label>
      <label>
        Body
        <textarea name="body" rows="8">${escapeHtml(draft?.body ?? file?.body ?? '')}</textarea>
      </label>
      <button type="submit" ${disabledAttr(Boolean(busy))}>Save ${space} file</button>
    </form>
  `
}

function filesListHtml(files: AppFile[], space: StorageSpace, busy?: string) {
  if (files.length === 0) {
    return `<p class="empty">No ${space} files yet.</p>`
  }

  return `
    <ul class="file-list">
      ${files.map((file) => fileItem(file, space, busy)).join('')}
    </ul>
  `
}

function fileItem(file: AppFile, space: StorageSpace, busy?: string) {
  return `
    <li>
      <div>
        <strong>${escapeHtml(file.title)}</strong>
        <span>${escapeHtml(formatDate(file.updatedAt))}</span>
        <code class="file-path">${escapeHtml(filePath(space, file.id))}</code>
      </div>
      <div class="actions">
        <button type="button" data-edit-id="${escapeHtml(file.id)}" ${disabledAttr(Boolean(busy))}>Edit</button>
        <button type="button" data-delete-id="${escapeHtml(file.id)}" ${disabledAttr(Boolean(busy))}>Delete</button>
        <button type="button" data-test-access-id="${escapeHtml(file.id)}" aria-label="Test public access to ${escapeHtml(file.title)}" ${disabledAttr(Boolean(busy))}>Test public access</button>
      </div>
    </li>
  `
}
