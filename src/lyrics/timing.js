// Timing maths for the lyrics view. Pure functions, no DOM, so they can be
// unit-tested and shared by every place lyrics are drawn.
//
// Units are the timed pieces a line is made of ({ word, time, end, space }):
// a whole word, or one syllable of one. See electron/lyrics/model.js.

/** How long a word takes to rise as it lands, and to settle once it's past (s). */
export const RISE_S = 0.7

const smooth = (x) => x * x * (3 - 2 * x)
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯ᄀ-ᇿ]/
const JOINED = /[֐-ࣿיִ-﷿ﹰ-﻿฀-๿ऀ-෿]/ // RTL, Thai, Indic: letters join up

export function isBlockScript(text) { return CJK.test(text || '') }

/** 0..1 through a unit's own span. */
export function unitProgress(u, t) {
  if (t <= u.time) return 0
  if (t >= u.end) return 1
  return (t - u.time) / Math.max(0.001, u.end - u.time)
}

/** How far a unit has lifted: up from its start, back down after its end. 0..1 */
export function unitLift(u, t) {
  const rising = clamp01((t - u.time) / RISE_S)
  const falling = clamp01(1 - (t - u.end) / RISE_S)
  return smooth(Math.min(rising, falling))
}

/** When a line's singing (lead or backing) actually stops. */
export function lineEndOf(line) {
  const lead = line.words?.length ? line.words[line.words.length - 1].end : (line.endStated || line.gap ? line.end : null)
  const bg = line.bgWords?.length ? line.bgWords[line.bgWords.length - 1].end : null
  return Math.max(lead ?? line.time ?? 0, bg ?? 0)
}

/** A break shorter than this isn't drawn (same threshold the lyrics post-processing uses). */
export const MIN_BREAK_S = 4
/** The player only crossfades when it is set above this. */
const CROSSFADE_MIN_S = 0.5

function knowsEnd(line) {
  return !!(line.words?.length || line.bgWords?.length || line.endStated === true)
}

/**
 * The break after the last sung line, for songs that carry on once the lyrics
 * stop (lyrics end at 1:40, the song at 2:40). The post-processing can't draw
 * it, because it doesn't know how long the song is; the panel does.
 *
 * It runs from when the singing actually stopped to when the song hands over:
 * the end of the track, less the crossfade, because with a crossfade the next
 * song takes over (and these lyrics leave) that many seconds before the file
 * ends. Like every other break it needs the last line to say when it stopped
 * (word timings, or a stated end such as a trailing LRC stamp); line-synced
 * lyrics that only stamp starts are left alone. Returns `lines` itself when
 * there is nothing to add.
 */
export function withOutroBreak(lines, { duration, crossfade = 0, synced = true } = {}) {
  if (!synced || !Array.isArray(lines) || !lines.length) return lines
  const total = Number(duration)
  if (!Number.isFinite(total) || total <= 0) return lines
  const sung = lines.filter(l => l && !l.gap)
  const last = sung[sung.length - 1]
  if (!last || last.time == null || !knowsEnd(last) || lines[lines.length - 1].gap) return lines
  const start = sung.reduce((latest, l) => Math.max(latest, lineEndOf(l)), 0)
  const fade = Number(crossfade) > CROSSFADE_MIN_S ? Number(crossfade) : 0
  const end = total - fade
  if (!(start > last.time) || end - start < MIN_BREAK_S) return lines
  const round3 = n => Math.round(n * 1000) / 1000
  return [...lines, { time: round3(start), end: round3(end), text: '', words: [], gap: true, outro: true }]
}

/** The line the view is centred on: the last one whose start has passed. */
export function focusRow(lines, t) {
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    const time = lines[i].time
    if (time == null) continue
    if (time <= t) idx = i
    else break
  }
  return idx
}

/**
 * The visual focus must remain on the older lead until whichever vocal lane
 * finishes last (lead words OR attached independent backing words). A newer
 * lead can start during that window; it is still painted, but the old lead
 * and its backing singer retain their shared focused row until completion.
 *
 * A plain LRC line with only a start timestamp has no known end and follows
 * the traditional newest-start behavior, including the optional lead-ahead.
 */
export function focusRowUntilVocalsFinish(lines, t, leadAhead = 0) {
  const latest = focusRow(lines, t + leadAhead)
  if (latest < 0) return latest
  for (let i = 0; i < latest; i++) {
    const line = lines[i]
    if (!line || line.gap || !Number.isFinite(line.time) || line.time > t) continue
    if (knowsEnd(line) && lineEndOf(line) > t) return i
  }
  return latest
}

/**
 * Every line that needs painting this frame: the focused line, plus any
 * earlier line still being sung (overlapping vocals, a backing line that runs
 * past the next line's start), plus the short settle after each ends.
 */
