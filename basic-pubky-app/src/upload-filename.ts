/** Plain, single-file names; percent sequences are literal, never URL-decoded. */
export function isUploadFilename(name: string) {
  return isPlainFilename(name) && new TextEncoder().encode(name).byteLength <= 180
}

/** Leave room for the UUID and encryption suffix without splitting a Unicode character. */
export function filenameForUpload(name: string) {
  if (!isPlainFilename(name)) throw new Error('Invalid uploaded filename.')
  let filename = ''
  let bytes = 0
  for (const character of name) {
    bytes += new TextEncoder().encode(character).byteLength
    if (bytes > 100) break
    filename += character
  }
  return filename
}

function isPlainFilename(name: string) {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\p{Cc}\p{Cs}]/u.test(name)
}
