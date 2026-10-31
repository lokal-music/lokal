'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { probeNetworkLibraryLocation } = require('../networkShare')

const STAT_TIMEOUT_MS = 8000

function withTimeout(fn, timeoutMs = STAT_TIMEOUT_MS) {
  return (...args) => {
    let timer
    return Promise.race([
      Promise.resolve().then(() => fn(...args)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Network share probe timed out. Check the NAS connection.')), timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
  }
}

async function isReadableRoot(folder, {
  stat = fs.stat,
  readdir = fs.readdir,
} = {}) {
  // A disconnected SMB mount may never answer immediately. Don't block the
  // Electron main thread; stop waiting after a bounded timeout.
  const check = async () => (await stat(folder)).isDirectory() &&
    Array.isArray(await readdir(folder))
  let timeout
  try {
    return await Promise.race([
      check().catch(() => false),
      new Promise(resolve => {
        timeout = setTimeout(() => resolve(false), STAT_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

// Prepare a synchronous, *in-memory* existence predicate for the legacy
// SQLite pruning transaction. All actual filesystem checks happen
// asynchronously, before entering the transaction: UNC/WebDAV paths must
// never hit fs.existsSync on Electron's main thread during playback.
// Unknown paths are treated as present; uncertain status must preserve music.
async function verifiedPruneExists(root, scannedFiles, knownRows, {
  stat = fs.stat,
  isReadable = isReadableRoot,
  timeoutMs = STAT_TIMEOUT_MS,
} = {}) {
  const parent = path.resolve(root).toLowerCase()
  const present = new Set(scannedFiles.map(file => path.resolve(file).toLowerCase()))
  const missing = new Set()
  const candidates = []
  for (const file of knownRows) {
    if (typeof file !== 'string' || !file) continue
    const resolved = path.resolve(file)
    const relative = path.relative(root, resolved)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) ||
        path.isAbsolute(relative)) continue
    const normalized = resolved.toLowerCase()
    if (!present.has(normalized) && !missing.has(normalized)) {
      candidates.push([normalized, resolved])
      // Mark as visited to avoid checking a duplicate database path.
      present.add(normalized)
    }
  }
  // The candidate set is only a deduplication aid; the scan's actual
  // inventory is authoritative for what was present during enumeration.
  for (const [key] of candidates) present.delete(key)

  for (let start = 0; start < candidates.length; start += 8) {
    const batch = candidates.slice(start, start + 8)
    const checks = await Promise.all(batch.map(async ([key, file]) => {
      try {
        await withTimeout(stat, timeoutMs)(file)
        return [key, true]
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return [key, false]
        }
        return [key, null]
      }
    }))
    if (checks.some(([, found]) => found === null)) return null
    for (const [key, found] of checks) {
      if (found) present.add(key)
      else missing.add(key)
    }
  }
  if (!await isReadable(root)) return null
  return file => {
    const key = path.resolve(file).toLowerCase()
    if (key === parent || present.has(key)) return true
    if (missing.has(key)) return false
    return true
  }
}

// A late fs.watch notification after disconnect must not destroy indexed
// music. Recheck each affected root immediately before any delete; group by
// root so a bulk rename does not cause thousands of NAS probes.
async function verifiedMissingPaths(paths, ownerFor, wasReadable, probe = isReadableRoot) {
  const verified = []
  const availability = new Map()
  for (const filePath of new Set(paths)) {
    const root = ownerFor(filePath)
    if (!root || wasReadable.get(root) !== true) continue
    if (!availability.has(root)) availability.set(root, await probe(root))
    if (availability.get(root)) verified.push(filePath)
  }
  return verified
}

/// Preserve offline existing NAS roots while never scanning unavailable ones.
/// This also protects the renderer from fs.statSync on disconnected UNC paths
/// in the legacy scanner. Accessible roots still use its metadata workflow.
async function scanNetworkRoots(inputs, {
  existing = [],
  scan,
  db,
  isReadable = isReadableRoot,
  closeWatchers = () => require('../libraryWatcher').watchLibraryRoots([]),
} = {}) {
  const candidates = Array.isArray(inputs) ? inputs : []
  const previous = new Set(existing.map(x => path.resolve(x).toLowerCase()))
  const seen = new Set()
  const normalized = candidates
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => path.resolve(x.trim()))
    .filter(x => {
      const lower = x.toLowerCase()
      if (seen.has(lower)) return false
      seen.add(lower)
      return true
    })
  const statuses = await Promise.all(normalized.map(async folder => ({
    folder, online: await isReadable(folder),
  })))
  const online = statuses.filter(x => x.online).map(x => x.folder)
  const offline = statuses.filter(x => !x.online && previous.has(x.folder.toLowerCase()))
    .map(x => x.folder)
  const folders = normalized.filter(x =>
    online.includes(x) || offline.includes(x))
  if (!folders.length) {
    return { error: 'Select at least one accessible music folder.', folders: existing }
  }

  let result = { results: [], status: null }
  try {
    if (online.length) {
      // Metadata scanning only sees currently reachable roots. A new network
      // failure during that scan must never erase a previously saved NAS.
      result = await scan(online)
    } else {
      // A disconnected share leaves old fs.watch handles behind unless
      // explicitly replaced with an empty active watcher set.
      closeWatchers()
    }
  } finally {
    // The scanner saves only online roots. Restore all configured folders,
    // even when a scan throws halfway through its work.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folders', ?)").run(JSON.stringify(folders))
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folder', ?)").run(folders[0])
  }
  return { ...result, folders, offlineFolders: offline }
}

function registerNetworkLibraryHandlers(ipcMain) {
  const scanner = require('./scanner')
  const { getDB } = require('./db')
  const run = roots => scanNetworkRoots(roots, {
    existing: scanner.configuredMusicFolders(),
    scan: scanner.scanFolders,
    db: getDB(),
  })
  const progress = (event, scanning, status) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send('scanner:progress', {
          scanning, total: status?.total ?? 0, done: status?.done ?? 0,
          errors: status?.errors ?? 0, skipped: status?.skipped ?? 0,
          ...(!scanning ? { complete: true } : {}),
        })
      }
    } catch {}
  }
  // These two handlers were registered by the legacy scanner. Replace only
  // their orchestration; actual scan and playback remain unchanged.
  ipcMain.removeHandler('scanner:scanFolders')
  ipcMain.removeHandler('scanner:connectNetworkShare')
  ipcMain.handle('scanner:scanFolders', async (event, inputs) => {
    progress(event, true)
    try {
      const result = await run(inputs)
      progress(event, false, result.status)
      return result
    } catch (error) {
      progress(event, false)
      return { error: error?.message || 'Could not scan the selected folders.' }
    }
  })
  ipcMain.handle('scanner:connectNetworkShare', async (event, input) => {
    try {
      const { folder } = await probeNetworkLibraryLocation(input, {
        stat: withTimeout(fs.stat),
        readdir: withTimeout(fs.readdir),
      })
      const current = scanner.configuredMusicFolders()
      if (!current.some(x => x.toLowerCase() === folder.toLowerCase())) {
        current.push(folder)
      }
      // A network share mounted on a drive letter or POSIX path looks like a
      // local folder. Record explicitly connected roots so the scanner caches
      // only *their* covers, never every local album's full-resolution art.
      const db = getDB()
      const setting = db.prepare("SELECT value FROM settings WHERE key = 'network_music_folders'").get()?.value
      let roots = []
      try {
        const saved = JSON.parse(setting || '[]')
        if (Array.isArray(saved)) roots = saved.filter(x => typeof x === 'string')
      } catch {}
      if (!roots.some(x => path.resolve(x).toLowerCase() === path.resolve(folder).toLowerCase())) {
        roots.push(folder)
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('network_music_folders', ?)").run(JSON.stringify(roots))
      const restore = () => {
        if (setting == null) db.prepare("DELETE FROM settings WHERE key = 'network_music_folders'").run()
        else db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('network_music_folders', ?)").run(setting)
      }
      progress(event, true)
      let result
      try { result = await run(current) } catch (error) { restore(); throw error }
      if (result?.error) restore()
      progress(event, false, result.status)
      return result
    } catch (error) {
      progress(event, false)
      return { error: error?.message || 'Could not open this network share.' }
    }
  })
}

module.exports = { registerNetworkLibraryHandlers, isReadableRoot, scanNetworkRoots, withTimeout, verifiedMissingPaths, verifiedPruneExists }
