import { useTranslation } from '../i18n'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { X, Play, Pause, SkipBack, SkipForward, Heart, Shuffle, Repeat, Repeat1, Mic2, ListMusic, ListPlus, Search, Maximize2, Expand, Minimize, Volume2, Film, Clapperboard, Gamepad2, Eye, EyeOff, Image as ImageIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { announceLyricsChanged } from '../lyricLine'
import { showToast } from './Toaster'
import { usePlayerStore, useAppStore } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import LyricsPanel from './LyricsPanel'
import { cacheLyrics, hasLyricLines, peekLyrics } from '../lyrics/lyricsCache'
import ArtworkBackdrop, { useArtworkBackdropEnabled } from './ArtworkBackdrop'
import MotionCover, { loadMotionCover } from './MotionCover'
import LikeBurst from './LikeBurst'
import { useMotionCoverOff } from '../motionCoverPrefs'
import MixCovers from './MixCovers'
import FullscreenTurntable from './FullscreenTurntable'
import MixingMark from './MixingMark'
import { useMusicVideo, useMusicVideoView } from '../musicVideo'
import { startCoverFlight } from '../coverFlight'
import { QueueContent } from './QueuePanel'
import LyricsFullscreen, { FULLSCREEN_SWITCH, FULLSCREEN_IN, FULLSCREEN_OUT } from './LyricsFullscreen'
import { api, wordSyncEnabled } from '../api'
import { contextLabel, isContextNavigable, navigateToContext, navigateToTrackAlbum } from '../playbackContext'
import { isStationTrack } from '../radio/stations'
import { navigateToRadioAlbum } from '../radio/stationAlbum'
import { trackArtURL, trackFullArtURL, isStreamed } from '../onlineTracks'
import StreamArtwork from './StreamArtwork'
import { useVolumeWheel } from '../volumeWheel'
import { usePerformanceMode } from '../performanceMode'
import { isSuspect, tierOf, qualityTagLabel } from '../quality'
import { isWindowHidden, onWindowVisibility } from '../windowVisibility'
import { computeFullscreenLyricsExpansion } from '../fullscreenLyricsLayout.mjs'

// The cover's size (square), and the lyrics/queue panel's width beside it.
const COVER_SIZE = 'min(60rem, 78vh, calc(100vw - 8rem), calc(110vh - 25rem))'
// With a side panel open, the cover must fit in the space left beside it.
// 6rem accounts for the cover stage's horizontal padding (px-12).
const COVER_SIZE_WITH_PANEL = 'min(60rem, 78vh, calc(100vw - 8rem), calc(110vh - 25rem), calc(100vw - min(42vw, 780px) - 6rem))'
const PANEL_WIDTH = 'min(42vw, 780px)'
const PANEL_ANIMATION_MS = 360 // transform-only so lyric text isn't reflowed every frame
const FULLSCREEN_LYRICS_WAIT_MS = 1500 // lyrics found after this don't open the panel on their own
// The header and the cover's controls hide (and the cursor too) after this
// long without the mouse moving.
const IDLE_MS = 3000

// Glass (backdrop-blur) has to fade by itself, never inside a parent that
// fades: while an ancestor's opacity is below 1, Chromium blurs that
// ancestor's (empty) layer instead of what's behind it, so the bubbles showed
// as flat grey discs during the fade, then snapped to clear glass at the end.
// So the cover's controls and the header fade piece by piece.
const COVER_FADE = 'transition-[opacity,color,background-color,border-color] duration-200 opacity-0 group-data-[shown=true]/controls:opacity-100 group-has-[:focus-visible]/controls:opacity-100'

/** A glassy bubble on the cover (like, playlist, queue, lyrics). */
function CoverButton({ onClick, label, active = false, children }) {
  const { t } = useTranslation()
  return (
    <button onClick={onClick} title={label} aria-label={label} aria-pressed={active}
      className={`relative w-12 h-12 flex items-center justify-center rounded-full border backdrop-blur-[2px] ${COVER_FADE} shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] drop-shadow-[0_1px_4px_rgba(0,0,0,0.3)] ${active ? 'border-white/30 bg-white/[0.16] text-white' : 'border-white/[0.14] bg-white/[0.05] text-white/90 hover:bg-white/[0.12] hover:text-white'}`}>
      {children}
    </button>
  )
}

/** A bare control on the cover (play, skip...): just the icon, with a soft shadow. */
function CoverIcon({ onClick, label, pressed, dim = false, children }) {
  const { t } = useTranslation()
  return (
    <button onClick={onClick} title={label} aria-label={label} aria-pressed={pressed}
      className={`flex items-center justify-center transition-[color,transform] hover:scale-105 active:scale-95 drop-shadow-[0_2px_8px_rgba(0,0,0,0.45)] ${dim ? 'text-white/60 hover:text-white' : 'text-white/90 hover:text-white'}`}>
      {children}
    </button>
  )
}

/** Volume as a slim glass pill up the cover's edge: drag (or click) along it. */
function VolumePill({ volume, onChange }) {
  const { t } = useTranslation()
  const ref = useRef(null)
  const volumeWheelRef = useVolumeWheel(volume, onChange)
  const attachRef = useCallback(element => {
    ref.current = element
    volumeWheelRef(element)
  }, [volumeWheelRef])
  const setFrom = (clientY) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    onChange(Math.max(0, Math.min(1, (r.bottom - clientY) / r.height)))
  }
  const start = (event) => {
    event.preventDefault()
    setFrom(event.clientY)
    const move = e => setFrom(e.clientY)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const keys = (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); onChange(Math.min(1, volume + 0.05)) }
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); onChange(Math.max(0, volume - 0.05)) }
  }
  // The speaker sits inside the pill, at its foot: dark over the white fill,
  // light over the glass.
  const covered = volume > 0.12
  return (
    <div ref={attachRef} role="slider" tabIndex={0} aria-label={t("Volume")} aria-orientation="vertical"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(volume * 100)} title={`Volume ${Math.round(volume * 100)}%`}
      onPointerDown={start} onKeyDown={keys}
      className={`relative h-44 w-7 cursor-pointer overflow-hidden rounded-full border border-white/[0.14] bg-white/[0.06] backdrop-blur-[2px] drop-shadow-[0_1px_4px_rgba(0,0,0,0.3)] outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${COVER_FADE}`}>
      <div className="absolute inset-x-0 bottom-0 bg-white/60" style={{ height: `${Math.round(volume * 100)}%` }} />
      <Volume2 size={13} className={`pointer-events-none absolute bottom-2.5 left-1/2 -translate-x-1/2 ${covered ? 'text-black/55' : 'text-white/80'}`} />
    </div>
  )
}

