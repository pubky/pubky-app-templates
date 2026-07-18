import type { Session } from '@synonymdev/pubky'
import { toCanvas } from 'qrcode'
import './style.css'
import { APP_PATH, DEFAULT_HOMESERVER, SHOW_DEVELOPMENT_SIGNUP } from './config'
import {
  createUser,
  isRingAuthCanceled,
  restoreSavedSession,
  saveSession,
  signOut,
  startRingLogin,
  type RingLoginFlow,
} from './pubky'
import { startAppEventStream, type AppStreamEvent } from './events'
import { deleteRecord, listRecords, recordPath, saveRecord, type AppRecord } from './storage'

const RING_QR_SIZE = 220

interface State {
  busy?: string
  editingId?: string
  error?: string
  notice?: string
  noticePath?: string
  records: AppRecord[]
  ringAuthFlow?: RingLoginFlow
  ringLogin: RingLoginState
  session?: Session
  stopStream?: () => Promise<void>
  streamEvents: AppStreamEvent[]
}

interface RingLoginState {
  authorizationUrl?: string
  copied?: boolean
  expired?: boolean
  loading?: boolean
  token?: symbol
}

const app = getAppElement()

const state: State = {
  records: [],
  ringLogin: {},
  streamEvents: [],
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

render()
void init()

async function init() {
  await run('Restoring session...', async () => {
    const session = await restoreSavedSession()
    if (session) {
      await activateSession(session, 'Session restored.')
    }
  })

  if (!state.session) await refreshRingLogin()
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

  bindEvents()
  void renderRingLoginQr()
}

function signedInHeader(session: Session) {
  return `
    <div class="user-block">
      <button id="sign-out" type="button">Sign out</button>
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
      ${ringLoginPanel()}
      ${SHOW_DEVELOPMENT_SIGNUP ? newIdentityPanel() : ''}
    </section>
  `
}

function newIdentityPanel() {
  return `
    <section class="panel">
      <div>
        <h2>New identity</h2>
        <p class="muted">
          Create a new key pair, sign up and sign in on the homeserver, in one go.
          Primarily for development, to move through auth quickly.
        </p>
      </div>
      <form id="create-user-form" class="record-form">
        <label>
          Homeserver public key
          <input
            name="homeserver"
            autocomplete="off"
            value="${escapeHtml(DEFAULT_HOMESERVER)}"
            required
          />
        </label>
        <button type="submit" ${disabledAttr()}>Create identity and sign in</button>
      </form>
    </section>
  `
}

function ringLoginPanel() {
  const authUrl = state.ringLogin.authorizationUrl
  const canUseAuthUrl = Boolean(authUrl) && !state.ringLogin.loading && !state.ringLogin.expired

  return `
    <section class="panel ring-login-panel">
      <div class="section-header">
        <h2>Sign in with Pubky Ring</h2>
        <button id="refresh-ring-login" type="button" ${refreshRingDisabledAttr()}>
          ${state.ringLogin.expired ? 'New link' : 'Refresh'}
        </button>
      </div>
      <div class="ring-login">
        <div class="qr-frame">
          ${ringQrSlot()}
        </div>
        <div class="ring-actions">
          ${
            canUseAuthUrl
              ? `<a id="open-ring-link" class="button-link primary" href="${escapeHtml(authUrl)}">Authorize with Pubky Ring</a>`
              : `<button type="button" disabled>Authorize with Pubky Ring</button>`
          }
          <button id="copy-ring-link" type="button" ${ringLinkDisabledAttr()}>
            ${state.ringLogin.copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
    </section>
  `
}

function ringQrSlot() {
  if (state.ringLogin.loading) {
    return `
      <div class="qr-placeholder" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <span>Generating link...</span>
      </div>
    `
  }

  if (state.ringLogin.expired) {
    return `
      <div class="qr-placeholder" aria-live="polite">
        <strong>Link expired</strong>
        <span>Generate a fresh one.</span>
      </div>
    `
  }

  if (!state.ringLogin.authorizationUrl) {
    return `
      <div class="qr-placeholder" aria-live="polite">
        <span>Waiting for Ring link...</span>
      </div>
    `
  }

  return `
    <canvas
      id="ring-login-qr"
      class="ring-qr"
      width="${RING_QR_SIZE}"
      height="${RING_QR_SIZE}"
      aria-label="Pubky Ring sign-in QR code"
    ></canvas>
  `
}

function appView() {
  return `
    <section class="grid">
      <section class="panel">
        <div class="section-header">
          <h2>Editor</h2>
          <button id="new-record" type="button">New</button>
        </div>
        ${recordForm()}
      </section>

      <section class="panel">
        <h2>Records</h2>
        ${recordsList()}
      </section>

      <section class="panel stream-panel">
        <div class="section-header">
          <div>
            <h2>Stream</h2>
            <p class="muted">Path filter: ${escapeHtml(APP_PATH)}</p>
          </div>
          <button id="toggle-stream" type="button" ${disabledAttr()}>
            ${state.stopStream ? 'Stop' : 'Start'}
          </button>
        </div>
        ${streamEventsList()}
      </section>
    </section>
  `
}

function recordForm() {
  const record = state.records.find((item) => item.id === state.editingId)

  return `
    <form id="record-form" class="record-form">
      <label>
        Title
        <input name="title" value="${escapeHtml(record?.title || '')}" autocomplete="off" />
      </label>
      <label>
        Body
        <textarea name="body" rows="8">${escapeHtml(record?.body || '')}</textarea>
      </label>
      <button type="submit" ${disabledAttr()}>${record ? 'Update' : 'Create'}</button>
    </form>
  `
}

function recordsList() {
  if (state.records.length === 0) {
    return '<p class="empty">No records yet.</p>'
  }

  return `
    <ul class="record-list">
      ${state.records.map(recordItem).join('')}
    </ul>
  `
}

function recordItem(record: AppRecord) {
  return `
    <li>
      <div>
        <strong>${escapeHtml(record.title)}</strong>
        <span>${escapeHtml(formatDate(record.updatedAt))}</span>
      </div>
      <div class="actions">
        <button type="button" data-edit-id="${escapeHtml(record.id)}">Edit</button>
        <button type="button" data-delete-id="${escapeHtml(record.id)}">Delete</button>
      </div>
    </li>
  `
}

function streamEventsList() {
  if (state.streamEvents.length === 0) {
    return '<p class="empty">No events yet.</p>'
  }

  return `
    <ol class="event-list">
      ${state.streamEvents
        .map(
          (event) => `
            <li>
              <strong>${escapeHtml(event.type)}</strong>
              <span>${escapeHtml(event.path)}</span>
              <small>${escapeHtml(event.cursor)}</small>
            </li>
          `,
        )
        .join('')}
    </ol>
  `
}

function bindEvents() {
  document.querySelector('#refresh-ring-login')?.addEventListener('click', () => {
    void refreshRingLogin()
  })

  document.querySelector('#copy-ring-link')?.addEventListener('click', () => {
    void handleCopyRingLink()
  })

  document.querySelector('#create-user-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleCreateUser(event.currentTarget as HTMLFormElement)
  })

  document.querySelector('#sign-out')?.addEventListener('click', () => {
    void handleSignOut()
  })

  document.querySelector('#new-record')?.addEventListener('click', () => {
    state.editingId = undefined
    render()
  })

  document.querySelector('#record-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSaveRecord(event.currentTarget as HTMLFormElement)
  })

  document.querySelectorAll<HTMLButtonElement>('[data-edit-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editingId = button.dataset.editId
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-delete-id]').forEach((button) => {
    button.addEventListener('click', () => {
      void handleDeleteRecord(button.dataset.deleteId)
    })
  })

  document.querySelector('#toggle-stream')?.addEventListener('click', () => {
    void toggleStream()
  })
}

