// Now-playing visuals: the colour mesh behind the Details sidebar and the
// fullscreen player, and moving covers (see electron/artwork/*). Everything is
// looked up by track id, from the library -- the renderer never hands us paths.

const path = require('path')
const fs = require('fs')
const { getDB, getStorageDir } = require('./db')
const { meshFromImage } = require('../artwork/mesh')
const { motionCoverFor } = require('../artwork/motion')
const { artistVisualsFor, artistMotionFor } = require('../artwork/artistVisuals')
const { httpsImageURL } = require('../playlists/remoteCover')

const MAX_REMOTE_ARTWORK_BYTES = 10 * 1024 * 1024

function trackRow(trackId) {
  try { return getDB().prepare('SELECT id, title, artist, album, file_path, artwork_path, artwork_url FROM tracks WHERE id = ?').get(trackId) || null } catch { return null }
}

function settingsMap() {
  try { return Object.fromEntries(getDB().prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])) } catch { return {} }
}

/**
 * The cover of an online song (a ghost row) to take colours from, or null:
 * https only, never this computer or the local network. Any host: a song
 * played from YouTube after its addon failed keeps the addon's cover.
 */
function remoteArtworkURL(track) {
  if (!/^ghost:\/\/(?:youtube|soundcloud|addon)\//.test(String(track?.file_path || ''))) return null
  return httpsImageURL(track?.artwork_url)
}

async function meshForTrack(trackId) {
  const track = trackRow(trackId)
  const art = track?.artwork_path
  if (art && fs.existsSync(art)) {
    let stamp = ''
    try { stamp = String(fs.statSync(art).mtimeMs) } catch {}
    return meshFromImage(art, `${art}|${stamp}`)
  }
  const url = remoteArtworkURL(track)
  if (!url) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal })
    if (!response.ok) return null
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_REMOTE_ARTWORK_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(Buffer.from(value))
    }
    const buffer = Buffer.concat(chunks, total)
    return meshFromImage(buffer, `remote|${url.toString()}`)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The colour mesh of a remote cover (HTTPS only, bounded response size).
 * Online radio has no library row, so its artwork arrives as a URL.
 */
async function meshFromRemoteURL(url) {
  if (!url) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_REMOTE_ARTWORK_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(Buffer.from(value))
    }
    return meshFromImage(Buffer.concat(chunks, total), `remote|${url.toString()}`)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function motionCacheDir() {
  return require('../cache').cacheDir('motion')
}

async function motionForTrack(trackId, ffmpeg) {
  const track = trackRow(trackId)
  if (!track) return null
  return motionCoverFor(getDB(), track, {
    settings: settingsMap(),
    cacheDir: motionCacheDir(),
    ffmpeg,
  })
}

/** Settings' Spotify "Save & Test", with the cookie as saved. */
function spotifyCheck() {
  const { checkSpotify } = require('../artwork/spotify')
  return checkSpotify(settingsMap().spotify_sp_dc)
}

function registerArtworkFxHandlers(ipcMain) {
  const { findFfmpeg } = require('./tools')
  ipcMain.handle('artwork:mesh', (_, trackId) => meshForTrack(trackId).catch(() => null))
  ipcMain.handle('artwork:meshFromUrl', (_, url) => meshFromRemoteURL(httpsImageURL(url)).catch(() => null))
  ipcMain.handle('artwork:motion', (_, trackId) => motionForTrack(trackId, findFfmpeg()).catch(() => null))
  ipcMain.handle('artwork:artistVisuals', (_, artistId, name, titles) =>
    artistVisualsFor(artistId, name, titles).catch(() => null))
  ipcMain.handle('artwork:artistMotion', (_, artistId) =>
    artistMotionFor(artistId, settingsMap(), {
      ffmpeg: findFfmpeg(), cacheDir: motionCacheDir(),
    }).catch(() => null))
  ipcMain.handle('artwork:spotifyCheck', () => spotifyCheck())
}

module.exports = { registerArtworkFxHandlers, meshForTrack, meshFromRemoteURL, remoteArtworkURL, motionForTrack, motionCacheDir, spotifyCheck }
