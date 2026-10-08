import type { Session } from '@synonymdev/pubky'
import { version as pubkySdkVersion } from '@synonymdev/pubky/package.json'
import { hasStorageAccess, requireStorageAccess } from './access'
import { type StorageSpace } from './config'
import {
  isAuthorizeRingLink,
  authViewHtml,
  renderRingSigninQr,
  updateAuthorizeLink,
  updateCopyButton,
  updateRingPanel,
  type RingSigninState,
} from './auth-ui'
import {
  startAppEventStream,
  startAppEventHistory,
  EVENT_HISTORY_LIMIT,
  type AppEvent,
  type AppEventStream,
} from './events'
import { eventStreamPanelHtml, updateEventList, updateEventStreamToggle } from './events-ui'
import {
  editorPanelHtml,
  filesPanelHtml,
  updateEditor,
  updateFilesList,
  type FileDraft,
} from './files-ui'
import { storageSpacesHtml } from './spaces-ui'
import {
  copyTextToClipboard,
  disabledAttr,
  escapeHtml,
  formValue,
  formatError,
  statusMessage,
} from './html'
import {
  deselectSavedAccount,
  getSavedSessionId,
  listSavedAccounts,
  selectSavedAccount,
  subscribeSavedSessionChanges,
  type SavedAccount,
  isRingAuthCanceled,
  isRingAuthExpired,
  restoreSavedSession,
  saveSession,
  signOut,
  signupDevelopmentUser,
  startRingAuthFlow,
  type RingAuthFlow,
} from './pubky'
import {
  acquireFileLock,
  renewFileLock,
  releaseFileLock,
  downloadFile,
  publicFileAddress,
  deleteFile,
  filePath,
  listFiles,
  saveFile,
  type AppFile,
  type FileLock,
} from './storage'
import { storageToolsPanelHtml, createStorageTools } from './storage-tools'
import { downloadBytes } from './storage-download'
import {
  deleteUploadedFile,
  listUploadedFiles,
  publicUploadedFileAddress,
  readUploadedFile,
  uploadedFilePath,
  uploadFileBytes,
  type UploadedFile,
} from './storage-tools-data'

interface State {
  revision: number
  accounts: SavedAccount[]
  logoutPending: boolean
  fileLock?: FileLock
  stopEventHistory?: () => Promise<void>
  eventCursor?: string
  busy?: string
  quietBusy?: boolean
  editingId?: string
  error?: string
  notice?: string
  noticePath?: string
  files: AppFile[]
  uploads: UploadedFile[]
  space: StorageSpace
  drafts: Partial<Record<StorageSpace, FileDraft & { editingId?: string }>>
  ringAuthFlow?: RingAuthFlow
  ringSignin: RingSigninState
  session?: Session
  stopEventStream?: () => Promise<void>
  eventStreamEvents: AppEvent[]
}

const state: State = {
  revision: 0,
  accounts: [],
  logoutPending: false,
  eventStreamEvents: [],
  files: [],
  uploads: [],
  space: 'public',
  drafts: {},
  ringSignin: {},
}

let app: HTMLElement
let toolsPanel: ReturnType<typeof createStorageTools> | undefined
let activeOperation: symbol | undefined

export function start(root: HTMLElement) {
  app = root
  app.addEventListener('click', handleClick)
  app.addEventListener('submit', handleSubmit)
  app.addEventListener('change', (event) => {
    const input = event.target
    if (input instanceof HTMLInputElement && input.name === 'write-mode') syncControls()
  })
  subscribeSavedSessionChanges((change) => {
    if (change.type === 'accounts') {
      void refreshSavedAccounts()
      return
    }
    resetWorkspace()
    setNotice(
      change.type === 'invalidated'
        ? 'This session was signed out or removed in another tab.'
        : 'Account selection changed in another tab.',
    )
    mount()
    void init()
  })
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      state.ringAuthFlow = undefined
      resetWorkspace()
      mount()
      void init()
    }
  })
  window.addEventListener('pagehide', () => {
    state.ringAuthFlow?.suspend()
    toolsPanel?.dispose()
    void stopEventStream()
    void stopEventHistory()
    void releaseEditorLock()
  })
  mount()
  void init()
}

