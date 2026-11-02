import { useTranslation } from '../i18n'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Mic2, Search, Languages, RotateCcw, Check, ChevronDown, Loader2, Save, Download } from 'lucide-react'
import LyricsSearchDrawer from './LyricsSearchDrawer'
import LyricBreakDots from './LyricBreakDots'
import { api } from '../api'
import { isWindowHidden, onWindowVisibility } from '../windowVisibility'
import { useLyricSubline } from '../lyrics/useLyricSubline'
import { sublineStatusNotice } from '../lyrics/sublineNotice.mjs'
import { announceLyricsChanged } from '../lyricLine'
import { isStationTrack, lyricsTrackFor, stationClockUnknown, stationSongTime } from '../radio/stations'
import { usePlayerStore } from '../store/player'
import { cacheLyrics, hasCachedLyrics, peekLyrics } from '../lyrics/lyricsCache'
import {
  canGrow, growLetters, unitProgress, unitLift, activeRows, focusRow, stillSinging, lineEndOf, groupUnits, withOutroBreak,
} from '../lyrics/timing'

// ---------------------------------------------------------------------------
// Apple Music-style lyrics.
//
// Everything that moves every frame (the sweep across each syllable, the lift
// of the word being sung, the swell and glow of a held note, the interlude
// dots) is written straight to the DOM from one requestAnimationFrame loop, for
// only the lines actually being sung. React renders the list and re-renders
// only when the focused line changes.
// ---------------------------------------------------------------------------

const BROWSE_IDLE_MS = 3200
const FOCUS_LEAD_S = 0.3 // the panel starts moving to a line slightly before it lands
const SCROLL_MS = 560
const STAGGER_STEPS = 3
const STAGGER_FRACTION = 0.07
const EASE = 'cubic-bezier(0.41, 0, 0.12, 0.99)'
const HANDOVER_MS = 420
const NO_LINES = []

// Falloff either side of the focused line, indexed by distance. Subtle close in
// (so you can read ahead and behind), letting go further out.
const FALLOFF_ALPHA = [1, 0.62, 0.5, 0.42, 0.34]
const FALLOFF_BLUR = [0, 0.8, 1.2, 1.8, 2.4]
const UNSUNG = 'rgba(255,255,255,0.42)'
const SUNG = 'rgba(255,255,255,1)'


// Where the player actually is, read from the audio element every frame when
// possible (the store's `progress` only updates a few times a second).
export function useLyricClock(progress) {
  const anchor = useRef({ t: progress, at: performance.now() })
  useEffect(() => { anchor.current = { t: progress, at: performance.now() } }, [progress])
  return useCallback(() => {
    const s = usePlayerStore.getState()
    const el = s.activeAudioElement === 'cf' ? s.cfAudioRef?.current : s.audioRef?.current
    if (isStationTrack(s.currentTrack)) return el ? (stationSongTime(s.currentTrack, el.currentTime) ?? 0) : 0
    if (el && Number.isFinite(el.currentTime) && el.currentTime > 0) return el.currentTime
    const { t, at } = anchor.current
    return t + (s.isPlaying ? Math.min((performance.now() - at) / 1000, 0.6) : 0)
  }, [])
}

// ---------------------------------------------------------------- word markup

function sweepStyle() {
  return {
    display: 'inline-block',
    whiteSpace: 'pre',
    backgroundImage: `linear-gradient(90deg, ${SUNG} var(--lo, -0.6em), ${UNSUNG} var(--hi, 0em))`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    color: 'transparent',
    willChange: 'transform, background',
    // A touch of room so the glow and the lift aren't clipped by the line box.
    paddingBlock: '0.06em',
    marginBlock: '-0.06em',
  }
}

/** One vocal (lead or background): units grouped into unbreakable words. */
export function Voice({ units, text, wordSync, className, style, voiceRef }) {
  const { t } = useTranslation()
  if (!wordSync || !units?.length) {
    return <span ref={voiceRef} data-voice="plain" dir="auto" className={className} style={style}>{text}</span>
  }
  const groups = groupUnits(units)
  return (
    <span ref={voiceRef} data-voice="timed" dir="auto" className={className} style={style}>
      {groups.map((group, gi) => {
        const grow = group.units.length === 1 && canGrow(group.units[0].unit)
        return (
          <React.Fragment key={gi}>
            {/* One unbreakable box per word; the space sits between boxes so
                the line can still wrap there (a space inside an inline-block
                would be collapsed away). */}
            <span style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
              {group.units.map(({ unit, index }) => (
                grow ? (
                  <span key={index} data-u={index} data-grow="1" style={{ display: 'inline-block', whiteSpace: 'pre' }}>
                    {Array.from(unit.word).map((ch, ci) => (
                      <span key={ci} data-l={ci} style={sweepStyle()}>{ch}</span>
                    ))}
                  </span>
                ) : (
                  <span key={index} data-u={index} style={sweepStyle()}>{unit.word}</span>
                )
              ))}
            </span>
            {group.space ? ' ' : null}
          </React.Fragment>
        )
      })}
    </span>
  )
}

// ---------------------------------------------------------------- per-frame painter

