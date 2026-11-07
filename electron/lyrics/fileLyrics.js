// Lyrics inside the audio file itself -- read for the tag editor and written
// only when the user asks for it (tag editor save, "Insert into track").
//
// MP3 (ID3v2) keeps synced lyrics in two frames, and players differ in which
// one they read, so both are written:
//   USLT -- one text block; LRC ("[mm:ss.xx] line") when synced, plain otherwise
//   SYLT -- binary lines with millisecond times; only when the text is synced
// An existing USLT is replaced in place (same language and description), not
// joined by a second one: with two, players show whichever comes first.
// Other formats have a single lyrics field (Vorbis LYRICS, MP4 ©lyr...), which
// gets the same text.
//
// Lokal's own LOKAL_LYRICS tag is rewritten with the new lyrics (or removed)
// so it never shows older words than the standard tags.

const fs = require('fs')
const path = require('path')
const { toPortableLyrics, toPrivateTag, PRIVATE_TAG } = require('./embedded')

let taglib = null
function lib() {
  if (taglib === null) {
    try { taglib = require('node-taglib-sharp') } catch { taglib = false }
  }
  return taglib || null
}

let mm = null
function metadata() {
  if (mm === null) {
    try { mm = require('../musicMetadata') } catch { mm = false }
  }
  return mm || null
}

const LRC_STAMP = /\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/
const LRC_STAMP_AT = /\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/y

/** True when the text has at least one LRC time stamp. */
function isSyncedText(text) {
  return typeof text === 'string' && LRC_STAMP.test(text)
}

/**
 * The song list's Lyrics column: '' (none), 'instrumental' (the file says
 * "Instrumental track without lyrics"), 'unfound' (the file says
 * "Невозможно нагуглить слова этого трека"), 'sync' (LRC time stamps) or 'plain'.
 */
function lyricsKind(text) {
  const value = String(text || '').trim()
  if (!value) return ''
  const words = value.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^instrumental track without lyrics\.?$/i.test(words)) return 'instrumental'
  if (/^невозможно нагуглить слова этого трека\.?$/i.test(words)) return 'unfound'
  return isSyncedText(value) ? 'sync' : 'plain'
}

