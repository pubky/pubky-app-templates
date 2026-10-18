import type { StorageSpace } from './config'
import type { AppEvent } from './events'
import { disabledAttr, escapeHtml } from './html'

export function eventStreamPanelHtml(
  events: AppEvent[],
  streaming: boolean,
  space: StorageSpace,
  busy?: string,
) {
  return `
    <section class="panel event-stream-panel" aria-label="${space === 'public' ? 'Public' : 'Private'} events">
      <div class="section-header">
        <h2>Events</h2>
        <div class="actions">
          <button id="load-event-history" type="button" ${disabledAttr(Boolean(busy))}>Recent history</button>
          <button id="toggle-event-stream" type="button" ${disabledAttr(Boolean(busy))}>
            ${streaming ? 'Stop live' : 'Start live'}
          </button>
        </div>
      </div>
      <p class="muted">Load recent changes, or follow new changes live. Restarting live updates resumes after the last received event.</p>
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
  if (button) button.textContent = streaming ? 'Stop live' : 'Start live'
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
