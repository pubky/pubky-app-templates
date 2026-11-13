/** Download as an attachment; never render uploaded HTML/SVG in the app origin. */
export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const safeName = filename.replace(/[/\\\p{Cc}\p{Cs}]/gu, '_')
  // Preserve the original ciphertext name: offline recovery derives its key from that path.
  link.download = !safeName || safeName === '.' || safeName === '..' ? 'download' : safeName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
