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
import { editorPanelHtml, filesPanelHtml, updateEditor, updateFilesList } from './files-ui'
import { captureFileDraft, reconcileFileDraft, type FileDraft } from './file-drafts'
import { storageSpacesHtml } from './spaces-ui'
import { createRingAuthAttempt, type RingAuthAttempt } from './ring-auth-lifecycle'
import {
  copyTextToClipboard,
  disabledAttr,
  escapeHtml,
  formValue,
  formatError,
  statusMessage,
} from './html'
import {
  discardSession,
  getSavedSessionId,
  getSessionId,
  hasPendingSessionCleanup,
  subscribeSavedSessionChanges,
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
  drafts: Partial<Record<StorageSpace, FileDraft>>
  ringAuthFlow?: RingAuthFlow
  ringSignin: RingSigninState
  session?: Session
  stopEventStream?: () => Promise<void>
  eventStreamEvents: AppEvent[]
}

const state: State = {
  revision: 0,
  logoutPending: false,
  eventStreamEvents: [],
  files: [],
  uploads: [],
  space: 'public',
  drafts: {},
  ringSignin: {},
}

let app: HTMLElement
let activeOperation: symbol | undefined
let ringAttempt: RingAuthAttempt | undefined
let pageSuspended = false
let suspendedDrafts: { sessionId: string; space: StorageSpace; drafts: State['drafts'] } | undefined

export function start(root: HTMLElement) {
  app = root
  app.addEventListener('click', handleClick)
  app.addEventListener('submit', handleSubmit)
  app.addEventListener('change', (event) => {
    const input = event.target
    if (input instanceof HTMLInputElement && input.name === 'write-mode') syncControls()
  })
  subscribeSavedSessionChanges((change) => {
    // pageshow validates the saved session before unblocking a cached waiter.
    if (pageSuspended) return
    resetWorkspace()
    setNotice(
      change.type === 'invalidated'
        ? 'This session was signed out or removed.'
        : 'Session changed in another tab.',
    )
    mount()
    void init()
  })
  window.addEventListener('pageshow', (event) => {
    pageSuspended = false
    const drafts = suspendedDrafts
    suspendedDrafts = undefined
    if (event.persisted) {
      if (ringAttempt?.isCurrent()) {
        ringAttempt.resume()
        return
      }
      resetWorkspace()
      mount()
      void init(drafts)
    }
  })
  window.addEventListener('pagehide', (event) => {
    pageSuspended = true
    captureDraft()
    const sessionId =
      state.session && !state.logoutPending ? getSessionId(state.session) : undefined
    suspendedDrafts =
      event.persisted && sessionId
        ? { sessionId, space: state.space, drafts: { ...state.drafts } }
        : undefined
    if (event.persisted) {
      ringAttempt?.pause()
    } else {
      ringAttempt?.cancel()
      state.ringAuthFlow?.suspend()
    }
    void stopEventStream()
    void stopEventHistory()
    void releaseEditorLock()
  })
  mount()
  void init()
}

async function init(drafts?: typeof suspendedDrafts) {
  const revision = state.revision
  await run('Restoring session...', async () => {
    const session = await restoreSavedSession()
    if (state.revision !== revision) return
    if (session) {
      const sessionId = getSessionId(session)
      if (sessionId !== getSavedSessionId()) return
      // Cached text belongs to the exact saved session, never a new sign-in.
      await activateSession(
        session,
        'Session restored.',
        drafts?.sessionId === sessionId ? drafts : undefined,
      )
    }
  })

  if (state.revision !== revision || state.session) return
  mount()
  if (!needsSessionRecovery()) await refreshRingSignin(Boolean(state.error))
}

function needsSessionRecovery() {
  return Boolean(getSavedSessionId()) || hasPendingSessionCleanup()
}

