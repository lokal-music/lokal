// The LRC family -> Lokal lyrics.
//
//   plain LRC       [01:02.34]a whole line            (line-synced, start only)
//   enhanced LRC    [01:02.34]<01:02.34>a <01:02.80>word <01:03.10>   (word stamps)
//   karaoke LRC     [62340,1200](62340,300,0)a (62640,500,0)word      (QQ QRC / NetEase YRC)
//
// A line-synced LRC only says when a line *starts*. Its end is left null rather
// than guessed from the next stamp: that distance is the line's own slot, and
// reading it as "singing stopped here" would put an interlude after every line.

const { unit, joinUnits, spacing, round3 } = require('./model')
const { decodeEntities } = require('./xml')

const LINE_STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_STAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const META_TAG = /^\[(ar|ti|al|au|by|re|ve|length|offset|id|hash|sign|qq|total|#)\s*:.*\]$/i

function stampToSeconds(min, sec, frac) {
  let fraction = 0
  if (frac) fraction = parseInt(frac, 10) / Math.pow(10, frac.length)
  return round3(parseInt(min, 10) * 60 + parseInt(sec, 10) + fraction)
}

// Some LRC providers (including lrc.red via Mornye) annotate vocal roles as
// "v1:" / "v2:" at the start of each lyric. This is structural metadata,
// not a sung word. Preserve the agent for duet placement, and strip only when
// the marker is anchored to the start of the line (not a lyric mentioning v1).
function stripVoicePrefix(line) {
  if (!line || typeof line.text !== 'string') return line
  // Preserve actual mentions of "v1": only a speaker label at the beginning
  // followed by a colon (ASCII or full-width) is metadata.
  const tag = line.text.match(/^\s*v(\d{1,4})\s*[:：]\s*/i)
  if (!tag) return line
  const text = line.text.slice(tag[0].length).trimStart()
  if (!text) return line

  let words = line.words
  if (Array.isArray(words) && words.length) {
    // Mornye's enhanced-LRC tags may split "v1" and ":" across two timed
    // units. Remove the prefix across units without changing surviving times.
    const timedText = joinUnits(words)
    const timedTag = timedText.match(/^v\d{1,4}\s*[:：]\s*/i)
    if (!timedTag) {
      // Some formats store the role only in the line, not in timed words.
      // Those already-clean word timings must be kept, not downgraded.
      if (timedText !== text.replace(/\s+/g, ' ').trim()) words = []
    } else {
      let remaining = timedTag[0].length
      const cleaned = []
      for (const word of words) {
        const part = String(word.word || '') + (word.space ? ' ' : '')
        if (remaining >= part.length) {
          remaining -= part.length
          continue
        }
        const tail = part.slice(remaining)
        remaining = 0
        const core = tail.trim()
        if (core) cleaned.push({ ...word, word: core, space: /\s$/.test(tail) })
      }
      words = remaining ? [] : cleaned
      if (words.length) words[words.length - 1].space = false
    }
  }
  return { ...line, text, words, agent: line.agent || 'v' + Number(tag[1]) }
}

function readOffset(text) {
  const m = String(text).match(/^\[offset\s*:\s*([+-]?\d+)\s*\]/im)
  return m ? parseInt(m[1], 10) / 1000 : 0
}

/** True when the text carries any per-word <mm:ss.xx> stamps. */
function isEnhanced(text) {
  WORD_STAMP.lastIndex = 0
  return WORD_STAMP.test(text || '')
}

/** Attach un-timestamped lines immediately following lyric lines as translations. */
function attachTranslations(out, extras) {
  const sungLines = new Set(out.filter(entry => entry.text).map(entry => entry.time)).size
  // A stray note shouldn't be mistaken for a translation; line-by-line files
  // normally contain translations for at least half their sung lines.
  if (extras.length && extras.length >= sungLines / 2) {
    for (const [entries, extra] of extras) {
      const text = String(extra || '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      for (const entry of entries) entry.translation = { text, bgText: null }
    }
  }
  return out
}

/**
 * Plain line-synced LRC. Lines with several stamps are repeated at each.
 * A line without a stamp right under a stamped one is its translation (some
 * taggers write "[00:21.65] Saigo no Kisu wa" then "    The last kiss") --
 * but only when most sung lines have one: a stray unstamped line (a credit,
 * a note) in an ordinary LRC is left out, as before.
 */
function parseLRC(text) {
  if (!text) return []
  const offset = readOffset(text)
  const out = []
  const extras = [] // [entries of a stamped line, the unstamped line under it]
  let previous = [] // the entries the last stamped line made
  // Windows (\r\n), Unix (\n) and old Mac (\r alone) line endings alike.
  for (const rawLine of String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n')) {
    const line = rawLine.trim()
    if (!line) { previous = []; continue }
    if (META_TAG.test(line)) continue
    LINE_STAMP.lastIndex = 0
    const stamps = []
    let m
    let lastIndex = 0
    while ((m = LINE_STAMP.exec(line)) !== null) {
      if (m.index !== lastIndex) break
      stamps.push(stampToSeconds(m[1], m[2], m[3]))
      lastIndex = LINE_STAMP.lastIndex
    }
    if (!stamps.length) {
      if (previous.length && previous[0].text) extras.push([previous, decodeEntities(line).replace(/\s+/g, ' ').trim()])
      previous = []
      continue
    }
    const body = decodeEntities(line.slice(lastIndex).replace(WORD_STAMP, '')).replace(/\s+/g, ' ').trim()
    previous = stamps.map(t => stripVoicePrefix({ time: Math.max(0, round3(t - offset)), end: null, endStated: false, text: body, words: [] }))
    out.push(...previous)
  }
  out.sort((a, b) => a.time - b.time)
  return attachTranslations(out, extras)
}

/** Enhanced (A2) LRC with <mm:ss.xx> stamps before each word. */
function parseEnhancedLRC(text) {
  if (!text || !isEnhanced(text)) return []
  const offset = readOffset(text)
  const out = []
  const extras = []
  let previous = []
  for (const rawLine of String(text).replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim()
    if (!line) { previous = []; continue }
    if (META_TAG.test(line)) { previous = []; continue }

    // Enhanced LRC can carry a separately timestamped backing voice directly
    // after its lead line: [bg:<mm:ss.xxx>word ... <end>].
    // It has no [mm:ss] line stamp of its own and must not become a translation.
    const backing = line.match(/^\[bg\s*:(.*)\]$/i)
    if (backing) {
      if (previous.length) {
        WORD_STAMP.lastIndex = 0
        const first = WORD_STAMP.exec(backing[1])
        if (first) {
          const synthetic = `[${first[1]}:${first[2]}.${first[3] || '00'}]${backing[1]}`
          const parsed = parseEnhancedLRC(
            `${offset ? `[offset:${Math.round(offset * 1000)}]\n` : ''}${synthetic}`
          )[0]
          if (parsed?.text) {
            const lead = previous[0]
            lead.bgText = lead.bgText ? `${lead.bgText} ${parsed.text}` : parsed.text
            lead.bgWords = [...(lead.bgWords || []), ...parsed.words]
          }
        }
      }
      continue
    }

    LINE_STAMP.lastIndex = 0
    const lm = LINE_STAMP.exec(line)
    if (!lm || lm.index !== 0) {
      if (previous.length && previous[0].text) extras.push([previous, decodeEntities(line).replace(/\s+/g, ' ').trim()])
      previous = []
      continue
    }
    const lineStart = stampToSeconds(lm[1], lm[2], lm[3])
    const body = line.slice(LINE_STAMP.lastIndex)

    // Split into (stamp, text) pieces; a trailing stamp with no text is the last word's end.
    const pieces = []
    const re = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>([^<]*)/g
    let m
    const leading = body.split('<')[0]
    while ((m = re.exec(body)) !== null) {
      pieces.push({ t: stampToSeconds(m[1], m[2], m[3]), text: decodeEntities(m[4]) })
    }
    if (!pieces.length) continue
    if (leading.trim()) pieces.unshift({ t: lineStart, text: decodeEntities(leading) })

    const words = []
    pieces.forEach((piece, i) => {
      const { core, trail } = spacing(piece.text)
      if (!core) return
      const next = pieces[i + 1]
      words.push(unit(core, piece.t - offset, (next ? next.t : piece.t + 0.5) - offset, trail || /^\s/.test(next?.text || '')))
    })
    if (!words.length) { previous = []; continue }
    words[words.length - 1].space = false
    // A background vocal in enhanced LRC is usually a "[bg:" line or a bracket;
    // brackets are split later by the shared post-processing.
    const entry = {
      time: Math.max(0, round3(Math.min(lineStart, words[0].time + offset) - offset)),
      end: words[words.length - 1].end,
      endStated: true,
      text: joinUnits(words),
      words,
    }
    const clean = stripVoicePrefix(entry)
    out.push(clean)
    previous = [clean]
  }
  out.sort((a, b) => a.time - b.time)
  return attachTranslations(out, extras)
}

// QQ QRC / NetEase YRC: [lineStartMs,lineDurMs] then (startMs,durMs[,x]) around each word.
const KARAOKE_LINE = /^\[(\d{1,8}),(\d{1,8})\](.*)$/
const PREFIX_WORD = /\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)([^()]*)/g
const SUFFIX_WORD = /([^()]*)\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)/g

function lyricContent(raw) {
  const m = String(raw).match(/LyricContent\s*=\s*"([^"]*)"/i)
  return m ? decodeEntities(m[1]) : String(raw)
}

