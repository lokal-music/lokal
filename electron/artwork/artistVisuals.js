// Apple Music artist editorial assets for the desktop artist header.
// Mirrors mobile PRs #407/#413: verified catalogue match, persistent PNG logo,
// optional silent square video and conservative fallback on any failure.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { getStorageDir } = require('../ipc/db')
const { norm, cachedClip } = require('./motion')

const HIT_TTL = 6 * 60 * 60 * 1000
const MISS_TTL = 20 * 60 * 1000
const pending = new Map()
const memory = new Map()
const UA = 'Mozilla/5.0 (compatible; Lokal/artist-art)'

function safeURL(value, kind = 'page') {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const host = url.hostname.toLowerCase()
    if (kind === 'logo' && !(host === 'mzstatic.com' || host.endsWith('.mzstatic.com'))) return null
    if (kind === 'page' && host !== 'music.apple.com' && host !== 'itunes.apple.com') return null
    if (kind === 'video' && !(
      host === 'apple.com' || host.endsWith('.apple.com') ||
      host === 'itunes.apple.com' || host.endsWith('.itunes.apple.com') ||
      host === 'mzstatic.com' || host.endsWith('.mzstatic.com') ||
      host.endsWith('.cdn-apple.com')
    )) return null
    return url.href
  } catch { return null }
}

function parseVisuals(html) {
  const match = String(html || '').match(/<script\b[^>]*\bid=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!match) return null
  let data
  try { data = JSON.parse(match[1]) } catch { return null }
  const findHeader = (node, depth = 0) => {
    if (!node || depth > 32) return null
    if (Array.isArray(node)) {
      for (const value of node) { const found = findHeader(value, depth + 1); if (found) return found }
    } else if (typeof node === 'object') {
      if (node.artistLogo && (node.artwork || node.colorBackdropArtwork)) return node
      for (const value of Object.values(node)) { const found = findHeader(value, depth + 1); if (found) return found }
    }
    return null
  }
  const header = findHeader(data)
  if (!header) return null
  const logo = header.artistLogo?.dictionary
  const sourceWidth = Number(logo?.width)
  const sourceHeight = Number(logo?.height)
  const template = logo?.url
  let logoURL = null
  if (sourceWidth > 0 && sourceHeight > 0 && typeof template === 'string' &&
      template.includes('{w}') && template.includes('{h}')) {
    logoURL = safeURL(template.replace(/\{w\}/g, '1000')
      .replace(/\{h\}/g, String(Math.min(4000, Math.max(1, Math.round(1000 * sourceHeight / sourceWidth)))))
      .replace(/\{c\}/g, 'bb').replace(/\{f\}/g, 'png'), 'logo')
  }
  const motionURL = safeURL(header.videoArtwork?.dictionary?.motionArtistSquare1x1?.video, 'video')
  if (!logoURL && !motionURL) return null
  return { logoURL, logoAspect: sourceWidth && sourceHeight ? Math.min(6, Math.max(.4, sourceWidth / sourceHeight)) : 1, motionURL }
}

async function boundedFetch(url, { fetchImpl = fetch, timeoutMs = 12000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: controller.signal, redirect: 'error' })
    if (!response.ok || Number(response.headers?.get?.('content-length') || 0) > maxBytes) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length <= maxBytes ? bytes : null
  } finally { clearTimeout(timer) }
}

async function appleJson(url, options) {
  const bytes = await boundedFetch(url, { ...options, maxBytes: 3 * 1024 * 1024 })
  if (!bytes) return null
  try { return JSON.parse(bytes.toString('utf8')) } catch { return null }
}

function cachePath(id, directory = path.join(getStorageDir(), 'artist-editorial')) {
  return path.join(directory, crypto.createHash('sha256').update(String(id)).digest('hex') + '.json')
}
function readCache(id, directory) {
  const file = cachePath(id, directory)
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8'))
    return result?.artistId === String(id) ? result : null
  } catch { return null }
}

function acceptedCache(record, artistName, knownTitles) {
  return record && norm(record.name) === norm(artistName) &&
    Array.isArray(record.proof) && record.proof.some(t => knownTitles.has(t))
}

function publicResult(record) {
  return {
    logoFile: record.logoFile && fs.existsSync(record.logoFile) ? record.logoFile : null,
    logoAspect: record.logoAspect || 1,
    // Motion is loaded independently to avoid blocking first paint/remux.
  }
}

