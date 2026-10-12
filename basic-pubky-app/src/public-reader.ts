import './style.css'
import { version as pubkySdkVersion } from '@synonymdev/pubky/package.json'
import { createStorageTools, storageToolsPanelHtml } from './storage-tools'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing #app element')

app.innerHTML = `
  <main class="app-shell">
    <header class="app-header">
      <div>
        <h1>Pubky App Template</h1>
        <nav class="page-nav" aria-label="Pages">
          <a href="./">Your files</a> · <strong aria-current="page">Public file reader</strong>
        </nav>
      </div>
    </header>
    ${storageToolsPanelHtml()}
    <footer class="app-footer">Built with <a href="https://www.npmjs.com/package/@synonymdev/pubky">Pubky SDK</a> v${pubkySdkVersion}</footer>
  </main>
`

const reader = createStorageTools(app)
window.addEventListener('pagehide', (event) => {
  // Keep the controller and loaded file when Back restores this page from cache.
  if (!event.persisted) reader.dispose()
})