export function paintVoice(voiceEl, units, t, live) {
  if (!voiceEl || !units?.length) return
  const els = voiceEl.querySelectorAll('[data-u]')
  els.forEach((el) => {
    const u = units[Number(el.dataset.u)]
    if (!u) return
    if (el.dataset.grow) {
      const letters = el.querySelectorAll('[data-l]')
      const plan = growLetters(u)
      letters.forEach((lEl, li) => {
        const s = plan.sample(li, t)
        const p = live ? s.lit : (t >= u.end ? 1 : 0)
        // Feather sits wholly outside the letter at 0 and 1, so an unsung
        // narrow letter ("i", "l") is never caught half-lit.
        lEl.style.setProperty('--lo', `calc(${(p * 100).toFixed(2)}% + ${(p * 0.5 - 0.5).toFixed(3)}em)`)
        lEl.style.setProperty('--hi', `calc(${(p * 100).toFixed(2)}% + ${(p * 0.5).toFixed(3)}em)`)
        if (live) {
          lEl.style.transform = `translate3d(${s.shift.toFixed(3)}em, ${(-s.rise).toFixed(3)}em, 0) scale(${s.scale.toFixed(4)})`
          lEl.style.filter = s.bloom > 0.01 ? `drop-shadow(0 0 ${(0.12 + 0.3 * s.bloom).toFixed(3)}em rgba(255,255,255,${(0.55 * s.bloom).toFixed(3)}))` : ''
        } else {
          lEl.style.transform = ''
          lEl.style.filter = ''
        }
      })
      return
    }
    const p = live ? unitProgress(u, t) : (t >= u.end ? 1 : 0)
    // Feathered edge: the lit region runs to p, fading over ~1.2em around it.
    el.style.setProperty('--lo', `calc(${(p * 100).toFixed(2)}% + ${(p * 1.2 - 0.6).toFixed(3)}em - 0.6em)`)
    el.style.setProperty('--hi', `calc(${(p * 100).toFixed(2)}% + ${(p * 1.2 - 0.6).toFixed(3)}em + 0.6em)`)
    el.style.transform = live ? `translate3d(0, ${(-0.06 * unitLift(u, t)).toFixed(4)}em, 0)` : ''
  })
}

// ---------------------------------------------------------------- rows

