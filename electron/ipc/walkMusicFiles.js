const fsp = require('node:fs/promises')
const path = require('node:path')
const { isPreparedStemClipName } = require('../automix/stem-clip')
const { isPrivatePhoneUploadPath } = require('../phoneUploadPaths')
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.aac', '.opus', '.wma', '.alac', '.ape'])

// `failures` collects folders that could not be read, so a scan can tell it
// missed files instead of looking complete.
async function walkDir(dir, files = [], failures = null) {
  // SMB/WebDAV mounts may take seconds to reply or disappear mid-scan.
  // Never perform directory enumeration synchronously in Electron's main
  // thread, and avoid a recursive JS stack on deeply nested NAS libraries.
  const { withTimeout } = require('./networkLibrary')
  const pending = [dir]
  const visited = new Set()
  while (pending.length) {
    const current = pending.pop()
    if (isPrivatePhoneUploadPath(current)) continue
    if (visited.has(current)) continue
    visited.add(current)
    let entries
    try {
      entries = await withTimeout(fsp.readdir)(current, { withFileTypes: true })
    } catch (error) {
      failures?.push(current)
      console.warn('[scanner] Folder enumeration failed:', current, error.message)
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile() && !isPreparedStemClipName(entry.name) &&
          AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  return files
}

module.exports = { walkDir, AUDIO_EXTS }