async function saveLogo(url, artistId, directory, options) {
  if (!safeURL(url, 'logo')) return null
  const buffer = await boundedFetch(url, options)
  if (!buffer || buffer.length < 8 ||
      !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null
  const folder = path.join(directory, 'logos')
  await fs.promises.mkdir(folder, { recursive: true })
  const name = crypto.createHash('sha256').update(String(artistId)).digest('hex').slice(0, 20) +
    '-' + crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 20) + '.png'
  const target = path.join(folder, name)
  if (!fs.existsSync(target)) {
    const temp = target + '.' + process.pid + '.tmp'
    await fs.promises.writeFile(temp, buffer)
    await fs.promises.rename(temp, target)
  }
  return target
}

async function lookupApple(artistName, knownTitles, { fetchImpl, directory }) {
  const opts = { fetchImpl }
  // The same public iTunes artist and top-song matching used on mobile.
  const artists = await appleJson('https://itunes.apple.com/search?' + new URLSearchParams({
    term: artistName, entity: 'musicArtist', media: 'music', limit: '12', country: 'us'
  }), opts)
  const candidates = (artists?.results || []).filter(a => a.artistId && norm(a.artistName) === norm(artistName))
  for (const candidate of candidates) {
    const songs = await appleJson('https://itunes.apple.com/lookup?' + new URLSearchParams({
      id: String(candidate.artistId), entity: 'song', sort: 'popular', limit: '25', country: 'us'
    }), opts)
    const proof = [...new Set((songs?.results || []).filter(s => s.wrapperType === 'track')
      .flatMap(s => [norm(s.trackName), norm(s.collectionName)])
      .filter(title => knownTitles.has(title)))]
    if (!proof.length) continue
    const page = safeURL('https://music.apple.com/us/artist/-/' + encodeURIComponent(candidate.artistId))
    const html = await boundedFetch(page, { fetchImpl, maxBytes: 6 * 1024 * 1024 })
    if (!html) return null
    const visuals = parseVisuals(html.toString('utf8'))
    if (!visuals) return null
    const logoFile = visuals.logoURL
      ? await saveLogo(visuals.logoURL, candidate.artistId, directory, opts).catch(() => null)
      : null
    return {
      artistId: '', name: artistName, proof, 
      logoFile, logoAspect: visuals.logoAspect, motionURL: visuals.motionURL,
      fetchedAt: Date.now()
    }
  }
  return null
}

async function artistVisualsFor(artistId, artistName, titles, options = {}) {
  const name = String(artistName || '').trim()
  const known = new Set((Array.isArray(titles) ? titles : []).map(norm).filter(Boolean))
  if (!artistId || !name || !known.size) return null
  const directory = options.directory || path.join(getStorageDir(), 'artist-editorial')
  const key = String(artistId)
  const stored = memory.get(key) || readCache(key, directory)
  const valid = acceptedCache(stored, name, known)
  if (!options.force && valid && Date.now() - stored.fetchedAt < (stored.logoFile || stored.motionURL ? HIT_TTL : MISS_TTL)) {
    return publicResult(stored)
  }
  if (!pending.has(key)) {
    const job = (async () => {
      let result = null
      try {
        result = await lookupApple(name, known, { ...options, directory })
        if (result) {
          result.artistId = key
          await fs.promises.mkdir(directory, { recursive: true })
          const dest = cachePath(key, directory)
          const temp = dest + '.' + process.pid + '.tmp'
          await fs.promises.writeFile(temp, JSON.stringify(result))
          await fs.promises.rename(temp, dest)
          memory.set(key, result)
        }
      } catch { /* Editorial data is optional. Preserve cached art. */ }
      // A namesake miss must never expose a previous artist's artwork.
      return result ? publicResult(result) : valid ? publicResult(stored) : null
    })().finally(() => pending.delete(key))
    pending.set(key, job)
  }
  return pending.get(key)
}

async function artistMotionFor(artistId, settings, { ffmpeg, cacheDir, directory } = {}) {
  if (settings?.motion_covers === '0' || !ffmpeg || !cacheDir) return null
  const row = memory.get(String(artistId)) || readCache(artistId, directory)
  const url = safeURL(row?.motionURL, 'video')
  if (!url) return null
  const file = await cachedClip({ url, kind: /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'mp4' }, {
    cacheDir, ffmpeg, highResolution: settings?.high_resolution_motion_covers === '1'
  })
  return file ? { file, source: 'apple' } : null
}

module.exports = { parseVisuals, safeURL, acceptedCache, artistVisualsFor, artistMotionFor }
