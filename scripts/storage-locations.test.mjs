import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

// Evaluate only this CommonJS module with an in-memory SQLite settings stub.
// No Electron runtime, native database rebuild or external drive is required.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-storage-test-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))
const rows = new Map()
const db = {
  transaction: callback => callback,
  prepare() {
    return {
      get: key => ({ value: rows.get(key) }),
      run: (key, value) => { rows.set(key, value) },
    }
  },
}
const script = readFileSync(new URL('../electron/storageLocations.js', import.meta.url), 'utf8')
const mod = { exports: {} }
vm.runInNewContext(script, {
  module: mod,
  require(id) {
    if (id === './ipc/db') return { getDB: () => db, getStorageDir: () => path.join(root, 'data') }
    if (id === 'fs') return fs
    if (id === 'path') return path
    if (id === 'os') return os
    throw new Error('Unexpected import: ' + id)
  },
  process,
}, { filename: 'storageLocations.js' })
const storage = mod.exports

test('download target honors an explicit output, then the selected disk, then the music library', () => {
  const music = path.join(root, 'music')
  const selected = path.join(root, 'external', 'downloads')
  assert.equal(storage.downloadDirectory({ music_folder: music }), music)
  assert.equal(storage.saveRoot('downloads', selected), selected)
  assert.equal(storage.downloadDirectory({ music_folder: music }), selected)
  assert.equal(storage.downloadDirectory({ music_folder: music }, path.join(root, 'override')), path.join(root, 'override'))
  assert.equal(storage.cacheDirectoryRoot(), path.join(root, 'data'))
  assert.equal(storage.saveRoot('downloads', ''), '')
  assert.equal(storage.downloadDirectory({ music_folder: music }), music)
})

test('paired phone originals follow the user-selected download disk', () => {
  const chosen = path.join(root, 'external', 'mobile-inbound')
  storage.saveRoot('downloads', chosen)
  assert.equal(storage.phoneCopyDirectory(), path.join(chosen, 'Lokal Phone'))
  storage.saveRoot('downloads', '')
  assert.equal(storage.phoneCopyDirectory({ music_folder: path.join(root, 'music') }),
    path.join(root, 'music', 'Lokal Phone'))
})

test('cache location is independent of downloads, database and installation directory', () => {
  const folder = path.join(root, 'other-disk', 'cache')
  assert.equal(storage.saveRoot('cache', folder), folder)
  assert.equal(storage.cacheDirectoryRoot(), folder)
  assert.equal(storage.savedRoot('downloads'), '')
  assert.equal(storage.saveRoot('cache', ''), '')
  assert.equal(storage.cacheDirectoryRoot(), path.join(root, 'data'))
})

test('only an absolute, writeable directory can be selected', () => {
  assert.throws(() => storage.saveRoot('downloads', '../relative'))
  // Reset intentionally accepts an empty selection; the picker only returns
  // absolute paths, and invalid nonempty values must be rejected.
  assert.equal(storage.saveRoot('cache', ''), '')
  assert.throws(() => storage.saveRoot('unsupported', root))
  const file = path.join(root, 'not-a-directory')
  fs.writeFileSync(file, 'not a directory')
  assert.throws(() => storage.saveRoot('downloads', file))
  assert.equal(storage.savedRoot('downloads'), '')
})

test('native folder selection is connected to settings, downloaded files and Lokal caches', () => {
  const read = filename => readFileSync(new URL('../' + filename, import.meta.url), 'utf8')
  const manager = read('electron/download/manager.js')
  assert.match(manager, /storageLocations'\)\.downloadDirectory/)
  assert.match(manager, /download_folder/)
  assert.match(manager, /job\.settings\?\.download_root/)
  assert.match(read('electron/downloadFolder.js'), /explicitRoot/)
  assert.match(read('electron/online/musicVideoDownloads.js'), /savedRoot\('downloads'\)/)
  assert.match(read('electron/cache.js'), /storageLocations'\)\.cacheDirectoryRoot/)
  assert.match(read('electron/ipc/downloader.js'), /cache'\)\.cacheDir\('playback'\)/)
  assert.match(read('electron/ipc/cache.js'), /storage:choose/)
  assert.match(read('electron/preload.js'), /storageLocations/)
  assert.match(read('src/pages/Settings.jsx'), /Download Location/)
  assert.match(read('src/pages/Settings.jsx'), /Cache Location/)
})

test('paired-phone original files have a separate selected destination', () => {
  const initial = storage.phoneCopyDirectory()
  assert.equal(storage.phoneDownloadDirectory(), initial)
  const selected = path.join(root, 'other-disk', 'phone-music')
  assert.equal(storage.saveRoot('phone', selected), selected)
  assert.equal(storage.phoneDownloadDirectory(), selected)
  assert.equal(storage.savedRoot('downloads'), '')
  assert.equal(storage.savedRoot('cache'), '')
  assert.equal(storage.saveRoot('phone', ''), '')
  assert.equal(storage.phoneDownloadDirectory(), initial)
})

test('a changed or missing selected volume rejects phone uploads instead of writing to its mountpoint', () => {
  const selected = path.join(root, 'separate-drive', 'incoming')
  storage.saveRoot('phone', selected)
  const originalDevice = rows.get('phone_download_root_device')
  assert.ok(originalDevice)
  rows.set('phone_download_root_device', 'unexpected-volume')
  assert.throws(() => storage.phoneDownloadDirectory(), /drive has changed/)
  rows.set('phone_download_root_device', originalDevice)
  assert.equal(storage.phoneDownloadDirectory(), selected)
  fs.rmSync(selected, { recursive: true, force: true })
  assert.throws(() => storage.phoneDownloadDirectory(), /drive is unavailable/)
  storage.saveRoot('phone', '')
})

test('phone-upload folder uses validated native selection and cannot be set through the web API', () => {
  const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  assert.match(read('server/linkUpload.js'), /phoneDownloadDirectory\(\)/)
  assert.match(read('electron/ipc/cache.js'), /phone: storage\.savedRoot\('phone'\)/)
  assert.match(read('src/pages/Settings.jsx'), /Incoming phone files/)
  assert.match(read('server/routes/settings.js'), /phone_download_root/)
  assert.match(read('electron/ipc/scanner.js'), /phone_download_root/)
})

test('Windows installer still uses its old configuration', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  assert.equal(pkg.build.nsis?.allowToChangeInstallationDirectory, undefined)
  assert.equal(pkg.build.nsis?.oneClick, undefined)
})
