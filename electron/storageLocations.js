// User-selected media storage locations. These are intentionally independent
// from the Electron installation folder, database, artwork library and sign-ins.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { getDB, getStorageDir } = require('./ipc/db')

const KEYS = Object.freeze({ downloads: 'download_root', cache: 'cache_root', phone: 'phone_download_root' })

function savedRoot(kind, settings) {
  const key = KEYS[kind]
  if (!key) throw new Error('Unknown storage location')
  let raw = settings?.[key]
  if (raw == null) {
    try { raw = getDB()?.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value } catch {}
  }
  const value = typeof raw === 'string' ? raw.trim() : ''
  // Malformed settings/backup imports never become relative working-directory paths.
  return value && path.isAbsolute(value) ? path.resolve(value) : ''
}

function downloadDirectory(settings = {}, explicitOutputDir = '') {
  if (explicitOutputDir) return explicitOutputDir
  return savedRoot('downloads', settings) || settings.music_folder || path.join(os.homedir(), 'Music')
}

// Paired-phone originals follow the same user-selected download drive,
 // never the private application database directory.
function phoneCopyDirectory(settings = {}) {
  return path.join(downloadDirectory(settings), 'Lokal Phone')
}

// Incoming paired-phone files live here; independent of normal downloads
// and app-private storage. Never silently fall back after an explicit choice.
function phoneDownloadDirectory(settings = {}) {
  // Reuse the existing Lokal Phone subfolder on the regular downloads drive
  // until users explicitly select a dedicated incoming-phone directory.
  return savedRoot('phone', settings) || phoneCopyDirectory(settings)
}

function cacheDirectoryRoot() {
  return savedRoot('cache') || getStorageDir()
}

/** Validate *before* persisting. Never silently fall back to C: on failures. */
function validateWritableDirectory(selected) {
  if (typeof selected !== 'string' || !selected.trim() || !path.isAbsolute(selected.trim())) {
    throw new Error('Select an absolute folder on the drive you want to use.')
  }
  const folder = path.resolve(selected.trim())
  fs.mkdirSync(folder, { recursive: true })
  if (!fs.statSync(folder).isDirectory()) throw new Error('The selected path is not a directory.')
  // Check actual creation, not merely access(): network/readonly mounts may
  // report a writable mode while refusing new files.
  const probe = path.join(folder, '.lokal-write-test-' + process.pid + '-' + Date.now())
  const fd = fs.openSync(probe, 'wx')
  try { fs.writeSync(fd, 'Lokal') } finally {
    fs.closeSync(fd)
    try { fs.unlinkSync(probe) } catch {}
  }
  return folder
}

function saveRoot(kind, selected) {
  const key = KEYS[kind]
  if (!key) throw new Error('Unknown storage location')
  const root = selected ? validateWritableDirectory(selected) : ''
  const database = getDB()
  if (!database) throw new Error('The music library has not loaded yet.')
  database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, root)
  return root
}

module.exports = { KEYS, savedRoot, downloadDirectory, phoneCopyDirectory, phoneDownloadDirectory, cacheDirectoryRoot, validateWritableDirectory, saveRoot }
