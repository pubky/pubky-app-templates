import type { AuthFlow, Session } from '@synonymdev/pubky'
import './style.css'
import {
  APP_CAPABILITIES,
  APP_PATH,
  TESTNET_HOMESERVER,
  clearPendingSigninFlow,
  createUser,
  restoreSavedSession,
  resumePendingSigninFlow,
  saveSession,
  signOut,
  startSigninFlow,
} from './pubky'
import { startAppEventStream, type AppStreamEvent } from './events'
import { deleteRecord, listRecords, saveRecord, type AppRecord } from './storage'

interface State {
  authUrl?: string
  busy?: string
  editingId?: string
  error?: string
  notice?: string
  records: AppRecord[]
  session?: Session
  stopStream?: () => Promise<void>
  streamEvents: AppStreamEvent[]
}

const app = getAppElement()

const state: State = {
  records: [],
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
      return
    }

    const flow = resumePendingSigninFlow()
    if (flow) void waitForApproval(flow)
  })
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
  if (state.notice) return `<p class="status">${escapeHtml(state.notice)}</p>`
  return ''
}

function authView() {
  return `
    <section class="auth-grid">
      <section class="panel">
        <div>
          <h2>Sign in</h2>
          <p class="muted">${escapeHtml(APP_CAPABILITIES)}</p>
        </div>
        <button id="sign-in" type="button" ${disabledAttr()}>Start sign in</button>
        ${
          state.authUrl
            ? `
              <div class="auth-url">
                <a href="${escapeHtml(state.authUrl)}">Open signer</a>
                <button id="copy-auth-url" type="button">Copy URL</button>
                <textarea readonly rows="4">${escapeHtml(state.authUrl)}</textarea>
              </div>
            `
            : ''
        }
      </section>

      <section class="panel">
        <h2>Create user</h2>
        <form id="create-user-form" class="record-form">
          <label>
            Homeserver public key
            <input
              name="homeserver"
              autocomplete="off"
              value="${escapeHtml(TESTNET_HOMESERVER)}"
              required
            />
          </label>
          <button type="submit" ${disabledAttr()}>Create user and sign in</button>
        </form>
      </section>
    </section>
  `
}

function appView() {
  return `
    <section class="grid">
      <section class="panel">
        <div class="section-header">
          <div>
            <h2>Records</h2>
            <p class="muted">${escapeHtml(APP_PATH)}</p>
          </div>
          <button id="new-record" type="button">New</button>
        </div>
        ${recordForm()}
      </section>

      <section class="panel">
        <h2>Saved records</h2>
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
  document.querySelector('#sign-in')?.addEventListener('click', () => {
    void waitForApproval(startSigninFlow())
  })

  document.querySelector('#copy-auth-url')?.addEventListener('click', () => {
    if (!state.authUrl) return
    void navigator.clipboard.writeText(state.authUrl)
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

async function waitForApproval(flow: AuthFlow) {
  state.authUrl = flow.authorizationUrl
  state.notice = 'Waiting for signer approval.'
  render()

  await run('Waiting for signer approval...', async () => {
    const session = await flow.awaitApproval()
    await saveSession(session)
    clearPendingSigninFlow()
    state.authUrl = undefined
    await activateSession(session, 'Signed in.')
  })
}

async function handleCreateUser(form: HTMLFormElement) {
  const formData = new FormData(form)
  const homeserver = formValue(formData, 'homeserver')

  await run('Creating user...', async () => {
    const session = await createUser(homeserver)
    await saveSession(session)
    await activateSession(session, 'User created and signed in.')
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
    state.notice = 'Record saved.'
    await refreshRecords()
  })
}

async function handleDeleteRecord(id: string | undefined) {
  if (!id) return
  const session = requireSession()

  await run('Deleting record...', async () => {
    await deleteRecord(session, id)
    if (state.editingId === id) state.editingId = undefined
    state.notice = 'Record deleted.'
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
    state.notice = 'Signed out.'
  })
}

async function toggleStream() {
  if (state.stopStream) {
    await run('Stopping stream...', async () => {
      await stopStream()
      state.notice = 'Stream stopped.'
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
    state.notice = 'Stream started.'
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

async function activateSession(session: Session, notice: string) {
  state.session = session
  state.notice = notice
  await refreshRecords()
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

function formValue(formData: FormData, name: string) {
  return String(formData.get(name) || '')
}

function formatDate(value: string) {
  if (!value) return ''
  return dateFormatter.format(new Date(value))
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
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