function mount() {
  const session = state.session

  app.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <div>
          <h1>Pubky App Template</h1>
          <nav class="page-nav" aria-label="Pages">
            <strong aria-current="page">Your files</strong> · <a href="./public-reader.html">Public file reader</a>
          </nav>
        </div>
        ${session ? signedInHeader(session) : ''}
      </header>
      <div id="status">${statusHtml()}</div>
      <div id="view">${session ? signedInViewHtml() : authViewHtml(state.ringSignin, state.busy, needsSessionRecovery())}</div>
      <footer class="app-footer">Built with <a href="https://www.npmjs.com/package/@synonymdev/pubky">Pubky SDK</a> v${pubkySdkVersion}</footer>
    </main>
  `

  void renderRingSigninQr(state.ringSignin)
  syncControls()
}

function signedInHeader(session: Session) {
  return `
    <div class="user-block">
      <button id="sign-out" type="button" ${disabledAttr(Boolean(state.busy))}>${state.logoutPending ? 'Retry sign out' : 'Sign out'}</button>
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
  `
}

function renderWorkspace() {
  const view = app.querySelector('#view')
  if (view) view.innerHTML = signedInViewHtml()
  syncControls()
}

function statusHtml() {
  if (state.busy) {
    return state.quietBusy ? '' : `<p class="status">${escapeHtml(state.busy)}</p>`
  }
  return `
    ${state.notice ? `<p class="status">${statusMessage(state.notice, state.noticePath)}</p>` : ''}
    ${state.error ? `<p class="status error">${escapeHtml(state.error)}</p>` : ''}
  `
}

function updateStatus() {
  const status = app.querySelector('#status')
  if (!status) return
  status.innerHTML = statusHtml()
}

function canUseAuthorizationUrl() {
  const { authorizationUrl, expired, loading } = state.ringSignin
  return (
    !state.session &&
    !needsSessionRecovery() &&
    !state.busy &&
    Boolean(authorizationUrl) &&
    !loading &&
    !expired
  )
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
  if (!button || state.busy) return
  if (state.logoutPending && button.id !== 'sign-out') return

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
    case 'retry-saved-session':
      void init()
      break
    case 'refresh-ring-signin':
      void refreshRingSignin(false, true)
      break
    case 'copy-authorization-url':
      void handleCopyAuthorizationUrl()
      break
    case 'sign-out':
      void handleSignOut()
      break
    case 'renew-file-lock':
      void renewEditorLock()
      break
    case 'release-file-lock':
      captureDraft()
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
  if (state.busy || state.logoutPending) return
  if (form.id === 'development-signup-form') void handleDevelopmentSignup(form)
  if (form.id === 'file-form') {
    const mode = new FormData(form).get('write-mode')
    if (mode === 'note') void handleSaveFile(form)
    else if (mode === 'file') void handleUploadFile(form)
  }
}

async function refreshRingSignin(preserveError = false, fresh = false) {
  if (state.session || needsSessionRecovery()) return
  const token = Symbol('ring-signin')
  cancelRingSignin()

  state.ringSignin = {
    loading: true,
    token,
  }
  const attempt = createRingAuthAttempt(getSavedSessionId, () => isActiveRingSignin(token))
  if (pageSuspended) attempt.pause()
  ringAttempt = attempt
  if (!preserveError) state.error = undefined
  updateStatus()
  updateRingPanel(state.ringSignin, state.busy)
  syncControls()

  try {
    const flow = await startRingAuthFlow({ fresh }, attempt.isCurrent)
    if (!attempt.isCurrent()) {
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

    void handleRingApproval(flow, token, attempt)
  } catch (error) {
    if (!(await attempt.waitUntilVisible())) return

    state.ringAuthFlow = undefined
    state.ringSignin = {}
    setError(error)
    updateStatus()
    updateRingPanel(state.ringSignin, state.busy)
    syncControls()
  }
}

async function handleRingApproval(flow: RingAuthFlow, token: symbol, attempt: RingAuthAttempt) {
  try {
    const session = await flow.awaitApproval
    if (!(await attempt.waitUntilVisible())) {
      await discardSession(session)
      return
    }

    state.ringAuthFlow = undefined
    const revision = state.revision
    await run('Completing Pubky Ring sign-in...', async () => {
      let selected: boolean
      try {
        selected = await saveSession(
          session,
          () => state.revision === revision && attempt.isCurrent(),
          attempt.waitUntilVisible,
        )
      } catch (error) {
        if (await attempt.waitUntilVisible()) throw error
        return
      }
      if (!selected || state.revision !== revision || !isActiveRingSignin(token)) return
      await activateSession(session, 'Signed in with Pubky Ring.')
    })
  } catch (error) {
    if (isRingAuthCanceled(error) || !(await attempt.waitUntilVisible())) return

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
  if (state.session || needsSessionRecovery()) return
  const formData = new FormData(form)
  const homeserver = formValue(formData, 'homeserver')

  const revision = state.revision
  await run('Creating identity...', async () => {
    const session = await signupDevelopmentUser(homeserver)
    const isCurrent = () => state.revision === revision && !getSavedSessionId()
    if (!(await saveSession(session, isCurrent))) return
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
    // The editor's baseline must stay tied to its text, even if refresh sees a newer write.
    state.drafts[space] = state.editingId ? reconcileFileDraft(file).draft : undefined
    state.files = [file, ...state.files.filter((existing) => existing.id !== file.id)]
    setNotice('File saved:', filePath(space, file.id))
    updateEditor(state.files, state.editingId, space, state.busy, undefined, state.fileLock)
    await refreshFileListAfterWrite()
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
    state.files = state.files.filter((file) => file.id !== id)
    setNotice('File deleted:', filePath(space, id))
    updateEditor(
      state.files,
      state.editingId,
      space,
      state.busy,
      state.drafts[space],
      state.fileLock,
    )
    await refreshFileListAfterWrite()
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
    state.uploads = [...state.uploads, { name }]
    setNotice('File uploaded:', uploadedFilePath(space, name))
    await refreshFileListAfterWrite()
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
      state.uploads = state.uploads.filter((file) => file.name !== name)
      setNotice('File deleted:', uploadedFilePath(space, name))
      await refreshFileListAfterWrite()
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
  const eventStream = startAppEventStream(
    session,
    space,
    (event) => {
      if (state.revision !== revision || state.space !== space || state.session !== session) return
      if (state.stopEventStream !== eventStream.stop) return
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
  state.drafts[state.space] = captureFileDraft(
    {
      editingId: state.editingId,
      // Read values directly: inactive note fields are deliberately omitted from FormData.
      title: form.querySelector<HTMLInputElement>('input[name="title"]')?.value ?? '',
      body: form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? '',
    },
    state.files.find((file) => file.id === state.editingId),
    state.drafts[state.space],
  )
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

/** A completed write stays successful even if refreshing the list fails. */
async function refreshFileListAfterWrite() {
  const revision = state.revision
  updateFilesList(state.files, state.space, state.busy, state.uploads)
  try {
    await refreshFiles()
    if (state.revision === revision) {
      updateFilesList(state.files, state.space, state.busy, state.uploads)
    }
  } catch (error) {
    if (state.revision === revision) {
      state.error = `Could not refresh the file list: ${formatError(error)}`
    }
  }
}

async function activateSession(session: Session, notice: string, drafts?: typeof suspendedDrafts) {
  cancelRingSignin()
  state.ringSignin = {}
  state.session = session
  state.space = drafts?.space ?? 'public'
  state.drafts = drafts?.drafts ?? {}
  state.files = []
  state.uploads = []
  state.editingId = state.drafts[state.space]?.editingId
  state.logoutPending = false
  setNotice(notice)
  await refreshFiles()
}

function cancelRingSignin() {
  const flow = state.ringAuthFlow
  state.ringAuthFlow = undefined
  state.ringSignin = {}
  ringAttempt?.cancel()
  ringAttempt = undefined
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
  const previousRecovery = needsSessionRecovery()
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

  if (state.session !== previousSession || needsSessionRecovery() !== previousRecovery) {
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

function resetWorkspace() {
  state.revision += 1
  activeOperation = undefined
  state.busy = undefined
  state.quietBusy = undefined
  cancelRingSignin()
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
  captureDraft()
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
    const { draft, conflict } = reconcileFileDraft(file, state.drafts[space])
    state.drafts[space] = draft
    if (conflict) {
      await releaseEditorLock()
      if (state.revision !== revision) return
    }
    selectNoteMode()
    updateEditor(state.files, id, space, state.busy, draft, state.fileLock)
    if (conflict) {
      throw new Error(
        'The file changed since you started editing. Your unsaved text is still here. Copy it first, then select New and reopen the file with Lock & edit to review the latest version.',
      )
    }
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
    updateEventStreamToggle(false)
    updateEventList(state.eventStreamEvents)
    const events: AppEvent[] = []
    const stream = startAppEventHistory(session, space, (event) => {
      if (state.revision !== revision || state.session !== session || state.space !== space) return
      if (state.stopEventHistory !== stream.stop) return
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
  })
}
