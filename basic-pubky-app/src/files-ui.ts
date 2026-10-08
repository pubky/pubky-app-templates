import { APP_PATHS, type StorageSpace } from './config'
import { disabledAttr, escapeHtml, formatDate } from './html'
import { filePath, type AppFile, type FileLock } from './storage'
import { uploadedFilePath, type UploadedFile } from './storage-tools-data'

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
  lock?: FileLock,
) {
  return `
    <section class="panel">
      <div class="section-header">
        <h2>Editor</h2>
        <span id="new-file-slot">${newFileButtonHtml(editingId, busy)}</span>
      </div>
      <div id="editor">${fileFormHtml(files, editingId, space, busy, draft, lock)}</div>
    </section>
  `
}

export function filesPanelHtml(
  files: AppFile[],
  space: StorageSpace,
  busy?: string,
  uploads: UploadedFile[] = [],
) {
  return `
    <section class="panel">
      <h2>Files</h2>
      <div id="files-list">${filesListHtml(files, space, busy, uploads)}</div>
    </section>
  `
}

export function updateEditor(
  files: AppFile[],
  editingId: string | undefined,
  space: StorageSpace,
  busy?: string,
  draft?: FileDraft,
  lock?: FileLock,
) {
  const fields = document.querySelector('#note-fields')
  if (fields) fields.innerHTML = noteFieldsHtml(files, editingId, space, busy, draft, lock)

  const slot = document.querySelector('#new-file-slot')
  if (slot) slot.innerHTML = newFileButtonHtml(editingId, busy)
}

export function updateFilesList(
  files: AppFile[],
  space: StorageSpace,
  busy?: string,
  uploads: UploadedFile[] = [],
) {
  const list = document.querySelector('#files-list')
  if (!list) return
  list.innerHTML = filesListHtml(files, space, busy, uploads)
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
  lock?: FileLock,
) {
  const file = files.find((item) => item.id === editingId)

  return `
    <form id="file-form" class="form-grid">
      <fieldset class="write-modes" ${disabledAttr(Boolean(busy))}>
        <legend>Content</legend>
        <label><input type="radio" name="write-mode" value="note" checked ${disabledAttr(Boolean(busy))} /> Write a note</label>
        <label><input type="radio" name="write-mode" value="file" ${disabledAttr(Boolean(busy))} /> Choose a file</label>
      </fieldset>
      <fieldset id="note-fields" data-write-mode="note" class="editor-fields" ${disabledAttr(Boolean(busy))}>
        ${noteFieldsHtml(files, editingId, space, busy, draft, lock)}
      </fieldset>
      <fieldset id="upload-fields" data-write-mode="file" class="editor-fields" hidden disabled>
        <label>File <input type="file" name="file" disabled /></label>
        <small class="muted">Store any file as bytes, up to 5 MiB.</small>
      </fieldset>
      <button type="submit" ${disabledAttr(Boolean(busy) || Boolean(file && !lock))}>Upload</button>
    </form>
  `
}

function noteFieldsHtml(
  files: AppFile[],
  editingId: string | undefined,
  space: StorageSpace,
  busy?: string,
  draft?: FileDraft,
  lock?: FileLock,
) {
  const file = files.find((item) => item.id === editingId)
  const destination = file ? filePath(space, file.id) : `${APP_PATHS[space]}files/`

  return `
      <small class="file-destination muted"><code>${escapeHtml(destination)}</code></small>
      ${file ? lockControlsHtml(lock, busy) : '<small class="muted">New files use a unique filename. Existing files are locked before editing.</small>'}
      <label>
        Title
        <input name="title" value="${escapeHtml(draft?.title ?? file?.title ?? '')}" autocomplete="off" />
      </label>
      <label>
        Body
        <textarea name="body" rows="8">${escapeHtml(draft?.body ?? file?.body ?? '')}</textarea>
      </label>
  `
}

function filesListHtml(
  files: AppFile[],
  space: StorageSpace,
  busy: string | undefined,
  uploads: UploadedFile[],
) {
  if (files.length === 0 && uploads.length === 0) {
    return `<p class="empty">No ${space} files yet.</p>`
  }

  return `
    <ul class="file-list">
      ${files.map((file) => fileItem(file, space, busy)).join('')}
      ${uploads.map((file) => uploadedFileItem(file, space, busy)).join('')}
    </ul>
  `
}

function uploadedFileItem(file: UploadedFile, space: StorageSpace, busy?: string) {
  return `
    <li>
      <div>
        <strong title="${escapeHtml(uploadedFilePath(space, file.name))}">${escapeHtml(file.name)}</strong>
        <span>Uploaded file</span>
        ${file.metadata ? `<small>${escapeHtml(metadataLabel(file.metadata))}</small>` : ''}
      </div>
      <div class="actions">
        <button type="button" data-upload-action="download" data-upload-name="${escapeHtml(file.name)}" ${disabledAttr(Boolean(busy))}>Download</button>
        <button type="button" data-upload-action="delete" data-upload-name="${escapeHtml(file.name)}" ${disabledAttr(Boolean(busy))}>Delete</button>
        ${space === 'public' ? `<button type="button" data-upload-action="copy" data-upload-name="${escapeHtml(file.name)}" ${disabledAttr(Boolean(busy))}>Copy public address</button>` : ''}
      </div>
    </li>
  `
}

function fileItem(file: AppFile, space: StorageSpace, busy?: string) {
  return `
    <li>
      <div>
        <strong title="${escapeHtml(filePath(space, file.id))}">${escapeHtml(file.title)}</strong>
        <span>${escapeHtml(validDate(file.updatedAt))}</span>
        ${file.metadata ? `<small>${escapeHtml(metadataLabel(file.metadata))}</small>` : ''}
      </div>
      <div class="actions">
        <button type="button" data-edit-id="${escapeHtml(file.id)}" ${disabledAttr(Boolean(busy))}>Lock &amp; edit</button>
        <button type="button" data-delete-id="${escapeHtml(file.id)}" ${disabledAttr(Boolean(busy))}>Delete</button>
        <button type="button" data-download-id="${escapeHtml(file.id)}" ${disabledAttr(Boolean(busy))}>Download JSON</button>
        ${space === 'public' ? `<button type="button" data-copy-id="${escapeHtml(file.id)}" ${disabledAttr(Boolean(busy))}>Copy public address</button>` : ''}
      </div>
    </li>
  `
}

function lockControlsHtml(lock: FileLock | undefined, busy?: string) {
  if (!lock)
    return '<p class="status">Select Lock &amp; edit to read the latest file before saving.</p>'
  const expires = new Date(lock.expiresAt).toLocaleTimeString()
  return `
    <div class="file-lock">
      <small>Exclusive edit lock expires at ${escapeHtml(expires)}. Renew it while editing, or release it when finished.</small>
      <div class="actions">
        <button id="renew-file-lock" type="button" ${disabledAttr(Boolean(busy))}>Renew lock</button>
        <button id="release-file-lock" type="button" ${disabledAttr(Boolean(busy))}>Release lock</button>
      </div>
    </div>
  `
}

function metadataLabel(metadata: NonNullable<AppFile['metadata']>) {
  return [
    metadata.contentLength === undefined ? '' : `${metadata.contentLength.toLocaleString()} bytes`,
    metadata.contentType || '',
    metadata.etag ? `ETag: ${metadata.etag}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function validDate(value: string) {
  return value && Number.isFinite(Date.parse(value)) ? formatDate(value) : ''
}