export function activeRows(lines, t) {
  const latest = focusRow(lines, t)
  if (latest < 0) return []
  const out = []
  const from = Math.max(0, latest - 6)
  for (let i = from; i <= latest; i++) {
    const line = lines[i]
    if (i === latest) { out.push(i); continue }
    if (line.gap) continue
    if (line.time <= t && t < lineEndOf(line) + RISE_S) out.push(i)
  }
  return out
}

/**
 * Lines that should stay fully lit next to the focused one: only those whose
 * singing genuinely hasn't finished yet -- a backing vocal running past the
 * next line's start, overlapping voices. No settle tail, and never a line
 * with no known end (line-synced LRC): those hand over the instant focus
 * moves, in one movement, rather than holding on and then fading.
 */
export function stillSinging(lines, t, focus) {
  const out = []
  for (let i = Math.max(0, focus - 6); i < focus; i++) {
    const line = lines[i]
    if (!line || line.gap || line.time == null || line.time > t) continue
    const hasEnd = (line.words?.length || line.bgWords?.length || line.endStated)
    if (hasEnd && t < lineEndOf(line)) out.push(i)
  }
  return out
}

/**
 * Consecutive units that make one word are kept together so a line never
 * wraps mid-word. CJK has no spaces, so there every unit may break on its own.
 */
export function groupUnits(units) {
  const groups = []
  let current = null
  units.forEach((unit, index) => {
    if (!current) { current = { units: [], space: false }; groups.push(current) }
    current.units.push({ unit, index })
    const next = units[index + 1]
    const breakHere = unit.space || !next || isBlockScript(unit.word) || isBlockScript(next.word)
    if (breakHere) { current.space = !!unit.space; current = null }
  })
  return groups
}

// ---------------------------------------------------------------- held notes
//
// A word held long enough is animated a letter at a time: each letter swells,
// lifts and glows in turn, so the movement travels along the word instead of
// the whole thing pulsing. Short words need to be held proportionally longer
// to qualify -- a two-letter word held for a second is a held note, a seven-
// letter word sung over the same second is just ordinary pace.

export function canGrow(u) {
  const letters = Array.from(u.word || '')
  const n = letters.length
  if (!n || n > 7 || u.word.includes('-') || isBlockScript(u.word) || JOINED.test(u.word)) return false
  const held = u.end - u.time
  if (n === 1) return held >= 1.1
  if (n <= 3) return held >= 1.3 + (n - 2) * 0.15
  if (n === 4) return held >= 1.05
  return held >= 0.9 && held >= n * 0.2
}

const plans = new WeakMap()

/** A per-letter animation plan for a held word; cached per unit object. */
export function growLetters(u) {
  let plan = plans.get(u)
  if (plan) return plan
  const n = Math.max(1, Array.from(u.word).length)
  const held = Math.max(0.001, u.end - u.time)
  // How much of the full treatment this word earns -- steep, so only a real
  // held note gets most of it and anything barely qualifying stays subtle.
  const earned = Math.pow(clamp01((held - 0.4) / 2.6), 2)
  const stagger = 0.09
  const span = 1.5
  const peaks = Array.from({ length: n }, (_, i) => {
    const place = n > 1 ? i / (n - 1) : 0
    const reach = earned * (1 - place * 0.45)
    const scale = 1 + (n <= 3 ? 0.05 : 0.04) + reach * 0.08
    const centre = (i + 0.5) / n
    return {
      scale,
      rise: (scale - 1) * 0.9 * Math.min(1, Math.max(0.3, held / 2)),
      shift: (centre - 0.5) * 2 * (scale - 1) * 0.55,
      bloom: (0.35 + reach * 0.45) * Math.min(1.1, held / 1.5),
    }
  })
  plan = {
    sample(i, t) {
      const peak = peaks[Math.min(i, n - 1)]
      // Lighting: each letter owns an equal share of the word's span.
      const lit = clamp01((t - u.time) / held * n - i)
      const elapsed = t - u.time - i * held * stagger
      const phase = clamp01(elapsed / (held * span))
      let k
      if (phase < 0.25) k = smooth(phase / 0.25)
      else if (phase < 0.3) k = 1
      else if (phase < 0.75) k = 1 - smooth((phase - 0.3) / 0.45)
      else k = 0
      if (elapsed <= 0) k = 0
      // Every letter keeps the ordinary sung-word lift underneath the swell.
      const base = 0.06 * unitLift(u, t)
      return {
        lit,
        scale: 1 + (peak.scale - 1) * k,
        rise: base + peak.rise * k,
        shift: peak.shift * k,
        bloom: peak.bloom * k,
      }
    },
  }
  plans.set(u, plan)
  return plan
}

/** True when any line carries letters outside the Latin script (so romanization means something). */
export function hasNonLatin(lines) {
  return (lines || []).some(l => /[^\u0000-ɏḀ-ỿ\s\p{P}\p{N}\p{S}]/u.test(`${l.text || ''}${l.bgText || ''}`))
}
