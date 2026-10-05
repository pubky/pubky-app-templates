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
import { startAppEventStream, type AppEvent, type AppEventStream } from './events'
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
  isRingAuthCanceled,
  isRingAuthExpired,
  restoreSavedSession,
  saveSession,
  signOut,
  signupDevelopmentUser,
  startRingAuthFlow,
  type RingAuthFlow,
} from './pubky'
import { deleteFile, filePath, listFiles, saveFile, type AppFile } from './storage'

interface State {
  busy?: string
  editingId?: string
  error?: string
  notice?: string
  noticePath?: string
  files: AppFile[]
  space: StorageSpace
  drafts: Partial<Record<StorageSpace, FileDraft & { editingId?: string }>>
  ringAuthFlow?: RingAuthFlow
  ringSignin: RingSigninState
  session?: Session
  stopEventStream?: () => Promise<void>
  eventStreamEvents: AppEvent[]
}

const state: State = {
  eventStreamEvents: [],
  files: [],
  space: 'public',
  drafts: {},
  ringSignin: {},
}

let app: HTMLElement

export function start(root: HTMLElement) {
  app = root
  app.addEventListener('click', handleClick)
  app.addEventListener('submit', handleSubmit)
  mount()
  void init()
}

async function init() {
  await run('Restoring session...', async () => {
    const session = await restoreSavedSession()
    if (session) {
      await activateSession(session, 'Session restored.')
    }
  })

  if (!state.session) await refreshRingSignin(Boolean(state.error))
}

