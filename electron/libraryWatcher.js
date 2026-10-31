// Watches the music folder, the way AIMP does: Windows says which files
// changed (fs.watch is ReadDirectoryChangesW there) and only those are read
// again. A tag editor renumbering a whole album arrives as one batch; a file
// deleted or renamed in Explorer leaves (or moves in) the library at once.
//
// What happens while the app is closed is the next scan's job: it compares
// each file's modification time with the library's and reads only those that
// differ.

const fs = require('fs')
const path = require('path')

// Events settle this long before a batch is read (a tagger saving 300 files
// is one batch, not 300).
const QUIET_MS = 400
// A file modified this recently may still be being written (a download, a
// copy): it waits.
const SETTLE_MS = 1500
// Windows lists changes in a small buffer: a mass edit (a tagger saving a
// whole folder) overflows it and arrives as "something changed". Once the
// events stop for this long, a scan catches up: it reads only the files whose
// modification time changed, the rest cost a stat.
const CATCH_UP_MS = 800
// The watcher failed (the folder went away): a scan, then watching again.
const RECOVER_MS = 3000

let watchers = new Map()
let roots = []
let root = null // legacy primary root for diagnostics
let timer = null
let running = null
const recovering = new Map()
let catchUp = null
const pending = new Map() // path -> whether it appeared/went (vs changed)
const catchUpRoots = new Set()
const catchUpAttempts = new Map()
const MAX_CATCH_UP_RETRIES = 3

function broadcast(channel, payload) {
  // During application shutdown (and in headless scan tests), Electron may
  // have no live BrowserWindow. Reconciliation must still finish and preserve
  // the database snapshot.
  try {
    const { BrowserWindow } = require('electron')
    if (!BrowserWindow?.getAllWindows) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  } catch (error) {
    console.warn('[libraryWatcher] Library notification skipped:', error.message)
  }
}

function schedule(ms = QUIET_MS) {
  clearTimeout(timer)
  timer = setTimeout(flush, ms)
}

function queue(filePath, renamed) {
  pending.set(filePath, pending.get(filePath) || renamed)
  schedule()
}

async function flush() {
  timer = null
  if (running) return schedule()
  const now = Date.now()
  const ready = []
  for (const [filePath, renamed] of pending) {
    let stat = null
    try {
      stat = await require('./ipc/networkLibrary')
        .withTimeout(fs.promises.stat)(filePath)
    } catch {}
    if (stat?.isFile() && now - stat.mtimeMs < SETTLE_MS) continue
    ready.push({ path: filePath, renamed })
    pending.delete(filePath)
  }
  if (pending.size) schedule(SETTLE_MS)
  if (!ready.length) return
  // Directory renames/deletions can affect many descendant paths at once.
  // Let the existing scanner reconcile those rows and find renamed copies;
  // individual-file updates continue through the incremental path below.
  let needsScan = false
  for (const change of ready) {
    if (!change.renamed) continue
    try {
      const stat = await require('./ipc/networkLibrary')
        .withTimeout(fs.promises.stat)(change.path)
      if (stat.isDirectory()) needsScan = true
    } catch { needsScan = true }
  }
  if (needsScan) {
    const active = [...new Set(ready.map(change => rootForPath(change.path)).filter(Boolean))]
    const { isReadableRoot } = require('./ipc/networkLibrary')
    for (const folder of active) {
      if (await isReadableRoot(folder)) catchUpLater(folder)
    }
    return
  }
  running = require('./ipc/scanner').applyFileChanges(ready, [...roots])
    .then(({ added, updated, removed }) => {
      if (!added.length && !updated.length && !removed.length) return
      console.log(`[libraryWatcher] ${added.length} added, ${updated.length} updated, ${removed.length} removed`)
      broadcast('library:changed', { added, updated, removed })
    })
    .catch(e => console.warn('[libraryWatcher] Applying changes failed:', e.message))
    .finally(() => { running = null })
}

function configuredRoots() {
  try {
    const db = require('./ipc/db').getDB()
    const plural = db.prepare("SELECT value FROM settings WHERE key = 'music_folders'").get()?.value
    let values = []
    try { values = Array.isArray(JSON.parse(plural || 'null')) ? JSON.parse(plural) : [] } catch {}
    if (!values.length) {
      const legacy = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value
      if (legacy) values = [legacy]
    }
    const seen = new Set()
    return values.filter(value => typeof value === 'string' && value.trim()).map(value => path.resolve(value.trim())).filter(value => {
      if (seen.has(value.toLowerCase())) return false
      seen.add(value.toLowerCase())
      return true
    })
  } catch { return [] }
}