const Row = React.memo(function Row({
  line, index, until, clock, distance, isFocused, isLive, synced, browsing, wordSync, fullscreen, textScale, duet, sub, onSeek, registerRow, onGapCollapse,
}) {
  const { t } = useTranslation()
  const rowRef = useRef(null)
  const leadRef = useRef(null)
  const bgRef = useRef(null)
  const subRef = useRef(null)

  useEffect(() => {
    registerRow(index, { rowEl: rowRef.current, leadEl: leadRef.current, bgEl: bgRef.current, subEl: subRef.current })
    return () => registerRow(index, null)
  })

  const alignEnd = duet && line.side === 'end'
  const baseSize = (fullscreen ? 1.85 : 0.98) * textScale
  // `isLive` is only for the per-frame word painter. Visual focus is exclusive:
  // as soon as the next line takes focus, the previous line enters the same
  // handover transition instead of remaining bright during an overlap. This
  // makes fast, densely timed verses (Rap God is a good stress case) bounce
  // from one line to the next without two competing focal points.
  const near = isFocused ? 0 : distance
  const falloff = browsing ? 0.8 : FALLOFF_ALPHA[Math.min(near, FALLOFF_ALPHA.length - 1)]
  const blur = browsing || !synced ? 0 : FALLOFF_BLUR[Math.min(near, FALLOFF_BLUR.length - 1)]
  const lineOpacity = !synced ? 1 : near === 0 ? 1 : falloff
  const seekable = synced && Number.isFinite(line.time)

  if (line.gap) {
    const open = isFocused && synced
    const breakEnd = Number.isFinite(line.end) && line.end > line.time ? line.end : until
    const exitLead = line.outro ? 0.05 : FOCUS_LEAD_S + 0.04
    return (
      <div ref={rowRef} data-row={index} className="w-full" style={{ willChange: 'transform' }}>
        <div
          onTransitionEnd={event => { if (event.propertyName === 'height' && !open) onGapCollapse?.() }}
          style={{
            height: open ? `${baseSize * 1.5}rem` : 0,
            opacity: open ? 1 : 0,
            transition: `height 420ms ${EASE}, opacity 360ms ${EASE}`,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: alignEnd ? 'flex-end' : 'flex-start',
            paddingInline: '0.75rem',
          }}
        >
          <LyricBreakDots start={line.time} end={breakEnd - exitLead} getTime={clock} active={open} size={baseSize * 0.5} align={alignEnd ? 'end' : 'start'} />
        </div>
      </div>
    )
  }

  const hasBg = !!line.bgText
  const subText = sub?.text && sub.text !== line.text ? sub.text : null
  const subBg = sub?.bgText && sub.bgText !== line.bgText ? sub.bgText : null
  const subUnits = sub?.words?.length ? sub.words : null
  const bgUnits = line.bgWords || []

  return (
    <div ref={rowRef} data-row={index} className="w-full" style={{ willChange: 'transform' }}>
      <div
        role={seekable ? 'button' : undefined}
        tabIndex={seekable ? 0 : undefined}
        onClick={() => { if (!seekable) return; const sel = window.getSelection?.(); if (sel && !sel.isCollapsed && sel.toString().trim()) return; onSeek(line.time) }}
        onKeyDown={(e) => { if (seekable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSeek(line.time) } }}
        className={`group rounded-2xl outline-none select-text ${seekable ? 'cursor-pointer hover:bg-white/[0.06] focus-visible:bg-white/[0.06]' : 'cursor-default'}`}
        style={{
          padding: `${baseSize * 0.28}rem 0.75rem`,
          textAlign: alignEnd ? 'right' : 'left',
          marginLeft: duet && alignEnd ? '12%' : 0,
          marginRight: duet && !alignEnd ? '12%' : 0,
          opacity: lineOpacity,
          filter: blur > 0.05 ? `blur(${blur}px)` : 'none',
          transform: synced && near > 0 && !browsing ? 'scale(0.975)' : 'scale(1)',
          transformOrigin: alignEnd ? 'right center' : 'left center',
          // Colour, fade, blur and scale share one duration and curve so a
          // handover reads as one movement: the new line brightens exactly as
          // the old one recedes.
          transition: `opacity ${HANDOVER_MS}ms ${EASE}, filter ${HANDOVER_MS}ms ${EASE}, transform ${HANDOVER_MS}ms ${EASE}`,
        }}
      >
        <div
          dir="auto"
          style={{
            fontSize: `${baseSize}rem`,
            lineHeight: 1.22,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: synced ? (isFocused ? undefined : UNSUNG) : SUNG,
          }}
        >
          {synced && wordSync && line.words?.length ? (
            <Voice voiceRef={leadRef} units={line.words} text={line.text} wordSync />
          ) : (
            <span
              ref={leadRef}
              data-voice="plain"
              style={{ color: !synced ? SUNG : isFocused ? SUNG : UNSUNG, transition: `color ${HANDOVER_MS}ms ${EASE}` }}
            >
              {line.text}
            </span>
          )}
        </div>
        {hasBg && (
          <div style={{ fontSize: `${baseSize * 0.68}rem`, lineHeight: 1.25, fontWeight: 600, marginTop: '0.15em', opacity: 0.78 }}>
            {synced && wordSync && bgUnits.length ? (
              <Voice voiceRef={bgRef} units={bgUnits} text={line.bgText} wordSync />
            ) : (
              <span ref={bgRef} data-voice="plain" style={{ color: !synced || isFocused ? SUNG : UNSUNG, transition: `color ${HANDOVER_MS}ms ${EASE}` }}>{line.bgText}</span>
            )}
          </div>
        )}
        <AnimatePresence initial={false}>
          {(subText || subBg) && (
            <motion.div
              key="sub"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.42, ease: [0.41, 0, 0.12, 0.99] }}
              style={{ overflow: 'hidden' }}
            >
              <div ref={subRef} dir="auto" style={{ fontSize: `${baseSize * 0.56}rem`, lineHeight: 1.3, fontWeight: 600, marginTop: '0.2em', color: 'rgba(255,255,255,0.72)' }}>
                {subText && (synced && wordSync && subUnits ? <Voice units={subUnits} text={subText} wordSync /> : <span>{subText}</span>)}
                {subBg && <div style={{ fontSize: '0.85em', opacity: 0.8 }}>{subBg}</div>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------- toolbar

// The toolbar's pills fade out by themselves when the full-screen player
// hides its controls (their parent row must not fade: see the row).
const TOOLBAR_FADE = 'transition-[opacity,color,background-color] duration-300 group-data-[hidden=true]/toolbar:opacity-0'

const SYNC_LABEL = { syllable: 'Syllable synced', line: 'Line synced', none: 'Not synced' }

function SourceMenu({ sources, current, attempts, busy, onPick, onRefresh, onSearch, hidden = false }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  // The toolbar hid (full screen idle): the menu goes with it rather than
  // staying up, unclickable, over the lyrics.
  useEffect(() => { if (hidden) setOpen(false) }, [hidden])
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const label = sources.find(s => s.id === current)?.label || current
  return (
    // It takes the room left beside Translate/Romanize and shortens the
    // source's name to fit (a narrow sidebar cut it off at the edge).
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex max-w-full items-center gap-1 px-2.5 py-1 rounded-full text-[11px] text-white/60 hover:text-white bg-white/[0.08] hover:bg-white/[0.14] backdrop-blur-md ${TOOLBAR_FADE}`}
        title={label ? `Lyrics source: ${label}` : 'Lyrics source'}
      >
        {busy ? <Loader2 size={11} className="flex-shrink-0 animate-spin" /> : null}
        <span className="min-w-0 max-w-[9rem] truncate">{label || 'Source'}</span>
        <ChevronDown size={11} className="flex-shrink-0" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 top-full mt-1.5 z-30 w-64 rounded-xl border border-white/10 bg-[#161616]/95 backdrop-blur-xl shadow-2xl p-1"
          >
            <p className="px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-white/35">{t("Try another source")}</p>
            {sources.map(s => {
              const status = attempts?.[s.id]
              const note = status === 'syllable' ? 'Syllable' : status === 'line' ? 'Line' : status === 'none' ? 'Plain' : status === 'miss' ? 'Not found' : ''
              return (
                <button
                  key={s.id}
                  onClick={() => { setOpen(false); onPick(s.id) }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs text-white/80 hover:bg-white/[0.08]"
                >
                  <span className="w-3.5">{s.id === current ? <Check size={12} className="text-accent" /> : null}</span>
                  <span className="flex-1 truncate">{s.label}</span>
                  {note && <span className={`text-[10px] ${status === 'miss' ? 'text-white/25' : 'text-white/45'}`}>{note}</span>}
                </button>
              )
            })}
            <div className="h-px bg-white/10 my-1" />
            <button onClick={() => { setOpen(false); onRefresh() }} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs text-white/70 hover:bg-white/[0.08]">
              <RotateCcw size={12} /> Search all sources again
            </button>
            {onSearch && (
              <button onClick={() => { setOpen(false); onSearch() }} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs text-white/70 hover:bg-white/[0.08]">
                <Search size={12} /> Search manually...
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Pill({ active, onClick, children, title, disabled }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] ${TOOLBAR_FADE} disabled:opacity-40 ${active ? 'bg-white text-black' : 'text-white/60 hover:text-white bg-white/[0.08] hover:bg-white/[0.14] backdrop-blur-md'}`}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- panel

// Lyrics already fetched, per song, shared by every panel (sidebar, full-screen
// player side panel, full-screen lyrics). A panel opened for a song another one
// already shows starts with its lines on the first frame (and refreshes them
// quietly), instead of "no lyrics", then a skeleton, then the lines.
function Loading() {
  const { t } = useTranslation()
  return (
    <div className="w-full flex flex-col gap-5 px-3 pt-4">
      {[0.92, 0.6, 0.8, 0.45, 0.7].map((w, i) => (
        <motion.div
          key={i}
          className="h-6 rounded-lg bg-white/[0.08]"
          style={{ width: `${w * 100}%` }}
          animate={{ opacity: [0.35, 0.8, 0.35] }}
          transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.1 }}
        />
      ))}
    </div>
  )
}

export default function LyricsPanel({
  track: shownTrack, progress, fullscreen = false, wordSync = true, onLyricsAvailable, onSearchRequest, textScale = 1, isAutoSynced = false,
  hideToolbar = false, compact = false, stretchFullscreenWidth = false, active = true,
  // The full screen player hides the buttons along with its own after a few
  // seconds without the mouse moving.
  toolbarHidden = false,
}) {
  const { t } = useTranslation()
  const track = useMemo(() => lyricsTrackFor(shownTrack), [shownTrack])
  const setProgressWithAudioUpdate = usePlayerStore(s => s.setProgressWithAudioUpdate)
  const now = useLyricClock(progress)
  const [result, setResult] = useState(() => (track?.id && hasCachedLyrics(track.id) ? peekLyrics(track.id) : null))
  // The song `result` is for: right after the song changes, until the new
  // song's lyrics are in, it's still the previous one's.
  const [resultFor, setResultFor] = useState(() => (track?.id && hasCachedLyrics(track.id) ? track.id : null))
  const setBoundResult = useCallback((trackId, next) => { setResultFor(trackId ?? null); setResult(next) }, [])
  // Loading from the first render when there's nothing to show yet, so a new
  // panel never flashes "no lyrics" before its request has even started.
  const [loading, setLoading] = useState(() => !!track?.id && !hasCachedLyrics(track.id))
  const [sourceBusy, setSourceBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [sources, setSources] = useState([])
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [liveKey, setLiveKey] = useState('')
  const [browsing, setBrowsing] = useState(false)

  const containerRef = useRef(null)
  const rowsRef = useRef(new Map())
  const browseTimer = useRef(null)
  const lastScrollIdx = useRef(-1)
  const paintedRows = useRef(new Set())

  const crossfadeSeconds = usePlayerStore(s => s.crossfadeSeconds)
  const lines = useMemo(
    () => withOutroBreak(result?.lines || [], { duration: track?.duration, crossfade: crossfadeSeconds, synced: result?.type === 'synced' }),
    [result, track?.duration, crossfadeSeconds],
  )
  const synced = result?.type === 'synced' && !stationClockUnknown(track)

  // ---- data
  const trackKey = track?.id
  // Async answers are only applied if they're still for what's on screen.
  // The sidebar and side panel keep this component mounted across track
  // changes, so a slow lookup for the previous song could otherwise land after
  // the next song's and replace its lyrics (same for translations, romanization
  // and the source picker).
  const requestSeq = useRef(0)
  const resultRef = useRef(null)
  resultRef.current = result

  // quiet: lines already on screen (from the cache) stay up while this
  // refreshes them; the answer only replaces them if it's different.
  const load = useCallback((opts = {}, quiet = false) => {
    if (!track?.id) return
    const seq = ++requestSeq.current
    const trackId = track.id
    if (!quiet) setLoading(true)
    setNotice('')
    if (isStationTrack(track) && track.song_lyrics && !opts.refresh) {
      const lines = String(track.song_lyrics).split(/\r?\n/).map(text => ({ text, time: null, words: [] })).filter(line => line.text.trim())
      const next = lines.length ? { type: 'plain', lines, source: null } : null
      cacheLyrics(trackId, next)
      setBoundResult(trackId, next)
      setLoading(false)
      lastScrollIdx.current = -1
      return
    }
    api.getLyrics(track.id, track.title, track.artist, track.album, track.duration, track.file_path, opts)
      .then(r => {
        if (seq !== requestSeq.current) return
        const next = r && (r.lines?.length || r.instrumental) ? r : null
        cacheLyrics(trackId, next)
        // Same lyrics as shown: keep the scroll position and translations.
        if (quiet && JSON.stringify(next) === JSON.stringify(resultRef.current)) return
        setBoundResult(trackId, next)
        // A refreshed result has different lines: drop the scroll position
        // that belonged to the previous one (its translations go with it).
        lastScrollIdx.current = -1
      })
      .catch(() => { if (seq === requestSeq.current && !quiet) setBoundResult(trackId, null) })
      .finally(() => { if (seq === requestSeq.current) setLoading(false) })
  }, [track?.id, track?.title, track?.artist, track?.album, track?.duration, track?.file_path, track?.song_key, track?.song_lyrics, setBoundResult])

  // Manual search. The fullscreen views bring their own drawer (onSearchRequest);
  // anywhere else -- the sidebar -- the panel opens one over itself.
  const [searchOpen, setSearchOpen] = useState(false)
  const requestSearch = onSearchRequest || (() => setSearchOpen(true))
  const currentTrackId = useRef(track?.id)
  currentTrackId.current = track?.id
  const pickSearchResult = async (lyrics, type) => {
    setSearchOpen(false)
    const trackId = track?.id
    if (!trackId) return
    try {
      const imported = await api.importLyrics(trackId, lyrics, type)
      if (!imported?.lines?.length) throw new Error('No usable lyrics were found in this selection.')
      announceLyricsChanged(trackId)
    } catch (error) {
      setNotice(error?.message || t('Could not import lyrics.'))
      return
    }
    // The song may have changed while saving; its own load already ran.
    if (currentTrackId.current === trackId) load()
  }

  useEffect(() => {
    setSearchOpen(false)
    // A source request for the previous song won't clear its own spinner
    // (its answer is dropped as stale), so clear it here.
    setSourceBusy(false)
    const cached = trackKey != null && hasCachedLyrics(trackKey)
    // Cached: its lines show right away (even if the previous song was still
    // loading); otherwise the loading state until this song's answer.
    setBoundResult(cached ? trackKey : null, cached ? peekLyrics(trackKey) : null); setLoading(!cached && trackKey != null); setFocusIdx(-1); lastScrollIdx.current = -1
    load({}, cached)
  }, [trackKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!loading) onLyricsAvailable?.(lines.length > 0) }, [loading, lines.length, onLyricsAvailable])

  useEffect(() => {
    api.getLyricsSources?.().then(s => setSources(s?.providers || [])).catch(() => {})
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // ---- translation / romanization (src/lyrics/useLyricSubline.js)
  const {
    subline, toggle: toggleSub, subLines, wantTranslation, translateTarget, translationState, romanizationState,
    translationFrom, translationBusy, romanizationBusy, canRomanize,
  } = useLyricSubline(resultFor != null && resultFor === track?.id
    ? { trackId: track?.id, result, lines }
    // Lyrics still the previous song's: no translating them under this song's name.
    : { trackId: track?.id, result: null, lines: NO_LINES })

  // ---- focus (which line the panel is centred on)
  // Single reverse pass: the former slice/find on each row was quadratic.
  const nextTimes = useMemo(() => {
    const times = new Array(lines.length)
    let next = null
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      times[i] = next ?? (track?.duration || (line.time ?? 0) + 4)
      if (line.time != null) next = line.time
    }
    return times
  }, [lines, track?.duration])

  useEffect(() => {
    if (!lines.length) return
    if (synced) {
      const t = now()
      const focus = focusRow(lines, t + FOCUS_LEAD_S)
      setFocusIdx(focus)
      setLiveKey(stillSinging(lines, t, focus).join(','))
    } else if (isAutoSynced && track?.duration) {
      setFocusIdx(Math.min(lines.length - 1, Math.floor((progress / track.duration) * lines.length)))
    } else {
      setFocusIdx(-1)
    }
  }, [progress, lines, synced, isAutoSynced, track?.duration, now])

  // ---- per-frame painting of what is actually being sung
  const registerRow = useCallback((index, refs) => {
    if (refs) rowsRef.current.set(index, refs)
    else rowsRef.current.delete(index)
  }, [])

  useEffect(() => {
    if (!active || !synced || !lines.length) return
    let raf = null
    let hidden = isWindowHidden()
    const tick = () => {
      raf = null
      if (hidden) return
      const t = now()
      const live = new Set(activeRows(lines, t))
      // Lines that just stopped being sung get settled into their final state once.
      for (const i of paintedRows.current) {
        if (live.has(i)) continue
        const refs = rowsRef.current.get(i)
        const line = lines[i]
        if (refs && line && wordSync) {
          paintVoice(refs.leadEl, line.words, t, false)
          paintVoice(refs.bgEl, line.bgWords, t, false)
          const sub = subLines?.[i]
          if (sub?.words?.length && refs.subEl) {
            paintVoice(refs.subEl.querySelector('[data-voice="timed"]'), sub.words, t, false)
          }
        }
      }
      for (const i of live) {
        const refs = rowsRef.current.get(i)
        const line = lines[i]
        if (!refs || !line) continue
        if (line.gap) continue
        if (!wordSync) continue
        paintVoice(refs.leadEl, line.words, t, true)
        paintVoice(refs.bgEl, line.bgWords, t, true)
        const sub = subLines?.[i]
        if (sub?.words?.length && refs.subEl) paintVoice(refs.subEl.querySelector('[data-voice="timed"]'), sub.words, t, true)
      }
      paintedRows.current = live
      raf = requestAnimationFrame(tick)
    }
    const unsubscribeVisibility = onWindowVisibility(nextHidden => {
      hidden = nextHidden
      if (hidden) {
        if (raf !== null) cancelAnimationFrame(raf)
        raf = null
      } else if (raf === null) {
        raf = requestAnimationFrame(tick)
      }
    })
    if (!hidden) raf = requestAnimationFrame(tick)
    return () => {
      unsubscribeVisibility()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [active, synced, lines, now, wordSync, subLines])

  // When the list re-renders, bring every timed line to its correct resting state.
  useLayoutEffect(() => {
    if (!synced || !wordSync) return
    const t = now()
    rowsRef.current.forEach((refs, i) => {
      const line = lines[i]
      if (!line || line.gap) return
      paintVoice(refs.leadEl, line.words, t, false)
      paintVoice(refs.bgEl, line.bgWords, t, false)
      const sub = subLines?.[i]
      if (sub?.words?.length && refs.subEl) {
        paintVoice(refs.subEl.querySelector('[data-voice="timed"]'), sub.words, t, false)
      }
    })
  }, [lines, synced, wordSync, subLines, now])

  // ---- scrolling: native scroll for browsing, a staggered glide for following
  // In the compact card, pin the focused line near the top so a Canvas above it
  // cannot make the preceding, dimmed line look like the main lyric.
  const anchorFraction = compact ? 0.03 : fullscreen ? 0.22 : 0.26
  // Full screen, the lyrics start at the top (clear of the buttons and the
  // edge fade) rather than a third of the way down; the line being sung
  // settles at anchorFraction once the song gets there.
  const FULLSCREEN_TOP = { height: '10%', minHeight: '4.5rem' }
  const scrollToFocus = useCallback((instant, distanceFraction = 1) => {
    const container = containerRef.current
    const refs = rowsRef.current.get(focusIdx)
    if (!container || !refs?.rowEl) return
    // Near the end of a song the list can't scroll far enough to put the line
    // at the anchor (the sidebar keeps no empty space after the last line), so
    // clamp to how far it can actually go. The last lines then simply light up
    // lower down the panel instead of the list trying to move.
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    const fullTarget = Math.min(maxScroll, Math.max(0, refs.rowEl.offsetTop - container.clientHeight * anchorFraction))
    const before = container.scrollTop
    const target = before + (fullTarget - before) * distanceFraction
    if (Math.abs(target - before) < 1) return
    if (instant || Math.abs(target - before) > container.clientHeight * 1.5) {
      container.scrollTop = target
      return
    }
    // FLIP: jump the scroll position, then let each row glide the difference
    // back to zero -- rows below the focus leave a beat later than the one
    // above, so the spacing opens and closes like the list is handing over.
    // The glide uses the distance the scroll really moved; gliding by the
    // intended distance when the scroll was clamped made every row jump and
    // settle back to where it already was (the end-of-song jitter).
    container.scrollTop = target
    const delta = container.scrollTop - before
    if (Math.abs(delta) < 1) return
    const top = container.scrollTop
    const bottom = top + container.clientHeight
    rowsRef.current.forEach(({ rowEl }, i) => {
      if (!rowEl) return
      const y = rowEl.offsetTop
      if (y + rowEl.offsetHeight < top - 200 || y > bottom + 200) return
      const steps = i > focusIdx ? Math.min(i - focusIdx, STAGGER_STEPS) : 0
      rowEl.style.transition = 'none'
      rowEl.style.transform = `translate3d(0, ${delta}px, 0)`
      // Force the start frame, then release.
      void rowEl.offsetHeight
      rowEl.style.transition = `transform ${SCROLL_MS}ms ${EASE} ${Math.round(steps * STAGGER_FRACTION * SCROLL_MS)}ms`
      rowEl.style.transform = ''
    })
  }, [focusIdx, anchorFraction])

  // When a focused three-dot break collapses, its height changes throughout a
  // CSS transition. Re-align after that final layout shift so the next lyric
  // line doesn't get clipped at the top of the scroll viewport.
  const handleGapCollapse = useCallback(() => {
    if (focusIdx < 0 || browsing) return
    scrollToFocus(true, 0.75)
  }, [focusIdx, browsing, scrollToFocus])

  useLayoutEffect(() => {
    if (focusIdx < 0 || browsing) return
    const first = lastScrollIdx.current < 0
    lastScrollIdx.current = focusIdx
    scrollToFocus(first)
  }, [focusIdx, browsing, scrollToFocus])

  const startBrowsing = useCallback(() => {
    if (!synced && !isAutoSynced) return
    setBrowsing(true)
    clearTimeout(browseTimer.current)
    browseTimer.current = setTimeout(() => setBrowsing(false), BROWSE_IDLE_MS)
  }, [synced, isAutoSynced])
  useEffect(() => () => clearTimeout(browseTimer.current), [])

  // ---- actions
  const seek = useCallback((time) => {
    if (!Number.isFinite(time)) return
    setBrowsing(false)
    setProgressWithAudioUpdate(Math.max(0, time))
  }, [setProgressWithAudioUpdate])

  const embedCurrentLyrics = async () => {
    if (!track?.id || !result?.source || !api.isElectron || !track.file_path || String(track.file_path).startsWith('ghost://')) return
    const label = sources.find(source => source.id === result.source)?.label || result.source
    if (!window.confirm(t('Insert lyrics from {source} into this audio file? This modifies the file tags.', { source: label }))) return
    setSourceBusy(true)
    try {
      await api.embedLyricsFrom(result.source, track.id, track.title, track.artist, track.album, track.duration)
      setNotice(t('Lyrics inserted into the audio file.'))
      announceLyricsChanged(track.id)
    } catch (error) {
      setNotice(error?.message || t('Could not insert lyrics into the audio file.'))
    } finally {
      setSourceBusy(false)
    }
  }

  const exportCurrentLyrics = async () => {
    if (!track?.id || !result?.source || !api.isElectron) return
    setSourceBusy(true)
    try {
      const saved = await api.exportLyricsFile(result.source, track.id, track.title, track.artist, track.album, track.duration)
      if (saved?.saved) setNotice(t('Lyrics saved to file.'))
    } catch (error) {
      setNotice(error?.message || t('Could not save lyrics to file.'))
    } finally {
      setSourceBusy(false)
    }
  }

  const pickSource = (id) => {
    if (!track?.id) return
    const seq = ++requestSeq.current
    setSourceBusy(true)
    api.getLyricsFrom(id, track.id, track.title, track.artist, track.album, track.duration, track.file_path)
      .then(r => {
        if (seq !== requestSeq.current) return
        if (r?.lines?.length) {
          setBoundResult(track.id, r)
          announceLyricsChanged(track.id)
          lastScrollIdx.current = -1
        } else {
          const label = sources.find(s => s.id === id)?.label || id
          setNotice(`${label} doesn't have this song`)
          setResult(prev => (prev ? { ...prev, attempts: { ...(prev.attempts || {}), ...(r?.attempts || {}) } } : prev))
          setTimeout(() => setNotice(''), 3500)
        }
      })
      .catch(() => {})
      .finally(() => { if (seq === requestSeq.current) setSourceBusy(false) })
  }

  // ---- render
  const liveSet = useMemo(() => new Set(liveKey ? liveKey.split(',').map(Number) : []), [liveKey])
  const sourceLabel = sources.find(s => s.id === result?.source)?.label || result?.source
  const attribution = result?.attribution
  const hasContributors = !!(attribution?.uploader || attribution?.maker)
  const showToolbar = !hideToolbar && lines.length > 0
  // A failed or unnecessary translation/romanization is not actionable in
  // the sidebar. Keep notices from explicit actions (source picker / embedding).
  const visibleNotice = notice || sublineStatusNotice({
    fullscreen, wantTranslation, translationState, subline, romanizationState,
  })

  return (
    <div className="relative w-full h-full">
      {showToolbar && (
        <div
          // The pills fade by themselves (TOOLBAR_FADE), not this row: glass
          // inside a fading parent shows as flat grey until the fade ends.
          data-hidden={toolbarHidden}
          className={`group/toolbar absolute top-0 inset-x-0 z-20 flex items-center gap-1.5 px-4 pt-3 pointer-events-none ${fullscreen ? '' : 'pb-6'}`}
          // The sidebar keeps its soft shade behind the buttons; the fullscreen
          // views already have their own header there, so they go without.
          style={fullscreen ? undefined : { background: 'linear-gradient(to bottom, rgba(0,0,0,0.35), transparent)' }}
        >
          <div className={`flex flex-shrink-0 items-center gap-1.5 ${toolbarHidden ? 'pointer-events-none' : 'pointer-events-auto'}`} inert={toolbarHidden}>
            <button type="button" onClick={() => toggleSub('translation')} title={t(`Show translation (${translateTarget})`)} aria-label={t('Translate lyrics')}
              aria-pressed={wantTranslation}
              className={`rounded-full p-2 transition-colors ${wantTranslation ? 'bg-accent/25 text-accent' : 'bg-white/[0.08] text-white/70 hover:bg-white/[0.14] hover:text-white'} ${TOOLBAR_FADE}`}>
              {translationBusy ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
            </button>
            {canRomanize && (
              <Pill active={subline === 'romanization'} onClick={() => toggleSub('romanization')} title={t("Show pronunciation in Latin letters")}>
                {romanizationBusy ? <Loader2 size={11} className="animate-spin" /> : <span className="font-semibold leading-none">Aa</span>}
                Romanize
              </Pill>
            )}
            {result?.source && api.isElectron && (
              <button type="button" onClick={exportCurrentLyrics} disabled={sourceBusy || loading}
                title={t('Save lyrics as .elrc, .lrc or .txt')} aria-label={t('Save lyrics to file')}
                className={`rounded-full p-2 text-white/65 hover:text-white bg-white/[0.08] hover:bg-white/[0.14] disabled:opacity-40 ${TOOLBAR_FADE}`}>
                <Download size={13} />
              </button>
            )}
            {sources.length > 0 && result?.source && api.isElectron && track?.file_path && !String(track.file_path).startsWith('ghost://') && (
              <button type="button" onClick={embedCurrentLyrics} disabled={sourceBusy || loading}
                title={t('Insert these lyrics into the audio file')} aria-label={t('Insert lyrics into track')}
                className={`rounded-full p-2 text-white/65 hover:text-white bg-white/[0.08] hover:bg-white/[0.14] disabled:opacity-40 ${TOOLBAR_FADE}`}>
                <Save size={13} />
              </button>
            )}
          </div>
          <div className="flex-1" />
          <div className={`flex min-w-0 items-center justify-end gap-1.5 ${toolbarHidden ? 'pointer-events-none' : 'pointer-events-auto'}`} inert={toolbarHidden}>
            {sources.length > 0 && result?.source && (
              <>
                <SourceMenu
                  sources={sources}
                  current={result.source}
                  attempts={result.attempts}
                  busy={sourceBusy}
                  onPick={pickSource}
                  onRefresh={() => load({ refresh: true })}
                  onSearch={requestSearch}
                  hidden={toolbarHidden}
                />

              </>
            )}
          </div>
        </div>
      )}

      <AnimatePresence>
        {visibleNotice && (
          <motion.div
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            // Right-aligned under the source menu (that's what it answers), and
            // allowed to wrap: a fixed-width, centred pill overflowed the narrow
            // sidebar, and framer's own transform overrode the centring.
            className="absolute top-11 right-4 z-30 max-w-[calc(100%-2rem)] w-max px-3 py-1.5 rounded-2xl bg-black/75 backdrop-blur-md border border-white/10 text-[11px] leading-snug text-white/85 text-right"
          >
            {visibleNotice}
          </motion.div>
        )}
      </AnimatePresence>

      <div
        ref={containerRef}
        data-lyrics-auto-follow={!browsing ? 'true' : 'false'}
        onWheel={startBrowsing}
        onTouchMove={startBrowsing}
        onKeyDown={(e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) startBrowsing() }}
        className="w-full h-full overflow-y-auto overflow-x-hidden"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          // The sidebar has no empty space after the last line, so its closing
          // lines light up near the bottom edge -- keep the fade there short
          // enough not to dim them.
          maskImage: compact ? 'linear-gradient(to bottom, black 0, black 94%, transparent 100%)' : `linear-gradient(to bottom, transparent 0, black 9%, black ${fullscreen ? 82 : 94}%, transparent 100%)`,
          WebkitMaskImage: compact ? 'linear-gradient(to bottom, black 0, black 94%, transparent 100%)' : `linear-gradient(to bottom, transparent 0, black 9%, black ${fullscreen ? 82 : 94}%, transparent 100%)`,
        }}
      >
        <div className={`w-full ${fullscreen ? (stretchFullscreenWidth ? 'px-6' : 'max-w-3xl mx-auto px-6') : 'px-3'}`}>

          {loading && <div style={fullscreen ? FULLSCREEN_TOP : { height: '18%' }} />}
          {loading && <Loading />}

          {!loading && !lines.length && (
            <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-3 text-white/35 select-none pt-24">
              <Mic2 size={fullscreen ? 40 : 28} />
              {result?.instrumental ? (
                <p className={fullscreen ? 'text-sm' : 'text-xs'}>{t("Instrumental — nothing to sing along to.")}</p>
              ) : !isOnline ? (
                <p className={fullscreen ? 'text-sm' : 'text-xs'}>{t("You're offline. Lyrics will load once you're back online.")}</p>
              ) : (
                <>
                  <p className={fullscreen ? 'text-sm' : 'text-xs'}>{t("No lyrics found")}</p>
                  <div className="flex items-center gap-3">
                    <button onClick={requestSearch} className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors">
                      <Search size={12} /> Search manually
                    </button>
                    <button onClick={() => load({ refresh: true })} className="flex items-center gap-1 text-xs text-white/50 hover:text-white transition-colors">
                      <RotateCcw size={12} /> Try again
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {!loading && lines.length > 0 && (
            <>
              <div style={fullscreen ? FULLSCREEN_TOP : compact ? { height: '1rem' } : { height: synced || isAutoSynced ? `${anchorFraction * 100}%` : '3.5rem', minHeight: synced ? '5rem' : undefined }} />
              {!synced && (
                <p className="px-3 pb-3 text-[11px] text-white/35">These lyrics aren't time-synced{isAutoSynced ? ' — following along roughly' : ''}.</p>
              )}
              {lines.map((line, i) => (
                <Row
                  key={i}
                  line={line}
                  index={i}
                  until={nextTimes[i]}
                  clock={now}
                  distance={focusIdx >= 0 ? Math.abs(i - focusIdx) : i + 1}
                  isFocused={i === focusIdx}
                  isLive={liveSet.has(i)}
                  synced={synced}
                  browsing={browsing}
                  wordSync={wordSync}
                  fullscreen={fullscreen}
                  textScale={textScale}
                  duet={!!result?.duet}
                  sub={subLines?.[i] || null}
                  onSeek={seek}
                  registerRow={registerRow}
                  onGapCollapse={line.gap ? handleGapCollapse : undefined}
                />
              ))}
              <div style={{ height: fullscreen ? '55vh' : compact ? '240px' : 0 }} />
              {sourceLabel && (
                <p className="px-3 pb-10 text-[11px] text-white/30">
                  Lyrics via {sourceLabel}{result?.sync ? ` · ${SYNC_LABEL[result.sync] || ''}` : ''}
                  {translationFrom ? ` · ${translationFrom === 'source' ? 'Apple Music translation' : `Translated to ${translateTarget}`}` : ''}
                  {attribution?.provider && <span className="block mt-1">Provided by {attribution.provider}</span>}
                  {hasContributors && (
                    <span className="block mt-1">
                      {attribution.uploader && <>Uploaded by <a href={attribution.uploader.url} target="_blank" rel="noreferrer" className="hover:text-white/60 underline underline-offset-2">{attribution.uploader.name}</a></>}
                      {attribution.uploader && attribution.maker && ' · '}
                      {attribution.maker && <>made by <a href={attribution.maker.url} target="_blank" rel="noreferrer" className="hover:text-white/60 underline underline-offset-2">{attribution.maker.name}</a></>}
                    </span>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <AnimatePresence>
        {searchOpen && track && (
          <LyricsSearchDrawer track={track} variant={fullscreen ? 'side' : 'fill'} onClose={() => setSearchOpen(false)} onSelect={pickSearchResult} />
        )}
      </AnimatePresence>
    </div>
  )
}