/** LRC -> [[ms, text], ...] sorted by time. Metadata lines ([ar:...]) are skipped. */
function parseLrc(lrc) {
  const out = []
  for (const line of String(lrc || '').split(/\r?\n/)) {
    const times = []
    let pos = 0
    let m
    LRC_STAMP_AT.lastIndex = 0
    while ((m = LRC_STAMP_AT.exec(line))) {
      const fraction = (m[3] || '0').padEnd(3, '0').slice(0, 3)
      times.push((Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(fraction))
      pos = LRC_STAMP_AT.lastIndex
    }
    const text = line.slice(pos).trim()
    for (const t of times) out.push([t, text])
  }
  return out.sort((a, b) => a[0] - b[0])
}

function lrcStamp(ms) {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`
}

/** SYLT lines (music-metadata shape) -> LRC; null unless the times are milliseconds. */
function syltToLrc(tag) {
  if (!tag || !Array.isArray(tag.syncText) || !tag.syncText.length) return null
  if (tag.timeStampFormat !== 2) return null
  const lines = tag.syncText
    .filter(l => l && l.timestamp != null)
    .map(l => `${lrcStamp(l.timestamp)} ${fixMojibake(String(l.text || '')).replace(/[\r\n]+/g, ' ').trim()}`.trimEnd())
  return lines.length ? lines.join('\n') : null
}

// ---------------------------------------------------------------- broken encodings
//
// Some taggers mark a frame as Latin-1 but put UTF-8 (or Windows-1251) bytes
// in it, so "Припев" reads back as "ÐŸÑ€Ð¸Ð¿ÐµÐ²" (or "Ïðèïåâ"). The original
// bytes are recovered from the misread text and decoded properly.

// Windows-1252's 0x80-0x9F (what a Latin-1 decode shows for those bytes).
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ'
const CP1252_BYTE = new Map([...CP1252_HIGH].map((ch, i) => [ch, 0x80 + i]))

/** The bytes a single-byte decode turned into this text; null if it can't have come from one. */
function singleByteBytes(text) {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0xff) bytes[i] = code
    else if (CP1252_BYTE.has(text[i])) bytes[i] = CP1252_BYTE.get(text[i])
    else return null
  }
  return bytes
}

const CYRILLIC = /[Ѐ-ӿ]/g

/** Text misread from UTF-8 / Windows-1251 bytes, decoded properly; anything else unchanged. */
function fixMojibake(text) {
  if (typeof text !== 'string' || !/[\u0080-ÿ]/.test(text)) return text
  const bytes = singleByteBytes(text)
  if (!bytes) return text
  // UTF-8 read as Latin-1: the bytes form valid UTF-8 with multi-byte characters.
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (utf8 !== text && /[^\u0000-\u007F]/.test(utf8)) return utf8
  } catch { /* not UTF-8 */ }
  // Windows-1251 read as Latin-1: mostly letters from À-ÿ, which as 1251 are Cyrillic.
  const high = (text.match(/[À-ÿ]/g) || []).length
  const letters = (text.match(/\p{L}/gu) || []).length
  if (high >= 3 && high / Math.max(1, letters) > 0.5) {
    try {
      const cp1251 = new TextDecoder('windows-1251').decode(bytes)
      if ((cp1251.match(CYRILLIC) || []).length >= high * 0.8) return cp1251
    } catch {}
  }
  return text
}

const LYRIC_IDS = new Set(['USLT', 'ULT', 'LYRICS', 'UNSYNCEDLYRICS', '©lyr', 'Lyrics'])

/**
 * The lyrics a file's tags hold, as one text: synced (LRC) when any frame has
 * timings -- USLT with LRC stamps first, then SYLT -- else the first plain text.
 * @param meta music-metadata result
 */
function lyricsFromMeta(meta) {
  const common = meta?.common?.lyrics
  const entries = Array.isArray(common) ? common : common ? [common] : []
  const texts = []
  const sylts = []
  for (const e of entries) {
    if (typeof e === 'string') texts.push(e)
    else if (e && typeof e.text === 'string' && e.text.trim()) texts.push(e.text)
    else if (e && Array.isArray(e.syncText) && e.syncText.length) sylts.push(e)
  }
  // Always inspect native lyric frames even when music-metadata provides
  // common.lyrics. Its flattened common text can lose LRC timestamps, while
  // Mornye FLACs also carry the original in native Vorbis comments.
  for (const tag of Object.values(meta?.native || {}).flat()) {
    if (!tag) continue
    if (LYRIC_IDS.has(tag.id)) {
      const v = tag.value
      const text = typeof v === 'string' ? v : typeof v?.text === 'string' ? v.text : ''
      if (text.trim()) texts.push(text)
    }
    if (tag.id === 'SYLT' && tag.value && !sylts.includes(tag.value)) sylts.push(tag.value)
  }
  const clean = texts.map(t => fixMojibake(t).replace(/\r\n?/g, '\n').trim()).filter(Boolean)
  // A word-timed native tag may include separately timed [bg:] vocals while
  // the flattened common tag contains only the lead. Prefer the complete one.
  const bgCount = text => (text.match(/^\s*\[bg\s*:/gim) || []).length
  const synced = clean.filter(isSyncedText)
  if (synced.length) return synced.reduce((best, text) =>
    bgCount(text) > bgCount(best) ? text : best)
  for (const s of sylts) {
    const lrc = syltToLrc(s)
    if (lrc) return lrc
  }
  return clean[0] || null
}

// Sanitize only the editor-facing copy; reading a tag does not rewrite it.
// The canonical lyrics player strips vocal-role markers independently.
function lyricsForEditor(text) {
  const { stripVoicePrefix } = require('./lrc')
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    const stamps = line.match(/^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)/)
    let head = stamps ? stamps[1] : ''
    let body = line.slice(head.length)
    // Enhanced LRC can place the first word stamp before the role marker.
    const wordStamp = body.match(/^(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)/)
    if (wordStamp) {
      head += wordStamp[1]
      body = body.slice(wordStamp[1].length)
    }
    return head + stripVoicePrefix({ text: body }).text
  }).join('\n')
}

/** Editor-facing lyrics, with source tags left untouched until explicit Save. */
async function readFileLyrics(filePath) {
  const lib = metadata()
  if (!lib || !filePath || !fs.existsSync(filePath)) return { text: '', synced: false }
  const meta = await lib.parseFile(filePath, { duration: false, skipCovers: true })
  const text = lyricsForEditor(lyricsFromMeta(meta) || '')
  return { text, synced: isSyncedText(text) }
}

function setPrivateField(T, file, value, tagName = PRIVATE_TAG) {
  const types = T.TagTypes
  const name = String(file.name || '').toLowerCase()
  try {
    if (/\.mp3$/.test(name)) {
      const id3 = file.getTag(types.Id3v2, value != null)
      if (!id3) return
      for (const frame of id3.getFramesByClassType(T.Id3v2FrameClassType.UserTextInformationFrame) || []) {
        if (frame.description === tagName) id3.removeFrame(frame)
      }
      if (value == null) return
      const frame = T.Id3v2UserTextInformationFrame.fromDescription(tagName)
      frame.text = [value]
      id3.addFrame(frame)
    } else if (/\.(m4a|mp4|aac|alac)$/.test(name)) {
      const apple = file.getTag(types.Apple, value != null)
      if (apple) apple.setItunesStrings('com.apple.iTunes', tagName, value == null ? undefined : value)
    } else {
      const xiph = file.getTag(types.Xiph, value != null)
      if (xiph) xiph.setFieldAsStrings(tagName, ...(value == null ? [] : [value]))
    }
  } catch { /* a format without that tag: nothing to keep in sync */ }
}

/** USLT (+ SYLT when synced) on an MP3's ID3v2 tag. Empty text removes them. */
function writeId3(T, file, text) {
  const id3 = file.getTag(T.TagTypes.Id3v2, true)
  const usltType = T.Id3v2FrameClassType.UnsynchronizedLyricsFrame
  const syltType = T.Id3v2FrameClassType.SynchronizedLyricsFrame
  const uslts = id3.getFramesByClassType(usltType) || []
  const sylts = id3.getFramesByClassType(syltType) || []
  // The frame being replaced decides language and description (e.g. "XXX").
  const model = uslts.find(f => f.text && f.text.trim()) || uslts[0] || null
  const language = (model?.language && model.language.length === 3) ? model.language : 'eng'
  const description = model?.description || ''
  for (const f of uslts) id3.removeFrame(f)
  for (const f of sylts) id3.removeFrame(f)
  if (!text) return

  const uslt = T.Id3v2UnsynchronizedLyricsFrame.fromData(description, language, T.StringType.UTF16)
  uslt.text = text
  id3.addFrame(uslt)

  if (isSyncedText(text)) {
    const lines = parseLrc(text)
    if (lines.length) {
      // (node-taglib-sharp exports the SYLT frame as Id3v2Synchronized and a
      // SYLT line as Id3v2SynchronizedLyricsFrame.)
      const sylt = T.Id3v2Synchronized.fromInfo('', language, T.Id3v2SynchronizedTextType.Lyrics, T.StringType.UTF16)
      sylt.format = T.Id3v2TimestampFormat.AbsoluteMilliseconds
      sylt.text = lines.map(([ms, line]) => new T.Id3v2SynchronizedLyricsFrame(ms, line))
      id3.addFrame(sylt)
    }
  }
}

/**
 * Writes lyrics into the file's tags.
 * @param text        LRC or plain text; empty removes the lyrics
 * @param privateTag  LOKAL_LYRICS JSON to keep alongside (word timings), or null
 */
function writeFileLyrics(filePath, text, privateTag = null) {
  const T = lib()
  if (!T) throw new Error('Tag writer unavailable')
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File not found')
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim()
  let file
  try {
    file = T.File.createFromPath(filePath)
    const hadId3v1 = typeof file.tagTypesOnDisk === 'number' && (file.tagTypesOnDisk & T.TagTypes.Id3v1) !== 0
    if (/\.mp3$/i.test(filePath)) writeId3(T, file, clean)
    else file.tag.lyrics = clean || undefined
    setPrivateField(T, file, clean && privateTag ? privateTag : null)
    // taglib adds an ID3v1 tag to MP3s that never had one; don't.
    if (!hadId3v1 && /\.mp3$/i.test(filePath)) { try { file.removeTags(T.TagTypes.Id3v1) } catch {} }
    file.save()
  } catch (e) {
    const busy = /EBUSY|EPERM|EACCES/i.test(String(e?.code || e?.message || ''))
    throw new Error(busy ? 'The file is in use or read-only' : (e?.message || String(e)))
  } finally {
    try { file?.dispose() } catch {}
  }
  return { ok: true, synced: isSyncedText(clean), empty: !clean }
}

/** A lookup result (lines) -> what goes into the file: { text, privateTag }. */
function fromResult(result) {
  return { text: toPortableLyrics(result) || '', privateTag: toPrivateTag(result) }
}

/** Sidecar files (song.lrc...) win over tags when Lokal reads lyrics. */
function sidecarFor(filePath) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath, path.extname(filePath))
  for (const ext of ['.ttml', '.elrc', '.lrc', '.txt']) {
    const candidate = path.join(dir, base + ext)
    try { if (fs.existsSync(candidate)) return candidate } catch {}
  }
  return null
}

module.exports = { lyricsKind, fixMojibake, readFileLyrics, writeFileLyrics, fromResult, lyricsFromMeta, lyricsForEditor, isSyncedText, parseLrc, syltToLrc, sidecarFor, setPrivateField }