async function init() {
  const revision = state.revision
  await run('Restoring session...', async () => {
    await refreshSavedAccounts()
    const session = await restoreSavedSession()
    if (state.revision !== revision) return
    if (session) {
      await activateSession(session, 'Session restored.')
    }
  })

  if (state.revision === revision && !state.session) await refreshRingSignin(Boolean(state.error))
}

function mount() {
  toolsPanel?.dispose()
  const session = state.session

  app.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <h1>Pubky App Template</h1>
        ${session ? signedInHeader(session) : ''}
      </header>
      <div id="status">${statusHtml()}</div>
      <div id="saved-accounts">${savedAccountsHtml()}</div>
      <div id="view">${session ? signedInViewHtml() : authViewHtml(state.ringSignin, state.busy) + storageToolsPanelHtml()}</div>
      <footer class="app-footer">Built with <a href="https://www.npmjs.com/package/@synonymdev/pubky">Pubky SDK</a> v${pubkySdkVersion}</footer>
    </main>
  `

  mountStorageTools()
  void renderRingSigninQr(state.ringSignin)
  syncControls()
}

function signedInHeader(session: Session) {
  return `
    <div class="user-block">
      <div class="account-actions">
        <button id="sign-out" type="button" ${disabledAttr(Boolean(state.busy))}>${state.logoutPending ? 'Retry sign out' : 'Sign out'}</button>
        <button id="add-account" type="button" ${disabledAttr(Boolean(state.busy))}>Add account</button>
      </div>
      <p class="pubky-id">${escapeHtml(session.info.publicKey.toString())}</p>
    </div>
  `
}

function signedInViewHtml() {
  if (state.logoutPending)
    return '<p>Sign-out is pending. Retry to finish revoking this session before making more requests.</p>'
  return `
    ${storageSpacesHtml(state.space, state.busy)}
    <section class="grid">
      ${editorPanelHtml(state.files, state.editingId, state.space, state.busy, state.drafts[state.space], state.fileLock)}
      ${filesPanelHtml(state.files, state.space, state.busy, state.uploads)}
      ${eventStreamPanelHtml(state.eventStreamEvents, Boolean(state.stopEventStream), state.space, state.busy)}
    </section>
    ${storageToolsPanelHtml()}
  `
}

function renderWorkspace() {
  toolsPanel?.dispose()
  const view = app.querySelector('#view')
  if (view) view.innerHTML = signedInViewHtml()
  mountStorageTools()
  syncControls()
}

function statusHtml() {
  if (state.busy) {
    return state.quietBusy ? '' : `<p class="status">${escapeHtml(state.busy)}</p>`
  }
  if (state.error) return `<p class="status error">${escapeHtml(state.error)}</p>`
  if (state.notice) return `<p class="status">${statusMessage(state.notice, state.noticePath)}</p>`
  return ''
}

function updateStatus() {
  const status = app.querySelector('#status')
  if (!status) return
  status.innerHTML = statusHtml()
}

function canUseAuthorizationUrl() {
  const { authorizationUrl, expired, loading } = state.ringSignin
  return !state.busy && Boolean(authorizationUrl) && !loading && !expired
}

function syncControls() {
  const busy = Boolean(state.busy)
  const loading = Boolean(state.ringSignin.loading)
  const canUse = canUseAuthorizationUrl()
  const canAccess = !state.session || hasStorageAccess(state.session, state.space)
  const writeMode = app.querySelector<HTMLInputElement>(
    '#file-form input[name="write-mode"]:checked',
  )?.value

  for (const button of app.querySelectorAll('button')) {
    if (button.closest('#storage-tools')) continue
    if (button.dataset.accountId) {
      button.disabled = busy || button.dataset.accountId === getSavedSessionId()
      continue
    }
    if (button.type === 'submit' && button.closest('#file-form')) {
      button.disabled =
        busy ||
        !canAccess ||
        !['note', 'file'].includes(writeMode ?? '') ||
        (writeMode === 'note' && Boolean(state.editingId && !state.fileLock))
      continue
    }
    switch (button.id) {
      case 'refresh-ring-signin':
        button.disabled = busy || loading
        break
      case 'copy-authorization-url':
        button.disabled = !canUse
        break
      default:
        button.disabled = busy || (!canAccess && Boolean(button.closest('.grid')))
        break
    }
  }

  for (const fields of app.querySelectorAll<HTMLFieldSetElement>('#file-form fieldset')) {
    fields.hidden = Boolean(fields.dataset.writeMode && fields.dataset.writeMode !== writeMode)
    fields.disabled = busy || !canAccess || fields.hidden
  }
  for (const input of app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    '#file-form input, #file-form textarea',
  )) {
    const fields = input.closest<HTMLFieldSetElement>('fieldset[data-write-mode]')
    input.disabled = busy || !canAccess || Boolean(fields?.hidden)
  }
  const fileInput = app.querySelector<HTMLInputElement>('#file-form input[name="file"]')
  if (fileInput) fileInput.required = writeMode === 'file'

  updateAuthorizeLink(canUse, state.ringSignin.authorizationUrl)
}

function handleClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  if (isAuthorizeRingLink(target)) {
    if (!canUseAuthorizationUrl()) event.preventDefault()
    return
  }

  const button = target.closest<HTMLButtonElement>('button')
  if (!button || state.busy || button.closest('#storage-tools')) return
  if (button.dataset.accountId) {
    void switchAccount(button.dataset.accountId)
    return
  }
  if (state.logoutPending && !['sign-out', 'add-account'].includes(button.id)) return

  const space = button.dataset.storageSpace
  if (space === 'public' || space === 'private') {
    if (space !== state.space) void switchStorageSpace(space)
    return
  }

  if (button.dataset.editId) {
    void editFile(button.dataset.editId)
    return
  }
  if (button.dataset.downloadId) {
    const id = button.dataset.downloadId
    const revision = state.revision
    void run('Downloading file...', async () => {
      await downloadFile(requireSession(), state.space, id, () => state.revision === revision)
    })
    return
  }
  if (button.dataset.copyId) {
    const id = button.dataset.copyId
    void run('Copying public address...', async () => {
      await copyTextToClipboard(publicFileAddress(requireSession(), id))
      setNotice('Public address copied.')
    })
    return
  }

  if (button.dataset.deleteId) {
    void handleDeleteFile(button.dataset.deleteId)
    return
  }

  if (button.dataset.uploadName && button.dataset.uploadAction) {
    void handleUploadedFileAction(button.dataset.uploadName, button.dataset.uploadAction)
    return
  }

  switch (button.id) {
    case 'refresh-ring-signin':
      void refreshRingSignin(false, true)
      break
    case 'copy-authorization-url':
      void handleCopyAuthorizationUrl()
      break
    case 'sign-out':
      void handleSignOut()
      break
    case 'add-account':
      deselectSavedAccount()
      resetWorkspace()
      mount()
      void refreshRingSignin()
      break
    case 'renew-file-lock':
      void renewEditorLock()
      break
    case 'release-file-lock':
      void run('Releasing file lock...', async () => {
        await releaseEditorLock()
        updateEditor(
          state.files,
          state.editingId,
          state.space,
          state.busy,
          state.drafts[state.space],
          state.fileLock,
        )
      })
      break
    case 'load-event-history':
      void loadEventHistory()
      break
    case 'new-file':
      void releaseEditorLock()
      state.editingId = undefined
      delete state.drafts[state.space]
      selectNoteMode()
      updateEditor(state.files, state.editingId, state.space, state.busy)
      syncControls()
      break
    case 'toggle-event-stream':
      void toggleEventStream()
      break
    default:
      break
  }
}

function handleSubmit(event: SubmitEvent) {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return

  event.preventDefault()
  if (state.busy || form.closest('#storage-tools') || state.logoutPending) return
  if (form.id === 'development-signup-form') void handleDevelopmentSignup(form)
  if (form.id === 'file-form') {
    const mode = new FormData(form).get('write-mode')
    if (mode === 'note') void handleSaveFile(form)
    else if (mode === 'file') void handleUploadFile(form)
  }
}

async function refreshRingSignin(preserveError = false, fresh = false) {
  const token = Symbol('ring-signin')
  cancelRingSignin()

  state.ringSignin = {
    loading: true,
    token,
  }
  if (!preserveError) state.error = undefined
  updateStatus()
  updateRingPanel(state.ringSignin, state.busy)
  syncControls()

  try {
    const flow = await startRingAuthFlow({ fresh })
    if (!isActiveRingSignin(token)) {
      flow.cancel()
      return
    }
    state.ringAuthFlow = flow

    state.ringSignin = {
      authorizationUrl: flow.authorizationUrl,
      token,
    }
    updateRingPanel(state.ringSignin, state.busy)
    syncControls()

    void handleRingApproval(flow, token)
  } catch (error) {
    if (!isActiveRingSignin(token)) return

    state.ringAuthFlow = undefined
    state.ringSignin = {}
    setError(error)
    updateStatus()
    updateRingPanel(state.ringSignin, state.busy)
    syncControls()
  }
}

async function handleRingApproval(flow: RingAuthFlow, token: symbol) {
  try {
    const session = await flow.awaitApproval
    if (!isActiveRingSignin(token)) return

    state.ringAuthFlow = undefined
    const revision = state.revision
    await run('Completing Pubky Ring sign-in...', async () => {
      await saveSession(session, () => state.revision === revision)
      if (state.revision !== revision) return
      await activateSession(session, 'Signed in with Pubky Ring.')
    })
  } catch (error) {
    if (isRingAuthCanceled(error) || !isActiveRingSignin(token)) return

    state.ringAuthFlow = undefined
    state.ringSignin = isRingAuthExpired(error) ? { expired: true, token } : {}
    setError(error)
    updateStatus()
    updateRingPanel(state.ringSignin, state.busy)
    syncControls()
  }
}

async function handleCopyAuthorizationUrl() {
  const authorizationUrl = state.ringSignin.authorizationUrl
  if (!authorizationUrl || state.ringSignin.expired) return

  try {
    await copyTextToClipboard(authorizationUrl)
    state.ringSignin.copied = true
    setNotice('Authorization URL copied.')
    updateStatus()
    updateCopyButton(true)

    window.setTimeout(() => {
      if (state.ringSignin.authorizationUrl !== authorizationUrl) return
      state.ringSignin.copied = false
      updateCopyButton(false)
    }, 2200)
  } catch (error) {
    setError(error)
    updateStatus()
  }
}

async function handleDevelopmentSignup(form: HTMLFormElement) {
  const formData = new FormData(form)
  const homeserver = formValue(formData, 'homeserver')

  const revision = state.revision
  await run('Creating identity...', async () => {
    const session = await signupDevelopmentUser(homeserver)
    if (state.revision !== revision) return
    await saveSession(session, () => state.revision === revision)
    if (state.revision !== revision) return
    await activateSession(session, 'Identity created and signed in.')
  })
}

async function handleSaveFile(form: HTMLFormElement) {
  const session = requireSession()
  const space = state.space
  const formData = new FormData(form)
  const title = formValue(formData, 'title')
  const body = formValue(formData, 'body')
  const revision = state.revision
  const editingId = state.editingId

  await run('Saving file...', async () => {
    requireStorageAccess(session, space)
    const file = await saveFile(
      session,
      space,
      {
        id: editingId,
        title,
        body,
      },
      state.fileLock,
    )
    if (state.revision !== revision) return
    await releaseEditorLock()
    if (state.revision !== revision) return
    state.editingId = state.editingId ? file.id : undefined
    delete state.drafts[space]
    setNotice('File saved:', filePath(space, file.id))
    await refreshFiles()
    if (state.revision !== revision) return
    updateFilesList(state.files, space, state.busy, state.uploads)
    updateEditor(state.files, state.editingId, space, state.busy, undefined, state.fileLock)
  })
}

async function handleDeleteFile(id: string) {
  const session = requireSession()
  const space = state.space
  captureDraft()
  const revision = state.revision

  await run('Deleting file...', async () => {
    requireStorageAccess(session, space)
    await deleteFile(session, space, id, state.fileLock?.id === id ? state.fileLock : undefined)
    if (state.revision !== revision) return
    if (state.editingId === id) {
      await releaseEditorLock()
      if (state.revision !== revision) return
      state.editingId = undefined
      delete state.drafts[space]
    }
    setNotice('File deleted:', filePath(space, id))
    await refreshFiles()
    if (state.revision !== revision) return
    updateFilesList(state.files, space, state.busy, state.uploads)
    updateEditor(
      state.files,
      state.editingId,
      space,
      state.busy,
      state.drafts[space],
      state.fileLock,
    )
  })
}

async function handleUploadFile(form: HTMLFormElement) {
  const session = requireSession()
  const space = state.space
  const revision = state.revision
  const file = new FormData(form).get('file')
  if (!(file instanceof File) || !file.name) return
  const isCurrent = () =>
    state.revision === revision && state.session === session && state.space === space

  await run('Uploading file...', async () => {
    const name = await uploadFileBytes(session, space, file, isCurrent)
    if (!isCurrent()) return
    const fileInput = form.querySelector<HTMLInputElement>('input[name="file"]')
    if (fileInput) fileInput.value = ''
    setNotice('File uploaded:', uploadedFilePath(space, name))
    await refreshFiles()
    if (isCurrent()) updateFilesList(state.files, space, state.busy, state.uploads)
  })
}

async function handleUploadedFileAction(name: string, action: string) {
  const session = requireSession()
  const space = state.space
  const revision = state.revision
  const isCurrent = () =>
    state.revision === revision && state.session === session && state.space === space

  await run('Working with file...', async () => {
    requireStorageAccess(session, space)
    if (action === 'download') {
      const bytes = await readUploadedFile(session, space, name, isCurrent)
      if (!isCurrent()) return
      downloadBytes(bytes, name)
      setNotice('File downloaded.')
    } else if (action === 'delete') {
      await deleteUploadedFile(session, space, name)
      if (!isCurrent()) return
      setNotice('File deleted:', uploadedFilePath(space, name))
      await refreshFiles()
      if (isCurrent()) updateFilesList(state.files, space, state.busy, state.uploads)
    } else if (action === 'copy' && space === 'public') {
      await copyTextToClipboard(publicUploadedFileAddress(session, name))
      if (isCurrent()) setNotice('Public address copied.')
    }
  })
}

async function handleSignOut() {
  const session = state.session
  if (!session) return
  state.logoutPending = true
  toolsPanel?.dispose()
  state.files = []
  state.uploads = []
  state.drafts = {}
  state.eventStreamEvents = []
  mount()
  await run('Signing out...', async () => {
    await stopEventStream()
    await stopEventHistory()
    await releaseEditorLock()
    if (state.session !== session) return
    await signOut(session)
    if (state.session !== session) return
    resetWorkspace()
    setNotice('Signed out.')
    mount()
    await init()
  })
}

async function toggleEventStream() {
  if (state.stopEventStream) {
    await run('Stopping event stream...', async () => {
      await stopEventStream()
      setNotice('Event stream stopped.')
    })
    updateEventStreamToggle(false)
    return
  }

  await run('Starting event stream...', async () => {
    await connectEventStream()
    if (state.session) setNotice('Event stream started.')
  })
  updateEventStreamToggle(Boolean(state.stopEventStream))
}

async function connectEventStream() {
  const session = requireSession()
  const space = state.space
  const revision = state.revision
  requireStorageAccess(session, space)
  let eventStream: AppEventStream | undefined = undefined
  eventStream = await startAppEventStream(
    session,
    space,
    (event) => {
      if (state.revision !== revision || state.space !== space || state.session !== session) return
      // Buffered events can arrive before the subscription handle is returned.
      if (eventStream && state.stopEventStream !== eventStream.stop) return
      state.eventCursor = event.cursor
      state.eventStreamEvents = [
        event,
        ...state.eventStreamEvents.filter((item) => item.cursor !== event.cursor),
      ].slice(0, EVENT_HISTORY_LIMIT)
      updateEventList(state.eventStreamEvents)
    },
    state.eventCursor,
  )
  if (state.revision !== revision || state.session !== session || state.space !== space) {
    await eventStream.stop()
    return
  }
  state.stopEventStream = eventStream.stop
  watchEventStream(eventStream)
  updateEventStreamToggle(true)
}

function captureDraft() {
  const form = app.querySelector<HTMLFormElement>('#file-form')
  if (!form) return
  state.drafts[state.space] = {
    editingId: state.editingId,
    // Read values directly: inactive note fields are deliberately omitted from FormData.
    title: form.querySelector<HTMLInputElement>('input[name="title"]')?.value ?? '',
    body: form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? '',
  }
}

async function switchStorageSpace(space: StorageSpace) {
  const revision = state.revision
  captureDraft()
  await run(
    `Opening ${space} files...`,
    async () => {
      const wasStreaming = Boolean(state.stopEventStream)
      await stopEventStream()
      await stopEventHistory()
      await releaseEditorLock()
      if (state.revision !== revision) return
      state.space = space
      state.files = []
      state.uploads = []
      state.editingId = state.drafts[space]?.editingId
      state.eventStreamEvents = []
      state.eventCursor = undefined
      setNotice('')
      renderWorkspace()
      await refreshFiles()
      if (state.revision !== revision) return
      renderWorkspace()
      if (wasStreaming) await connectEventStream()
    },
    { quiet: true },
  )
}

function watchEventStream(eventStream: AppEventStream) {
  void eventStream.done.then(
    () => finishEventStream(eventStream),
    (error: unknown) => finishEventStream(eventStream, error),
  )
}

function finishEventStream(eventStream: AppEventStream, error?: unknown) {
  if (state.stopEventStream !== eventStream.stop) return

  state.stopEventStream = undefined
  if (error) setError(error)
  else setNotice('Event stream ended.')
  updateStatus()
  updateEventStreamToggle(false)
  syncControls()
}

async function stopEventStream() {
  const stop = state.stopEventStream
  state.stopEventStream = undefined
  if (stop) await stop().catch(() => undefined)
}

async function refreshFiles() {
  const session = state.session
  if (!session) return

  requireStorageAccess(session, state.space)
  const space = state.space
  const revision = state.revision
  const isCurrent = () =>
    state.revision === revision && state.session === session && state.space === space
  const [files, uploads] = await Promise.all([
    listFiles(session, space),
    listUploadedFiles(session, space, isCurrent),
  ])
  if (isCurrent()) {
    state.files = files
    state.uploads = uploads
  }
}

async function activateSession(session: Session, notice: string) {
  cancelRingSignin()
  state.ringSignin = {}
  state.session = session
  state.space = 'public'
  state.drafts = {}
  state.files = []
  state.uploads = []
  state.editingId = undefined
  state.logoutPending = false
  const revision = state.revision
  await refreshSavedAccounts()
  if (state.revision !== revision || state.session !== session) return
  setNotice(notice)
  await refreshFiles()
}

function cancelRingSignin() {
  const flow = state.ringAuthFlow
  state.ringAuthFlow = undefined
  state.ringSignin = {}
  flow?.cancel()
}

function isActiveRingSignin(token: symbol) {
  return state.ringSignin.token === token
}

function setNotice(notice: string, path?: string) {
  state.error = undefined
  state.notice = notice
  state.noticePath = path
}

function setError(error: unknown) {
  state.error = formatError(error)
  state.notice = undefined
  state.noticePath = undefined
}

async function run(label: string, task: () => Promise<void>, options: { quiet?: boolean } = {}) {
  const previousSession = state.session
  const token = Symbol(label)
  activeOperation = token
  state.busy = label
  state.quietBusy = options.quiet
  state.error = undefined
  updateStatus()
  syncControls()

  try {
    await task()
  } catch (error) {
    if (activeOperation !== token) return
    setError(error)
  }
  if (activeOperation !== token) return
  activeOperation = undefined
  state.busy = undefined
  state.quietBusy = undefined

  if (state.session !== previousSession) {
    mount()
    return
  }

  updateStatus()
  syncControls()
}

function requireSession() {
  if (!state.session || state.logoutPending) throw new Error('No active Pubky session')
  return state.session
}

function savedAccountsHtml() {
  if (!state.accounts.length) return ''
  const selected = getSavedSessionId()
  if (state.session && state.accounts.length === 1 && state.accounts[0]?.id === selected) return ''
  return `<nav aria-label="Saved accounts"><p>Saved accounts on this browser:</p>${state.accounts
    .map(
      (account) =>
        `<button type="button" data-account-id="${escapeHtml(account.id)}" ${disabledAttr(account.id === selected || Boolean(state.busy))}>${escapeHtml(account.publicKey)}${account.id === selected ? ' (active)' : ''}</button>`,
    )
    .join('')}</nav>`
}

async function refreshSavedAccounts() {
  const revision = state.revision
  const accounts = await listSavedAccounts()
  if (state.revision !== revision) return
  state.accounts = accounts
  const container = app.querySelector('#saved-accounts')
  if (container) container.innerHTML = savedAccountsHtml()
}

function mountStorageTools() {
  const container = app.querySelector<HTMLElement>('#storage-tools')
  toolsPanel = container ? createStorageTools(container) : undefined
}

function resetWorkspace() {
  state.revision += 1
  activeOperation = undefined
  state.busy = undefined
  state.quietBusy = undefined
  cancelRingSignin()
  toolsPanel?.dispose()
  void stopEventStream()
  void stopEventHistory()
  void releaseEditorLock()
  state.session = undefined
  state.logoutPending = false
  state.files = []
  state.uploads = []
  state.editingId = undefined
  state.drafts = {}
  state.space = 'public'
  state.eventStreamEvents = []
  state.eventCursor = undefined
}

async function switchAccount(id: string) {
  resetWorkspace()
  mount()
  const revision = state.revision
  await run('Switching account...', async () => {
    const session = await selectSavedAccount(id, () => state.revision === revision)
    if (state.revision !== revision) return
    if (!session)
      throw new Error('This saved session is no longer valid. Sign in again with Pubky Ring.')
    await activateSession(session, 'Account selected.')
  })
  if (state.revision === revision && !state.session) await refreshRingSignin(Boolean(state.error))
}

async function releaseEditorLock() {
  const lock = state.fileLock
  state.fileLock = undefined
  if (lock) {
    try {
      await releaseFileLock(lock)
    } catch {
      // A lost response or expired/revoked session can prevent explicit unlock.
      // Server locks have a bounded lease and expire without a browser heartbeat.
    }
  }
}

async function editFile(id: string) {
  const session = requireSession()
  const space = state.space
  const revision = state.revision
  await run('Locking file for editing...', async () => {
    await releaseEditorLock()
    if (state.revision !== revision) return
    const { file, lock } = await acquireFileLock(session, space, id)
    if (state.revision !== revision || state.space !== space || state.session !== session) {
      await releaseFileLock(lock)
      return
    }
    state.fileLock = lock
    state.files = state.files.map((existing) => (existing.id === id ? file : existing))
    state.editingId = id
    delete state.drafts[space]
    selectNoteMode()
    updateEditor(state.files, id, space, state.busy, undefined, lock)
    setNotice('File locked. Save before the lease expires, or renew the lock.')
  })
}

function selectNoteMode() {
  const option = app.querySelector<HTMLInputElement>(
    '#file-form input[name="write-mode"][value="note"]',
  )
  if (option) option.checked = true
}

async function renewEditorLock() {
  const session = requireSession()
  const lock = state.fileLock
  if (!lock) return
  const revision = state.revision
  captureDraft()
  await run('Renewing file lock...', async () => {
    await renewFileLock(session, state.space, lock.id, lock)
    if (state.revision !== revision || state.fileLock !== lock) return
    updateEditor(
      state.files,
      state.editingId,
      state.space,
      state.busy,
      state.drafts[state.space],
      lock,
    )
    setNotice('File lock renewed.')
  })
}

async function stopEventHistory() {
  const stop = state.stopEventHistory
  state.stopEventHistory = undefined
  if (stop) await stop().catch(() => undefined)
}

async function loadEventHistory() {
  const session = requireSession()
  const space = state.space
  const revision = state.revision
  await run('Loading recent events...', async () => {
    await stopEventStream()
    await stopEventHistory()
    if (state.revision !== revision) return
    state.eventStreamEvents = []
    const events: AppEvent[] = []
    let stream: AppEventStream | undefined = undefined
    stream = await startAppEventHistory(session, space, (event) => {
      if (state.revision !== revision || state.session !== session || state.space !== space) return
      if (stream && state.stopEventHistory !== stream.stop) return
      events.push(event)
      state.eventStreamEvents = [...events]
      if (events.length === 1) state.eventCursor = event.cursor
      updateEventList(state.eventStreamEvents)
    })
    if (state.revision !== revision || state.session !== session) {
      await stream.stop()
      return
    }
    state.stopEventHistory = stream.stop
    try {
      await stream.done
    } finally {
      if (state.stopEventHistory === stream.stop) state.stopEventHistory = undefined
    }
    if (state.revision !== revision) return
    setNotice(
      `Loaded ${events.length} recent events. Start live to continue from the newest event.`,
    )
    updateEventStreamToggle(false)
  })
}
