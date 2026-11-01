// Settings → Data → Cache: what Lokal's caches use, their limit, and clearing
// them. Lokal's own files are in electron/cache.js; Chromium's web cache
// (covers and pages it fetched) is the app session's.

const { app, session, dialog, BrowserWindow } = require('electron')
const db = require('./db')
const cache = require('../cache')
const storage = require('../storageLocations')

async function report() {
  const used = cache.usage()
  let web = 0
  try { web = await session.defaultSession.getCacheSize() } catch {}
  return { motion: used.motion, playback: used.playback, musicVideo: used.musicVideo, addonAudio: used.addonAudio, cast: used.cast, web, limit: cache.limitBytes(), limits: cache.LIMITS_MB }
}

// What the Cache Analysis page and its clean-up need: the open database, the
// signed-in YouTube Music profile (kept by the safe clean-up) and the log being written.
function analysisContext() {
  let database = null
  let activePartition = ''
  let currentLog = null
  try { database = db.getDB() } catch {}
  try { activePartition = database?.prepare("SELECT value FROM settings WHERE key = 'yt_account_partition'").get()?.value || '' } catch {}
  try { currentLog = require('electron-log').transports.file.getFile()?.path || null } catch {}
  return { userData: app.getPath('userData'), dataDir: db.getStorageDir(), db: database, activePartition, currentLog }
}

function registerCacheHandlers(ipcMain) {

  // Browse to another disk from Settings; never change Lokal's install path,
  // database or Chromium sign-in data. Cancel means no change.
  ipcMain.handle('storage:locations', () => ({
    downloads: storage.savedRoot('downloads'),
    cache: storage.savedRoot('cache'),
    phone: storage.savedRoot('phone'),
    defaultPhone: storage.phoneDownloadDirectory(),
    defaultDownloads: storage.downloadDirectory({}),
    defaultCache: db.getStorageDir(),
  }))
  ipcMain.handle('storage:choose', async (event, kind) => {
    if (!storage.KEYS[kind]) return { error: 'Unknown storage location' }
    try {
      const options = {
        title: kind === 'cache' ? 'Select app cache location' :
          kind === 'phone' ? 'Select paired-phone files destination' : 'Select download location',
        defaultPath: storage.savedRoot(kind) ||
          (kind === 'cache' ? db.getStorageDir() :
            kind === 'phone' ? storage.phoneDownloadDirectory() : storage.downloadDirectory({})),
        properties: ['openDirectory', 'createDirectory'],
      }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths?.length) return { canceled: true }
      return { root: storage.saveRoot(kind, result.filePaths[0]) }
    } catch (error) {
      return { error: error?.message || String(error) }
    }
  })
  ipcMain.handle('storage:reset', (_, kind) => {
    try { return { root: storage.saveRoot(kind, '') } }
    catch (error) { return { error: error?.message || String(error) } }
  })
  ipcMain.handle('cache:usage', () => report())
  // After the limit is changed: bring the caches under it now.
  ipcMain.handle('cache:trim', () => { cache.trim(); return report() })
  ipcMain.handle('cache:clear', async () => {
    cache.clear()
    try { await session.defaultSession.clearCache() } catch {}
    return report()
  })

  // The Cache Analysis page: everything in the app's folder, by section.
  let analysis = null
  ipcMain.handle('cacheAnalysis:run', (event) => {
    if (!analysis) {
      const onProgress = (current) => { try { if (!event.sender.isDestroyed()) event.sender.send('cacheAnalysis:progress', { running: true, current }) } catch {} }
      analysis = require('../cacheAnalysis').analyze({ ...analysisContext(), onProgress })
        .then(report => ({ ok: true, report }), e => ({ ok: false, error: e?.message || String(e) }))
        .finally(() => { analysis = null })
    }
    return analysis
  })

  // Its clean-up buttons: 'safe' or 'full' (see electron/cacheCleanup.js).
  let cleaning = null
  ipcMain.handle('cacheAnalysis:clean', (_, mode) => {
    if (!cleaning) {
      cleaning = require('../cacheCleanup').clean({ ...analysisContext(), mode: mode === 'full' ? 'full' : 'safe', electron: { session } }).catch(e => ({ ok: false, error: e?.message || String(e) })).finally(() => { cleaning = null })
    }
    return cleaning
  })
}

module.exports = { registerCacheHandlers }
