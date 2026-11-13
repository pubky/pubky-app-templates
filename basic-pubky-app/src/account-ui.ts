import type { Session } from '@synonymdev/pubky'
import { hasAccountAccess } from './access'
import { getAccountInfo, type AppAccountInfo } from './account'
import { formatError } from './html'

export function accountPanelHtml(session: Session) {
  return `
    <section id="account-tools" class="panel">
      <h2>Account usage and quotas</h2>
      <p class="muted">Optional account inspection requires read access to /. This also lets the app read every public and private folder on this account, beyond the template's own folders.</p>
      ${
        hasAccountAccess(session)
          ? '<button id="load-account" type="button">Load account information</button>'
          : '<p class="muted">Normal file operations do not need this access. Continue only if you want to approve this broader permission in Pubky Ring.</p><button id="authorize-account-permissions" type="button">Authorize account inspection</button>'
      }
      <p id="account-status" class="status" role="status"></p>
      <pre id="account-result" class="file-preview"></pre>
    </section>
  `
}

/** Loads only on demand and discards results when the owning session view is replaced. */
export function createAccountTools(root: HTMLElement, session: Session) {
  let disposed = false
  let busy = false
  const active = () => !disposed && root.isConnected
  const button = root.querySelector<HTMLButtonElement>('#load-account')
  const status = root.querySelector<HTMLElement>('#account-status')
  const result = root.querySelector<HTMLElement>('#account-result')

  function message(text: string, error = false) {
    if (!active() || !status) return
    status.textContent = text
    status.classList.toggle('error', error)
  }

  async function load() {
    if (busy || !active() || !button) return
    busy = true
    button.disabled = true
    if (result) result.textContent = ''
    message('Loading account information...')
    try {
      const account = await getAccountInfo(session)
      if (!active()) return
      if (result) result.textContent = accountDescription(account)
      message('Account information loaded.')
    } catch (error) {
      message(formatError(error), true)
    } finally {
      busy = false
      if (active()) button.disabled = false
    }
  }

  const handleClick = (event: Event) => {
    event.stopPropagation()
    void load()
  }
  button?.addEventListener('click', handleClick)
  return {
    dispose() {
      disposed = true
      button?.removeEventListener('click', handleClick)
      if (result) result.textContent = ''
      if (status) status.textContent = ''
    },
  }
}

function accountDescription(account: AppAccountInfo) {
  return [
    `Storage used: ${account.usedBytes.toLocaleString()} bytes`,
    `Created: ${account.createdAt}`,
    `Disabled: ${account.disabled ? 'yes' : 'no'}`,
    '',
    'Effective quotas:',
    JSON.stringify(account.quota.effective, null, 2),
    '',
    'Per-account overrides:',
    JSON.stringify(account.quota.overrides, null, 2),
  ].join('\n')
}
