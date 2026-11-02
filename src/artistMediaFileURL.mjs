// Convert a desktop app-owned media path to a browser-safe file URL.
// Windows file paths contain single backslashes; treating them as pairs
// silently makes both animated artist portraits and cached logos fail.
export function artistMediaFileURL(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || /[\u0000-\u001f]/.test(filePath)) return null
  const normalized = filePath.replace(/\\/g, '/')
  const encode = value => value.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':')
  if (/^[a-zA-Z]:\//.test(normalized)) return 'file:///' + encode(normalized)
  if (normalized.startsWith('//')) return 'file://' + encode(normalized.slice(2))
  if (normalized.startsWith('/')) return 'file://' + encode(normalized)
  return null
}