function rootForPath(filePath) {
  const full = path.resolve(String(filePath || ''))
  for (const candidate of roots) {
    const relative = path.relative(candidate, full)
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return candidate
  }
  return null
}

function selectedRoot(folder) {
  const wanted = path.resolve(folder).toLowerCase()
  return configuredRoots().some(candidate => candidate.toLowerCase() === wanted)
}

async function scan(folder) {
  const target = path.resolve(folder)
  const { isReadableRoot } = require('./ipc/networkLibrary')
  if (!selectedRoot(target) || !await isReadableRoot(target)) return false
  const db = require('./ipc/db').getDB()
  const scanner = require('./ipc/scanner')
  const before = db.prepare("SELECT id, file_path, last_modified FROM tracks WHERE file_path NOT LIKE 'ghost://%'").all()
  let inventory = null
  let walkFailures = null
  const scanned = await scanner.scanFolder(target, {
    saveRoot: false,
    watch: false,
    onInventory(files, failures) {
      inventory = files
      walkFailures = failures
    },
  })
  // A failed metadata read or missing NAS subfolder means the inventory is
  // incomplete. Never interpret that snapshot as deleted files. Reuse the
  // scan's directory walk: scanner.walkDir was not exported, and a second
  // walk could return a different snapshot after a NAS disconnect.
  if (!scanned || scanned.errors || !inventory || walkFailures?.length) return false
  if (!selectedRoot(target) || !await isReadableRoot(target)) return false
  const pruned = require('./libraryPrune').pruneMissingTracks(db, target, files)
  const after = db.prepare("SELECT id, file_path, last_modified FROM tracks WHERE file_path NOT LIKE 'ghost://%'").all()
  const afterIds = new Set(after.map(row => row.id))
  const beforeByPath = new Map(before.map(row => [path.resolve(row.file_path).toLowerCase(), row]))
  const added = []
  const updated = []
  const removed = before.filter(row => !afterIds.has(row.id)).map(row => row.id)
  for (const row of after) {
    const prior = beforeByPath.get(path.resolve(row.file_path).toLowerCase())
    if (!prior) added.push(row.id)
    else if (prior.last_modified !== row.last_modified || prior.id !== row.id) updated.push(row.id)
  }
  // A move can replace an old row with a fresh ID while pruneMissingTracks
  // hands the new row its likes, plays and playlist references.
  if (added.length || updated.length || removed.length || pruned.removed || pruned.moved) {
    broadcast('library:changed', {
      added: [...new Set(added)],
      updated: [...new Set(updated)],
      removed: [...new Set(removed)],
    })
  }
  return true
}

/** Retry an incomplete directory catch-up at most three times; never prune on failure. */
function scheduleCatchUp(delay = CATCH_UP_MS) {
  clearTimeout(catchUp)
  catchUp = setTimeout(async () => {
    catchUp = null
    const pendingRoots = [...catchUpRoots]
    catchUpRoots.clear()
    let retryDelay = CATCH_UP_MS
    for (const candidate of pendingRoots) {
      const attempt = catchUpAttempts.get(candidate) ?? 0
      if (!selectedRoot(candidate)) {
        catchUpAttempts.delete(candidate)
        continue
      }
      let complete = false
      try {
        complete = await scan(candidate)
      } catch (error) {
        console.warn('[libraryWatcher] Catch-up scan failed:', error.message)
      }
      // A newer watch event may have reset this root's retry sequence.
      if (catchUpAttempts.get(candidate) !== attempt) continue
      if (complete) {
        catchUpAttempts.delete(candidate)
      } else if (attempt < MAX_CATCH_UP_RETRIES) {
        catchUpAttempts.set(candidate, attempt + 1)
        catchUpRoots.add(candidate)
        retryDelay = Math.max(retryDelay, CATCH_UP_MS * 2 ** (attempt + 1))
      } else {
        catchUpAttempts.delete(candidate)
        console.warn('[libraryWatcher] Incomplete catch-up after bounded retries:', candidate)
      }
    }
    // An incoming watcher event may already have scheduled a newer catch-up.
    if (catchUpRoots.size && !catchUp) scheduleCatchUp(retryDelay)
  }, delay)
}

function discardPendingForRoot(events, target, ownerFor) {
  const rootPath = path.resolve(target)
  for (const filePath of events.keys()) {
    if (path.resolve(filePath) === rootPath || ownerFor(filePath) === rootPath) {
      events.delete(filePath)
    }
  }
}

