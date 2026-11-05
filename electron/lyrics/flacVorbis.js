// FLAC's VORBIS_COMMENT block may contain two distinct lyrics fields:
// lead-synced text and independent [bg:] enhanced-LRC rows. music-metadata's
// common.lyrics can flatten or drop the latter, so read only the bounded FLAC
// metadata blocks, never the audio payload.
'use strict'
const fs = require('node:fs/promises')

const MAX_BLOCK = 4 * 1024 * 1024
const KEYS = new Set(['LYRICS', 'UNSYNCEDLYRICS', 'UNSYNCED_LYRICS', 'SYNCEDLYRICS', 'SYNCED_LYRICS'])
const BG = /^\s*\[bg\s*:/im
const LEAD = /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m

function backgroundRows(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map(row => row.trim())
    .filter(row => BG.test(row))
}
function hasLead(text) { return LEAD.test(String(text || '')) }

/** Deduplicate independent timed vocals while respecting the primary lead. */
function attachBackgroundRows(primary, ...sources) {
  const source = String(primary || '').trim()
  if (!source) return null
  const seen = new Set(source.split(/\r?\n/).map(line => line.trim()))
  const extras = []
  for (const entry of sources) {
    for (const row of backgroundRows(entry)) {
      if (!seen.has(row)) { seen.add(row); extras.push(row) }
    }
  }
  return extras.length ? source + '\n' + extras.join('\n') : source
}

/** Prefer time-synchronised lead lyrics; never let a bg-only tag replace them. */
function selectWithBacking(candidates) {
  const values = [...candidates].filter(value => typeof value === 'string' && value.trim())
  if (!values.length) return null
  const leads = values.filter(hasLead)
  const pool = leads.length ? leads : values
  let best = pool[0]
  for (const value of pool.slice(1)) {
    const score = text => (hasLead(text) ? 100000 : 0) +
      (backgroundRows(text).length * 10000) + Math.min(text.length, 9999)
    if (score(value) > score(best)) best = value
  }
  return attachBackgroundRows(best, ...values)
}

function fromVorbisCommentBlock(data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || [])
  if (data.length < 8) return null
  let at = 0
  function size() {
    if (at + 4 > data.length) return null
    const length = data.readUInt32LE(at)
    at += 4
    if (length > data.length - at) return null
    return length
  }
  const vendor = size()
  if (vendor == null) return null
  at += vendor
  if (at + 4 > data.length) return null
  const count = data.readUInt32LE(at); at += 4
  if (count > 100000) return null
  const texts = []
  for (let i = 0; i < count; i++) {
    const length = size()
    if (length == null) break
    const entry = data.toString('utf8', at, at + length)
    at += length
    const eq = entry.indexOf('=')
    if (eq < 1 || !KEYS.has(entry.slice(0, eq).toUpperCase())) continue
    const value = entry.slice(eq + 1).trim()
    if (value) texts.push(value)
  }
  return selectWithBacking(texts)
}

async function readFlacLyrics(filePath) {
  if (typeof filePath !== 'string' || !/\.flac$/i.test(filePath)) return null
  let fh
  try {
    fh = await fs.open(filePath, 'r')
    const header = Buffer.alloc(4)
    if ((await fh.read(header, 0, 4, 0)).bytesRead !== 4 ||
        header.toString('ascii') !== 'fLaC') return null
    let at = 4
    let last = false
    for (let i = 0; i < 128 && !last; i++) {
      const block = Buffer.alloc(4)
      if ((await fh.read(block, 0, 4, at)).bytesRead !== 4) return null
      last = (block[0] & 128) !== 0
      const type = block[0] & 127
      const length = block.readUIntBE(1, 3)
      at += 4
      if (type === 4) {
        if (length > MAX_BLOCK) return null
        const data = Buffer.alloc(length)
        if ((await fh.read(data, 0, length, at)).bytesRead !== length) return null
        return fromVorbisCommentBlock(data)
      }
      at += length
    }
  } catch { /* missing file and unsupported metadata are non-fatal */ }
  finally { await fh?.close().catch(() => {}) }
  return null
}

module.exports = { readFlacLyrics, fromVorbisCommentBlock, selectWithBacking, attachBackgroundRows, backgroundRows, hasLead }
