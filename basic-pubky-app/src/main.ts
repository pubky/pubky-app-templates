import type { Session } from '@synonymdev/pubky'
import { toCanvas } from 'qrcode'
import './style.css'
import { APP_PATH, DEVELOPMENT_SIGNUP_HOMESERVER, SHOW_DEVELOPMENT_SIGNUP } from './config'
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
import { startAppEventStream, type AppEvent, type AppEventStream } from './events'
import { deleteFile, filePath, listFiles, saveFile, type AppFile } from './storage'

const RING_QR_SIZE = 220

interface State {
  busy?: string
  editingId?: string
  error?: string
  notice?: string
  noticePath?: string
  files: AppFile[]
  ringAuthFlow?: RingAuthFlow
  ringSignin: RingSigninState
  session?: Session
  stopEventStream?: () => Promise<void>
  eventStreamEvents: AppEvent[]
}

interface RingSigninState {
  authorizationUrl?: string
  copied?: boolean
  expired?: boolean
  loading?: boolean
  token?: symbol
}

const app = getAppElement()

const state: State = {
  eventStreamEvents: [],
  files: [],
  ringSignin: {},
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

app.addEventListener('click', handleClick)
app.addEventListener('submit', handleSubmit)
render()
void init()

async function init() {
  await run('Restoring session...', async () => {
    const session = await restoreSavedSession()
    if (session) {
      await activateSession(session, 'Session restored.')
    }
  })

  if (!state.session) await refreshRingSignin(Boolean(state.error))
}

function render() {
  const session = state.session

  app.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <h1>Pubky App Template</h1>
        ${session ? signedInHeader(session) : ''}
      </header>

      ${statusView()}
      ${session ? appView() : authView()}
    </main>
  `

  void renderRingSigninQr()
}

function signedInHeader(session: Session) {
  return `
    <div class="user-block">
      <button id="sign-out" type="button" ${disabledAttr()}>Sign out</button>
      <p class="pubky-id">${escapeHtml(session.info.publicKey.toString())}</p>
    </div>
  `
}

function statusView() {
  if (state.busy) return `<p class="status">${escapeHtml(state.busy)}</p>`
  if (state.error) return `<p class="status error">${escapeHtml(state.error)}</p>`
  if (state.notice) return `<p class="status">${statusMessage(state.notice, state.noticePath)}</p>`
  return ''
}

function authView() {
  return `
    <section class="auth-grid ${SHOW_DEVELOPMENT_SIGNUP ? '' : 'ring-only'}">
      ${ringSigninPanel()}
      ${SHOW_DEVELOPMENT_SIGNUP ? newIdentityPanel() : ''}
    </section>
  `
}

function newIdentityPanel() {
  return `
    <section class="panel">
      <h2>New identity</h2>
      <p class="muted">
        Create a new keypair, sign up and sign in on the homeserver, in one go.
        Primarily for development, to move through auth quickly.
      </p>
      <form id="development-signup-form" class="form-grid">
        <label>
          Homeserver public key
          <input
            name="homeserver"
            autocomplete="off"
            value="${escapeHtml(DEVELOPMENT_SIGNUP_HOMESERVER)}"
            required
          />
        </label>
        <button type="submit" ${disabledAttr()}>Create identity and sign in</button>
      </form>
    </section>
  `
}

function ringSigninPanel() {
  const { authorizationUrl, copied, expired, loading } = state.ringSignin
  const busy = Boolean(state.busy)
  const canUseAuthorizationUrl = !busy && Boolean(authorizationUrl) && !loading && !expired

  return `
    <section class="panel">
      <div class="section-header">
        <h2>Sign in with Pubky Ring</h2>
        <button id="refresh-ring-signin" type="button" ${disabledAttr(busy || Boolean(loading))}>
          ${expired ? 'New link' : 'Refresh'}
        </button>
      </div>
      <div class="ring-signin">
        <div class="qr-frame">
          ${ringQrSlot()}
        </div>
        <div class="ring-actions">
          ${
            canUseAuthorizationUrl
              ? `<a class="button-link primary" href="${escapeHtml(authorizationUrl)}">Authorize with Pubky Ring</a>`
              : `<button type="button" disabled>Authorize with Pubky Ring</button>`
          }
          <button id="copy-authorization-url" type="button" ${disabledAttr(!canUseAuthorizationUrl)}>
            ${copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
    </section>
  `
}

function ringQrSlot() {
  const { authorizationUrl, expired, loading } = state.ringSignin

  if (loading) {
    return ringQrPlaceholder(`
      <span class="spinner" aria-hidden="true"></span>
      <span>Generating link...</span>
    `)
  }

  if (expired) {
    return ringQrPlaceholder(`
      <strong>Link expired</strong>
      <span>Generate a fresh one.</span>
    `)
  }

  if (!authorizationUrl) return ringQrPlaceholder('<span>Waiting for Ring link...</span>')

  return `
    <canvas
      id="ring-signin-qr"
      class="ring-qr"
      width="${RING_QR_SIZE}"
      height="${RING_QR_SIZE}"
      aria-label="Pubky Ring sign-in QR code"
    ></canvas>
  `
}

function ringQrPlaceholder(content: string) {
  return `<div class="qr-placeholder" aria-live="polite">${content}</div>`
}

function appView() {
  return `
    <section class="grid">
      <section class="panel">
        <div class="section-header">
          <h2>Editor</h2>
          <button id="new-file" type="button" ${disabledAttr()}>New</button>
        </div>
        ${fileForm()}
      </section>

      <section class="panel">
        <h2>Files</h2>
        ${filesList()}
      </section>

      <section class="panel event-stream-panel">
        <div class="section-header">
          <div>
            <h2>Event stream</h2>
            <p class="muted">Path filter: ${escapeHtml(APP_PATH)}</p>
          </div>
          <button id="toggle-event-stream" type="button" ${disabledAttr()}>
            ${state.stopEventStream ? 'Stop' : 'Start'}
          </button>
        </div>
        ${eventStreamEventsList()}
      </section>
    </section>
  `
}

function fileForm() {
  const file = state.files.find((item) => item.id === state.editingId)

  return `
    <form id="file-form" class="form-grid">
      <label>
        Title
        <input name="title" value="${escapeHtml(file?.title || '')}" autocomplete="off" />
      </label>
      <label>
        Body
        <textarea name="body" rows="8">${escapeHtml(file?.body || '')}</textarea>
      </label>
      <button type="submit" ${disabledAttr()}>${file ? 'Update' : 'Create'}</button>
    </form>
  `
}

function filesList() {
  if (state.files.length === 0) {
    return '<p class="empty">No files yet.</p>'
  }

  return `
    <ul class="file-list">
      ${state.files.map(fileItem).join('')}
    </ul>
  `
}

function fileItem(file: AppFile) {
  return `
    <li>
      <div>
        <strong>${escapeHtml(file.title)}</strong>
        <span>${escapeHtml(formatDate(file.updatedAt))}</span>
      </div>
      <div class="actions">
        <button type="button" data-edit-id="${escapeHtml(file.id)}" ${disabledAttr()}>Edit</button>
        <button type="button" data-delete-id="${escapeHtml(file.id)}" ${disabledAttr()}>Delete</button>
      </div>
    </li>
  `
}

function eventStreamEventsList() {
  if (state.eventStreamEvents.length === 0) {
    return '<p class="empty">No events yet.</p>'
  }

  return `
    <ol class="event-list">
      ${state.eventStreamEvents.map(eventStreamEventItem).join('')}
    </ol>
  `
}

function eventStreamEventItem(event: AppEvent) {
  return `
    <li>
      <strong>${escapeHtml(event.type)}</strong>
      <span>${escapeHtml(event.path)}</span>
      ${event.contentHash ? `<small>Content hash: ${escapeHtml(event.contentHash)}</small>` : ''}
      <small>Cursor: ${escapeHtml(event.cursor)}</small>
    </li>
  `
}

function handleClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const button = target.closest<HTMLButtonElement>('button')
  if (!button || state.busy) return

  if (button.dataset.editId) {
    state.editingId = button.dataset.editId
    render()
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
      render()
      break
    case 'toggle-event-stream':
      void toggleEventStream()
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
  render()

  try {
    const flow = startRingAuthFlow()
    state.ringAuthFlow = flow

    if (!isActiveRingSignin(token)) {
      flow.cancel()
      return
    }

    state.ringSignin = {
      authorizationUrl: flow.authorizationUrl,
      token,
    }
    render()

    void handleRingApproval(flow, token)
  } catch (error) {
    if (!isActiveRingSignin(token)) return

    state.ringAuthFlow = undefined
    state.ringSignin = {}
    setError(error)
    render()
  }
}

async function handleRingApproval(flow: RingAuthFlow, token: symbol) {
  try {
    const session = await flow.awaitApproval
    if (!isActiveRingSignin(token)) return

    state.ringAuthFlow = undefined
    await run('Completing Pubky Ring sign-in...', async () => {
      saveSession(session)
      await activateSession(session, 'Signed in with Pubky Ring.')
    })
  } catch (error) {
    if (isRingAuthCanceled(error) || !isActiveRingSignin(token)) return

    state.ringAuthFlow = undefined
    state.ringSignin = isRingAuthExpired(error) ? { expired: true, token } : {}
    setError(error)
    render()
  }
}

async function handleCopyAuthorizationUrl() {
  const authorizationUrl = state.ringSignin.authorizationUrl
  if (!authorizationUrl || state.ringSignin.expired) return

  try {
    await copyTextToClipboard(authorizationUrl)
    state.ringSignin.copied = true
    setNotice('Authorization URL copied.')
    render()

    window.setTimeout(() => {
      if (state.ringSignin.authorizationUrl !== authorizationUrl) return
      state.ringSignin.copied = false
      render()
    }, 2200)
  } catch (error) {
    setError(error)
    render()
  }
}

async function handleDevelopmentSignup(form: HTMLFormElement) {
  const formData = new FormData(form)
  const homeserver = formValue(formData, 'homeserver')

  await run('Creating identity...', async () => {
    const session = await signupDevelopmentUser(homeserver)
    saveSession(session)
    await activateSession(session, 'Identity created and signed in.')
  })
}

async function handleSaveFile(form: HTMLFormElement) {
  const session = requireSession()
  const formData = new FormData(form)
  const title = formValue(formData, 'title')
  const body = formValue(formData, 'body')

  await run('Saving file...', async () => {
    const file = await saveFile(session, {
      id: state.editingId,
      title,
      body,
    })
    state.editingId = state.editingId ? file.id : undefined
    setNotice('File saved:', filePath(file.id))
    await refreshFiles()
  })
}

async function handleDeleteFile(id: string) {
  const session = requireSession()

  await run('Deleting file...', async () => {
    await deleteFile(session, id)
    if (state.editingId === id) state.editingId = undefined
    setNotice('File deleted:', filePath(id))
    await refreshFiles()
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
    return
  }

  const session = requireSession()
  await run('Starting event stream...', async () => {
    const eventStream = await startAppEventStream(session, (event) => {
      state.eventStreamEvents = [event, ...state.eventStreamEvents].slice(0, 12)
      render()
    })
    state.stopEventStream = eventStream.stop
    watchEventStream(eventStream)
    setNotice('Event stream started.')
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
  render()
}

async function stopEventStream() {
  const stop = state.stopEventStream
  state.stopEventStream = undefined
  if (stop) await stop()
}

async function refreshFiles() {
  const session = state.session
  if (!session) return

  state.files = await listFiles(session)
}

async function renderRingSigninQr() {
  const canvas = document.querySelector<HTMLCanvasElement>('#ring-signin-qr')
  const authorizationUrl = state.ringSignin.authorizationUrl
  if (!canvas || !authorizationUrl || state.ringSignin.expired) return

  try {
    await toCanvas(canvas, authorizationUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: RING_QR_SIZE,
      color: {
        dark: '#101828',
        light: '#ffffff',
      },
    })
  } catch (error) {
    console.error('Failed to render Pubky Ring QR code', error)
  }
}

async function activateSession(session: Session, notice: string) {
  cancelRingSignin()
  state.ringSignin = {}
  state.session = session
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
  state.busy = label
  state.error = undefined
  render()

  try {
    await task()
  } catch (error) {
    setError(error)
  } finally {
    state.busy = undefined
    render()
  }
}

function requireSession() {
  if (!state.session) throw new Error('No active Pubky session')
  return state.session
}

function getAppElement() {
  const element = document.querySelector<HTMLDivElement>('#app')
  if (!element) throw new Error('Missing #app element')
  return element
}

function disabledAttr(disabled = Boolean(state.busy)) {
  return disabled ? 'disabled' : ''
}

function formValue(formData: FormData, name: string) {
  return String(formData.get(name) || '')
}

async function copyTextToClipboard(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textArea = document.createElement('textarea')
  textArea.value = value
  textArea.setAttribute('readonly', '')
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  document.body.append(textArea)
  textArea.select()

  try {
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard copy failed')
    }
  } finally {
    textArea.remove()
  }
}

function formatDate(value: string) {
  if (!value) return ''
  return dateFormatter.format(new Date(value))
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function statusMessage(message: string, path: string | undefined) {
  const escapedMessage = escapeHtml(message)
  if (!path) return escapedMessage
  return `${escapedMessage} <em>${escapeHtml(path)}</em>`
}

const htmlEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (char) => htmlEscapes[char])
}
