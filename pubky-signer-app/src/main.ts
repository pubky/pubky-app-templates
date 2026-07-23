import './style.css'
import {
  DEFAULT_HOMESERVER,
  DEFAULT_HOMESERVER_ADMIN_PASSWORD,
  DEFAULT_HOMESERVER_ADMIN_URL,
  approveAuthRequest,
  createIdentity,
  deleteIdentity,
  identityManagerStorageKey,
  importIdentity,
  parseAuthRequest,
  publishHomeserver,
  restoreSavedIdentities,
  saveIdentity,
  signUpSavedIdentity,
  type AuthRequestPreview,
  type SignupSettings,
  type SignerIdentity,
} from './pubky'

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor
  }
}

interface ApprovalHistoryItem {
  at: string
  capabilities: string[]
  kind: AuthRequestPreview['kind']
  publicKey: string
  relay: string
}

type Route = 'identity' | 'auth'

interface State {
  approvals: ApprovalHistoryItem[]
  activeIdentityId?: string
  authInput: string
  authRequest?: AuthRequestPreview
  busy?: string
  error?: string
  identities: SignerIdentity[]
  notice?: string
  scanActive: boolean
}

const app = getAppElement()
const ACTIVE_IDENTITY_KEY = identityManagerStorageKey('pubky-key-manager:active-identity')
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const savedIdentities = restoreSavedIdentities()
const state: State = {
  activeIdentityId: restoreActiveIdentityId(savedIdentities),
  approvals: [],
  authInput: '',
  identities: savedIdentities,
  scanActive: false,
}

let scanStream: MediaStream | undefined
let scanDetector: BarcodeDetectorLike | undefined
let scanTimer: number | undefined
let scanCanvas: HTMLCanvasElement | undefined

app.addEventListener('click', handleClick)
app.addEventListener('submit', handleSubmit)
app.addEventListener('change', handleChange)
window.addEventListener('hashchange', handleRouteChange)

render()