async function refreshRingLogin() {
  const token = Symbol('ring-login')
  cancelRingLogin()

  state.ringLogin = {
    loading: true,
    token,
  }
  state.error = undefined
  render()

  try {
    const flow = startRingLogin()
    state.ringAuthFlow = flow

    if (!isActiveRingLogin(token)) {
      flow.cancel()
      return
    }

    state.ringLogin = {
      authorizationUrl: flow.authorizationUrl,
      token,
    }
    render()

    void handleRingApproval(flow, token)
  } catch (error) {
    if (!isActiveRingLogin(token)) return

    state.ringAuthFlow = undefined
    state.ringLogin = {}
    state.error = formatError(error)
    render()
  }
}

async function handleRingApproval(flow: RingLoginFlow, token: symbol) {
  try {
    const session = await flow.awaitApproval
    if (!isActiveRingLogin(token)) return

    state.ringAuthFlow = undefined
    await run('Completing Pubky Ring sign-in...', async () => {
      await saveSession(session)
      await activateSession(session, 'Signed in with Pubky Ring.')
    })
  } catch (error) {
    if (isRingAuthCanceled(error) || !isActiveRingLogin(token)) return

    state.ringAuthFlow = undefined
    state.ringLogin = {
      expired: true,
      token,
    }
    state.error = formatError(error)
    render()
  }
}