function isKaraoke(raw) {
  return lyricContent(raw).split('\n').some(l => {
    const m = l.trim().match(KARAOKE_LINE)
    return m && /\(\d{1,8},\d{1,8}/.test(m[3])
  })
}

function parseKaraokeLRC(raw) {
  const out = []
  const extras = []
  let previous = []
  for (const source of lyricContent(raw).replace(/\r/g, '').split('\n')) {
    const line = source.trim()
    if (!line) { previous = []; continue }
    if (META_TAG.test(line)) { previous = []; continue }
    const m = line.match(KARAOKE_LINE)
    if (!m) {
      if (previous.length && previous[0].text) extras.push([previous, decodeEntities(line).replace(/\s+/g, ' ').trim()])
      previous = []
      continue
    }
    const lineStart = parseInt(m[1], 10) / 1000
    const lineDur = parseInt(m[2], 10) / 1000
    const body = m[3]
    const build = (re, textIdx, startIdx, durIdx) => {
      const words = []
      re.lastIndex = 0
      let w
      while ((w = re.exec(body)) !== null) {
        const { core, lead, trail } = spacing(decodeEntities(w[textIdx]))
        if (!core) { if (words.length && (lead || trail)) words[words.length - 1].space = true; continue }
        if (lead && words.length) words[words.length - 1].space = true
        const s = parseInt(w[startIdx], 10) / 1000
        words.push(unit(core, s, s + parseInt(w[durIdx], 10) / 1000, trail))
      }
      return words
    }
    const prefixed = build(PREFIX_WORD, 3, 1, 2)
    const suffixed = build(SUFFIX_WORD, 1, 2, 3)
    const chars = (ws) => ws.reduce((n, x) => n + x.word.length, 0)
    const words = chars(prefixed) >= chars(suffixed) ? prefixed : suffixed
    if (!words.length) { previous = []; continue }
    words[words.length - 1].space = false
    const entry = {
      time: round3(Math.min(lineStart, words[0].time)),
      end: lineDur > 0 ? round3(lineStart + lineDur) : words[words.length - 1].end,
      endStated: true,
      text: joinUnits(words),
      words,
    }
    const clean = stripVoicePrefix(entry)
    out.push(clean)
    previous = [clean]
  }
  out.sort((a, b) => a.time - b.time)
  return attachTranslations(out, extras)
}

/** Untimed lyrics: one line each, no stamps. */
function parsePlain(text) {
  if (!text) return []
  return String(text).replace(/\r/g, '').split('\n')
    .map(l => l.trim())
    .filter(l => l && !META_TAG.test(l))
    .map(l => stripVoicePrefix({ time: null, end: null, text: l, words: [] }))
}

module.exports = { parseLRC, parseEnhancedLRC, parseKaraokeLRC, parsePlain, isEnhanced, isKaraoke, stampToSeconds, stripVoicePrefix }