function render() {
  const route = currentRoute()
  const identity = activeIdentity()

  app.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <div class="title-block">
          <div>
            <h1>Pubky Identity Manager</h1>
          </div>
          ${pageNav(route)}
        </div>
        ${identity ? identityPill(identity) : ''}
      </header>

      ${statusView()}

      ${route === 'auth' ? authPage() : identityPage()}
    </main>
  `

  attachScanVideo()
}

function pageNav(route: Route) {
  return `
    <nav class="tabs" aria-label="Primary">
      <a href="#/identity" class="${route === 'identity' ? 'active' : ''}">Identity</a>
      <a href="#/auth" class="${route === 'auth' ? 'active' : ''}">Auth</a>
    </nav>
  `
}

function authPage() {
  return `
    <section class="workspace">
      ${authView()}
      ${captureView()}
      ${historyView()}
    </section>
  `
}

function identityPill(identity: SignerIdentity) {
  return `
    <div class="identity-pill">
      <span>Identity</span>
      ${
        state.identities.length > 1
          ? identitySelectView()
          : `<span class="identity-value">${escapeHtml(shortPubky(identity.publicKey))}</span>`
      }
    </div>
  `
}

function identitySelectView() {
  return `
    <form id="identity-select-form" class="identity-select-form">
      <select name="identityId" aria-label="Active identity" ${disabledAttr()}>
        ${state.identities
          .map(
            (identity) => `
              <option
                value="${escapeHtml(identity.id)}"
                ${identity.id === state.activeIdentityId ? 'selected' : ''}
              >
                ${escapeHtml(shortPubky(identity.publicKey))}
              </option>
            `,
          )
          .join('')}
      </select>
    </form>
  `
}

function statusView() {
  if (state.busy) return `<p class="status">${escapeHtml(state.busy)}</p>`
  if (state.error) return `<p class="status error">${escapeHtml(state.error)}</p>`
  if (state.notice) return `<p class="status">${escapeHtml(state.notice)}</p>`
  return ''
}

function identityPage() {
  const identity = activeIdentity()

  return `
    <section class="workspace">
      ${keyManagementView()}
      ${identity ? identitySettingsView(identity) : ''}
    </section>
  `
}

function keyManagementView() {
  return `
    <section class="panel key-panel">
      <h2>Key management</h2>
      ${createIdentityView()}
      ${importIdentityView()}
    </section>
  `
}

function createIdentityView() {
  return `
    <div class="stack">
      <form id="create-identity-form" class="form-grid">
        <button type="submit" ${disabledAttr()}>Create new identity</button>
      </form>
    </div>
  `
}

function importIdentityView() {
  return `
    <div class="split-section stack">
      <h2>Import identity</h2>
      <form id="import-identity-form" class="form-grid">
        <label>
          Recovery phrase
          <textarea name="recoveryPhrase" rows="4" spellcheck="false" required></textarea>
        </label>
        <button type="submit" ${disabledAttr()}>Import</button>
      </form>
    </div>
  `
}

function identitySettingsView(identity: SignerIdentity) {
  return `
    <section class="panel identity-settings-panel">
      ${localIdentityView(identity)}
      ${homeserverView(identity)}
    </section>
  `
}

function localIdentityView(identity: SignerIdentity) {
  return `
    <div class="stack identity-details">
      <h2>Identity details</h2>
      <dl class="details">
        <div>
          <dt>Public key</dt>
          <dd>${escapeHtml(identity.publicKey)}</dd>
        </div>
        <div>
          <dt>Homeserver</dt>
          <dd>${escapeHtml(identity.homeserver || 'Not signed up')}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>${escapeHtml(formatDate(identity.createdAt))}</dd>
        </div>
      </dl>
      <div class="button-row">
        <button id="copy-recovery-phrase" type="button" ${disabledAttr(!identity.recoveryPhrase)}>
          Copy recovery phrase
        </button>
        <button id="forget-identity" type="button" ${disabledAttr()}>Forget identity</button>
      </div>
    </div>
  `
}

function homeserverView(identity: SignerIdentity) {
  const homeserver = identity.homeserver || DEFAULT_HOMESERVER

  return `
    <div class="split-section stack homeserver-panel">
      <h2>Homeserver</h2>
      <form id="identity-actions-form" class="form-grid">
        <label>
          Homeserver pubky
          <input
            name="homeserver"
            autocomplete="off"
            value="${escapeHtml(homeserver)}"
            required
          />
        </label>
        <label>
          Homeserver admin URL
          <input
            name="adminUrl"
            autocomplete="off"
            value="${escapeHtml(DEFAULT_HOMESERVER_ADMIN_URL)}"
          />
        </label>
        <label>
          Homeserver admin password
          <input
            name="adminPassword"
            type="password"
            autocomplete="off"
            value="${escapeHtml(DEFAULT_HOMESERVER_ADMIN_PASSWORD)}"
          />
        </label>
        <div class="button-row">
          <button type="submit" name="action" value="signup" ${disabledAttr()}>Sign up</button>
          <button type="submit" name="action" value="publish" ${disabledAttr()}>
            Publish PKARR
          </button>
        </div>
      </form>
    </div>
  `
}

function authView() {
  const identity = activeIdentity()

  return `
    <section class="panel auth-panel">
      <div class="section-header">
        <h2>Auth request</h2>
        <button id="clear-auth" type="button" ${disabledAttr()}>Clear</button>
      </div>
      ${identity?.homeserver ? '' : authRequirementView(identity)}

      <form id="auth-form" class="form-grid">
        <label>
          Pubky auth link
          <textarea name="auth" rows="7" spellcheck="false">${escapeHtml(state.authInput)}</textarea>
        </label>
        <div class="button-row">
          <button type="submit" ${disabledAttr(!identity?.homeserver)}>Approve request</button>
          <button id="preview-auth" type="button" ${disabledAttr()}>Preview</button>
        </div>
      </form>

      ${state.authRequest ? authPreviewView(state.authRequest) : ''}
    </section>
  `
}

function authRequirementView(identity: SignerIdentity | undefined) {
  const message = identity
    ? 'Sign up this identity on a homeserver before approving auth requests.'
    : 'Create or import an identity before approving auth requests.'

  return `
    <p class="inline-note">
      ${escapeHtml(message)}
      <a href="#/identity">Go to Identity</a>
    </p>
  `
}

function authPreviewView(request: AuthRequestPreview) {
  return `
    <dl class="details preview">
      <div>
        <dt>Kind</dt>
        <dd>${escapeHtml(request.kind)}</dd>
      </div>
      <div>
        <dt>Relay</dt>
        <dd>${escapeHtml(request.relay)}</dd>
      </div>
      <div>
        <dt>Capabilities</dt>
        <dd>${request.capabilities.length ? escapeHtml(request.capabilities.join(', ')) : 'None'}</dd>
      </div>
      ${
        request.homeserver
          ? `
            <div>
              <dt>Homeserver</dt>
              <dd>${escapeHtml(request.homeserver)}</dd>
            </div>
          `
          : ''
      }
    </dl>
  `
}

function captureView() {
  return `
    <section class="panel capture-panel">
      <div class="section-header">
        <h2>Screen QR</h2>
        ${
          state.scanActive
            ? `<button id="stop-scan" type="button">Stop</button>`
            : `<button id="start-scan" type="button" ${disabledAttr()}>Capture</button>`
        }
      </div>
      ${
        state.scanActive
          ? '<video id="scan-video" autoplay muted playsinline></video>'
          : `<p class="empty">${escapeHtml(scannerStatus())}</p>`
      }
    </section>
  `
}

function historyView() {
  return `
    <section class="panel history-panel">
      <h2>Approvals</h2>
      ${
        state.approvals.length
          ? `
            <ol class="history-list">
              ${state.approvals.map(historyItemView).join('')}
            </ol>
          `
          : '<p class="empty">No approvals yet.</p>'
      }
    </section>
  `
}

function historyItemView(item: ApprovalHistoryItem) {
  const caps = item.capabilities.length ? item.capabilities.join(', ') : 'no capabilities'

  return `
    <li>
      <strong>${escapeHtml(item.kind)} approved</strong>
      <span>${escapeHtml(formatDate(item.at))}</span>
      <small>${escapeHtml(item.publicKey)}</small>
      <small>${escapeHtml(caps)}</small>
      <small>${escapeHtml(item.relay)}</small>
    </li>
  `
}

function handleClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const button = target.closest<HTMLButtonElement>('button')
  if (!button || button.disabled) return

  switch (button.id) {
    case 'forget-identity':
      void handleForgetIdentity()
      break
    case 'copy-recovery-phrase':
      void handleCopyRecoveryPhrase()
      break
    case 'preview-auth':
      handlePreviewAuth()
      break
    case 'clear-auth':
      state.authInput = ''
      state.authRequest = undefined
      clearStatus()
      render()
      break
    case 'start-scan':
      void handleStartScan()
      break
    case 'stop-scan':
      stopScreenCapture('Screen capture stopped.')
      break
  }
}

function handleSubmit(event: SubmitEvent) {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return

  event.preventDefault()
  if (state.busy) return

  switch (form.id) {
    case 'create-identity-form':
      void handleCreateIdentity()
      break
    case 'import-identity-form':
      void handleImportIdentity(form)
      break
    case 'identity-actions-form':
      void handleIdentityAction(form, event)
      break
    case 'auth-form':
      void handleApproveAuth(form)
      break
  }
}

function handleChange(event: Event) {
  const select = event.target
  if (!(select instanceof HTMLSelectElement) || select.form?.id !== 'identity-select-form') return

  handleSelectIdentity(select)
}

async function handleCreateIdentity() {
  await run('Creating identity...', async () => {
    setActiveIdentity(createIdentity())
    setNotice('Identity created.')
  })
}

async function handleImportIdentity(form: HTMLFormElement) {
  const formData = new FormData(form)
  const recoveryPhrase = formValue(formData, 'recoveryPhrase')

  await run('Importing identity...', async () => {
    setActiveIdentity(await importIdentity(recoveryPhrase))
    setNotice('Identity imported.')
  })
}

async function handleIdentityAction(form: HTMLFormElement, event: SubmitEvent) {
  const action = submitterValue(event)
  const formData = new FormData(form)
  const signupSettings = signupSettingsFromForm(formData)

  if (action !== 'signup' && action !== 'publish') {
    setError(`Unknown identity action: ${action}`)
    render()
    return
  }

  await run(action === 'signup' ? 'Signing up...' : 'Publishing PKARR...', async () => {
    const identity = requireIdentity()

    if (action === 'signup') {
      const signup = await signUpSavedIdentity(identity, signupSettings)
      setActiveIdentity(signup.identity)
      setNotice(signupNotice(signup.inviteCodeUsed))
      return
    }

    await publishHomeserver(identity.keypair, signupSettings.homeserver)
    setActiveIdentity(saveIdentity(identity.keypair, signupSettings.homeserver))
    setNotice('PKARR published.')
  })
}

function handleSelectIdentity(select: HTMLSelectElement) {
  setActiveIdentityId(select.value)
  render()
}

async function handleForgetIdentity() {
  await run('Forgetting identity...', async () => {
    const identity = requireIdentity()
    deleteIdentity(identity.id)
    state.identities = state.identities.filter((item) => item.id !== identity.id)
    setActiveIdentityId(state.identities[0]?.id)
    setNotice('Identity forgotten.')
  })
}

async function handleCopyRecoveryPhrase() {
  await run('Copying recovery phrase...', async () => {
    const recoveryPhrase = requireIdentity().recoveryPhrase
    if (!recoveryPhrase) throw new Error('This identity does not have a recovery phrase.')

    await navigator.clipboard.writeText(recoveryPhrase)
    setNotice('Recovery phrase copied.')
  })
}

async function handleApproveAuth(form: HTMLFormElement) {
  const authInput = formValue(new FormData(form), 'auth')
  state.authInput = authInput

  await run('Approving auth request...', async () => {
    const identity = requireSignedUpIdentity()
    const request = await approveAuthRequest(identity, authInput)
    state.authRequest = request
    state.approvals = [
      {
        at: new Date().toISOString(),
        capabilities: request.capabilities,
        kind: request.kind,
        publicKey: identity.publicKey,
        relay: request.relay,
      },
      ...state.approvals,
    ].slice(0, 10)
    setNotice('Auth request approved.')
  })
}

function handlePreviewAuth() {
  const form = document.querySelector<HTMLFormElement>('#auth-form')
  if (!form) return

  try {
    state.authInput = formValue(new FormData(form), 'auth')
    state.authRequest = undefined
    state.authRequest = parseAuthRequest(state.authInput)
    setNotice('Auth request parsed.')
  } catch (error) {
    setError(error)
  }

  render()
}

async function handleStartScan() {
  if (!window.BarcodeDetector) {
    setError('Screen QR scanning needs BarcodeDetector. Use Chrome or Edge, or paste the link.')
    render()
    return
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    setError('Screen capture is not available in this browser context.')
    render()
    return
  }

  const BarcodeDetector = window.BarcodeDetector

  await run('Starting screen capture...', async () => {
    const detector = new BarcodeDetector({ formats: ['qr_code'] })
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: { ideal: 8, max: 12 } },
    })
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        stopScreenCapture('Screen capture ended.')
      })
    })
    scanDetector = detector
    scanStream = stream
    state.scanActive = true
    setNotice('Screen capture started.')
  })

  if (state.scanActive) queueScan()
}

function attachScanVideo() {
  const video = document.querySelector<HTMLVideoElement>('#scan-video')
  if (!video || !scanStream) return

  if (video.srcObject !== scanStream) {
    video.srcObject = scanStream
  }

  void video.play().catch((error: unknown) => {
    if (!state.scanActive) return

    setError(error)
    stopScreenCapture()
  })
}

function queueScan() {
  window.clearTimeout(scanTimer)
  scanTimer = window.setTimeout(() => {
    void scanScreenFrame()
  }, 250)
}

async function scanScreenFrame() {
  if (!state.scanActive || !scanDetector) return

  const video = document.querySelector<HTMLVideoElement>('#scan-video')
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    queueScan()
    return
  }

  try {
    const rawValue = await detectQrValue(video)
    if (!state.scanActive) return

    if (!rawValue) {
      queueScan()
      return
    }

    state.authInput = rawValue
    state.authRequest = undefined
    state.authRequest = parseAuthRequest(rawValue)
    stopScreenCapture('QR found.')
  } catch (error) {
    if (!state.scanActive) return

    setError(error)
    stopScreenCapture()
  }
}

async function detectQrValue(video: HTMLVideoElement) {
  if (!scanDetector || !video.videoWidth || !video.videoHeight) return undefined

  const canvas = scanCanvas || document.createElement('canvas')
  scanCanvas = canvas
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight

  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not read the screen capture frame.')

  context.drawImage(video, 0, 0, canvas.width, canvas.height)

  const barcodes = await scanDetector.detect(canvas)
  return barcodes.find((barcode) => barcode.rawValue)?.rawValue
}

function stopScreenCapture(notice?: string) {
  window.clearTimeout(scanTimer)
  scanTimer = undefined

  scanStream?.getTracks().forEach((track) => {
    track.stop()
  })
  scanStream = undefined
  scanDetector = undefined
  state.scanActive = false

  if (notice) setNotice(notice)
  render()
}

function handleRouteChange() {
  if (currentRoute() !== 'auth' && state.scanActive) {
    stopScreenCapture()
    return
  }

  render()
}

function activeIdentity() {
  return state.identities.find((identity) => identity.id === state.activeIdentityId)
}

function setActiveIdentity(identity: SignerIdentity) {
  state.identities = [identity, ...state.identities.filter((item) => item.id !== identity.id)]
  setActiveIdentityId(identity.id)
}

function setActiveIdentityId(id: string | undefined) {
  state.activeIdentityId = id

  if (id) {
    localStorage.setItem(ACTIVE_IDENTITY_KEY, id)
  } else {
    localStorage.removeItem(ACTIVE_IDENTITY_KEY)
  }
}

function restoreActiveIdentityId(identities: SignerIdentity[]) {
  const savedId = localStorage.getItem(ACTIVE_IDENTITY_KEY)
  if (savedId && identities.some((identity) => identity.id === savedId)) return savedId

  return identities[0]?.id
}

async function run(label: string, task: () => Promise<void>) {
  state.busy = label
  clearStatus()
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

function requireIdentity() {
  const identity = activeIdentity()
  if (!identity) throw new Error('Create or import an identity first.')
  return identity
}

function requireSignedUpIdentity() {
  const identity = requireIdentity()
  if (!identity.homeserver) {
    throw new Error('Sign up this identity on a homeserver before approving auth requests.')
  }
  return identity
}

function setNotice(notice: string) {
  state.notice = notice
  state.error = undefined
}

function setError(error: unknown) {
  state.error = formatError(error)
  state.notice = undefined
}

function clearStatus() {
  state.error = undefined
  state.notice = undefined
}

function scannerStatus() {
  if (!window.isSecureContext) return 'Screen capture needs a secure browser context.'
  if (!navigator.mediaDevices?.getDisplayMedia) return 'Screen capture unavailable.'
  if (!window.BarcodeDetector) return 'QR scanning unavailable. Paste the auth link instead.'
  return 'Ready.'
}

function submitterValue(event: SubmitEvent) {
  const submitter = event.submitter
  if (submitter instanceof HTMLButtonElement) return submitter.value
  return ''
}

function formValue(formData: FormData, name: string) {
  return String(formData.get(name) || '')
}

function signupSettingsFromForm(formData: FormData): SignupSettings {
  return {
    adminPassword: formValue(formData, 'adminPassword'),
    adminUrl: formValue(formData, 'adminUrl'),
    homeserver: formValue(formData, 'homeserver'),
  }
}

function signupNotice(inviteCodeUsed: boolean) {
  return inviteCodeUsed
    ? 'Identity signed up with a generated invite code.'
    : 'Identity signed up without an invite code.'
}

function shortPubky(value: string) {
  if (value.length <= 24) return value
  return `${value.slice(0, 16)}...${value.slice(-8)}`
}

function currentRoute(): Route {
  return window.location.hash === '#/auth' ? 'auth' : 'identity'
}

function getAppElement() {
  const element = document.querySelector<HTMLDivElement>('#app')
  if (!element) throw new Error('Missing #app element')
  return element
}

function disabledAttr(disabled = false) {
  return state.busy || disabled ? 'disabled' : ''
}

function formatDate(value: string) {
  if (!value) return ''

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date)
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
