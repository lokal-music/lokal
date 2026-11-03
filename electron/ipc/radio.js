// Online radio IPC: the station catalogue (downloaded, parsed, kept as data in
// settings -- never the file) and the stations' own now-playing APIs.

const { getDB } = require('./db')
const { loadCatalog } = require('../radio/catalog')
const { nowPlaying } = require('../radio/nowPlaying')
const { browseStations } = require('../radio/browser')
const { visibleStationMetadata } = require('../radio/metadata')

function readSetting(key) {
  try { return getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null } catch { return null }
}

function writeSettings(values) {
  const db = getDB()
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  db.transaction(() => { for (const [key, value] of Object.entries(values)) stmt.run(key, String(value)) })()
}

/** The saved catalogue: { url, catalog, updatedAt } (catalog null if none yet). */
function getCatalog() {
  let catalog = null
  try { catalog = JSON.parse(readSetting('radio_catalog') || 'null') } catch {}
  return { url: readSetting('radio_catalog_url') || '', catalog, updatedAt: Number(readSetting('radio_catalog_updated_at')) || 0 }
}

/**
 * Download and parse the catalogue at `url`. Saved only when it parses, so a
 * broken file never replaces the stations already there.
 */
async function loadAndSave(url, { publicOnly = false } = {}) {
  const result = await loadCatalog(url, { publicOnly })
  if (!result.ok) return result
  const updatedAt = Date.now()
  writeSettings({ radio_catalog_url: String(url).trim(), radio_catalog: JSON.stringify(result.catalog), radio_catalog_updated_at: updatedAt })
  return { ok: true, url: String(url).trim(), catalog: result.catalog, updatedAt }
}

function registerRadioHandlers(ipcMain) {
  ipcMain.handle('radio:getCatalog', () => getCatalog())
  ipcMain.handle('radio:loadCatalog', (_, url) => loadAndSave(url).catch(error => ({ ok: false, errors: [{ path: '', code: 'network', detail: String(error?.message || error) }] })))
  ipcMain.handle('radio:nowPlaying', (_, api) => nowPlaying(api).catch(() => null))
  ipcMain.handle('radio:browse', (_, params) => browseStations(params))
  ipcMain.handle('radio:stationMetadata', (_, station) => visibleStationMetadata(station))
}

module.exports = { registerRadioHandlers, getCatalog, loadAndSave }
