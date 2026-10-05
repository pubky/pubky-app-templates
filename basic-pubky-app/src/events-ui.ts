import { APP_PATHS, type StorageSpace } from './config'
import type { AppEvent } from './events'
import { disabledAttr, escapeHtml } from './html'

export function eventStreamPanelHtml(
  events: AppEvent[],
  streaming: boolean,
  space: StorageSpace,
  busy?: string,
) {
  return `
    <section class="panel event-stream-panel">
      <div class="section-header">
        <div>
          <h2>${space === 'public' ? 'Public' : 'Private'} event stream</h2>
          <p class="muted">Path filter: <code>${escapeHtml(APP_PATHS[space])}</code></p>
        </div>
        <button id="toggle-event-stream" type="button" ${disabledAttr(Boolean(busy))}>
          ${streaming ? 'Stop' : 'Start'}
        </button>
      </div>
      <p class="muted">${space === 'public' ? 'Anyone can subscribe to changes in this public folder.' : 'This stream uses your session and requires read access to this private folder.'} Events contain file metadata, not file contents.</p>
      <div id="event-list">${eventListHtml(events)}</div>
    </section>
  `
}

export function updateEventList(events: AppEvent[]) {
  const list = document.querySelector('#event-list')
  if (!list) return
  list.innerHTML = eventListHtml(events)
}

export function updateEventStreamToggle(streaming: boolean) {
  const button = document.querySelector('#toggle-event-stream')
  if (button) button.textContent = streaming ? 'Stop' : 'Start'
}

function eventListHtml(events: AppEvent[]) {
  if (events.length === 0) {
    return '<p class="empty">No events yet.</p>'
  }

  return `
    <ol class="event-list">
      ${events.map(eventStreamEventItem).join('')}
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
