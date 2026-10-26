import type { Session } from '@synonymdev/pubky'
import { formatError } from './html'
import { createAppProof, verifyAppProof } from './proofs'

export function proofPanelHtml() {
  return `
    <section id="proof-tools" class="panel">
      <h2>Sign and verify a message</h2>
      <p class="muted">Prove that this account authorized a message, without contacting the Homeserver. This checks the signatures and this page's challenge; it does not check revocation or grant service permissions.</p>
      <p class="muted">Replay tracking lasts for this panel only. Services need their own persistent challenge and replay state.</p>
      <form id="proof-form" class="form-grid">
        <label>Message <textarea name="message" rows="3" maxlength="4096" required></textarea></label>
        <button type="submit">Sign and verify</button>
      </form>
      <p id="proof-status" class="status" role="status"></p>
      <pre id="proof-result" class="file-preview"></pre>
    </section>
  `
}

/** Owns one panel and clears its message/results when the workspace is replaced. */
export function createProofTools(root: HTMLElement, session: Session) {
  let disposed = false
  let busy = false
  const seenNonces = new Map<string, number>()
  const active = () => !disposed && root.isConnected
  const status = root.querySelector<HTMLElement>('#proof-status')
  const result = root.querySelector<HTMLElement>('#proof-result')

  function message(text: string, error = false) {
    if (!active() || !status) return
    status.textContent = text
    status.classList.toggle('error', error)
  }

  async function sign(form: HTMLFormElement) {
    if (busy || !active()) return
    const text = String(new FormData(form).get('message') || '')
    busy = true
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
      'button,textarea',
    )) {
      control.disabled = true
    }
    if (result) result.textContent = ''
    message('Signing and verifying...')
    try {
      const audience = window.location.origin
      const challenge = crypto.randomUUID()
      const identity = session.info.publicKey.z32()
      const credentials = await createAppProof(session, text, audience, challenge)
      if (!active()) return
      const verified = verifyAppProof(credentials, { identity, audience, challenge }, seenNonces)
      if (result) {
        result.textContent = `Verified identity: ${verified.identity}\nSigned message: ${verified.message}`
      }
      message('Message signature and challenge verified locally.')
    } catch (error) {
      message(formatError(error), true)
    } finally {
      busy = false
      if (active()) {
        for (const control of root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
          'button,textarea',
        )) {
          control.disabled = false
        }
      }
    }
  }

  function handleSubmit(event: Event) {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || form.id !== 'proof-form') return
    event.preventDefault()
    event.stopPropagation()
    void sign(form)
  }

  root.addEventListener('submit', handleSubmit)
  return {
    dispose() {
      disposed = true
      seenNonces.clear()
      root.removeEventListener('submit', handleSubmit)
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea')
      if (textarea) textarea.value = ''
      if (result) result.textContent = ''
      if (status) status.textContent = ''
    },
  }
}