/** Windows dropped events: a scan catches up once things are quiet. */
function catchUpLater(folder) {
  const target = path.resolve(folder)
  // An overflow on NAS A must not erase pending local or NAS B changes.
  discardPendingForRoot(pending, target, rootForPath)
  if (!pending.size) {
    clearTimeout(timer)
    timer = null
  } else if (!timer) {
    schedule()
  }
  if (selectedRoot(target)) {
    catchUpRoots.add(target)
    catchUpAttempts.set(target, 0)
  }
  scheduleCatchUp()
}

function attachWatcher(next) {
  if (watchers.has(next)) return
  try {
    const watcher = fs.watch(next, { recursive: true }, (type, name) => {
      // Missing names or buffer overflows trigger safe per-root catch-up.
      if (!name || catchUp) return catchUpLater(next)
      queue(path.join(next, String(name)), type === 'rename')
    })
    watcher.on('error', error => {
      console.warn('[libraryWatcher] Watching stopped:', error.message)
      recover(next)
    })
    watchers.set(next, watcher)
    console.log(`[libraryWatcher] Watching ${next}`)
  } catch (error) {
    console.warn('[libraryWatcher] Could not watch music folder:', next, error.message)
  }
}

/** A failed NAS watcher must not stop every other active library root. */
function recover(folder) {
  const target = path.resolve(folder)
  // Drop only stale events from the failed root; preserve local and other NAS
  // changes already queued for the incremental scanner.
  discardPendingForRoot(pending, target, rootForPath)
  const failed = watchers.get(target)
  if (failed) {
    try { failed.close() } catch {}
    watchers.delete(target)
  }
  roots = [...watchers.keys()]
  root = roots[0] || null

  clearTimeout(recovering.get(target))
  recovering.set(target, setTimeout(async () => {
    recovering.delete(target)
    if (!selectedRoot(target)) return
    try {
      await scan(target)
    } catch (error) {
      console.warn('[libraryWatcher] Recovery scan failed:', error.message)
    }
    // Probe only the affected mount. Restarting every watcher here would
    // drop unrelated local edits made while the NAS was reconnecting.
    try {
      const { isReadableRoot } = require('./ipc/networkLibrary')
      if (selectedRoot(target) && !watchers.has(target) && await isReadableRoot(target)) {
        attachWatcher(target)
        roots = [...watchers.keys()]
        root = roots[0] || null
      }
    } catch (error) {
      console.warn('[libraryWatcher] Watcher reconnection failed:', error.message)
    }
  }, RECOVER_MS))
}

function watchLibrary(folder) {
  return watchLibraryRoots(folder ? [folder] : [])
}

/** Watch every selected music root; changes are batched through the same scanner. */
function watchLibraryRoots(folderPaths = []) {
  const nextRoots = []
  const seen = new Set()
  for (const value of Array.isArray(folderPaths) ? folderPaths : []) {
    if (typeof value !== 'string' || !value.trim()) continue
    const full = path.resolve(value.trim())
    // The network-source scanner already probes directory access before
    // supplying roots. A synchronous statSync here could still freeze
    // Electron if the NAS disappears between probing and watcher setup.
    if (seen.has(full.toLowerCase())) continue
    seen.add(full.toLowerCase())
    nextRoots.push(full)
  }
  if (nextRoots.length === roots.length && nextRoots.every((value, index) => value.toLowerCase() === roots[index]?.toLowerCase()) && watchers.size === nextRoots.length) return

  stopWatching()
  roots = nextRoots
  root = nextRoots[0] || null
  for (const next of nextRoots) attachWatcher(next)
  // Only directories whose fs.watch was successfully established are active.
  // Unavailable NAS roots remain in persisted settings, not in live watchers.
  roots = [...watchers.keys()]
  root = roots[0] || null
}

function stopWatching() {
  for (const watcher of watchers.values()) {
    try { watcher.close() } catch {}
  }
  watchers.clear()
  roots = []
  root = null
  clearTimeout(timer)
  timer = null
  clearTimeout(catchUp)
  catchUp = null
  catchUpRoots.clear()
  catchUpAttempts.clear()
  for (const timeout of recovering.values()) clearTimeout(timeout)
  recovering.clear()
  pending.clear()
}


module.exports = { watchLibrary, watchLibraryRoots, stopWatching, scanRootForCatchUp: scan, discardPendingForRoot }