function fmt(s) {
  if (!s || isNaN(s)) return '0:00'
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

function SearchDrawer({ track, onClose, onSelect }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(track?.title || '')
  const [artist, setArtist] = useState(track?.artist || '')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const formatDuration = (d) => {
    if (!d) return '--:--'
    return Math.floor(d / 60) + ':' + String(Math.floor(d % 60)).padStart(2, '0')
  }

  const handleSearch = async () => {
    if (!title || !artist) return
    setLoading(true)
    setError(null)
    setResults([])

    try {
      const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`
      const res = await fetch(url)
      const data = await res.json()
      if (Array.isArray(data)) {
        setResults(data)
      } else {
        setResults([])
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleResultClick = (result) => {
    const lyrics = result.syncedLyrics || result.plainLyrics
    const type = result.syncedLyrics ? 'lrc' : 'txt'
    onSelect(lyrics, type)
  }

  return (
    <motion.div
      initial={{ x: 420 }}
      animate={{ x: 0 }}
      exit={{ x: 420 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="absolute top-0 right-0 h-full w-[420px] bg-black/95 backdrop-blur-xl border-l border-white/10 z-30 flex flex-col"
    >
      {/* The close button is sized/positioned to match the main fullscreen
          exit button exactly (top-5, w-9 h-9, same circle style) -- it used
          to be a small p-1 icon sitting inside a p-4 row, which put it a
          few pixels lower than the exit button it sits right below. */}
      <div className="relative flex items-center justify-center px-4 py-4 border-b border-white/10">
        <button onClick={onClose}
          className="absolute top-5 left-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">
          <X size={15} />
        </button>
        <h3 className="text-sm font-medium text-white">{t("Search Lyrics")}</h3>
      </div>

      <div className="p-4 space-y-3 border-b border-white/10">
        <div>
          <label className="text-xs text-white/40 uppercase tracking-wider">{t("Title")}</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("Track title")}
            className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-accent/50"
          />
        </div>
        <div>
          <label className="text-xs text-white/40 uppercase tracking-wider">{t("Artist")}</label>
          <input
            type="text"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder={t("Artist name")}
            className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-accent/50"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={!title || !artist || loading}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-accent text-base rounded-lg text-sm font-medium hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? t('Searching…') : <><Search size={14} /> {t('Search')}</>}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {results.length === 0 && !loading && !error && (
          <p className="text-xs text-white/30 text-center py-8">{t("Enter title and artist to search")}</p>
        )}
        {results.map((r, i) => (
          <button
            key={i}
            onClick={() => handleResultClick(r)}
            className="w-full p-3 text-left hover:bg-white/5 rounded-lg transition-colors"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{r.trackName}</p>
                <p className="text-xs text-white/50 truncate">{r.artistName}</p>
                {r.albumName && <p className="text-xs text-white/30 truncate">{r.albumName}</p>}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs text-white/40">{formatDuration(r.duration)}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${r.syncedLyrics ? 'bg-green-500/20 text-green-400' : 'bg-white/10 text-white/40'}`}>
                  {r.syncedLyrics ? 'Synced' : 'Unsynced'}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  )
}

// React owns the fallback so a same-ID artwork update can retry the original.
function FullscreenStillArtwork({ track }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [track])
  const full = trackFullArtURL(track) || trackArtURL(track)
  const fallback = trackArtURL(track)
  if (isStreamed(track)) return <StreamArtwork track={track} src={full}
    className="absolute inset-0 w-full h-full object-cover" alt=""
    fallback={<div className="absolute inset-0 flex items-center justify-center text-white/10 text-7xl">♪</div>} />
  return <img src={failed ? fallback : full}
    onError={() => { if (!failed && fallback && fallback !== full) setFailed(true) }}
    className="absolute inset-0 w-full h-full object-cover" alt="" />
}

