// The last pass every provider's lines go through, whichever one won:
//
//   1. background vocals written as a trailing bracket are split off the lead
//   2. duet lines get a side (start/end) from who sang them
//   3. instrumental breaks become explicit `gap` lines -- including the intro
//   4. the sync level is classified (syllable / line / none)
//
// Done once here rather than inside each parser so every source reads the same.

const { joinUnits, round3, lineEnd, hasKnownEnd } = require('./model')
const { stripVoicePrefix } = require('./lrc')

/** Shorter silences aren't worth interrupting the flow of the lyrics for. */
const MIN_GAP_SECONDS = 4

// ---------------------------------------------------------------- background
// "I'm foolishly patient (Foolishly patient)" -- a bracket doing the job of a
// second voice. Only TTML (x-bg) and LyricsPlus (isBackground) mark it
// structurally; everyone else writes the bracket inline, which dragged the
// sweep through words sung over the *next* line.

function bracketStart(text) {
  if (!text.endsWith(')')) return null
  let depth = 0
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === ')') depth++
    else if (ch === '(') {
      depth--
      if (depth === 0) return i > 0 ? i : null
    }
  }
  return null
}

function splitTrailingBracket(line) {
  if (line.gap || line.bgText || !line.text) return line
  const open = bracketStart(line.text)
  if (open == null) return line
  const lead = line.text.slice(0, open).trimEnd()
  const backing = line.text.slice(open).trim()
  if (!lead || !/[\p{L}\p{N}]/u.test(backing)) return line

  if (!line.words?.length) return { ...line, text: lead, bgText: backing, bgWords: [] }

  // Find the unit where the bracket starts; bail if it opens mid-unit ("wait(ing)").
  let at = 0
  let split = -1
  for (let i = 0; i < line.words.length; i++) {
    if (at === open) { split = i; break }
    if (at > open) break
    at += line.words[i].word.length + (line.words[i].space ? 1 : 0)
  }
  if (split <= 0) return line
  const leadWords = line.words.slice(0, split).map((w, i, a) => (i === a.length - 1 ? { ...w, space: false } : w))
  const bgWords = line.words.slice(split)
  return { ...line, text: joinUnits(leadWords), words: leadWords, bgText: joinUnits(bgWords), bgWords }
}

// ---------------------------------------------------------------- duet sides
// Sides alternate every time the voice changes, which keeps a three-voice song
// reading as a conversation; a group line (everyone) stays left without taking
// a turn. If nearly everything lands right, the whole song is flipped.

const GROUP_AGENT = 'v1000'
const OTHER_AGENT = 'v2000'
const MOSTLY_RIGHT = 0.85

function assignSides(lines, agentTypes = {}) {
  let left = true
  let lastVoice = null
  let rightward = 0
  let placed = 0
  const sides = lines.map(line => {
    const singer = line.agent
    if (!singer || line.gap) return 'start'
    const type = agentTypes[singer] || (singer === GROUP_AGENT ? 'group' : singer === OTHER_AGENT ? 'other' : 'person')
    placed++
    if (type === 'group') return 'start'
    if (lastVoice === null) left = type !== 'other'
    else if (singer !== lastVoice) left = !left
    lastVoice = singer
    if (!left) rightward++
    return left ? 'start' : 'end'
  })
  const voices = new Set(lines.filter(l => l.agent && !l.gap).map(l => l.agent).filter(a => (agentTypes[a] || 'person') !== 'group' && a !== GROUP_AGENT))
  const duet = voices.size > 1
  const flip = placed > 0 && rightward / placed >= MOSTLY_RIGHT
  lines.forEach((line, i) => {
    let side = duet ? sides[i] : 'start'
    if (duet && flip) side = side === 'start' ? 'end' : 'start'
    line.side = side
  })
  return duet
}

// ---------------------------------------------------------------- gaps
// A break is only drawn where the line before it says when its singing stopped.
// Line-synced sources don't, so they only ever get the intro break.

function withInstrumentalGaps(lines) {
  const explicit = lines.filter(l => l.gap)
  const sung = lines.filter(l => !l.gap)
  if (!sung.length || sung[0].time == null) return sung
  const out = []
  if (sung[0].time >= MIN_GAP_SECONDS) out.push({ time: 0, end: sung[0].time, text: '', words: [], gap: true })
  sung.forEach((line, i) => {
    out.push(line)
    const next = sung[i + 1]
    if (!next) return
    // A break the source marked itself (LRC bare stamp) is kept as given.
    const marked = explicit.find(g => g.time >= line.time && g.time < next.time && g.time > 0)
    if (marked) { out.push(marked); return }
    if (!hasKnownEnd(line)) return
    const end = lineEnd(line)
    if (next.time - end >= MIN_GAP_SECONDS && end > line.time) {
      out.push({ time: round3(end), end: next.time, text: '', words: [], gap: true })
    }
  })
  return out
}

// ---------------------------------------------------------------- embedded extras

/** Attaches a source document's own translation / romanization to its lines, by key. */
function attachEmbedded(lines, { translations = {}, transliterations = {} } = {}) {
  const trLang = Object.keys(translations)[0]
  const tlLang = Object.keys(transliterations)[0]
  if (!trLang && !tlLang) return { translationLang: null, romanizationLang: null }
  for (const line of lines) {
    if (!line.key) continue
    const tr = trLang ? translations[trLang][line.key] : null
    if (tr?.text) line.translation = { text: tr.text, bgText: tr.bgText || null }
    const tl = tlLang ? transliterations[tlLang][line.key] : null
    if (tl?.text) line.romanization = tl
  }
  return { translationLang: trLang || null, romanizationLang: tlLang || null }
}