async function handleCopyRingLink() {
  const authUrl = state.ringLogin.authorizationUrl
  if (!authUrl || state.ringLogin.expired) return

  try {
    await copyTextToClipboard(authUrl)
    state.ringLogin = {
      ...state.ringLogin,
      copied: true,
    }
    setNotice('Pubky Ring link copied.')
    render()

    window.setTimeout(() => {
      if (state.ringLogin.authorizationUrl !== authUrl) return
      state.ringLogin = {
        ...state.ringLogin,
        copied: false,
      }
      render()
    }, 2200)
  } catch (error) {
    state.error = formatError(error)
    render()
  }
}

async function handleCreateUser(form: HTMLFormElement) {
  const formData = new FormData(form)
  const homeserver = formValue(formData, 'homeserver')

  await run('Creating identity...', async () => {
    const session = await createUser(homeserver)
    await saveSession(session)
    await activateSession(session, 'Identity created and signed in.')
  })
}

async function handleSaveRecord(form: HTMLFormElement) {
  const session = requireSession()
  const formData = new FormData(form)
  const title = formValue(formData, 'title')
  const body = formValue(formData, 'body')

  await run('Saving record...', async () => {
    const record = await saveRecord(session, {
      id: state.editingId,
      title,
      body,
    })
    state.editingId = state.editingId ? record.id : undefined
    setNotice('Record saved:', recordPath(record.id))
    await refreshRecords()
  })
}

async function handleDeleteRecord(id: string | undefined) {
  if (!id) return
  const session = requireSession()

  await run('Deleting record...', async () => {
    await deleteRecord(session, id)
    if (state.editingId === id) state.editingId = undefined
    setNotice('Record deleted:', recordPath(id))
    await refreshRecords()
  })
}

async function handleSignOut() {
  const session = requireSession()

  await run('Signing out...', async () => {
    await stopStream()
    await signOut(session)
    state.session = undefined
    state.records = []
    state.editingId = undefined
    state.streamEvents = []
    setNotice('Signed out.')
  })

  if (!state.session) await refreshRingLogin()
}

async function toggleStream() {
  if (state.stopStream) {
    await run('Stopping stream...', async () => {
      await stopStream()
      setNotice('Stream stopped.')
    })
    return
  }

  const session = requireSession()
  await run('Starting stream...', async () => {
    state.stopStream = await startAppEventStream(
      session,
      (event) => {
        state.streamEvents = [event, ...state.streamEvents].slice(0, 12)
        render()
      },
      (error) => {
        state.stopStream = undefined
        state.error = formatError(error)
        render()
      },
    )
    setNotice('Stream started.')
  })
}

async function stopStream() {
  const stop = state.stopStream
  state.stopStream = undefined
  if (stop) await stop()
}

async function refreshRecords() {
  const session = state.session
  if (!session) return

  state.records = await listRecords(session)
}

async function renderRingLoginQr() {
  const canvas = document.querySelector<HTMLCanvasElement>('#ring-login-qr')
  const authUrl = state.ringLogin.authorizationUrl
  if (!canvas || !authUrl || state.ringLogin.expired) return

  try {
    await toCanvas(canvas, authUrl, {
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
  cancelRingLogin()
  state.ringLogin = {}
  state.session = session
  setNotice(notice)
  await refreshRecords()
}

function cancelRingLogin() {
  const flow = state.ringAuthFlow
  state.ringAuthFlow = undefined
  flow?.cancel()
}

function isActiveRingLogin(token: symbol) {
  return state.ringLogin.token === token
}

function setNotice(notice: string, path?: string) {
  state.notice = notice
  state.noticePath = path
}

async function run(label: string, task: () => Promise<void>) {
  state.busy = label
  state.error = undefined
  render()

  try {
    await task()
  } catch (error) {
    state.error = formatError(error)
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

function disabledAttr() {
  return state.busy ? 'disabled' : ''
}

function ringLinkDisabledAttr() {
  return state.busy ||
    state.ringLogin.loading ||
    state.ringLogin.expired ||
    !state.ringLogin.authorizationUrl
    ? 'disabled'
    : ''
}

function refreshRingDisabledAttr() {
  return state.busy || state.ringLogin.loading ? 'disabled' : ''
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
