const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const htmlEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}

export function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (char) => htmlEscapes[char])
}

export function disabledAttr(disabled: boolean) {
  return disabled ? 'disabled' : ''
}

export function formValue(formData: FormData, name: string) {
  return String(formData.get(name) || '')
}

export function formatDate(value: string) {
  if (!value) return ''
  return dateFormatter.format(new Date(value))
}

export function formatError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === 'CredentialRefreshError') {
      return `Session credentials could not be refreshed. ${error.message} Sign out and authorize again if access was revoked or expired.`
    }
    if (error.name === 'RequestError' && 'data' in error) {
      const data = error.data
      if (typeof data === 'object' && data !== null && 'reason' in data) {
        if (['Timeout', 'Connection', 'Body'].includes(String(data.reason))) {
          return `${error.message} The operation's result may be unknown; check the file before repeating a write.`
        }
        if (data.reason === 'Decode')
          return `${error.message} The server response could not be decoded.`
        if (data.reason === 'InvalidRequest')
          return `${error.message} Check the request parameters.`
      }
    }
    return error.message
  }
  return String(error)
}

export function statusMessage(message: string, path: string | undefined) {
  const escapedMessage = escapeHtml(message)
  if (!path) return escapedMessage
  return `${escapedMessage} <em>${escapeHtml(path)}</em>`
}

export async function copyTextToClipboard(value: string) {
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