function mount() {
  const session = state.session

  app.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <h1>Pubky App Template</h1>
        ${session ? signedInHeader(session) : ''}
      </header>
      <div id="status">${statusHtml()}</div>
      <div id="view">${session ? signedInViewHtml() : authViewHtml(state.ringSignin, state.busy)}</div>
      <footer class="app-footer">Built with <a href="https://www.npmjs.com/package/@synonymdev/pubky">Pubky SDK</a> v${pubkySdkVersion}</footer>
    </main>
  `

  void renderRingSigninQr(state.ringSignin)
  syncControls()
}

function signedInHeader(session: Session) {
  return `
    <div class="user-block">
      <button id="sign-out" type="button" ${disabledAttr(Boolean(state.busy))}>Sign out</button>
      <p class="pubky-id">${escapeHtml(session.info.publicKey.toString())}</p>
    </div>
  `
}

function signedInViewHtml() {
  return `
    ${storageSpacesHtml(state.space, state.busy)}
    <section class="grid">
      ${editorPanelHtml(state.files, state.editingId, state.space, state.busy, state.drafts[state.space])}
      ${filesPanelHtml(state.files, state.space, state.busy)}
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
  if (state.busy) return `<p class="status">${escapeHtml(state.busy)}</p>`
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

  for (const button of app.querySelectorAll('button')) {
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

  for (const input of app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    '#file-form input, #file-form textarea',
  )) {
    input.disabled = busy || !canAccess
  }

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

  const space = button.dataset.storageSpace
  if (space === 'public' || space === 'private') {
    if (space !== state.space) void switchStorageSpace(space)
    return
  }

  if (button.dataset.editId) {
    state.editingId = button.dataset.editId
    delete state.drafts[state.space]
    updateEditor(state.files, state.editingId, state.space, state.busy)
    return
  }

  if (button.dataset.deleteId) {
    void handleDeleteFile(button.dataset.deleteId)
    return
  }

  switch (button.id) {
    case 'refresh-ring-signin':
      void refreshRingSignin()
      break
    case 'copy-authorization-url':
      void handleCopyAuthorizationUrl()
      break
    case 'sign-out':
      void handleSignOut()
      break
    case 'new-file':
      state.editingId = undefined
      delete state.drafts[state.space]
      updateEditor(state.files, state.editingId, state.space, state.busy)
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
  if (state.busy) return
  if (form.id === 'development-signup-form') void handleDevelopmentSignup(form)
  if (form.id === 'file-form') void handleSaveFile(form)
}

async function refreshRingSignin(preserveError = false) {
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
    const flow = await startRingAuthFlow()
    state.ringAuthFlow = flow

    if (!isActiveRingSignin(token)) {
      flow.cancel()
      return
    }

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
    await run('Completing Pubky Ring sign-in...', async () => {
      await saveSession(session)
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

  await run('Creating identity...', async () => {
    const session = await signupDevelopmentUser(homeserver)
    await saveSession(session)
    await activateSession(session, 'Identity created and signed in.')
  })
}

async function handleSaveFile(form: HTMLFormElement) {
  const session = requireSession()
  const space = state.space
  const formData = new FormData(form)
  const title = formValue(formData, 'title')
  const body = formValue(formData, 'body')

  await run('Saving file...', async () => {
    requireStorageAccess(session, space)
    const file = await saveFile(session, space, {
      id: state.editingId,
      title,
      body,
    })
    state.editingId = state.editingId ? file.id : undefined
    delete state.drafts[space]
    setNotice('File saved:', filePath(space, file.id))
    await refreshFiles()
    updateFilesList(state.files, space, state.busy)
    updateEditor(state.files, state.editingId, space, state.busy)
  })
}

async function handleDeleteFile(id: string) {
  const session = requireSession()
  const space = state.space
  captureDraft()

  await run('Deleting file...', async () => {
    requireStorageAccess(session, space)
    await deleteFile(session, space, id)
    if (state.editingId === id) {
      state.editingId = undefined
      delete state.drafts[space]
    }
    setNotice('File deleted:', filePath(space, id))
    await refreshFiles()
    updateFilesList(state.files, space, state.busy)
    updateEditor(state.files, state.editingId, space, state.busy, state.drafts[space])
  })
}

async function handleSignOut() {
  const session = requireSession()

  await run('Signing out...', async () => {
    await stopEventStream()
    await signOut(session)
    state.session = undefined
    state.files = []
    state.editingId = undefined
    state.drafts = {}
    state.space = 'public'
    state.eventStreamEvents = []
    setNotice('Signed out.')
  })

  if (!state.session) await refreshRingSignin()
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
    setNotice('Event stream started.')
  })
  updateEventStreamToggle(Boolean(state.stopEventStream))
}

async function connectEventStream() {
  const session = requireSession()
  const space = state.space
  requireStorageAccess(session, space)
  let current: AppEventStream | undefined = undefined
  const eventStream = await startAppEventStream(session, space, (event) => {
    if (
      !current ||
      state.stopEventStream !== current.stop ||
      state.space !== space ||
      state.session !== session
    )
      return
    state.eventStreamEvents = [event, ...state.eventStreamEvents].slice(0, 12)
    updateEventList(state.eventStreamEvents)
  })
  current = eventStream
  state.stopEventStream = eventStream.stop
  watchEventStream(eventStream)
  updateEventStreamToggle(true)
}

function captureDraft() {
  const form = app.querySelector<HTMLFormElement>('#file-form')
  if (!form) return
  const data = new FormData(form)
  state.drafts[state.space] = {
    editingId: state.editingId,
    title: formValue(data, 'title'),
    body: formValue(data, 'body'),
  }
}

async function switchStorageSpace(space: StorageSpace) {
  captureDraft()
  await run(`Opening ${space} files...`, async () => {
    const wasStreaming = Boolean(state.stopEventStream)
    await stopEventStream()
    state.space = space
    state.files = []
    state.editingId = state.drafts[space]?.editingId
    state.eventStreamEvents = []
    setNotice('')
    renderWorkspace()
    await refreshFiles()
    renderWorkspace()
    if (wasStreaming) await connectEventStream()
  })
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
  if (stop) await stop()
}

async function refreshFiles() {
  const session = state.session
  if (!session) return

  requireStorageAccess(session, state.space)
  state.files = await listFiles(session, state.space)
}

async function activateSession(session: Session, notice: string) {
  cancelRingSignin()
  state.ringSignin = {}
  state.session = session
  state.space = 'public'
  state.drafts = {}
  state.files = []
  state.editingId = undefined
  setNotice(notice)
  await refreshFiles()
}

function cancelRingSignin() {
  const flow = state.ringAuthFlow
  state.ringAuthFlow = undefined
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

async function run(label: string, task: () => Promise<void>) {
  const hadSession = Boolean(state.session)
  state.busy = label
  state.error = undefined
  updateStatus()
  syncControls()

  try {
    await task()
  } catch (error) {
    setError(error)
  } finally {
    state.busy = undefined
  }

  if (Boolean(state.session) !== hadSession) {
    mount()
    return
  }

  updateStatus()
  syncControls()
}

function requireSession() {
  if (!state.session) throw new Error('No active Pubky session')
  return state.session
}