// ---------------------------------------------------------------- credits
// Several catalogues (QQ, KuGou, some LRC uploads) open with credit lines
// stamped as if sung: "Lyrics by：…", "作曲：…", "Title - Artist". They're
// dropped from the head of the song only -- a lyric can legitimately contain a
// colon later on.

const CREDIT_LINE = /^(?:lyrics?|lyricist|written|words|music|composed?r?|composition|arranged?r?|arrangement|produced?r?|producer|vocals?|mix(?:ed|ing)?|master(?:ed|ing)?|recorded|作词|作詞|作曲|编曲|編曲|制作|製作|监制|混音|录音|演唱|詞|曲|词)(?:\s*by)?\s*[:：]/i

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function dropCredits(lines, { title, artist } = {}) {
  const t = normalizeName(title)
  const a = normalizeName(artist)
  let sungSeen = 0
  return lines.filter(line => {
    if (sungSeen >= 6 || !line.text) return true
    const text = line.text.trim()
    const n = normalizeName(text)
    const dash = text.match(/^(.+?)\s[-–—]\s(.+)$/)
    const titlePlusArtist = !!(dash && normalizeName(dash[1]) === t && normalizeName(dash[2]))
    const isCredit = CREDIT_LINE.test(text) ||
      (t && (titlePlusArtist || (/\s[-–—]\s/.test(text) && n.includes(t) && (!a || n.includes(a.split(' ')[0])))))
    if (isCredit) return false
    sungSeen++
    return true
  })
}

// ---------------------------------------------------------------- finish

/**
 * Stamps that don't time anything: most sung lines start at the same moment.
 * LyricsPlus answers some songs with untimed lyrics dressed up as synced
 * (every line at 0), and files tagged from such an answer carry the same;
 * shown as synced, every line has "started" and only the last one lights up.
 */
function isUntimed(lines) {
  const sung = (lines || []).filter(l => l && !l.gap && l.text)
  if (sung.length < 3) return false
  const starts = new Map()
  for (const line of sung) {
    const start = line.words?.length ? line.words[0].time : line.time
    if (start == null) continue
    const key = Math.round(start * 100)
    starts.set(key, (starts.get(key) || 0) + 1)
  }
  return Math.max(0, ...starts.values()) > sung.length / 2
}

function classify(lines) {
  const sung = lines.filter(l => !l.gap && l.text)
  if (!sung.length) return 'none'
  if (isUntimed(sung)) return 'none'
  if (sung.some(l => l.words?.length)) return 'syllable'
  if (sung.some(l => l.time != null)) return 'line'
  return 'none'
}

/**
 * Turns a parser's raw output into a finished result.
 * `doc` is the optional TTML extras ({ agents, translations, transliterations }).
 */
// An LRC file marks an instrumental break with a bare timestamp: "[01:23.45]"
// and nothing after it. That stamp says two things -- the line before it has
// stopped being sung, and silence runs until the next line -- so it becomes
// the previous line's stated end, and a break of its own if it's long enough.
function readEmptyStamps(raw) {
  const sorted = (raw || []).filter(Boolean).slice().sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  const out = []
  sorted.forEach((line, i) => {
    const empty = !String(line.text || '').trim() && !line.bgText && !(line.words?.length)
    if (!empty || line.time == null) { out.push(line); return }
    const prev = out[out.length - 1]
    if (prev && !prev.words?.length && !prev.endStated && line.time > prev.time) {
      prev.end = line.time
      prev.endStated = true
    }
    const next = sorted.slice(i + 1).find(l => String(l.text || '').trim())
    if (next && next.time - line.time >= MIN_GAP_SECONDS) out.push({ time: line.time, end: next.time, text: '', words: [], gap: true })
  })
  return out
}

function finish(rawLines, { source, doc = null, isrc = null, language = null, title = null, artist = null } = {}) {
  let lines = readEmptyStamps(rawLines)
    .filter(l => l && (l.gap || l.text || l.bgText))
    // Normalize even TTML/private-tag/provider lyrics that bypass LRC parsers.
    .map(l => stripVoicePrefix({ ...l, text: String(l.text || '').trim() }))
  lines = dropCredits(lines, { title, artist })
  const sync = classify(lines)
  if (sync === 'none') {
    lines = lines.map(l => ({ text: l.text, time: null, end: null, words: [] }))
    return { type: lines.length ? 'unsynced' : null, sync, lines, source, isrc, language, duet: false }
  }
  lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  lines = lines.map(splitTrailingBracket)
  // An LRC with a translation under each line (see parseLRC) doesn't say its
  // language: '*' shows it whatever the chosen translation language.
  const embedded = doc ? attachEmbedded(lines, doc) : { translationLang: lines.some(l => l.translation?.text) ? '*' : null, romanizationLang: null }
  const duet = assignSides(lines, doc?.agents || {})
  lines = withInstrumentalGaps(lines)
  return {
    type: 'synced',
    sync,
    lines,
    source,
    isrc: isrc || null,
    language: language || null,
    duet,
    translationLang: embedded.translationLang,
    romanizationLang: embedded.romanizationLang,
  }
}

module.exports = { finish, isUntimed, dropCredits, splitTrailingBracket, assignSides, withInstrumentalGaps, attachEmbedded, MIN_GAP_SECONDS }