export default function FullscreenPlayer() {
  const performanceMode = usePerformanceMode()
  const { t } = useTranslation()
  const {
    showFullscreen, toggleFullscreen, currentTrack, isPlaying,
    showFullscreenVisualizer, setShowFullscreenVisualizer,
    progress, duration, volume, shuffle, repeat,
    showLyricsFullscreen, toggleLyricsFullscreen, switchFullscreenView,
    togglePlay, next, prev, setProgress, toggleShuffle, toggleRepeat,
    likedIds, setLiked, audioRef, cfAudioRef, activeAudioElement,
    playbackContext, setVolume,
  } = usePlayerStore(useShallow(({
    showFullscreen, toggleFullscreen, currentTrack, isPlaying,
    showFullscreenVisualizer, setShowFullscreenVisualizer,
    progress, duration, volume, shuffle, repeat,
    showLyricsFullscreen, toggleLyricsFullscreen, switchFullscreenView,
    togglePlay, next, prev, setProgress, toggleShuffle, toggleRepeat,
    likedIds, setLiked, audioRef, cfAudioRef, activeAudioElement,
    playbackContext, setVolume,
  }) => ({
    showFullscreen, toggleFullscreen, currentTrack, isPlaying,
    showFullscreenVisualizer, setShowFullscreenVisualizer,
    progress, duration, volume, shuffle, repeat,
    showLyricsFullscreen, toggleLyricsFullscreen, switchFullscreenView,
    togglePlay, next, prev, setProgress, toggleShuffle, toggleRepeat,
    likedIds, setLiked, audioRef, cfAudioRef, activeAudioElement,
    playbackContext, setVolume,
  })))
  const { user, openAddToPlaylist } = useAppStore()
  const nav = useNavigate()
  const openFullscreenAlbum = async (target = currentTrack) => {
    if (!target) return
    // Both resolvers navigate via the supplied callback only after an album
    // is found. Close the overlay immediately before that navigation, never
    // when a radio lookup fails (otherwise the user loses their player).
    const navigateFromFullscreen = (...args) => {
      toggleFullscreen()
      nav(...args)
    }
    if (isStationTrack(target)) {
      if (!await navigateToRadioAlbum(navigateFromFullscreen, target)) showToast(t("Couldn't find this song's album"))
    } else {
      navigateToTrackAlbum(navigateFromFullscreen, target)
    }
  }
  const wordSync = wordSyncEnabled()
  const [likeAnim, setLikeAnim] = useState(false)
  const [burst, setBurst] = useState(null)
  const likeBusy = useRef(false)
  const burstTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(burstTimer.current), [])
  const [bgLoaded, setBgLoaded] = useState(false)
  const backdropFx = useArtworkBackdropEnabled()
  const [fsCanvas, setFsCanvas] = useState(false)
  const [squareMotionActive, setSquareMotionActive] = useState(false)
  const [windowHidden, setWindowHidden] = useState(isWindowHidden)
  useEffect(() => onWindowVisibility(setWindowHidden), [])
  // Turned off for this song from the side panel.
  const [coverOff, setCoverOff] = useMotionCoverOff(currentTrack)
  const [settings, setSettings] = useState({})
  // Whether the song has a Canvas / moving cover (asked even while it's
  // turned off, so its button stays to turn it back on).
  const [coverClip, setCoverClip] = useState({ id: null, clip: null })
  useEffect(() => {
    const id = currentTrack?.id
    if (!id || !(showFullscreen || showLyricsFullscreen) || settings.fullscreen_visual_mode === 'turntable') return undefined
    let current = true
    loadMotionCover(id).then(clip => { if (current) setCoverClip({ id, clip: clip?.src ? clip : null }) })
    return () => { current = false }
  }, [currentTrack?.id, showFullscreen, showLyricsFullscreen, settings.fullscreen_visual_mode])
  const clipNow = coverClip.id === currentTrack?.id ? coverClip.clip : null
  const { video: musicVideo } = useMusicVideo(currentTrack, showFullscreen || showLyricsFullscreen)
  const showMusicVideo = useMusicVideoView(s => s.show)
  const clipName = clipNow && (clipNow.tall || clipNow.source === 'spotify') ? 'Canvas' : 'Moving Cover'
  const [showSearch, setShowSearch] = useState(false)
  // The artwork details have one explicit visibility control, independent
  // of the mouse-idle chrome. Preserve the choice across songs and modes.
  const [trackDetailsVisible, setTrackDetailsVisible] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  // Which side panel is open, driven purely by the two buttons below -- not
  // by whether the current track actually has lyrics. It used to require
  // hasLyrics to become true before the panel would show at all, so on a
  // track with no lyrics the Lyrics button looked completely broken (LyricsPanel
  // never even got a chance to render its own "no lyrics found" + search
  // state, exactly like it already does in windowed mode).
  const [fullscreenPanel, setFullscreenPanel] = useState('none')
  const isPanelVisible = Boolean(currentTrack && fullscreenPanel !== 'none')
  const prevTrackId = useRef(null)
  // Full-screen lyrics is this same overlay in another layout (see
  // LyricsFullscreen): it's open when either view is, and the player's own
  // controls step aside while lyrics shows.
  const open = showFullscreen || showLyricsFullscreen
  const lyricsMode = showLyricsFullscreen
  // Reduced motion: the views just crossfade (the cover doesn't fly).
  const reduceMotion = useReducedMotion()
  // Old installations used a CD on/off flag; preserve its choice until the
  // user explicitly selects one of the three fullscreen artwork modes.
  const fullscreenVisualMode = ['cover', 'cd', 'turntable'].includes(settings.fullscreen_visual_mode)
    ? settings.fullscreen_visual_mode
    : (settings.fullscreen_rotating_cd === '1' ? 'cd' : 'cover')
  const turntableMode = fullscreenVisualMode === 'turntable'
  // Suspend all moving covers, including a sidebar hidden behind this overlay.
  // Restore their normal behavior on exit without changing the user's setting.
  useEffect(() => {
    const enabled = showFullscreen && turntableMode
    document.documentElement.toggleAttribute('data-fullscreen-turntable', enabled)
    window.dispatchEvent(new Event('lokal:fullscreen-turntable'))
    return () => {
      if (enabled) {
        document.documentElement.removeAttribute('data-fullscreen-turntable')
        window.dispatchEvent(new Event('lokal:fullscreen-turntable'))
      }
    }
  }, [showFullscreen, turntableMode])
  const rotatingCd = fullscreenVisualMode === 'cd' && !performanceMode && !reduceMotion
  // In the original CD mode, a playing Canvas/moving cover still takes priority.
  const spinCd = rotatingCd && !fsCanvas && !squareMotionActive
  const animationRunning = showFullscreen && !lyricsMode && isPlaying && !windowHidden
  const playerLayerRef = useRef(null)
  const coverRef = useRef(null)
  const coverMotionRef = useRef(null)
  const coverStageRef = useRef(null)
  const previousPanelLayoutRef = useRef(null)
  const panelStageAnimationRef = useRef(null)
  const panelCoverAnimationRef = useRef(null)
  const lyricsPanelRef = useRef(null)
  const [lyricsLeftExpansion, setLyricsLeftExpansion] = useState(0)

  // The previous 18–32px negative margin barely affected the real artwork-to-
  // lyrics gap, and LyricsPanel's centred max-width cancelled part of it.
  // Measure the *untransformed* square artwork's right edge and the panel's
  // fixed left edge, then extend just the lyrics content 40% into that gap.
  // A separate width option in LyricsPanel removes the internal max-width;
  // no textScale, cover position or panel right edge is changed.
  useLayoutEffect(() => {
    if (!showFullscreen || fullscreenPanel !== 'lyrics') {
      setLyricsLeftExpansion(value => value === 0 ? value : 0)
      return undefined
    }
    const stage = coverStageRef.current
    const cover = coverMotionRef.current
    const panel = lyricsPanelRef.current
    const layer = playerLayerRef.current
    if (!stage || !cover || !panel || !layer) return undefined

    const measure = () => {
      // Use layout offsets, never animated getBoundingClientRect() values.
      // Neither the cover's GPU scale nor the panel slide affects this gap.
      const layerLeft = layer.getBoundingClientRect().left
      const coverRight = layerLeft + stage.offsetLeft + cover.offsetLeft + cover.offsetWidth
      const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
      const lyricRow = panel.querySelector('[data-lyrics-auto-follow] [data-row] > div')
      const rowPadding = lyricRow && Number.parseFloat(window.getComputedStyle(lyricRow).paddingLeft)
      // LyricsPanel uses px-6 (1.5rem); the rows add their own inset.
      const textInset = rootFontSize * 1.5 + (Number.isFinite(rowPadding) ? rowPadding : rootFontSize * 0.83)
      const next = computeFullscreenLyricsExpansion({
        panelLeft: layerLeft + panel.offsetLeft,
        coverRight,
        textInset,
      })
      setLyricsLeftExpansion(value => value === next ? value : next)
    }

    let frame = 0
    const scheduleMeasure = () => {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; measure() })
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null
    for (const node of [stage, cover, panel]) observer?.observe(node)
    window.addEventListener('resize', scheduleMeasure)
    measure()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [showFullscreen, fullscreenPanel, currentTrack?.id])
  // FLIP: the new panel width and artwork size are laid out once, before paint.
  // Only the stage's translation and artwork wrapper's scale are then animated.
  // Animating the old width/height/transition-all forced Chromium to rewrap
  // every lyric line (including its word spans) throughout the 500ms animation.
  useLayoutEffect(() => {
    const stage = coverStageRef.current
    const cover = coverMotionRef.current
    if (!showFullscreen || lyricsMode || !stage) {
      previousPanelLayoutRef.current = null
      return
    }
    const stageBox = stage.getBoundingClientRect()
    const coverBox = cover?.getBoundingClientRect()
    const previous = previousPanelLayoutRef.current
    previousPanelLayoutRef.current = { stageBox, coverBox }
    panelStageAnimationRef.current?.cancel()
    panelCoverAnimationRef.current?.cancel()
    if (!previous || reduceMotion) return

    const previousCenter = previous.stageBox.left + previous.stageBox.width / 2
    const currentCenter = stageBox.left + stageBox.width / 2
    const distance = previousCenter - currentCenter
    const options = {
      duration: PANEL_ANIMATION_MS,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    }
    if (Math.abs(distance) > 1) {
      panelStageAnimationRef.current = stage.animate([
        { transform: `translate3d(${distance}px, 0, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ], options)
    }
    if (cover && previous.coverBox && coverBox?.width > 0) {
      const scale = previous.coverBox.width / coverBox.width
      if (Number.isFinite(scale) && Math.abs(scale - 1) > 0.005) {
        panelCoverAnimationRef.current = cover.animate([
          { transform: `scale(${scale})` },
          { transform: 'scale(1)' },
        ], options)
      }
    }
  }, [showFullscreen, isPanelVisible, lyricsMode, reduceMotion])

  useEffect(() => () => {
    panelStageAnimationRef.current?.cancel()
    panelCoverAnimationRef.current?.cancel()
  }, [])

  useEffect(() => {
    if (playerLayerRef.current) playerLayerRef.current.inert = lyricsMode
  }, [lyricsMode, open])
  // The cover flies between the player and the full-screen lyrics header (see
  // coverFlight): a copy of it moves while the real ones stay hidden until it
  // lands. With a canvas playing, the copy keeps playing it and turns into
  // the cover on the way (the header shows the cover), without stretching
  // between aspect ratios: Spotify Canvas is cropped to the square card.
  // Both views are always laid out (just faded) for correct measurements.
  const flightRef = useRef(null)
  const prevModeRef = useRef(null)
  useLayoutEffect(() => {
    const was = prevModeRef.current
    prevModeRef.current = open ? lyricsMode : null
    if (!open || was === null || was === lyricsMode || reduceMotion) return
    flightRef.current?.()
    const overlay = document.querySelector('[data-fullscreen-player-overlay]')
    const big = coverRef.current
    const thumb = overlay?.querySelector('[data-fullscreen-thumb]')
    const art = trackArtURL(usePlayerStore.getState().currentTrack)
    if (!overlay || !big || !thumb || !art) return
    const card = big.getBoundingClientRect()
    const small = thumb.getBoundingClientRect()
    if (!card.width || !small.width) return
    // The canvas, if one is showing in the card (MotionCover fades it in once playing).
    const video = [...big.querySelectorAll('video')].find(v => v.readyState >= 2 && v.style.opacity !== '0') || null
    const flight = startCoverFlight({
      parent: overlay,
      from: lyricsMode ? card : small,
      to: lyricsMode ? small : card,
      art,
      video,
      card: { width: card.width, height: card.height },
      toLyrics: lyricsMode,
      radius: lyricsMode ? [16, 8] : [8, 16],
      timing: { duration: FULLSCREEN_SWITCH.duration * 1000 + 60, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    })
    big.style.visibility = 'hidden'
    thumb.style.visibility = 'hidden'
    const land = () => {
      if (flightRef.current !== land) return
      flightRef.current = null
      big.style.visibility = ''
      thumb.style.visibility = ''
      flight.cancel()
    }
    flightRef.current = land
    flight.finished.then(land, land)
  }, [lyricsMode, open, reduceMotion])
  useEffect(() => () => flightRef.current?.(), [])
  // The panel container fades/collapses out over 500ms after fullscreenPanel
  // goes back to 'none' (see isPanelVisible below), but the ternary that picks
  // Queue vs. Lyrics content only matched 'queue' -- everything else, 'none'
  // included, fell through to the Lyrics branch. That swapped the panel's
  // contents to Lyrics the instant Queue was closed, so users saw a flash of
  // the Lyrics header/panel during the queue's own closing animation. Tracking
  // the last non-'none' panel keeps showing that panel's content while it
  // fades out, instead of switching to whatever the fallback branch was.
  const lastPanelRef = useRef('lyrics')
  useEffect(() => {
    if (fullscreenPanel !== 'none') lastPanelRef.current = fullscreenPanel
  }, [fullscreenPanel])

  // FullscreenPlayer stays mounted for the whole app session (App.jsx renders
  // it unconditionally and it just hides its own JSX), so a settings fetch
  // tied to mount only ever ran once at startup -- toggling and saving
  // Unsynced Lyrics Auto-Sync later in Settings never updated this component,
  // and lyrics kept using whatever value was cached at launch. Re-fetching
  // whenever the overlay actually opens picks up the current saved value.
  useEffect(() => {
    if (!showFullscreen) return undefined
    let active = true
    const refresh = () => api.getSettings().then(s => { if (active) setSettings(s || {}) }).catch(() => {})
    refresh()
    window.addEventListener('lokal:settings-saved', refresh)
    return () => { active = false; window.removeEventListener('lokal:settings-saved', refresh) }
  }, [showFullscreen])

  // Leaving fullscreen only fades the *outer* overlay out over its own
  // 300ms AnimatePresence exit. Confirmed live (Windows, DevTools attached
  // to a real build) that this exit can get stuck indefinitely: the whole
  // overlay -- side panel and all its buttons included -- stays mounted,
  // faded to opacity 0 but with computed pointer-events still "auto",
  // sitting at z-50 over the entire window and intercepting every click
  // anywhere in the app until the process is restarted. Repeatedly
  // switching Queue<->Lyrics right before closing (which tears down and
  // remounts the heavy LyricsPanel -- rAF word-sync ticking, springs,
  // selection/scroll listeners) right as the outer AnimatePresence exit
  // starts made this reliable to reproduce, but the stuck exit itself is
  // the bug; that's just what triggers it.
  //
  // Two things that look like fixes for this do NOT work, confirmed live:
  //  1. A `style={{ pointerEvents: showFullscreen ? 'auto' : 'none' }}`
  //     ternary on the overlay. It's dead code: that JSX only ever gets
  //     (re-)created while `showFullscreen && (...)` is true, so the
  //     'none' branch can never be reached at creation time. Once
  //     showFullscreen flips false, this component stops including the
  //     motion.div in its own return value at all -- AnimatePresence
  //     keeps animating out a snapshot of the *last* element it was
  //     given, frozen with whatever props/classes it had at that moment.
  //  2. Resetting fullscreenPanel/showSearch React state (still done
  //     below, for its own sake -- it's what makes reopening fullscreen
  //     start from a clean panel-closed state). It runs fine, but can't
  //     reach the frozen snapshot either, for the same reason: by the
  //     time this component re-renders with the new state, showFullscreen
  //     is already false, so it again contributes nothing for that slot.
  //
  // The only thing that actually worked, verified live: reaching the real
  // DOM node directly, outside React, and hiding it. pointer-events alone
  // isn't enough either -- the "Go to {context}" link a little further
  // down explicitly opts back in with its own pointer-events-auto (by
  // design, for while fullscreen is genuinely open), which would stay
  // clickable through an ancestor's pointer-events: none. visibility is
  // not overridden anywhere in this file, so visibility: hidden reliably
  // takes every descendant out of hit-testing regardless of what pointer-
  // events they set. This queries the DOM instead of using a single ref
  // because if this happens more than once without a previous exit ever
  // completing, more than one stuck copy can accumulate; a ref would only
  // ever reach the most recently mounted one. data-fullscreen-player-
  // overlay is a marker unique to this component -- Modal.jsx,
  // AlbumsModal.jsx and LyricsFullscreen.jsx all reuse the same "fixed
  // inset-0 z-50" classes, so matching on those instead risked hiding an
  // unrelated, legitimately open overlay.
  useEffect(() => {
    if (open) {
      // Reopening before the exit animation finishes can make Framer Motion
      // reuse the same overlay DOM node, and React doesn't manage the inline
      // visibility set below -- clear it or the player reopens invisible.
      document.querySelectorAll('[data-fullscreen-player-overlay]').forEach((el) => {
        el.style.removeProperty('visibility')
      })
      return
    }
    setFullscreenPanel('none')
    setShowSearch(false)
    document.querySelectorAll('[data-fullscreen-player-overlay]').forEach((el) => {
      el.style.setProperty('visibility', 'hidden')
    })
  }, [open])

  // Opened for a song with lyrics found: the lyrics at the side of the cover
  // (the Lyrics button's panel); for one without: the cover, centred. Lyrics
  // not looked up yet are asked for, and found within a moment they open the
  // panel; later, or none, the cover stays (a view changing under someone
  // already looking at it is worse than a cover). Only on opening, and only
  // while the panel is still closed: picking a panel meanwhile wins.
  const wasShowingRef = useRef(false)
  useLayoutEffect(() => {
    const opened = showFullscreen && !wasShowingRef.current
    wasShowingRef.current = showFullscreen
    if (!opened || !currentTrack || turntableMode) return undefined
    const track = currentTrack
    const showLyrics = () => setFullscreenPanel(panel => (panel === 'none' ? 'lyrics' : panel))
    const cached = peekLyrics(track.id)
    if (hasLyricLines(cached)) { showLyrics(); return undefined }
    if (cached !== undefined) return undefined
    let cancelled = false
    const asked = Date.now()
    Promise.resolve(api.getLyrics(track.id, track.title, track.artist, track.album, track.duration, track.file_path)).then(result => {
      const found = result && (result.lines?.length || result.instrumental) ? result : null
      cacheLyrics(track.id, found)
      if (cancelled || !hasLyricLines(found) || Date.now() - asked > FULLSCREEN_LYRICS_WAIT_MS) return
      if (usePlayerStore.getState().currentTrack?.id === track.id) showLyrics()
    }).catch(() => {})
    return () => { cancelled = true }
  }, [showFullscreen, turntableMode]) // eslint-disable-line react-hooks/exhaustive-deps
  // Switching to the scene never leaves an auto-opened lyrics/queue panel over
  // the artwork; panels may still be opened deliberately from its controls.
  useEffect(() => {
    if (turntableMode) setFullscreenPanel('none')
  }, [turntableMode])

  const canOpenContext = isContextNavigable(playbackContext)
  const openContext = () => {
    if (!canOpenContext) return
    // Leave fullscreen first, otherwise the overlay hides the page we land on.
    toggleFullscreen()
    navigateToContext(nav, playbackContext, currentTrack?.id)
  }

  useEffect(() => {
    // LyricsFullscreen renders on top of this overlay when both are open
    // (see the Expand Lyrics button below), so while it's showing, Escape
    // should close *that* first instead of also tearing down this whole
    // fullscreen view underneath it.
    const h = (e) => {
      if (e.key !== 'Escape' || showFullscreenVisualizer) return
      // In the whole-screen mode, Escape leaves that first (the player stays).
      if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); return }
      toggleFullscreen()
    }
    if (showFullscreen && !showLyricsFullscreen) document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [showFullscreen, showLyricsFullscreen, showFullscreenVisualizer])

  useEffect(() => {
    if (currentTrack?.id !== prevTrackId.current) {
      setBgLoaded(false)
      prevTrackId.current = currentTrack?.id
    }
  }, [currentTrack?.id])

  const artSrc = trackFullArtURL(currentTrack)

  const isLiked = currentTrack && likedIds.has(currentTrack.id)
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat


  const toggleLike = async () => {
    if (!currentTrack || likeBusy.current) return
    likeBusy.current = true
    try {
      const r = await api.toggleLike(currentTrack.id, user?.id, currentTrack)
      const liked = typeof r === 'boolean' ? r : r?.liked ?? false
      setLiked(currentTrack.id, liked)
      if (liked && !reduceMotion) { setLikeAnim(true); setTimeout(() => setLikeAnim(false), 700) }
    } finally {
      likeBusy.current = false
    }
  }

  // Double-clicking the cover itself (not a button or the volume pill on it)
  // likes the song; doing it again un-likes it. One at a time, so a quick triple
  // click can't get the heart and the server out of step.
  const doubleClickLike = async (event) => {
    if (!currentTrack || likeBusy.current) return
    if (event.target.closest?.('button, a, input, [role="slider"]')) return
    window.clearTimeout(burstTimer.current)
    setBurst({ id: Date.now(), trackId: currentTrack.id, kind: isLiked ? 'unlike' : 'like' })
    burstTimer.current = window.setTimeout(() => setBurst(null), 1200)
    try {
      await toggleLike()
    } catch {
      setBurst(null)
    }
  }

  const handleLyricsSelect = async (lyrics, type) => {
    if (!currentTrack) return
    const trackId = currentTrack.id
    setShowSearch(false)
    try {
      const imported = await api.importLyrics(trackId, lyrics, type)
      if (!imported?.lines?.length) throw new Error('No usable lyrics were found.')
      announceLyricsChanged(trackId)
      if (usePlayerStore.getState().currentTrack?.id === trackId) setRefreshKey(k => k + 1)
    } catch (error) {
      showToast(error?.message || 'Could not import lyrics.')
    }
  }

  // Idle: after a few seconds without the mouse moving, the header and the
  // cover's controls fade out and the cursor hides; any movement brings them
  // back. Not while the pointer rests on the header or the lyrics search is open.
  // The lyrics layout (LyricsFullscreen) hides its own the same way.
  const [idle, setIdle] = useState(false)
  const overChromeRef = useRef(false)
  useEffect(() => {
    if (!showFullscreen) { setIdle(false); return undefined }
    let timer = null
    const wake = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => { if (!overChromeRef.current) setIdle(true) }, IDLE_MS)
    }
    wake()
    const events = ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart']
    events.forEach(type => window.addEventListener(type, wake, { passive: true }))
    return () => { clearTimeout(timer); events.forEach(type => window.removeEventListener(type, wake)) }
  }, [showFullscreen])
  const chromeHidden = idle && !showSearch
  const setOverChrome = useCallback((over) => { overChromeRef.current = over }, [])
  // Each piece of the header fades by itself (glass inside a fading parent flashes grey; see COVER_FADE).
  const chromeFade = `transition-[opacity,color,background-color] duration-300 ${chromeHidden ? 'opacity-0' : 'opacity-100'}`
  const [coverHover, setCoverHover] = useState(false)
  const controlsShown = coverHover && !chromeHidden
  /**
   * Tilt the fullscreen cover toward the pointer without adding a hover-light effect.
   * @param {PointerEvent} event Pointer movement over the cover.
   */
  const handleCoverPointerMove = (event) => {
    if (reduceMotion || event.pointerType !== 'mouse') return
    const cover = event.currentTarget
    const bounds = cover.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    cover.style.setProperty('--cover-rotate-x', `${(0.5 - y) * 9}deg`)
    cover.style.setProperty('--cover-rotate-y', `${(x - 0.5) * 9}deg`)
  }
  /**
   * Restore the fullscreen cover's neutral tilt when the pointer leaves.
   * @param {MouseEvent} event Pointer-leave event from the cover.
   */
  const resetCoverPointer = (event) => {
    setCoverHover(false)
    const cover = event.currentTarget
    cover.style.setProperty('--cover-rotate-x', '0deg')
    cover.style.setProperty('--cover-rotate-y', '0deg')
  }

  // The whole screen (the OS's full screen), on top of this view; left when
  // the view closes.
  const [screenFull, setScreenFull] = useState(() => !!document.fullscreenElement)
  useEffect(() => {
    const onChange = () => setScreenFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleScreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    else document.documentElement.requestFullscreen?.().catch(() => {})
  }
  useEffect(() => {
    if (!open && document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }, [open])

  // Seeking: click or drag along the bar.
  const barRef = useRef(null)
  const seekTo = (clientX) => {
    const bar = barRef.current
    const { duration: length } = usePlayerStore.getState()
    if (!bar || !length) return
    const r = bar.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * length
    // Through the store: it seeks the playing element, or the TV while casting.
    usePlayerStore.getState().setProgressWithAudioUpdate(t)
  }
  const startScrub = (event) => {
    event.preventDefault()
    seekTo(event.clientX)
    const move = e => seekTo(e.clientX)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const isAutoSynced = settings.unsynced_auto_sync === '1'
  const coverSize = isPanelVisible ? COVER_SIZE_WITH_PANEL : COVER_SIZE
  const fullscreenQualityTier = currentTrack
    ? (isSuspect(currentTrack) ? 'suspect' : tierOf(currentTrack))
    : 'unknown'
  const fullscreenQualityLabel = currentTrack
    ? qualityTagLabel(currentTrack, fullscreenQualityTier, settings.resolution_tags_in_full_player === '1')
    : null
  const showFullscreenQuality = !!fullscreenQualityLabel &&
    !(fullscreenQualityTier === 'unknown' && fullscreenQualityLabel === 'Not read')
  // The side panel keeps its full width even when hidden. Its contents can be
  // laid out at their final width; opening it never animates layout dimensions.
  // The fullscreen overlay still owns its existing exit animation.

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          // Idle, the cursor hides everywhere, the seek bar and other clickable bits included.
          className={`fixed inset-0 z-50 flex overflow-hidden ${chromeHidden && !lyricsMode ? 'cursor-none [&_*]:!cursor-none' : ''}`}
          style={{ WebkitAppRegion: 'no-drag' }}
          // Marks this exact DOM node so the useEffect above can reach and
          // hide it (and any stuck earlier copies) directly if its exit
          // animation never completes -- see that effect's comment.
          data-fullscreen-player-overlay=""
        >
          <div className="absolute inset-0 bg-black">
            {/* Colours taken from the cover (see ArtworkBackdrop), or -- with
                that switched off in Settings -- the plain blurred cover. */}
            {performanceMode ? <div className="absolute inset-0 bg-neutral-950" /> : backdropFx ? (
              <ArtworkBackdrop trackId={currentTrack?.id} blur={64} />
            ) : (
              <AnimatePresence mode="wait">
                {artSrc ? (
                  <motion.img
                    key={currentTrack?.id}
                    src={artSrc}
                    onLoad={() => setBgLoaded(true)}
                    initial={{ opacity: 0, scale: 1.15 }}
                    animate={{ opacity: bgLoaded ? 0.45 : 0, scale: 1.08 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.8 }}
                    className="w-full h-full object-cover"
                    style={{ filter: 'blur(72px) saturate(1.6) brightness(0.5)' }}
                  />
                ) : (
                  <motion.div
                    key="no-art"
                    className="w-full h-full bg-gradient-to-br from-neutral-900 to-black"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  />
                )}
              </AnimatePresence>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/30" />
            {/* Lyrics read over a darker backdrop: the same one, dimmed. */}
            <motion.div className="absolute inset-0 bg-black" initial={false}
              animate={{ opacity: lyricsMode ? 0.35 : 0 }} transition={FULLSCREEN_SWITCH} />
          </div>

          {/* The player's own controls, which step aside for full-screen
              lyrics (and come back when it closes) instead of a second
              overlay sliding over them. Faded out, they stay drawn (opacity
              0, not visibility: hidden, which would drop what's drawn and
              make coming back redraw all of it on the switch's first frame). */}
          <motion.div ref={playerLayerRef} className="absolute inset-0 flex"
            initial={false}
            animate={{ opacity: lyricsMode ? 0 : 1 }}
            transition={lyricsMode ? FULLSCREEN_OUT : FULLSCREEN_IN}
            style={{ pointerEvents: lyricsMode ? 'none' : undefined }}>

          {turntableMode && <FullscreenTurntable track={currentTrack}
            playing={animationRunning && !reduceMotion && !performanceMode}
            progress={progress} duration={duration}
            onNext={() => next(false)} onPrevious={prev} onPlayPause={togglePlay} />}

          {/* The header: close, lyrics view, what's playing from, full screen.
              It fades out (and the cursor hides) after a few seconds without
              the mouse moving, and comes back as soon as it moves. */}
          <div className={`absolute inset-x-0 top-0 z-20 grid grid-cols-[1fr_minmax(0,2fr)_1fr] items-start gap-4 px-5 pt-5 ${chromeHidden ? 'pointer-events-none' : ''}`}
            onMouseEnter={() => { overChromeRef.current = true }} onMouseLeave={() => { overChromeRef.current = false }}>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={toggleFullscreen} title={t("Close")} aria-label={t("Close full-screen player")}
                className={`w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur-sm ${chromeFade}`}>
                <X size={15} />
              </button>
              {/* Straight to full-screen lyrics (the view to come back from
                  has a Player button). */}
              {currentTrack && (
                <button onClick={() => switchFullscreenView('lyrics')} title={t("Switch to full-screen lyrics")}
                  className={`h-9 px-3.5 flex items-center gap-1.5 rounded-full bg-white/10 hover:bg-white/20 text-xs text-white/80 hover:text-white backdrop-blur-sm ${chromeFade}`}>
                  <Maximize2 size={13} /> Lyrics
                </button>
              )}
            </div>
            {playbackContext?.name && (
              <div className={`col-start-2 min-w-0 text-center ${chromeFade}`}>
                <p className="text-[10px] font-display uppercase tracking-[0.28em] text-white/45">
                  {contextLabel(playbackContext)}
                </p>
                {canOpenContext ? (
                  <button
                    onClick={openContext}
                    title={`Go to ${playbackContext.name}`}
                    className="mt-1 max-w-full truncate text-sm font-medium text-white/85 hover:text-white hover:underline transition-colors">
                    {playbackContext.name}
                  </button>
                ) : (
                  <p className="mt-1 truncate text-sm font-medium text-white/85">{playbackContext.name}</p>
                )}
              </div>
            )}
            <div className={`col-start-3 justify-self-end flex items-center gap-2 ${chromeFade}`}>
              <button onClick={() => setShowFullscreenVisualizer(true)} disabled={!currentTrack}
                title={t('Open full-screen visualizer')} aria-label={t('Open full-screen visualizer')}
                className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur-sm disabled:opacity-30">
                <Gamepad2 size={16} />
              </button>
              <button type="button" onClick={() => setTrackDetailsVisible(visible => !visible)}
                title={trackDetailsVisible ? t('Hide track details') : t('Show track details')}
                aria-label={trackDetailsVisible ? t('Hide track details') : t('Show track details')}
                aria-pressed={!trackDetailsVisible}
                data-fullscreen-details-toggle=""
                className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur-sm">
                {trackDetailsVisible ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button onClick={toggleScreen} title={screenFull ? 'Exit full screen' : 'Fill the whole screen'} aria-label={screenFull ? 'Exit full screen' : 'Fill the whole screen'}
                className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur-sm">
                {screenFull ? <Minimize size={15} /> : <Expand size={15} />}
              </button>
            </div>
          </div>

          {/* The cover, with the controls over it (shown while the pointer is
              on it), then the progress, the title and the artist. Clear of
              the header, so a tall canvas doesn't run into "Playing from". */}
          <div ref={coverStageRef} className={`relative z-10 flex flex-col items-center ${turntableMode ? 'justify-end' : 'justify-center'} flex-1 min-w-0 px-12 pt-24 pb-12`}
            style={{ marginRight: isPanelVisible ? PANEL_WIDTH : 0 }}>
            {/* Keep the tag outside the artwork, directly above the cover.
                This zero-height anchor never shifts the cover, title, or seek
                bar when the tag is hidden (or when tracks change). In
                Turntable mode the scene is a full-stage canvas, so anchor
                the badge just below the main header instead. */}
            {showFullscreenQuality && (
              <div data-fullscreen-quality-tag aria-hidden={!trackDetailsVisible}
                className={`pointer-events-none z-20 flex h-0 justify-center transition-opacity duration-300 ${trackDetailsVisible ? 'opacity-100' : 'opacity-0'} ${turntableMode ? 'absolute inset-x-0 top-20' : 'relative flex-shrink-0'}`}
                style={turntableMode ? undefined : { width: coverSize }}>
                <span
                  className={`absolute ${turntableMode ? 'top-0' : 'bottom-3'} left-1/2 -translate-x-1/2 max-w-full truncate whitespace-nowrap rounded-full border border-white/25 bg-white/10 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-white`}
                  title={fullscreenQualityLabel}
                  aria-label={settings.resolution_tags_in_full_player === '1'
                    ? `Audio resolution: ${fullscreenQualityLabel}`
                    : `Audio quality: ${fullscreenQualityLabel}`}>
                  {fullscreenQualityLabel}
                </span>
              </div>
            )}
            {/* One card for every song (never swapped, so never waiting on an
                exit while the window is minimized): the artwork changes inside
                it (MixCovers: AutoMix's cloudy dissolve, else a short fade). */}
              {!turntableMode && <div ref={coverMotionRef} className="relative flex-shrink-0" style={{ width: coverSize, height: coverSize }}><motion.div
                ref={coverRef}
                initial={{ opacity: 0, scale: 0.92, y: 16 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 200, damping: 26 }}
                onMouseEnter={() => setCoverHover(true)}
                onMouseLeave={resetCoverPointer}
                onPointerMove={handleCoverPointerMove}
                onDoubleClick={doubleClickLike}
                className={"fullscreen-cover-stage group/cover relative select-none overflow-hidden flex-shrink-0 flex items-center justify-center " + (spinCd ? "rounded-full border border-transparent bg-transparent shadow-none" : "rounded-2xl shadow-[0_32px_80px_rgba(0,0,0,0.8)] border border-white/10 bg-white/5")}
                // Keep the artwork box square, including for a 9:16 Spotify Canvas.
                style={{ width: '100%', height: '100%' }}
              >
                <div className={spinCd ? "absolute inset-0 fullscreen-cd-disc" : "absolute inset-0"}
                  style={spinCd ? { animationPlayState: animationRunning ? "running" : "paused" } : undefined}>
                <div className={spinCd ? "fullscreen-cd-artwork absolute inset-0" : "absolute inset-0"}>
                {(artSrc || isStreamed(currentTrack))
                  ? <MixCovers track={currentTrack} render={(track, { top }) => (
                      <>
                        <FullscreenStillArtwork track={track} />
                        {top && !turntableMode && <MotionCover trackId={track?.id} only="square" onActive={setSquareMotionActive} off={coverOff} />}
                        {top && !turntableMode && <MotionCover trackId={track?.id} only="tall" onActive={setFsCanvas} off={coverOff} />}
                      </>
                    )} />
                  : <span className="absolute inset-0 flex items-center justify-center text-white/10 text-7xl">♪</span>
                }
                </div>
                {spinCd && <div className="fullscreen-cd-hole-outline" aria-hidden="true" />}
                </div>

                {currentTrack && (
                  <div data-shown={controlsShown} className="group/controls absolute inset-0 z-10 flex flex-col justify-between">
                    <div className={`absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/40 pointer-events-none ${COVER_FADE}`} />
                    <div className="relative flex items-center justify-center gap-3 pt-5">
                      <CoverButton onClick={toggleLike} label={isLiked ? 'Remove from Liked Songs' : 'Add to Liked Songs'} active={isLiked}>
                        <Heart size={19} fill={isLiked ? 'currentColor' : 'none'} />
                        <AnimatePresence>
                          {likeAnim && (
                            <motion.span initial={{ scale: 0.5, opacity: 1 }} animate={{ scale: 2.5, opacity: 0 }} exit={{}}
                              transition={{ duration: 0.5 }} className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <Heart size={19} className="text-accent" fill="currentColor" />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </CoverButton>
                      <CoverButton onClick={() => openAddToPlaylist(currentTrack)} label={t("Add to a playlist")}><ListPlus size={19} /></CoverButton>
                      <CoverButton onClick={() => setFullscreenPanel(p => p === 'queue' ? 'none' : 'queue')} label={fullscreenPanel === 'queue' ? 'Hide the queue' : 'Show the queue'} active={fullscreenPanel === 'queue'}><ListMusic size={19} /></CoverButton>
                      <CoverButton onClick={() => setFullscreenPanel(p => p === 'lyrics' ? 'none' : 'lyrics')} label={fullscreenPanel === 'lyrics' ? 'Hide the lyrics' : 'Show the lyrics'} active={fullscreenPanel === 'lyrics'}><Mic2 size={19} /></CoverButton>
                      {clipNow && (
                        <CoverButton onClick={() => setCoverOff(!coverOff)} label={coverOff ? `Show ${clipName}` : `Hide ${clipName}`} active={coverOff}>
                          {coverOff ? <Film size={19} /> : <ImageIcon size={19} />}
                        </CoverButton>
                      )}
                    </div>
                    <div className={`relative flex items-center justify-center gap-8 pb-7 ${COVER_FADE}`}>
                      <CoverIcon onClick={toggleShuffle} label={t("Shuffle")} pressed={shuffle} dim={!shuffle}>
                        <Shuffle size={22} className={shuffle ? 'text-accent' : ''} />
                      </CoverIcon>
                      <CoverIcon onClick={prev} label={t("Previous")}>
                        <SkipBack size={32} fill="currentColor" />
                      </CoverIcon>
                      <CoverIcon onClick={togglePlay} label={isPlaying ? 'Pause' : 'Play'}>
                        {isPlaying ? <Pause size={44} fill="currentColor" strokeWidth={0} /> : <Play size={44} fill="currentColor" strokeWidth={0} className="translate-x-0.5" />}
                      </CoverIcon>
                      <CoverIcon onClick={() => next(false)} label={t("Next")}>
                        <SkipForward size={32} fill="currentColor" />
                      </CoverIcon>
                      <CoverIcon onClick={toggleRepeat} label={t("Repeat")} pressed={repeat !== 'none'} dim={repeat === 'none'}>
                        <RepeatIcon size={22} className={repeat !== 'none' ? 'text-accent' : ''} />
                      </CoverIcon>
                    </div>
                    {/* The music video, mid left edge (opposite the volume). */}
                    {musicVideo && (
                      <div className="absolute left-4 top-1/2 -translate-y-1/2">
                        <CoverButton onClick={showMusicVideo} label={t("Play the music video")}><Clapperboard size={19} /></CoverButton>
                      </div>
                    )}
                    {/* Volume, up the right edge. */}
                    <div className="absolute right-4 top-1/2 -translate-y-1/2">
                      <VolumePill volume={volume} onChange={setVolume} />
                    </div>
                  </div>
                )}
                {burst && burst.trackId === currentTrack?.id && <LikeBurst key={burst.id} kind={burst.kind} />}
              </motion.div></div>}

            {turntableMode && currentTrack && (
              <div className={`relative z-10 flex items-center justify-center gap-5 rounded-full border border-white/15 bg-black/50 px-7 py-4 shadow-2xl backdrop-blur-md transition-opacity duration-300 ${chromeHidden ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                <CoverIcon onClick={toggleShuffle} label={t("Shuffle")} pressed={shuffle} dim={!shuffle}><Shuffle size={19} className={shuffle ? 'text-accent' : ''}/></CoverIcon>
                <CoverIcon onClick={prev} label={t("Previous")}><SkipBack size={25} fill="currentColor"/></CoverIcon>
                <CoverIcon onClick={togglePlay} label={isPlaying ? t("Pause") : t("Play")}>{isPlaying ? <Pause size={31} fill="currentColor" strokeWidth={0}/> : <Play size={31} fill="currentColor" strokeWidth={0}/>}</CoverIcon>
                <CoverIcon onClick={() => next(false)} label={t("Next")}><SkipForward size={25} fill="currentColor"/></CoverIcon>
                <CoverIcon onClick={toggleRepeat} label={t("Repeat")} pressed={repeat !== 'none'} dim={repeat === 'none'}><RepeatIcon size={19} className={repeat !== 'none' ? 'text-accent' : ''}/></CoverIcon>
                <span className="h-6 w-px bg-white/20" aria-hidden="true" />
                <CoverIcon onClick={() => setFullscreenPanel(p => p === 'queue' ? 'none' : 'queue')} label={t('Queue')} pressed={fullscreenPanel === 'queue'}><ListMusic size={19}/></CoverIcon>
                <CoverIcon onClick={() => setFullscreenPanel(p => p === 'lyrics' ? 'none' : 'lyrics')} label={t('Lyrics')} pressed={fullscreenPanel === 'lyrics'}><Mic2 size={19}/></CoverIcon>
                <input aria-label={t('Volume')} title={t('Volume')} type="range" min="0" max="1" step="0.01"
                  value={volume} onChange={e => setVolume(Number(e.target.value))}
                  className="w-20 accent-white" />
              </div>
            )}

            <div data-fullscreen-track-seekbar="" aria-hidden={!trackDetailsVisible} inert={!trackDetailsVisible}
              className={`relative mt-6 flex items-center gap-3 ${trackDetailsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'} transition-opacity duration-300`} style={{ width: turntableMode ? 'min(42rem, calc(100vw - 4rem))' : coverSize }}>
              <MixingMark className="absolute -top-4 left-1/2 -translate-x-1/2 pointer-events-none !text-white/80" />
              <span className="w-11 text-right text-sm tabular-nums text-white/75">{fmt(progress)}</span>
              <div ref={barRef} className="group/bar relative h-3.5 flex-1 cursor-pointer overflow-hidden rounded-full bg-white/20 backdrop-blur-[2px] drop-shadow-[0_1px_4px_rgba(0,0,0,0.25)]"
                onPointerDown={startScrub} role="slider" aria-label={t("Position")} aria-valuemin={0} aria-valuemax={Math.round(duration || 0)} aria-valuenow={Math.round(progress || 0)}>
                <div className="absolute inset-y-0 left-0 bg-white/90" style={{ width: `${duration ? Math.min(100, (progress / duration) * 100) : 0}%` }} />
              </div>
              <span className="w-11 text-sm tabular-nums text-white/75">{fmt(duration)}</span>
            </div>

            {/* In at once, fading: never waiting on the old title's way out (see PlayerBar). */}
            <motion.div key={currentTrack?.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              data-fullscreen-track-metadata="" aria-hidden={!trackDetailsVisible}
              className={`mt-5 text-center transition-opacity duration-300 ${trackDetailsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} style={{ width: turntableMode ? 'min(42rem, calc(100vw - 4rem))' : coverSize }}>
              {currentTrack && (currentTrack.album || (isStationTrack(currentTrack) && currentTrack.song_key)) ? (
                <button type="button" onClick={() => openFullscreenAlbum(currentTrack)}
                  title={t('Go to album')} aria-label={t('Go to album')}
                  className="block w-full text-center text-3xl font-bold text-white leading-tight truncate hover:underline hover:text-white/85 transition-colors">
                  {currentTrack.title}
                </button>
              ) : (
                <h2 className="text-3xl font-bold text-white leading-tight truncate">{currentTrack?.title || '—'}</h2>
              )}
              <p className="mt-1.5 text-lg text-white/70 truncate">{currentTrack?.artist}</p>
              {currentTrack?.album && <p className="mt-0.5 text-sm text-white/40 truncate">{currentTrack.album}</p>}
            </motion.div>
          </div>

          {currentTrack && (
              // Panel visibility (and which panel) is driven entirely by the
              // Queue/Lyrics buttons on the cover, not by whether lyrics
              // happen to exist; with lyrics missing, the panel shows its own
              // "no lyrics" state and search, same as windowed mode.
              <div
                ref={lyricsPanelRef}
                className={`absolute inset-y-0 right-0 z-10 flex flex-col ${isPanelVisible && fullscreenPanel === 'lyrics' ? 'overflow-visible' : 'overflow-hidden'} pt-24 pb-10 ${isPanelVisible ? '' : 'pointer-events-none'}`}
                style={{
                  width: PANEL_WIDTH,
                  opacity: isPanelVisible ? 1 : 0,
                  transform: isPanelVisible ? 'translate3d(0, 0, 0)' : 'translate3d(48px, 0, 0)',
                  transition: reduceMotion ? 'none' : `opacity ${PANEL_ANIMATION_MS}ms ease, transform ${PANEL_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
                }}
              >
                {(fullscreenPanel !== 'none' ? fullscreenPanel : lastPanelRef.current) === 'queue' ? (
                  <QueueContent variant="fullscreen" />
                ) : (
                  <>
                    <div className={`absolute right-6 top-[4.5rem] z-10 flex items-center gap-1 transition-opacity duration-300 ${chromeHidden ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                      <button onClick={toggleLyricsFullscreen} className="p-2 text-white/40 hover:text-white transition-colors" title={t("Expand lyrics")} aria-label={t("Expand lyrics")}>
                        <Maximize2 size={15} />
                      </button>
                      <button onClick={() => setShowSearch(true)} className="p-2 text-white/40 hover:text-white transition-colors" title={t("Search lyrics")} aria-label={t("Search lyrics")}>
                        <Search size={15} />
                      </button>
                    </div>
                    <div className="flex-1 min-h-0 pr-6" style={{ marginLeft: -lyricsLeftExpansion, width: `calc(100% + ${lyricsLeftExpansion}px)` }}>
                      <LyricsPanel
                        key={`${currentTrack?.id}-${refreshKey}`}
                        track={currentTrack}
                        progress={progress}
                        darkMode
                        fullscreen
                        wordSync={wordSync}
                        active={isPanelVisible && fullscreenPanel === 'lyrics' && !lyricsMode}
                        onSearchRequest={() => setShowSearch(true)}
                        textScale={1.6}
                        stretchFullscreenWidth
                        toolbarHidden={chromeHidden}
                        isAutoSynced={isAutoSynced}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

          <AnimatePresence>
            {showSearch && currentTrack && (
              <SearchDrawer 
                track={currentTrack} 
                onClose={() => setShowSearch(false)} 
                onSelect={handleLyricsSelect} 
              />
            )}
          </AnimatePresence>
          </motion.div>

          <LyricsFullscreen idle={idle} onChromeHover={setOverChrome} screenFull={screenFull} onToggleScreen={toggleScreen} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
