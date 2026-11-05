// LastWave/Eclipse HTTP add-on: bounded, unencrypted *static* audio DASH.
// Mirrors mobile's SegmentTemplate + SegmentTimeline path. Assemble the init
// and segments into a seekable local fMP4; never hand an MPD to audio decoders.
// No DRM stripping, dynamic MPDs, arbitrary network hosts or media headers.
'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const os = require('node:os')

const MAX_MPD_BYTES = 1024 * 1024
const MAX_SEGMENTS = 512
const MAX_AUDIO_BYTES = 512 * 1024 * 1024
const SEGMENT_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 30000

function guardMediaUrl(value, addonBase) {
  let uri, addon
  try {
    uri = new URL(value)
    addon = new URL(addonBase)
  } catch { throw new Error('LastWave returned an invalid media URL.') }
  if (uri.username || uri.password || uri.hash ||
      !['https:', 'http:'].includes(uri.protocol)) throw new Error('Invalid add-on DASH media URL.')
  // A same-origin explicitly configured LAN add-on can serve its own assets.
  if (uri.origin === addon.origin && (uri.protocol === 'https:' || uri.hostname === 'localhost' || uri.hostname.endsWith('.local'))) return uri.toString()
  if (uri.protocol !== 'https:') throw new Error('DASH media must use HTTPS.')
  const host = uri.hostname.toLowerCase()
  if (!host.includes('.') || host.endsWith('.') ||
      /(?:^localhost$|\.(?:local|localhost|internal|lan|home)$)/.test(host) ||
      /^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|\[?fc|\[?fd)/.test(host)) {
    throw new Error('DASH media cannot use private network hosts.')
  }
  return uri.toString()
}

function extractManifest(response, addonBase) {
  const source = response && typeof response === 'object' ? response : {}
  for (const item of [source.manifestXml, source.dataUrl, source.url,
    source.directUrl, source.streamUrl, source.downloadUrl, source.mediaUrl]) {
    if (typeof item !== 'string' || !item.trim()) continue
    if (/^data:application\/dash\+xml[;,]/i.test(item)) {
      if (item.length > MAX_MPD_BYTES * 2) throw new Error('DASH manifest is too large.')
      const at = item.indexOf(',')
      if (at < 0) throw new Error('Invalid inline DASH manifest.')
      const header = item.slice(0, at)
      let xml
      try {
        xml = /;base64$/i.test(header) ? Buffer.from(item.slice(at + 1), 'base64').toString('utf8')
          : decodeURIComponent(item.slice(at + 1))
      } catch { throw new Error('Invalid DASH manifest encoding.') }
      if (Buffer.byteLength(xml) > MAX_MPD_BYTES || !/<MPD\b/.test(xml)) throw new Error('Invalid inline DASH manifest.')
      return { xml, base: addonBase }
    }
    if (/^\s*(?:<\?xml[^>]*>\s*)?<MPD\b/.test(item)) {
      if (Buffer.byteLength(item) > MAX_MPD_BYTES) throw new Error('DASH manifest is too large.')
      return { xml: item, base: addonBase }
    }
    try {
      const url = new URL(item)
      if (/\.mpd$/i.test(url.pathname)) return { url: guardMediaUrl(item, addonBase), base: item }
    } catch (e) {
      if (/\.mpd(?:\?|$)/i.test(item)) throw e
    }
  }
  return null
}

function attrs(tag) {
  const result = {}
  for (const match of String(tag).matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(['"])(.*?)\2/g)) result[match[1]] = match[3]
  return result
}
const tag = (xml, name) => [...String(xml).matchAll(new RegExp('<(?:\\w+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + name + '\\s*>', 'g'))]
const start = (xml, name) => [...String(xml).matchAll(new RegExp('<(?:\\w+:)?' + name + '\\b[^>]*\/?>', 'g'))]
const rootAttrs = (xml, name) => attrs(start(xml, name)[0]?.[0] || '')

function parseStaticMpd(xml, manifestBase, addonBase) {
  if (Buffer.byteLength(xml) > MAX_MPD_BYTES ||
      /<!DOCTYPE|<!ENTITY|<\s*ContentProtection\b/i.test(xml)) {
    throw new Error('Unsupported or protected DASH manifest.')
  }
  const mpd = rootAttrs(xml, 'MPD')
  if (!start(xml, 'MPD').length || (mpd.type && mpd.type !== 'static')) throw new Error('Only static DASH audio is supported.')
  const periods = tag(xml, 'Period')
  if (periods.length !== 1) throw new Error('Unsupported DASH period layout.')
  const sets = tag(periods[0][1], 'AdaptationSet')
  const audio = sets.filter(s => {
    const a = attrs(s[0]); return a.contentType === 'audio' || String(a.mimeType || '').startsWith('audio/')
  })
  if (!audio.length) throw new Error('No DASH audio rendition.')
  const reps = tag(audio[0][1], 'Representation')
    .sort((x, y) => Number(attrs(y[0]).bandwidth || 0) - Number(attrs(x[0]).bandwidth || 0))
  if (!reps.length) throw new Error('DASH audio representation missing.')
  const rep = reps[0]
  const template = start(rep[1], 'SegmentTemplate')[0] ||
    start(audio[0][1].replace(/<Representation\b[^>]*>[\s\S]*?<\/Representation>/g, ''), 'SegmentTemplate')[0]
  if (!template) throw new Error('Unsupported DASH segment layout.')
  const fields = attrs(template[0])
  if (!fields.initialization || !/\$Number(?:%0[1-8]d)?\$/.test(fields.media || '')) throw new Error('Unsupported DASH URL template.')
  let base = manifestBase
  for (const section of [xml, periods[0][1], audio[0][1], rep[1]]) {
    const baseTag = tag(section, 'BaseURL')[0]
    if (baseTag?.[1]) base = guardMediaUrl(new URL(baseTag[1].trim(), base).toString(), addonBase)
  }
  const repId = attrs(rep[0]).id || ''
  function expand(template, number) {
    const replaced = template.replaceAll('$RepresentationID$', repId)
      .replace(/\$Number(?:%0([1-8])d)?\$/g, (_, pad) => {
        if (number == null) throw new Error('DASH init cannot contain segment number.')
        return String(number).padStart(Number(pad) || 0, '0')
      })
    if (replaced.includes('$')) throw new Error('Unsupported DASH URL token.')
    return guardMediaUrl(new URL(replaced, base).toString(), addonBase)
  }
  const timeline = tag(rep[1], 'SegmentTimeline')[0] ||
    tag(audio[0][1], 'SegmentTimeline')[0]
  if (!timeline) throw new Error('DASH segment timeline missing.')
  let count = 0
  for (const segment of start(timeline[1], 'S')) {
    const { d, r = '0' } = attrs(segment[0])
    const duration = Number(d), repeat = Number(r)
    if (!Number.isSafeInteger(duration) || duration <= 0 ||
        !Number.isSafeInteger(repeat) || repeat < 0 || repeat > MAX_SEGMENTS) {
      throw new Error('Unsupported DASH timeline.')
    }
    count += repeat + 1
    if (count > MAX_SEGMENTS) throw new Error('DASH has too many segments.')
  }
  const startNumber = Number(fields.startNumber || 1)
  if (count < 1 || !Number.isSafeInteger(startNumber) || startNumber < 0) throw new Error('Invalid DASH segment numbering.')
  return {
    initUrl: expand(fields.initialization),
    segments: Array.from({ length: count }, (_, i) => expand(fields.media, i + startNumber)),
  }
}

/** Downloads and joins the selected audio representation in the playback cache. */
async function stageAddonDash(manifest, addonBase, { fetchImpl = fetch, signal, key = '' } = {}) {
  let xml = manifest.xml
  if (!xml) {
    const response = await fetchImpl(guardMediaUrl(manifest.url, addonBase), {
      signal: signal || AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
    })
    if (!response.ok) throw new Error('The DASH manifest could not be fetched.')
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > MAX_MPD_BYTES) throw new Error('DASH manifest is too large.')
    xml = data.toString('utf8')
  }
  const plan = parseStaticMpd(xml, manifest.base, addonBase)
  const dir = require('../cache').cacheDir('playback') || path.join(os.tmpdir(), 'lokal-playback-cache')
  await fsp.mkdir(dir, { recursive: true })
  const digest = crypto.createHash('sha256').update(key + '\n' + xml).digest('hex').slice(0, 24)
  const dest = path.join(dir, 'addon-dash-' + digest + '.m4a')
  if ((await fsp.stat(dest).catch(() => null))?.size > 0) return dest
  const tmp = dest + '.' + process.pid + '.part'
  let length = 0
  try {
    const output = fs.createWriteStream(tmp, { flags: 'wx' })
    try {
      for (const address of [plan.initUrl, ...plan.segments]) {
        const response = await fetchImpl(address, {
          signal: signal || AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
        })
        if (!response.ok || !response.body) throw new Error('The DASH audio segment could not be fetched.')
        const part = Buffer.from(await response.arrayBuffer())
        if (!part.length || part.length > SEGMENT_BYTES ||
            (length += part.length) > MAX_AUDIO_BYTES) throw new Error('DASH audio exceeds playback limits.')
        if (!output.write(part)) await new Promise(resolve => output.once('drain', resolve))
      }
      await new Promise((resolve, reject) => output.end(err => err ? reject(err) : resolve()))
    } catch (error) { output.destroy(); throw error }
    await fsp.rename(tmp, dest)
    return dest
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    throw error
  }
}
module.exports = { guardMediaUrl, extractManifest, parseStaticMpd, stageAddonDash }
