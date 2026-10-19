import { NativeAudioBridge, readOutputPreferences, saveOutputPreferences } from './audio/nativeOutput'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { effectiveReplayGainMode, replayGainMultiplier } from './audio/replayGain.mjs'
import { readCrossfadeSettings, fadeCurve, crossfadeDurations, CROSSFADE_MIN_S } from './audio/crossfade'
import { planTransition, AUTOMIX_PRELOAD_S } from './audio/automix'

// handleTimeUpdate's AutoMix: a pair whose plan failed crossfades this long.
const AUTOMIX_FALLBACK = Object.freeze({ fallback: true })
const AUTOMIX_FALLBACK_S = 6
const AUTOMIX_PLAN_BUDGET_MS = 40
import { prefetchUpcoming } from './queuePrefetch'
import React, { Activity, useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react'
import { MemoryRouter as Router, Routes, Route, Navigate, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import Sidebar from './components/Sidebar'
import PlayerBar from './components/PlayerBar'
import TitleBar from './components/TitleBar'
import { usePageWidth } from './pageWidth'
import RightSidebar from './components/RightSidebar'
import FullscreenPlayer from './components/FullscreenPlayer'
import MusicVideoPlayer from './components/MusicVideoPlayer'
import QueuePanel from './components/QueuePanel'
import LyricsSidePanel from './components/LyricsSidePanel'
import AuthModal from './components/AuthModal'
import ProfileModal from './components/ProfileModal'
import AddToPlaylistModal from './components/AddToPlaylistModal'
import MiniPlayer from './components/MiniPlayer'
import RecapStories from './components/RecapStories'
import Onboarding, { useOnboarding } from './components/Onboarding'
import PostOnboardingTour from './components/PostOnboardingTour'
import Home from './pages/Home'
import Albums from './pages/Albums'
import Genres, { GenreTracks } from './pages/Genres'
import Stations from './pages/Stations'
import CacheAnalysis from './pages/CacheAnalysis'
import OnlineAlbum from './pages/OnlineAlbum'
import Artists from './pages/Artists'
import Videos from './pages/Videos'
import Library from './pages/Library'
import Search from './pages/Search'
import Artist from './pages/Artist'
import Playlist from './pages/Playlist'
import Settings from './pages/Settings'
import Profile from './pages/Profile'
import Recap from './pages/Recap'
import Quality from './pages/Quality'
import Radio from './pages/Radio'
import LosslessModal from './components/LosslessModal'
import BulkLosslessModal from './components/BulkLosslessModal'
import SmartPlaylistModal from './components/SmartPlaylistModal'
import ImportPlaylistModal from './components/ImportPlaylistModal'
import ShareCardModal from './components/ShareCardModal'
import { usePlayerStore, useAppStore } from './store/player'
import { useShallow } from 'zustand/react/shallow'
import { api, peekSettings } from './api'
import { isStationTrack, stationSongTime, RADIO_CONTEXT } from './radio/stations'
import { pauseRadio, playRadio, radioTrackId, releaseRadio, startRadio } from './radio/radioSession'
import { handleStationTitle, resetStationDisplay } from './radio/radioNowPlaying'
import { radioBufferSeconds, useRadioStore } from './store/radio'
import { createDiscordPublisher } from './discord'
import Toaster, { showLoadingToast, showToast } from './components/Toaster'
import ReleaseRefreshBanner from './components/ReleaseRefreshBanner'
import { PageReadyContext, PageShownContext, PAGE_READY_TIMEOUT_MS } from './pageCache'
import { audioSrcFor, isAddonProvider, providerLabel, streamRef } from './onlineTracks'
import { playbackLog } from './playbackLog'
import TvController from './tv/TvController'


// An addon refusing because its access isn't set up (or has lapsed).
const ADDON_ACCESS_ERROR = /VERIFY_REQUIRED|verif|log\s*in|sign\s*in|unauthori[sz]ed|not authenticated/i

import { playbackAvailability, playbackFallbackMessage, resolveRecommendationTracks } from './recommendations'
import { isAudioEventForTrack, replaceAudioSource } from './playerAudio'
import { handleLiveSeek } from './liveSeek'
import { useMusicVideoView } from './musicVideo'
import { skipUnavailableRecommendation } from './recommendationPlayback'
import { useTranslation } from './i18n'
import { THEMES, applyTheme } from './theme'
import { useAppearanceFlag } from './appearanceFlags'
import { usePerformanceMode } from './performanceMode'
import { isWindowHidden, onWindowVisibility } from './windowVisibility'
import { startSpotifyLikesSync } from './spotifyLikes'
import { continueFlow, flowNeedsMore } from './flow/session'
import { useCastPlayback, takeResumePosition } from './cast/useCastPlayback'

async function addonStreamTrackHash(id) {
  try {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(id)))
    return Array.from(new Uint8Array(digest).slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join('')
  } catch { return null }
}

function logAddonMediaEvent(eventName, event, slot) {
  const el = event?.currentTarget
  if (!el) return
  const state = usePlayerStore.getState()
  const ref = streamRef(state.currentTrack)
  if (!ref || !isAddonProvider(ref.provider)) return
  if (String(el.getAttribute('src') || '').split('?')[0] !== api.onlineStreamURL(ref.provider, ref.id)) return

  const error = el.error
  const snapshot = {
    event: eventName,
    provider: ref.provider,
    slot,
    active: state.activeAudioElement === slot,
    storeIsPlaying: !!state.isPlaying,
    paused: !!el.paused,
    readyState: Number.isFinite(el.readyState) ? el.readyState : null,
    networkState: Number.isFinite(el.networkState) ? el.networkState : null,
    currentTime: Number.isFinite(el.currentTime) ? Number(el.currentTime.toFixed(3)) : null,
    duration: Number.isFinite(el.duration) ? Number(el.duration.toFixed(3)) : null,
    mediaErrorCode: Number.isFinite(Number(error?.code)) ? Number(error.code) : null,
    mediaError: String(error?.message || '').slice(0, 200) || null,
  }
  void addonStreamTrackHash(ref.id).then(track => {
    api.log(eventName === 'error' || eventName === 'stalled' ? 'warn' : 'info',
      `[online-stream] media-event ${JSON.stringify({ ...snapshot, track })}`)
  }).catch(() => {})
}

// A bass-swap filter at rest: open (below anything audible).
const MIX_FILTER_OPEN_HZ = 10

/** The song that plays after the current one in `state`'s queue (shuffle order when shuffled), or null. */
function upcomingTrack(state) {
  const { shuffle, shuffleQueue, shuffleIndex, queue, queueIndex } = state
  if (shuffle && shuffleQueue.length > 0) return shuffleIndex + 1 < shuffleQueue.length ? shuffleQueue[shuffleIndex + 1] : null
  return queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null
}

const EQ_AUDIO_BANDS = [
  { frequency: 31, type: 'lowshelf', q: 0.7 },
  { frequency: 62, type: 'peaking', q: 0.9 },
  { frequency: 125, type: 'peaking', q: 0.95 },
  { frequency: 250, type: 'peaking', q: 0.95 },
  { frequency: 500, type: 'peaking', q: 1 },
  { frequency: 1000, type: 'peaking', q: 1 },
  { frequency: 2000, type: 'peaking', q: 1 },
  { frequency: 4000, type: 'peaking', q: 0.95 },
  { frequency: 8000, type: 'peaking', q: 0.9 },
  { frequency: 16000, type: 'highshelf', q: 0.7 },
]
const LASTFM_STATUS_KEY = 'lokal-lastfm-status-feed'
const YTDLP_DISMISS_KEY = 'lokal-ytdlp-version-dismissed'
// A scrobble / listen that wasn't sent is tried again after this long (not every second).
const SCROBBLE_RETRY_MS = 30 * 1000
// How long a crossfade waits for the next track (a stream may start slowly).
const CROSSFADE_READY_TIMEOUT_MS = 15 * 1000

function formatRelativeDays(days, t) {
  if (!Number.isFinite(days) || days <= 0) return t('up to date')
  if (days < 30) return t(days === 1 ? '{count} day behind' : '{count} days behind', { count: days })
  const months = Math.floor(days / 30)
  if (months < 12) return t(months === 1 ? '{count} month behind' : '{count} months behind', { count: months })
  const years = Math.floor(months / 12)
  return t(years === 1 ? '{count} year behind' : '{count} years behind', { count: years })
}

function getYtDlpDismissKey(status) {
  return `${status?.installedVersion || 'missing'}::${status?.latestVersion || 'unknown'}`
}

/** The fields ListenBrainz needs from a library track. */
function listenBrainzTrack(track) {
  return { title: track.title, artist: track.artist, album: track.album || '', duration: Number(track.duration) || 0, track_num: track.track_num || null }
}

function pushLastfmStatus(entry) {
  try {
    const feed = JSON.parse(localStorage.getItem(LASTFM_STATUS_KEY) || '[]')
    const next = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        time: Date.now(),
        ...entry,
      },
      ...feed,
    ].slice(0, 10)
    localStorage.setItem(LASTFM_STATUS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('lokal:lastfm-status', { detail: next }))
  } catch {}
}

function normalizeEqGains(input) {
  const values = Array.isArray(input) ? input.map(v => Number(v) || 0) : []
  if (values.length === EQ_AUDIO_BANDS.length) {
    return values.slice(0, EQ_AUDIO_BANDS.length)
  }
  if (values.length === 5) {
    return [values[0], values[0], values[1], values[1], values[2], values[2], values[3], values[3], values[4], values[4]]
  }
  return EQ_AUDIO_BANDS.map((_, i) => values[i] || 0)
}

function KeyboardShortcuts() {
  useKeyboardShortcuts()
  return null
}

function NativeHistoryNavigation() {
  const navigate = useNavigate()
  // { at, source, direction } of the last navigation actually performed.
  const lastNativeNavigationAtRef = useRef({ at: 0, source: null, direction: 0 })

  useEffect(() => {
    // Some Windows mice surface ONE press as both an Electron app-command
    // and a Chromium mouse-button event. Only that cross-source echo is a
    // duplicate: a second event from the SAME source is a real second press
    // (e.g. clicking Back twice quickly) and must go through.
    const isCrossSourceDuplicate = (source, direction) => {
      const last = lastNativeNavigationAtRef.current
      return last.source !== null &&
        last.source !== source &&
        last.direction === direction &&
        performance.now() - last.at < 250
    }

    const navigateOnce = (source, direction) => {
      if (isCrossSourceDuplicate(source, direction)) return
      lastNativeNavigationAtRef.current = { at: performance.now(), source, direction }

      const navEvent = new CustomEvent('lokal:history-navigate', {
        cancelable: true,
        detail: { direction, source },
      })
      const handled = !window.dispatchEvent(navEvent)
      if (handled) return

      navigate(direction)
    }

    const unsubscribeElectron = window.electron?.onNavigationHistory?.((direction) => {
      navigateOnce('electron', direction)
    })

    const handleMouseButton = (event) => {
      if (event.button !== 3 && event.button !== 4) return

      // Chromium reports X1/X2 as mouse buttons 3/4. Prevent its default
      // browser navigation and drive the MemoryRouter ourselves.
      event.preventDefault()
      event.stopPropagation()

      const direction = event.button === 3 ? -1 : 1
      navigateOnce('mouse', direction)
    }

    window.addEventListener('mouseup', handleMouseButton, true)

    return () => {
      unsubscribeElectron?.()
      window.removeEventListener('mouseup', handleMouseButton, true)
    }
  }, [navigate])

  return null
}

/**
 * One page's fade in / out. A `gated` page stays invisible until it calls
 * usePageReady(true) (its data is in), so it appears whole instead of
 * flashing its empty state first; PAGE_READY_TIMEOUT_MS caps the wait.
 */
function PageTransition({ gated = false, children }) {
  const [ready, setReady] = useState(!gated)
  const [shown, setShown] = useState(false)
  // Start the fade two frames after the page says it's ready: the page's
  // first render and paint (heavy on image grids) then happen while it's
  // still invisible, instead of eating the start of the fade.
  const requested = useRef(false)
  const markReady = useCallback(() => {
    if (requested.current) return
    requested.current = true
    requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))
  }, [])
  // Reduced motion: fade only, no rise. A plain transform string (not `y`)
  // plus opacity lets the fade run on the compositor (WAAPI), so it stays
  // smooth while the page's first render and its images are still busy.
  const hidden = useReducedMotion() ? 'none' : 'translateY(6px)'
  // While it's invisible, the page's controls can't take keyboard focus.
  const pageRef = useRef(null)
  useLayoutEffect(() => {
    if (pageRef.current) pageRef.current.inert = !ready
  }, [ready])
  useEffect(() => {
    if (ready) return
    const timer = setTimeout(markReady, PAGE_READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [ready, markReady])
  return (
    <PageReadyContext.Provider value={markReady}>
      <PageShownContext.Provider value={shown}>
      <motion.div
        ref={pageRef}
        onAnimationComplete={() => { if (ready) setShown(true) }}
        initial={{ opacity: 0, transform: hidden }}
        // Leave no transform behind once it's in: even an identity
        // translateY(0px) makes this div the containing block of every
        // position:fixed element inside the page, so overlays (modals, the
        // Recap story) were sized and placed by the page instead of the
        // screen. transitionEnd sets it in framer's own state: setting the
        // style by hand was undone by framer on the next render.
        animate={ready ? { opacity: 1, transform: 'translateY(0px)', transitionEnd: { transform: 'none' } } : { opacity: 0, transform: hidden }}
        exit={{ opacity: 0, transition: { duration: 0.12, ease: 'easeIn' } }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
      </PageShownContext.Provider>
    </PageReadyContext.Provider>
  )
}

function AnimatedRoutes() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const routeKey = location.pathname === '/' || location.pathname.startsWith('/home/') ? 'home' : location.pathname
  // Every page scrolls inside the same <main>, so without this a page opened
  // from a scrolled-down one (e.g. Settings from the middle of Home) inherited
  // that scroll position. Reset once the old page has faded out -- resetting
  // immediately would visibly jump the outgoing page -- and only for new
  // navigations: Back/Forward (POP, incl. mouse side buttons) is left as is.
  const resetOnEnter = useRef(false)
  useEffect(() => {
    resetOnEnter.current = navigationType !== 'POP'
  }, [routeKey, navigationType])
  const handleExitComplete = () => {
    if (!resetOnEnter.current) return
    resetOnEnter.current = false
    const main = document.querySelector('main.flex-1.overflow-y-auto')
    if (main) main.scrollTop = 0
  }
  return (
    <AnimatePresence mode="wait" onExitComplete={handleExitComplete}>
      <Routes location={location} key={routeKey}>
        <Route path="/" element={<PageTransition gated><Home /></PageTransition>} />
        <Route path="/home/:tab/*" element={<PageTransition gated><Home /></PageTransition>} />
        <Route path="/albums" element={<PageTransition gated><Albums /></PageTransition>} />
        <Route path="/genres" element={<PageTransition gated><Genres /></PageTransition>} />
        <Route path="/genre/:name" element={<PageTransition gated><GenreTracks /></PageTransition>} />
        <Route path="/stations" element={<PageTransition gated><Stations /></PageTransition>} />
        <Route path="/cache-analysis" element={<PageTransition gated><CacheAnalysis /></PageTransition>} />
        <Route path="/artists" element={<PageTransition gated><Artists /></PageTransition>} />
        <Route path="/videos" element={<PageTransition gated><Videos /></PageTransition>} />
        <Route path="/library" element={<PageTransition gated><Library /></PageTransition>} />
        <Route path="/search" element={<PageTransition><Search /></PageTransition>} />
        <Route path="/artist/:id" element={<PageTransition><Artist /></PageTransition>} />
        <Route path="/online/album" element={<PageTransition><OnlineAlbum /></PageTransition>} />
        <Route path="/playlist/:id" element={<PageTransition gated><Playlist /></PageTransition>} />
        {/* The Downloader lives in Search now; what asked for it (a Soulseek search) is passed on. */}
        <Route path="/downloader" element={<Navigate to="/search" replace state={location.state} />} />
        <Route path="/profile" element={<PageTransition><Profile /></PageTransition>} />
        <Route path="/quality" element={<PageTransition gated><Quality /></PageTransition>} />
        <Route path="/radio" element={<PageTransition gated><Radio /></PageTransition>} />
        <Route path="/recap" element={<PageTransition gated><Recap /></PageTransition>} />
        <Route path="/settings" element={<PageTransition gated><Settings /></PageTransition>} />
      </Routes>
    </AnimatePresence>
  )
}

/** The app shell: header, sidebar, pages, side panels, player and overlays. */
export default function App() {
  useEffect(() => api.onLibraryChanged?.(() => {
    window.dispatchEvent(new Event('lokal:refresh'))
  }), [])

  const { t } = useTranslation()
  // The glass player bar floats over the pages, which keep room for it.
  const glassPlayerBar = useAppearanceFlag('glass_player_bar')
  const performanceMode = usePerformanceMode()
  useEffect(() => {
    document.documentElement.classList.toggle('performance-mode', performanceMode)
    return () => document.documentElement.classList.remove('performance-mode')
  }, [performanceMode])
  // Pages lay out by the space they get between the sidebars (pageWidth.js).
  const pageWidthRef = usePageWidth()
  const audioRef = useRef(null)
  const cfAudioRef = useRef(null)
  const lastRemoteStateRef = useRef('')
  const streamRecoveryRef = useRef({ track: null, pending: false, failed: [] })
  // Library → Songs with errors: a song that failed to play is noted, and
  // the note goes once it plays again.
  const reportPlaybackError = useCallback((track, message) => {
    if (!track?.id || String(track.id).startsWith('import-')) return
    track.playback_error = message
    Promise.resolve(api.reportTrackError?.(track.id, message)).catch(() => {})
  }, [])
  const clearPlaybackError = useCallback(() => {
    const track = usePlayerStore.getState().currentTrack
    if (!track?.playback_error) return
    delete track.playback_error
    Promise.resolve(api.clearTrackError?.(track.id)).catch(() => {})
  }, [])

  const recoverOnlinePlayback = useCallback(async (el, failedTrack, failedRef, reason = 'unavailable', detail = '') => {
    const activeEl = () => usePlayerStore.getState().activeAudioElement === 'cf' ? cfAudioRef.current : audioRef.current
    if (usePlayerStore.getState().currentTrack !== failedTrack || el !== activeEl()) return
    if (streamRecoveryRef.current.track !== failedTrack) streamRecoveryRef.current = { track: failedTrack, pending: false, failed: [] }
    const recovery = streamRecoveryRef.current
    if (recovery.pending) return
    recovery.pending = true
    recovery.failed.push(failedRef.provider)
    el.dataset.fallbackPending = '1'
    clearInterval(playTimerRef.current)
    playTimerRef.current = null
    el.pause()
    const isCurrent = () => streamRecoveryRef.current === recovery && usePlayerStore.getState().currentTrack === failedTrack && el === activeEl()
    const toast = showLoadingToast(reason === 'preview'
      ? `${providerLabel(failedRef.provider)} only has a preview of “${failedTrack.title}”. Trying the next playback source.`
      : `“${failedTrack.title}” couldn't play on ${providerLabel(failedRef.provider)}${detail ? ` (${detail})` : ''}. Trying the next playback source.`)
    try {
      const [replacement] = await resolveRecommendationTracks([failedTrack], api, {
        reusePlayable: false, afterProvider: failedRef.provider, skipProviders: recovery.failed, isCurrent,
        onProgress: message => { if (isCurrent()) toast.update(message) },
        onProviderFailure: failure => { if (isCurrent()) toast.update(playbackFallbackMessage(failure)) },
      })
      if (!isCurrent()) return
      if (replacement) {
        recovery.track = replacement
        setStreamError(null)
        usePlayerStore.getState().replaceCurrentTrack(failedTrack.id, replacement)
      } else {
        if (['discovery', 'mix', 'flow'].includes(usePlayerStore.getState().playbackContext?.type)) {
          toast.update(`“${failedTrack.title}” is unavailable. Trying the next song…`)
          if (await skipUnavailableRecommendation(failedTrack)) { setStreamError(null); return }
          if (!isCurrent()) return
        }
        usePlayerStore.getState().setIsPlaying(false)
        usePlayerStore.getState().setIsBuffering(false)
        const message = 'No full-length stream was found in your playback sources.'
        setStreamError({ title: failedTrack.title, message })
        reportPlaybackError(failedTrack, message)
        toast.close(message)
      }
    } finally {
      toast.close()
      recovery.pending = false
      el.dataset.fallbackPending = ''
    }
  }, [reportPlaybackError])

  // A file the player can't decode (Apple Lossless .m4a, WMA, APE...): ask the
  // main process for a playable copy (converted once, cached) and switch to it.
  // Web mode needs nothing here: the server's stream route does the same.
  const handleAudioError = useCallback(async (event) => {
    const el = event.currentTarget
    // Online radio: icecast-metadata-player reconnects by itself (src/radio/radioSession.js).
    if (isStationTrack(usePlayerStore.getState().currentTrack) && el === audioRef.current) return
    const code = el?.error?.code
    // A failed stream advances through the configured playback providers.
    const failedTrack = usePlayerStore.getState().currentTrack
    const failedRef = streamRef(failedTrack)
    if (failedRef && String(el?.getAttribute('src') || '').split('?')[0] === api.onlineStreamURL(failedRef.provider, failedRef.id)) {
      if (isAddonProvider(failedRef.provider)) {
        const mediaError = el?.error
        const diagnostic = {
          provider: failedRef.provider,
          track: await addonStreamTrackHash(failedRef.id),
          mediaErrorCode: Number.isFinite(Number(mediaError?.code)) ? Number(mediaError.code) : null,
          mediaError: String(mediaError?.message || '').slice(0, 240) || null,
          networkState: Number.isFinite(el?.networkState) ? el.networkState : null,
          readyState: Number.isFinite(el?.readyState) ? el.readyState : null,
          currentTime: Number.isFinite(el?.currentTime) ? Number(el.currentTime.toFixed(3)) : null,
          duration: Number.isFinite(el?.duration) ? Number(el.duration.toFixed(3)) : null,
        }
        api.log('warn', `[online-stream] renderer-error ${JSON.stringify(diagnostic)}`)
      }
      await recoverOnlinePlayback(el, failedTrack, failedRef)
      return
    }
    if (!api.isElectron || !el || (code !== 3 && code !== 4)) return
    const src = el.getAttribute('src') || ''
    if (!src.startsWith('file://') || el.dataset.fallbackFor === src || el.dataset.fallbackSrc === src) return
    el.dataset.fallbackFor = src
    // While the copy is being made and swapped in, pause events from this
    // element aren't the user pausing (see ignoreElementPause).
    el.dataset.fallbackPending = '1'
    try {
      let filePath = src.slice('file://'.length)
      try { filePath = decodeURIComponent(filePath) } catch {}
      const result = await api.playableFile?.(filePath).catch(() => null)
      const copy = typeof result === 'string' ? result : result?.path || null
      if (!copy && el.getAttribute('src') === src) {
        const failed = usePlayerStore.getState().currentTrack
        const message = result?.error === 'ffmpeg-missing'
          ? 'FFMPEG_MISSING'
          : failed?.missing ? 'The file is no longer on disk' : "The file couldn't be decoded, even after conversion"
        reportPlaybackError(failed, message)
      }
      if (!copy || el.getAttribute('src') !== src) return
      const next = `file://${copy.replace(/\\/g, '/').split('/').map(p => encodeURIComponent(p)).join('/').replace(/%3A/g, ':')}`
      el.dataset.fallbackSrc = next
      el.src = next
      el.load()
      if (usePlayerStore.getState().isPlaying) await el.play().catch(() => {})
    } finally {
      el.dataset.fallbackPending = ''
    }
  }, [recoverOnlinePlayback, reportPlaybackError])

  // A pause event that doesn't mean "the user paused": the file failed to
  // decode (the failed first attempt at an Apple Lossless .m4a fires one), it
  // never got as far as loading, or it's being swapped for a playable copy.
  // Treating those as pauses flipped the player to paused, so the converted
  // copy never started and play had to be clicked a second time. The user's
  // own pauses go through the store, not through these events.
  // Online radio: the radio player pauses the element itself while it
  // reconnects; a real pause goes through the store (play/pause, media keys).
  const ignoreElementPause = (el) => !!el?.error || el?.readyState === 0 || el?.dataset.fallbackPending === '1' || isStationTrack(usePlayerStore.getState().currentTrack)
  const smtcKeepAliveRef = useRef(null)
  const gainNodeRef = useRef(null)
  const cfGainNodeRef = useRef(null)
  const replayGainNodeRef = useRef(null)
  const cfReplayGainNodeRef = useRef(null)
  const replayGainRequestRef = useRef({ primary: 0, cf: 0 })
  const replayGainCacheRef = useRef(new Map())
  // Crossfades ramp these, after the volume gains, so volume changes never cut a fade short.
  const fadeGainRef = useRef({ primary: null, cf: null })
  // AutoMix's bass swap: a high-pass per side (10 Hz, open, outside a transition).
  const mixFilterRef = useRef({ primary: null, cf: null })
  // AutoMix: songs' analyses (id -> analysis, or null when it couldn't be), and the ones asked for.
  const automixRef = useRef({ analyses: new Map(), asked: new Set() })
  const rateGlideRef = useRef(null)
  const audioCtxRef = useRef(null)
  const nativeAudioRef = useRef(null)
  const analyserRef = useRef(null)
  const isCrossfadingRef = useRef(false)
  const audioSourcesInitializedRef = useRef(false)
  const playSecsRef = useRef(0)
  const playTimerRef = useRef(null)
  const userRef = useRef(null)
  const currentTrackRef = useRef(null)
  const prevTrackIdRef = useRef(null)
  const lastFlushedTrackIdRef = useRef(null)
  const artworkCacheRef = useRef({})
  const eqFiltersRef = useRef([])
  const activeElementRef = useRef('primary')
  const pauseSuppressRef = useRef(false)
  const crossfadeTokenRef = useRef(0)
  const crossfadeTimeoutRef = useRef(null)
  const expectedCrossfadeTrackIdRef = useRef(null)
  const lastfmPlaybackStartedAtRef = useRef(0)
  const lastfmPlaybackKeyRef = useRef(null)
  const lastfmScrobbledPlaybackKeyRef = useRef(null)
  const lastfmScrobbleCheckRef = useRef(null)
  const listenbrainzSubmittedPlaybackKeyRef = useRef(null)
  const listenbrainzNowPlayingKeyRef = useRef(null)

  const [updateState, setUpdateState] = useState({
    status: 'idle',
    info: null,
    progress: 0,
    error: null,
  })
  const [ytDlpVersionState, setYtDlpVersionState] = useState({
    checking: false,
    visible: false,
    installedVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    latestUrl: null,
    releasesBehind: null,
    daysBehind: null,
    upToDate: null,
    found: false,
    source: null,
    error: null,
    downloadState: 'idle',
    downloadMessage: '',
  })
  const [showRecapStories, setShowRecapStories] = useState(() => {
    try {
      return localStorage.getItem('lokal-dev-recap') === '1'
    } catch {
      return false
    }
  })
  const [changelog, setChangelog] = useState('')
  const [loadingChangelog, setLoadingChangelog] = useState(false)
  const clampEq = (v) => Math.max(-12, Math.min(12, Number(v) || 0))
  const shapeEqGain = (v) => clampEq(v) * 0.72

  const getArtworkDataURL = useCallback(async (artworkPath) => {
    if (!artworkPath) return null
    if (artworkCacheRef.current[artworkPath]) return artworkCacheRef.current[artworkPath]
    try {
      let dataUrl = null
      if (api.isElectron && window.electron?.readFileAsDataURL) {
        dataUrl = await window.electron.readFileAsDataURL(artworkPath)
      }
      if (dataUrl) {
        artworkCacheRef.current[artworkPath] = dataUrl
      }
      return dataUrl
    } catch (e) {
      console.error('Error reading artwork:', e)
      return null
    }
  }, [])

  const {
    currentTrack, isPlaying, duration, volume, repeat,
    outputDeviceId,
    autoNext, setProgress, setDuration, setIsPlaying, setIsBuffering,
    setAudioRef, setCfAudioRef, initLiked, setCrossfade, crossfadeSeconds,
    setActiveAudioElement,
    shuffle, playNext, addToQueue, skipAhead,
    showMiniPlayer, likedIds, exclusiveSidePanels, hydrateExclusiveSidePanels,
  } = usePlayerStore(useShallow(({
    currentTrack, isPlaying, duration, volume, repeat,
    outputDeviceId,
    autoNext, setProgress, setDuration, setIsPlaying, setIsBuffering,
    setAudioRef, setCfAudioRef, initLiked, setCrossfade, crossfadeSeconds,
    setActiveAudioElement,
    shuffle, playNext, addToQueue, skipAhead,
    showMiniPlayer, likedIds, exclusiveSidePanels, hydrateExclusiveSidePanels,
  }) => ({
    currentTrack, isPlaying, duration, volume, repeat,
    outputDeviceId,
    autoNext, setProgress, setDuration, setIsPlaying, setIsBuffering,
    setAudioRef, setCfAudioRef, initLiked, setCrossfade, crossfadeSeconds,
    setActiveAudioElement,
    shuffle, playNext, addToQueue, skipAhead,
    showMiniPlayer, likedIds, exclusiveSidePanels, hydrateExclusiveSidePanels,
  })))
  const miniSwitching = usePlayerStore(s => s.miniSwitching)
  // Casting: the TV plays, and this computer's audio is parked (src/cast).
  const castActive = usePlayerStore(s => s.castActive)
  const replayGainMode = usePlayerStore(s => s.replayGainMode)
  const volumeRef = useRef(volume)
  const [audioOutputReady, setAudioOutputReady] = useState(0)
  const { user } = useAppStore()
  const { showOnboarding, completeOnboarding, loading: onboardingLoading } = useOnboarding()

  useEffect(() => {
    volumeRef.current = volume
  }, [volume])

  const applyReplayGainToElement = useCallback(async (element, track) => {
    if (!element) return null
    const side = element === audioRef.current ? 'primary' : 'cf'
    const request = ++replayGainRequestRef.current[side]
    const id = track?.id == null ? '' : String(track.id)
    const assignedId = element.dataset.lokalTrackPending || element.dataset.lokalTrackId
    if (assignedId && assignedId !== id) return null

    const apply = multiplier => {
      if (request !== replayGainRequestRef.current[side]) return
      const node = side === 'primary' ? replayGainNodeRef.current : cfReplayGainNodeRef.current
      if (!node?.gain) return
      const ctx = audioCtxRef.current
      const now = ctx?.currentTime || 0
      try {
        node.gain.cancelScheduledValues(now)
        if (ctx) node.gain.setTargetAtTime(multiplier, now, 0.04)
        else node.gain.value = multiplier
      } catch { node.gain.value = multiplier }
    }

    try {
      const mode = usePlayerStore.getState().replayGainMode
      if (mode === 'off' || !id || typeof window.electron?.getReplayGain !== 'function') {
        apply(1)
        return null
      }

      let tags
      if (replayGainCacheRef.current.has(id)) {
        tags = replayGainCacheRef.current.get(id)
        if (tags && typeof tags.then === 'function') tags = await tags
      } else {
        const pending = Promise.resolve().then(() => window.electron.getReplayGain(id)).catch(() => null)
        replayGainCacheRef.current.set(id, pending)
        tags = await pending
        replayGainCacheRef.current.set(id, tags || null)
        if (replayGainCacheRef.current.size > 400) {
          replayGainCacheRef.current.delete(replayGainCacheRef.current.keys().next().value)
        }
      }

      const latestAssignedId = element.dataset.lokalTrackPending || element.dataset.lokalTrackId
      if (latestAssignedId && latestAssignedId !== id) return null
      const state = usePlayerStore.getState()
      apply(replayGainMultiplier(tags, effectiveReplayGainMode(state.replayGainMode, track, state)))
      return tags || null
    } catch {
      apply(1)
      return null
    }
  }, [])

  const applyAudioOutput = useCallback(async (deviceId = 'default') => {
    const id = String(deviceId || 'default')
    const context = audioCtxRef.current
    if (nativeAudioRef.current) {
      nativeAudioRef.current.browserDeviceId = id
      // Defer device changes while idle; apply them on resume.
      if (!nativeAudioRef.current.playing) return { ok: true }
    }
    if (context && typeof context.setSinkId === 'function') {
      try {
        await context.setSinkId(id)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e?.message || 'Could not change audio output' }
      }
    }
    const elements = [audioRef.current, cfAudioRef.current].filter(Boolean)
    const settable = elements.filter(element => typeof element.setSinkId === 'function')
    if (!settable.length) return { ok: true, pending: true }
    try {
      await Promise.all(settable.map(element => element.setSinkId(id)))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'Could not change audio output' }
    }
  }, [])

  useEffect(() => {
    window.__lokalSetAudioOutput = applyAudioOutput
    return () => {
      if (window.__lokalSetAudioOutput === applyAudioOutput) delete window.__lokalSetAudioOutput
    }
  }, [applyAudioOutput])

  useEffect(() => {
    if (!audioOutputReady) return
    applyAudioOutput(outputDeviceId).catch(() => {})
  }, [audioOutputReady, outputDeviceId, applyAudioOutput])

  const isEventFromActive = useCallback((e) => {
    const activeSide = usePlayerStore.getState().activeAudioElement
    const isPrimary = e.target === audioRef.current
    const active = (activeSide === 'primary' && isPrimary) || (activeSide === 'cf' && !isPrimary)
    return active && isAudioEventForTrack(e.target, usePlayerStore.getState().currentTrack?.id)
  }, [])

  const fetchChangelog = useCallback(async () => {
    if (!api.isElectron) return;
    setLoadingChangelog(true);
    try {
      const response = await fetch('https://api.github.com/repos/sipbuu/lokal/releases/latest');
      if (!response.ok) throw new Error('Failed to fetch release info');
      const data = await response.json();
      const fullBody = data.body || '';

      const sectionMatch = fullBody.match(/(?:##|###) (?:Changelog|Changes|What's New)([\s\S]*?)(?=(?:##|###) (?:Setup|Binary Checksums|Full Changelog)|---|$)/i);
      
      let extracted = sectionMatch ? sectionMatch[1].trim() : '';

      if (!extracted) {
        extracted = fullBody.split(/## Setup|### Binary Checksums|---/)[0].trim();
      }

      setChangelog(extracted);
    } catch (err) {
      console.error('[updater] Failed to fetch changelog:', err);
      setChangelog('• Bug fixes and performance improvements\n• Stability updates');
    } finally {
      setLoadingChangelog(false);
    }
  }, []);

  const refreshYtDlpVersionStatus = useCallback(async (forceVisible = false) => {
    if (!api.isElectron) return
    setYtDlpVersionState(prev => ({ ...prev, checking: true, error: null }))
    try {
      const status = await api.getYtDlpVersionStatus()
      const dismissed = localStorage.getItem(YTDLP_DISMISS_KEY)
      const dismissKey = getYtDlpDismissKey(status)
      const shouldShow = Boolean(
        status?.found &&
        status?.latestVersion &&
        status?.installedVersion &&
        status?.upToDate === false &&
        (forceVisible || dismissed !== dismissKey)
      )
      setYtDlpVersionState(prev => ({
        ...prev,
        ...status,
        checking: false,
        visible: shouldShow,
        downloadState: prev.downloadState === 'downloading' ? prev.downloadState : 'idle',
        downloadMessage: prev.downloadState === 'downloading' ? prev.downloadMessage : '',
      }))
    } catch (error) {
      setYtDlpVersionState(prev => ({
        ...prev,
        checking: false,
        error: error.message,
      }))
    }
  }, [])

  useEffect(() => {
    api.getTheme().then(t => {
      if (t) {
        const baseVars = THEMES[t.theme]?.vars || THEMES.dark.vars
        applyTheme({ ...baseVars, ...(t.overrides || {}) })
        if (t.overrides?.['--text-scale']) {
          document.documentElement.style.setProperty('--text-scale', t.overrides['--text-scale'])
        }
      }
    })

    if (!api.isElectron) return

    const cleanup = api.onUpdaterEvent((event, data) => {
      console.log('[updater] event:', event, data)
      switch (event) {
        case 'available':
          setUpdateState({
            status: 'available',
            info: data,
            progress: 0,
            error: null,
          })
          fetchChangelog()
          break
        case 'progress':
          setUpdateState(prev => ({
            ...prev,
            status: 'downloading',
            progress: data && data.percent ? Math.floor(data.percent) : prev.progress,
          }))
          break
        case 'ready':
          setUpdateState(prev => ({
            ...prev,
            status: 'ready',
            progress: 100,
          }))
          break
        case 'error':
          console.error('[updater] error:', data)
          setUpdateState(prev => ({
            ...prev,
            status: 'error',
            error: data,
          }))
          break
        default:
          break
      }
    })

    return cleanup
  }, [fetchChangelog])

  useEffect(() => {
    if (!api.isElectron) return
    refreshYtDlpVersionStatus()
    const unsubscribe = api.onToolsDownloadProgress((_, payload) => {
      if (payload?.tool !== 'yt-dlp') return
      // Downloads started from Settings send progress too: they must not pop
      // this window open, nor leave it stuck at 100%. Only the queue's own
      // update (payload.auto, on YouTube 403s) opens it, and the window's own
      // Update button feeds its bar while the window is open.
      if (!payload.auto) {
        if (payload.status === 'done') return
        setYtDlpVersionState(prev => (prev.visible && prev.downloadState === 'downloading' ? {
          ...prev,
          downloadMessage: payload.message || prev.downloadMessage,
          downloadPercent: Number.isFinite(payload.percent) ? payload.percent : (payload.status === 'installing' ? 100 : prev.downloadPercent ?? null),
        } : prev))
        return
      }
      if (payload.status === 'done') {
        setYtDlpVersionState(prev => ({ ...prev, visible: true, downloadState: 'done', downloadMessage: payload.message || 'yt-dlp updated.', downloadPercent: null }))
        refreshYtDlpVersionStatus()
        setTimeout(() => setYtDlpVersionState(prev => ({ ...prev, visible: prev.upToDate === false && prev.downloadState !== 'done' ? true : false, downloadState: 'idle', downloadMessage: '' })), 2200)
        return
      }
      setYtDlpVersionState(prev => ({
        ...prev,
        visible: true,
        downloadState: payload.status === 'error' ? 'error' : 'downloading',
        downloadMessage: payload.message || '',
        downloadPercent: Number.isFinite(payload.percent) ? payload.percent : (payload.status === 'installing' ? 100 : prev.downloadPercent ?? null),
      }))
    })
    const interval = setInterval(() => {
      refreshYtDlpVersionStatus()
    }, 1000 * 60 * 60 * 6)
    return () => {
      clearInterval(interval)
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [refreshYtDlpVersionStatus])

  const handleInstallUpdate = async () => {
    await api.updaterInstall()
  }

  const handleDismissUpdate = () => {
    setUpdateState({
      status: 'idle',
      info: null,
      progress: 0,
      error: null,
    })
    setChangelog('')
  }

  const handleDismissYtDlpNotice = () => {
    try {
      localStorage.setItem(YTDLP_DISMISS_KEY, getYtDlpDismissKey(ytDlpVersionState))
    } catch {}
    setYtDlpVersionState(prev => ({
      ...prev,
      visible: false,
      downloadState: 'idle',
      downloadMessage: '',
    }))
  }

  const handleUpdateYtDlp = async () => {
    setYtDlpVersionState(prev => ({
      ...prev,
      visible: true,
      downloadState: 'downloading',
      downloadMessage: 'Starting yt-dlp update...',
      downloadPercent: null,
      error: null,
    }))
    try {
      const result = await api.downloadYtDlp()
      if (result?.error) {
        setYtDlpVersionState(prev => ({
          ...prev,
          visible: prev.visible,
          downloadState: 'error',
          downloadMessage: '',
          error: result.error,
        }))
        return
      }
      const status = await api.getYtDlpVersionStatus()
      if (!status?.installedVersion) {
        setYtDlpVersionState(prev => ({
          ...prev,
          ...status,
          downloadState: 'error',
          downloadMessage: '',
          error: 'yt-dlp was installed but its version could not be read. Close and reopen Lokal, then try again.',
        }))
        return
      }
      setYtDlpVersionState(prev => ({
        ...prev,
        ...status,
        visible: prev.visible && status?.upToDate === false,
        downloadState: 'done',
        downloadMessage: status?.upToDate === false ? 'yt-dlp updated, but another newer release is still available.' : 'yt-dlp is up to date.',
      }))
      setTimeout(() => {
        setYtDlpVersionState(prev => ({
          ...prev,
          visible: prev.upToDate === false,
          downloadState: 'idle',
          downloadMessage: '',
        }))
      }, 1400)
    } catch (error) {
      setYtDlpVersionState(prev => ({
        ...prev,
        downloadState: 'error',
        downloadMessage: '',
        error: error.message,
      }))
    }
  }

  const initAudioCtx = useCallback(() => {
  if (audioSourcesInitializedRef.current) return
  if (!audioRef.current || !cfAudioRef.current) return

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    audioCtxRef.current = ctx
    if (!usePlayerStore.getState().isPlaying) ctx.suspend().catch(() => {})
    const keepAudioRunning = () => {
      // Route changes deliberately suspend the context to release its device.
      if (!nativeAudioRef.current?.transitioning && usePlayerStore.getState().isPlaying && ctx.state === 'suspended') {
        ctx.resume().catch(() => {})
      }
    }
    ctx.addEventListener('statechange', keepAudioRunning)

    const nodes = EQ_AUDIO_BANDS.map((band) => {
      const f = ctx.createBiquadFilter()
      f.type = band.type
      f.frequency.value = band.frequency
      f.Q.value = band.q
      f.gain.value = 0
      return f
    })

    const cfNodes = EQ_AUDIO_BANDS.map((band, i) => {
      const f = ctx.createBiquadFilter()
      f.type = band.type
      f.frequency.value = band.frequency
      f.Q.value = band.q
      f.gain.value = nodes[i].gain.value
      return f
    })

    eqFiltersRef.current = { primary: nodes, cf: cfNodes }

    const primarySource = ctx.createMediaElementSource(audioRef.current)
    const cfSource = ctx.createMediaElementSource(cfAudioRef.current)

    const primaryGain = ctx.createGain()
    const cfGain = ctx.createGain()
    const primaryReplayGain = ctx.createGain()
    const cfReplayGain = ctx.createGain()
    gainNodeRef.current = primaryGain
    cfGainNodeRef.current = cfGain
    replayGainNodeRef.current = primaryReplayGain
    cfReplayGainNodeRef.current = cfReplayGain

    primaryGain.gain.value = volumeRef.current
    cfGain.gain.value = 0
    primaryReplayGain.gain.value = 1
    cfReplayGain.gain.value = 1
    const primaryFade = ctx.createGain()
    const cfFade = ctx.createGain()
    fadeGainRef.current = { primary: primaryFade, cf: cfFade }
    const mixFilter = () => {
      const filter = ctx.createBiquadFilter()
      filter.type = 'highpass'
      filter.frequency.value = MIX_FILTER_OPEN_HZ
      filter.Q.value = 0.7
      return filter
    }
    const primaryMix = mixFilter()
    const cfMix = mixFilter()
    mixFilterRef.current = { primary: primaryMix, cf: cfMix }

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.8
    analyserRef.current = analyser
    window.__lokalAnalyser = analyser
    window.dispatchEvent(new CustomEvent('lokal:analyser-ready'))

    if (isIOS) {
      // iOS bypasses EQ/fade nodes, but still routes both decks through the
      // analyser as a pass-through so every visualizer receives live audio.
      primarySource.connect(primaryReplayGain)
      primaryReplayGain.connect(analyser)
      analyser.connect(ctx.destination)
      cfSource.connect(cfReplayGain)
      cfReplayGain.connect(analyser)
    } else {
      let prev = primarySource
      for (const n of nodes) { prev.connect(n); prev = n }
      prev.connect(primaryReplayGain)
      primaryReplayGain.connect(primaryGain)
      primaryGain.connect(primaryFade)
      primaryFade.connect(primaryMix)
      primaryMix.connect(analyser)
      analyser.connect(ctx.destination)

      let cfPrev = cfSource
      for (const n of cfNodes) { cfPrev.connect(n); cfPrev = n }
      cfPrev.connect(cfReplayGain)
      cfReplayGain.connect(cfGain)
      cfGain.connect(cfFade)
      cfFade.connect(cfMix)
      cfMix.connect(analyser)
    }

    try {
      const stored = normalizeEqGains(JSON.parse(localStorage.getItem('lokal-eq') || '[]'))
      stored.forEach((v, i) => {
        const shaped = shapeEqGain(v)
        if (nodes[i]) nodes[i].gain.value = shaped
        if (cfNodes[i]) cfNodes[i].gain.value = shaped
      })
    } catch (err) {
    }

    window.__lokaleq = {
      setGain: (i, v) => {
        const shaped = shapeEqGain(v)
        if (nodes[i]) nodes[i].gain.value = shaped
        if (cfNodes[i]) cfNodes[i].gain.value = shaped
      }
    }

    if (window.electron?.nativeAudio && !isIOS) {
      nativeAudioRef.current = new NativeAudioBridge(ctx, analyser, window.electron.nativeAudio, status => {
        window.__lokalOutputStatus = status
        window.dispatchEvent(new CustomEvent('lokal:output-status', { detail: status }))
        api.log('info', `[audio-output] ${JSON.stringify({
          mode: status.mode,
          precision: status.precision || 'auto',
          sampleRate: status.sampleRate || ctx.sampleRate,
          deviceName: status.deviceName || null,
          exclusive: status.exclusive === true,
          warning: status.warning || null,
        })}`)
        // Native output is clocked by the speaker, so the SMTC silence element
        // is redundant while that route is active.
        const keepAlive = smtcKeepAliveRef.current
        if (status.mode !== 'auto' || !usePlayerStore.getState().isPlaying) keepAlive?.pause()
        else keepAlive?.play().catch(() => {})
      })
      nativeAudioRef.current.configure(readOutputPreferences())
      nativeAudioRef.current.setPlaying(usePlayerStore.getState().isPlaying)
      // Discard buffered audio on seeks and explicit pauses, including either
      // side of a crossfade. Both media elements still feed the same EQ graph.
      for (const element of [audioRef.current, cfAudioRef.current]) {
        for (const event of ['seeking', 'pause', 'emptied']) {
          element.addEventListener(event, () => nativeAudioRef.current?.flush())
        }
      }
    }
    audioSourcesInitializedRef.current = true
    setAudioOutputReady(value => value + 1)
  } catch (e) {
    console.error('Failed to initialize AudioContext:', e)
  }
}, [])

  useEffect(() => {
    if (!api.isElectron || !window.electron?.onWindowVisibility) return
    let previousHidden = null
    let previous = null
    let chain = Promise.resolve()
    const unsubscribe = window.electron.onWindowVisibility(hidden => {
      if (previousHidden === hidden) return
      previousHidden = hidden
      chain = chain.catch(() => {}).then(async () => {
        const player = usePlayerStore.getState()
        const active = player.activeAudioElement === 'primary' ? audioRef.current : cfAudioRef.current
        const native = await window.electron.nativeAudio?.diagnostics?.()
        const status = window.__lokalOutputStatus || {}
        const nativeUnderruns = native?.native?.underrunEvents ?? null
        const underrunDelta = previous?.mode === status.mode && previous?.events !== null &&
          nativeUnderruns !== null && nativeUnderruns >= previous.events
          ? nativeUnderruns - previous.events
          : null
        const sample = {
          event: hidden ? 'minimized' : 'restored',
          isPlaying: player.isPlaying,
          audioContextState: audioCtxRef.current?.state || null,
          mode: status.mode || 'auto',
          precision: status.precision || readOutputPreferences().precision,
          sampleRate: status.sampleRate || audioCtxRef.current?.sampleRate || null,
          deviceName: status.deviceName || null,
          exclusive: status.exclusive === true,
          mediaCurrentTime: Number.isFinite(active?.currentTime) ? Number(active.currentTime.toFixed(3)) : null,
          nativeDiagnosticsAvailable: !!native?.native,
          native,
          underrunEventsSincePreviousVisibility: underrunDelta,
        }
        api.log('info', `[audio-visibility] ${JSON.stringify(sample)}`)
        previous = { events: nativeUnderruns, mode: status.mode }
      }).catch(error => {
        api.log('warn', `[audio-visibility] diagnostics failed: ${error.message}`)
      })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    window.__lokalSetOutputPrecision = async preferences => {
      saveOutputPreferences(preferences)
      initAudioCtx()
      if (!nativeAudioRef.current) return { mode: 'auto', warning: 'Native output is only available in the desktop app.' }
      return nativeAudioRef.current.configure(preferences)
    }
    return () => {
      delete window.__lokalSetOutputPrecision
      nativeAudioRef.current?.setPlaying(false)
    }
  }, [initAudioCtx])

  useEffect(() => {
    const bridge = nativeAudioRef.current
    if (bridge) bridge.setPlaying(isPlaying).catch(error => api.log('warn', `[audio-output] ${error.message}`))
    else if (audioCtxRef.current) {
      audioCtxRef.current[isPlaying ? 'resume' : 'suspend']().catch(() => {})
    }
  }, [isPlaying, audioOutputReady])

  useEffect(() => {
    window.__lokalInitAudio = initAudioCtx
    return () => {
      if (window.__lokalInitAudio === initAudioCtx) {
        delete window.__lokalInitAudio
      }
    }
  }, [initAudioCtx])

  useEffect(() => {
    const syncRecapStories = () => {
      try {
        setShowRecapStories(localStorage.getItem('lokal-dev-recap') === '1')
      } catch {
        setShowRecapStories(false)
      }
    }

    window.__lokalRecap = {
      open: () => {
        try { localStorage.setItem('lokal-dev-recap', '1') } catch {}
        syncRecapStories()
      },
      close: () => {
        try { localStorage.removeItem('lokal-dev-recap') } catch {}
        syncRecapStories()
      },
      toggle: () => {
        try {
          if (localStorage.getItem('lokal-dev-recap') === '1') localStorage.removeItem('lokal-dev-recap')
          else localStorage.setItem('lokal-dev-recap', '1')
        } catch {}
        syncRecapStories()
      },
    }

    window.addEventListener('storage', syncRecapStories)
    window.addEventListener('lokal:recap-toggle', syncRecapStories)
    return () => {
      window.removeEventListener('storage', syncRecapStories)
      window.removeEventListener('lokal:recap-toggle', syncRecapStories)
      delete window.__lokalRecap
    }
  }, [])

  useEffect(() => {
    const resumeAudio = () => {
      if (!nativeAudioRef.current?.transitioning && usePlayerStore.getState().isPlaying && audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {})
      }
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') resumeAudio()
    }

    // A music player must keep its audio clock alive while the window loses
    // focus, is minimized, or a menu briefly takes focus.
    window.addEventListener('focus', resumeAudio)
    window.addEventListener('blur', resumeAudio)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.removeEventListener('focus', resumeAudio)
      window.removeEventListener('blur', resumeAudio)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  useEffect(() => {
    if (!api.isElectron) return
    const off = api.onOpenFileRequest(async (filePath) => {
      if (!filePath) return
      try {
        const result = await api.resolveFileToPlay(filePath)
        if (result?.success && result.track) {
          usePlayerStore.getState().playTrack(result.track, [result.track])
        } else {
          api.log('warn', `Failed to open file from Explorer: ${filePath} (${result?.error || 'unknown error'})`)
        }
      } catch (e) {
        api.log('error', `Error opening file from Explorer: ${e.message}`)
      }
    })
    return off
  }, [])

  useEffect(() => {
    if (!api.isElectron) return
    const off = api.onThumbarCommand((action) => {
      const state = usePlayerStore.getState()
      if (action === 'previous') state.prev()
      else if (action === 'next') state.next()
      else if (action === 'toggle-play') state.togglePlay()
      else if (action === 'toggle-like') {
        const track = state.currentTrack
        if (!track) return
        const userId = useAppStore.getState().user?.id
        api.toggleLike(track.id, userId, track).then((r) => {
          const liked = typeof r === 'boolean' ? r : r?.liked ?? false
          usePlayerStore.getState().setLiked(track.id, liked)
        })
      }
    })
    return off
  }, [])

  useEffect(() => {
    if (!api.isElectron) return
    api.updateThumbarState({ isPlaying, isLiked: !!(currentTrack && likedIds.has(currentTrack.id)) })
  }, [isPlaying, currentTrack, likedIds])

  useEffect(() => {
    //safety net for pesky SMTC.
    const el = smtcKeepAliveRef.current
    if (!el) return
    if (isPlaying && window.__lokalOutputStatus?.mode !== 'native') {
      el.play().catch((e) => api.log('warn', `[smtc-keepalive] play() failed: ${e.message}`))
    } else {
      el.pause()
    }
  }, [isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    const actions = ['play', 'pause', 'seekto', 'previoustrack', 'nexttrack']
    if (!currentTrack) {
      // Chromium's Linux MPRIS session otherwise retains the previous song
      // and its handlers after the queue stops or is cleared.
      try {
        navigator.mediaSession.metadata = null
        navigator.mediaSession.playbackState = 'none'
        navigator.mediaSession.setPositionState?.()
      } catch {}
      for (const action of actions) {
        try { navigator.mediaSession.setActionHandler(action, null) } catch {}
      }
      return
    }

    let current = true
    const updateMetadata = async () => {
      let artworkSrc = 'fallback_nopfp.png'
      if (currentTrack.artwork_path) {
        const dataUrl = await getArtworkDataURL(currentTrack.artwork_path)
        if (dataUrl) artworkSrc = dataUrl
      } else if (currentTrack.artwork_url) {
        artworkSrc = currentTrack.artwork_url
      }
      // A slower artwork read for the previous song must not replace the
      // metadata for the current one in Linux MPRIS or other Media Session UIs.
      if (!current) return
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: currentTrack.title || '',
        artist: currentTrack.artist || '',
        album: currentTrack.album || '',
        artwork: [{ src: artworkSrc, sizes: '512x512', type: 'image/png' }]
      })
    }

    updateMetadata().catch(() => {})
    try {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    } catch {}

    const getActiveAudio = () => {
      const state = usePlayerStore.getState()
      return state.activeAudioElement === 'primary' ? audioRef.current : cfAudioRef.current
    }

    if (audioRef.current && !isStationTrack(currentTrack) && typeof navigator.mediaSession.setPositionState === 'function') {
      try {
        navigator.mediaSession.setPositionState({
          duration: audioRef.current.duration || 0,
          playbackRate: audioRef.current.playbackRate || 1,
          position: audioRef.current.currentTime || 0
        })
      } catch {}
    }
    navigator.mediaSession.setActionHandler('play', () => {
      if (usePlayerStore.getState().castActive) { usePlayerStore.getState().setIsPlaying(true); return }
      const activeEl = getActiveAudio()
      activeEl?.play()
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      if (usePlayerStore.getState().castActive) { usePlayerStore.getState().setIsPlaying(false); return }
      const activeEl = getActiveAudio()
      activeEl?.pause()
      // Record explicit pauses even when a source is failing or being swapped.
      usePlayerStore.getState().setIsPlaying(false)
    })
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (isStationTrack(usePlayerStore.getState().currentTrack)) return
      if (usePlayerStore.getState().castActive) {
        if (typeof details.seekTime === 'number') usePlayerStore.getState().setProgressWithAudioUpdate(details.seekTime)
        return
      }
      const activeEl = getActiveAudio()
      if (activeEl && typeof details.seekTime === 'number') activeEl.currentTime = details.seekTime
    })
    navigator.mediaSession.setActionHandler('previoustrack', () => usePlayerStore.getState().prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => usePlayerStore.getState().next())
    return () => { current = false }
  }, [currentTrack, isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    
    const activeEl = usePlayerStore.getState().activeAudioElement === 'primary' ? audioRef.current : cfAudioRef.current
    if (!activeEl) return

    const update = () => {
      if (isStationTrack(usePlayerStore.getState().currentTrack)) return
      if (typeof navigator.mediaSession.setPositionState === 'function') {
        try {
          navigator.mediaSession.setPositionState({
            duration: activeEl.duration || 0,
            playbackRate: activeEl.playbackRate || 1,
            position: activeEl.currentTime || 0
          })
        } catch {}
      }
    }

    activeEl.addEventListener('timeupdate', update)
    return () => activeEl.removeEventListener('timeupdate', update)
  }, [])

  useEffect(() => { userRef.current = user }, [user])

  // Songs liked on Spotify since likes sync was turned on, liked here too (src/spotifyLikes.js).
  useEffect(() => { startSpotifyLikesSync() }, [])

  useEffect(() => {
    if (!api.isElectron || !window.electron?.reportRemoteState) return
    let interval = null
    const publish = () => {
      const state = usePlayerStore.getState()
      const payload = {
        userId: userRef.current?.id || 'guest',
        isPlaying: state.isPlaying,
        progress: state.progress || 0,
        duration: state.duration || 0,
        volume: state.volume ?? 0.8,
        repeat: state.repeat || 'none',
        shuffle: !!state.shuffle,
        currentTrack: state.currentTrack
          ? {
              id: state.currentTrack.id,
              title: state.currentTrack.title,
              artist: state.currentTrack.artist,
              album: state.currentTrack.album,
              artwork_path: state.currentTrack.artwork_path,
            }
          : null,
      }
      const serialized = JSON.stringify(payload)
      if (serialized === lastRemoteStateRef.current) return
      lastRemoteStateRef.current = serialized
      window.electron.reportRemoteState(payload)
    }
    const stop = () => {
      if (interval !== null) clearInterval(interval)
      interval = null
    }
    const schedule = hidden => {
      stop()
      // Keep remotes current during background playback, but poll less often.
      publish()
      interval = setInterval(publish, hidden ? 5000 : 1000)
    }
    const unsubscribe = onWindowVisibility(schedule)
    schedule(isWindowHidden())
    return () => { stop(); unsubscribe() }
  }, [currentTrack?.id, isPlaying, duration, volume])

  useEffect(() => {
    if (!api.isElectron || !window.electron?.onRemoteCommand) return
    return window.electron.onRemoteCommand(async (command) => {
      const action = command?.action
      if (!action) return
      const state = usePlayerStore.getState()
      if (['playLibraryTrack', 'playNextTracks', 'queueTracks'].includes(action)) {
        const value = command?.value && typeof command.value === 'object' ? command.value : {}
        const targetId = String(value.trackId || '')
        const requestedIds = Array.isArray(value.trackIds) ? value.trackIds : []
        const ids = [...new Set([...requestedIds, targetId].map(id => String(id || '').trim()).filter(Boolean))].slice(0, 5000)
        if (!ids.length) return { error: t('No library tracks were selected') }
        const tracks = []
        // Keep each SQL IN-list under the parameter limit used by SQLite
        // builds that ship with older Linux distributions.
        for (let offset = 0; offset < ids.length; offset += 400) {
          const loaded = await api.getTracks({ ids: ids.slice(offset, offset + 400), includeGhosts: '1', limit: 400 })
          const batch = Array.isArray(loaded) ? loaded : Array.isArray(loaded?.items) ? loaded.items : []
          tracks.push(...batch)
        }
        const byId = new Map(tracks.filter(track => track?.id).map(track => [String(track.id), track]))
        const ordered = ids.map(id => byId.get(id)).filter(Boolean)
        if (action === 'playLibraryTrack' && !byId.has(targetId)) {
          return { error: t('The selected track is no longer available in the library') }
        }
        if (!ordered.length) return { error: t('No playable tracks were found') }
        if (action === 'playLibraryTrack') {
          const selected = byId.get(targetId)
          state.playTrack(selected, ordered)
          return { ok: true, trackId: selected.id }
        }
        if (action === 'playNextTracks') {
          for (const track of [...ordered].reverse()) state.playNext(track)
          return { ok: true, count: ordered.length }
        }
        for (const track of ordered) state.addToQueue(track)
        return { ok: true, count: ordered.length }
      }
      if (action === 'togglePlay') return state.togglePlay()
      if (action === 'play' && !state.isPlaying) return state.togglePlay()
      if (action === 'pause' && state.isPlaying) return state.togglePlay()
      if (action === 'next') return state.next()
      if (action === 'prev') return state.prev()
      if (action === 'volume') {
        const value = Number(command?.value)
        if (Number.isFinite(value)) state.setVolume(Math.max(0, Math.min(1, value)))
        return
      }
      if (action === 'seek') {
        const value = Number(command?.value)
        if (Number.isFinite(value)) {
          const safeDuration = Math.max(0, state.duration || 0)
          state.setProgressWithAudioUpdate(Math.max(0, Math.min(safeDuration, value)))
        }
        return
      }
      if (action === 'toggleLike' && state.currentTrack?.id) {
        const r = await api.toggleLike(state.currentTrack.id, userRef.current?.id, state.currentTrack)
        const liked = typeof r === 'boolean' ? r : r?.liked ?? false
        state.setLiked(state.currentTrack.id, liked)
      }
    })
  }, [])

  useEffect(() => {
    if (!api.isElectron || !window.electron?.onSmtcShuffleRequest) return
    return window.electron.onSmtcShuffleRequest((value) => {
      const state = usePlayerStore.getState()
      if (value) state.enableShuffle()
      else state.disableShuffle()
    })
  }, [])

  useEffect(() => {
    if (!api.isElectron || !window.electron?.onSmtcRepeatRequest) return
    return window.electron.onSmtcRepeatRequest((mode) => {
      usePlayerStore.getState().setRepeat(mode)
    })
  }, [])

  // Bumped by every like / unlike: a liked-songs read started before one is
  // older than the hearts and mustn't replace them.
  const likedRevisionRef = useRef(0)
  useEffect(() => {
    let cancelled = false
    let syncTimer = null
    const syncCooldownMs = 10 * 60 * 1000
    // Each liked song with every id it goes by (its streamed copies too).
    const load = () => {
      const revision = likedRevisionRef.current
      api.getLikedTracks(user?.id).then(t => {
        if (cancelled) return
        if (revision !== likedRevisionRef.current) { load(); return }
        initLiked((t || []).flatMap(x => [x.id, ...(x.also_ids || [])]))
      }).catch(() => {})
    }
    const syncKey = `lokal-lastfm-like-sync:${user?.id || 'guest'}`
    const nextPageKey = `lokal-lastfm-like-sync-page:${user?.id || 'guest'}`
    const lastSync = Number(localStorage.getItem(syncKey) || 0)
    const pendingPage = Number(localStorage.getItem(nextPageKey) || 0)
    const scheduleSync = (page, delay = syncCooldownMs) => {
      if (cancelled) return
      clearTimeout(syncTimer)
      syncTimer = setTimeout(() => {
        syncTimer = null
        if (cancelled) return
        api.lastfmSyncLikes(user?.id, page).then(result => {
          if (cancelled) return
          if (result?.partial && result.nextPage) {
            try { localStorage.setItem(nextPageKey, String(result.nextPage)) } catch {}
            scheduleSync(Number(result.nextPage) || page)
          } else if (result?.error) {
            try { localStorage.setItem(nextPageKey, String(page)) } catch {}
            scheduleSync(page)
          } else {
            try { localStorage.removeItem(nextPageKey) } catch {}
          }
        }).catch(() => {
          if (cancelled) return
          try { localStorage.setItem(nextPageKey, String(page)) } catch {}
          scheduleSync(page)
        }).finally(() => {
          try { localStorage.setItem(syncKey, String(Date.now())) } catch {}
          if (!cancelled) load()
        })
      }, Math.max(0, delay))
    }
    const elapsed = Date.now() - lastSync
    if (elapsed > syncCooldownMs || pendingPage) {
      if (pendingPage) load()
      scheduleSync(pendingPage || 1, Math.max(0, syncCooldownMs - Math.max(0, elapsed)))
    } else {
      load()
    }
    // A download that added songs: a liked streamed song may now be a file
    // with an id of its own (its like moved to it), so reload the hearts.
    const onLibraryChanged = () => { if (!cancelled) load() }
    window.addEventListener('lokal:refresh', onLibraryChanged)
    return () => {
      cancelled = true
      clearTimeout(syncTimer)
      window.removeEventListener('lokal:refresh', onLibraryChanged)
    }
  }, [user?.id])

  // A like from any heart: the song's other ids follow (see api.toggleLike).
  useEffect(() => {
    const onLiked = (e) => {
      if ((e.detail?.userId ?? null) !== (useAppStore.getState().user?.id ?? null)) return
      likedRevisionRef.current += 1
      usePlayerStore.getState().setLikedMany(e.detail?.ids, !!e.detail?.liked)
    }
    window.addEventListener('lokal:liked', onLiked)
    return () => window.removeEventListener('lokal:liked', onLiked)
  }, [])

  useEffect(() => {
    setAudioRef(audioRef)
    setCfAudioRef(cfAudioRef)
    api.getSettings().then(s => {
      if (s) usePlayerStore.getState().setCrossfadeOptions(readCrossfadeSettings(s))
      usePlayerStore.getState().hydrateReplayGainMode(s?.replaygain_mode)
      // Sync the backend-persisted Side Panels mode at boot -- previously
      // this only happened once the Settings page itself mounted, so a
      // user who never opened Settings stayed on whatever
      // localStorage/the hardcoded default said, even after saving a
      // different mode from another install or profile.
      hydrateExclusiveSidePanels(s?.exclusive_side_panels !== '0')
      if (api.isElectron && s?.discord_auto_connect === '1') {
        const clientId = s?.discord_use_default_app_id === '0'
          ? s?.discord_client_id
          : '1473597925581131919'
        if (clientId) {
          api.discordConnect(clientId).catch(() => {})
        }
      }
    })
  }, [])

  // Checked every second of playback, so a scrobble / listen is sent as soon
  // as half the track (or 4 minutes) has been played, not when it ends.
  const scrobbleTickRef = useRef(null)
  const startTimer = useCallback(() => {
    if (playTimerRef.current) return
    playTimerRef.current = setInterval(() => {
      playSecsRef.current++
      try { scrobbleTickRef.current?.() } catch {}
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    clearInterval(playTimerRef.current); playTimerRef.current = null
  }, [])

  const getLastfmTrackDuration = useCallback((track) => {
    const seconds = Number(track?.duration) || 0
    return seconds > 0 ? Math.round(seconds) : 0
  }, [])

  const shouldScrobbleLastfmTrack = useCallback((playedSeconds, track) => {
    const durationSeconds = getLastfmTrackDuration(track)
    if (playedSeconds < 30) return false
    if (!durationSeconds) return true
    return playedSeconds >= Math.min(durationSeconds / 2, 240)
  }, [getLastfmTrackDuration])

  // A SpotiFLAC song playing while it downloads: a seek finishes once the
  // song is complete (src/liveSeek.js).
  const onAudioSeeking = useCallback((event) => handleLiveSeek(event.currentTarget, {
    currentTrack: () => usePlayerStore.getState().currentTrack,
    streamRef, isAddonProvider,
    prepare: (provider, id) => api.onlinePrepare(provider, id),
    streamURL: api.onlineStreamURL,
    isPlaying: () => usePlayerStore.getState().isPlaying,
  }), [])

  // The mini player opened from the video player: closing it goes back to
  // the video, not to the rest of the app.
  useEffect(() => usePlayerStore.subscribe((state, previous) => {
    if (!previous.showMiniPlayer || state.showMiniPlayer) return
    const view = useMusicVideoView.getState()
    if (view.fromVideo) useMusicVideoView.setState({ open: !!state.currentTrack, fromVideo: false })
  }), [])

  // Settings → Sync Linked Playlists at Launch: once, a little after start.
  useEffect(() => {
    if (!api.isElectron) return undefined
    const timer = setTimeout(async () => {
      const settings = await Promise.resolve(api.getSettings()).catch(() => null)
      if (settings?.playlist_sync_on_launch !== '1') return
      const { syncLinkedPlaylists } = await import('./playlistSync')
      const results = await syncLinkedPlaylists({ userId: useAppStore.getState().user?.id }).catch(() => [])
      const added = results.reduce((sum, result) => sum + (Number(result.added) || 0), 0)
      const failed = results.filter(result => result.error)
      if (added) showToast(`Linked playlists synced: ${added} new song${added === 1 ? '' : 's'}.`)
      if (failed.length) showToast(`${failed.length} linked playlist${failed.length === 1 ? '' : 's'} couldn't sync: ${failed[0].error}`)
    }, 15000)
    return () => clearTimeout(timer)
  }, [])

  // An online song that couldn't be streamed (shown as a small notice).
  const [streamError, setStreamError] = useState(null)
  const [addonVerificationPrompt, setAddonVerificationPrompt] = useState(null)
  const [addonVerificationBusy, setAddonVerificationBusy] = useState(false)
  const [addonVerificationMessage, setAddonVerificationMessage] = useState('')
  const [playbackRetryNonce, setPlaybackRetryNonce] = useState(0)

  // The library's FFmpeg prompt can resume a track after the dependency is
  // installed. Clear the media-element guard and bump the playback nonce so
  // the same file is loaded and its conversion fallback gets another attempt.
  useEffect(() => {
    const retryLocalPlayback = (event) => {
      const { track, queue, context } = event.detail || {}
      if (!track?.id) return
      const retryTrack = { ...track }
      delete retryTrack.playback_error
      for (const el of [audioRef.current, cfAudioRef.current]) {
        if (!el) continue
        el.dataset.fallbackFor = ''
        el.dataset.fallbackSrc = ''
        el.dataset.fallbackPending = ''
      }
      const retryQueue = Array.isArray(queue) && queue.some(item => item?.id === retryTrack.id)
        ? queue.map(item => item?.id === retryTrack.id ? retryTrack : item)
        : [retryTrack]
      Promise.resolve(api.clearTrackError?.(retryTrack.id)).catch(() => {})
      usePlayerStore.getState().playTrack(retryTrack, retryQueue, context || null)
      setPlaybackRetryNonce(value => value + 1)
    }
    window.addEventListener('lokal:retry-track-playback', retryLocalPlayback)
    return () => window.removeEventListener('lokal:retry-track-playback', retryLocalPlayback)
  }, [setPlaybackRetryNonce])

  const addonVerificationRetryRef = useRef(null)

  const completeAddonVerification = useCallback((key) => {
    const pending = addonVerificationRetryRef.current
    if (!pending || pending.key !== key || pending.retrying) return
    if (typeof pending.retry === 'function') {
      // The popup may be completed both by its immediate response and by the
      // auth-window event. Guard the retry and close only once it has started.
      pending.retrying = true
      setAddonVerificationBusy(true)
      setAddonVerificationMessage('Access verified. Starting the selected song…')
      return Promise.resolve().then(async () => {
        let result = await pending.retry()
        if (addonVerificationRetryRef.current !== pending) return
        // An auth-window close event can arrive a fraction before the provider
        // runtime reports the fresh session. Recheck and retry once automatically
        // rather than requiring the listener to click Play again.
        if (result === false) {
          const status = await api.addonsPackages({ action: 'package.auth', key }).catch(() => null)
          if (status?.authenticated) result = await pending.retry()
        }
        if (addonVerificationRetryRef.current !== pending) return
        if (result === true || result === undefined || (Array.isArray(result) && result.length > 0)) {
          addonVerificationRetryRef.current = null
          setAddonVerificationPrompt(current => current?.key === key ? null : current)
          setAddonVerificationMessage('')
          if (result === true) setIsPlaying(true)
        } else if (result === false || Array.isArray(result)) {
          addonVerificationRetryRef.current = null
          setAddonVerificationPrompt(current => current?.key === key ? null : current)
          setAddonVerificationMessage('')
          showToast('Access was verified, but no playable match could be resolved for this song.')
        } else if (result === null) {
          setAddonVerificationMessage('Access was verified, but playback could not resume automatically. Lokal will keep the selected song ready to retry.')
        }
      }).catch(error => {
        if (addonVerificationRetryRef.current === pending) {
          setAddonVerificationMessage(error?.message || "Verification succeeded, but playback couldn't be resumed automatically.")
        }
      }).finally(() => {
        if (addonVerificationRetryRef.current === pending) pending.retrying = false
        setAddonVerificationBusy(false)
      })
    }
    addonVerificationRetryRef.current = null
    setAddonVerificationPrompt(current => current?.key === key ? null : current)
    setAddonVerificationMessage('')
    const state = usePlayerStore.getState()
    // The actual stream-preparation path hasn't assigned a src when it detects
    // VERIFY_REQUIRED. Replaying the same queue entry with a new generation
    // makes the source effect prepare it again after access is granted.
    if (state.currentTrack && state.currentTrack.id === pending.trackId) {
      setPlaybackRetryNonce(value => value + 1)
      setIsPlaying(true)
    }
  }, [setIsPlaying])

  const dismissAddonVerificationPrompt = useCallback(() => {
    const pending = addonVerificationRetryRef.current
    addonVerificationRetryRef.current = null
    try { pending?.cancel?.() } catch {}
    setAddonVerificationPrompt(null)
    setAddonVerificationMessage('')
  }, [])

  useEffect(() => {
    const onAddonVerificationRequired = event => {
      const detail = event?.detail || {}
      const provider = String(detail.provider || '')
      const key = String(detail.key || (provider.startsWith('a-') ? provider.slice(2) : ''))
      if (!key) return
      const state = usePlayerStore.getState()
      const title = detail.title || state.currentTrack?.title || 'this song'
      addonVerificationRetryRef.current = {
        key, provider: provider || 'a-' + key, title,
        trackId: state.currentTrack?.id ?? null,
        retry: typeof detail.retry === 'function' ? detail.retry : null,
        cancel: typeof detail.cancel === 'function' ? detail.cancel : null,
        isCurrentPlayback: false,
      }
      setAddonVerificationMessage('')
      setAddonVerificationPrompt({ key, provider: provider || 'a-' + key, title, isCurrentPlayback: false })
      // This event is raised during recommendation resolution, before its
      // candidate is installed in the queue. Keep the current song untouched;
      // the actual stream-preparation path owns its own pause/resume handling.
    }
    window.addEventListener('lokal:addon-verification-required', onAddonVerificationRequired)
    return () => window.removeEventListener('lokal:addon-verification-required', onAddonVerificationRequired)
  }, [])

  // A verified add-on is retried at the point that was interrupted: either the
  // selected Discovery candidate/batch, or the current track's stream request.
  useEffect(() => api.onAddonAuthChanged(status => {
    window.dispatchEvent(new Event('lokal:addons-changed'))
    if (status?.authenticated) {
      showToast('Addon access verified. It can now stream and download.')
      completeAddonVerification(status.key)
    } else if (status?.key && addonVerificationRetryRef.current?.key === status.key) {
      setAddonVerificationMessage(status.error || "Verification wasn't completed. Try again when you're ready.")
    }
  }), [completeAddonVerification])
  useEffect(() => {
    if (!streamError) return undefined
    const t = setTimeout(() => setStreamError(null), 9000)
    return () => clearTimeout(t)
  }, [streamError])

  /** Look up the streams of the songs coming up ahead of time, so each starts without the wait (src/queuePrefetch.js). */
  const prepareNextStream = useCallback(() => { prefetchUpcoming(usePlayerStore.getState(), { getState: usePlayerStore.getState }) }, [])

  // What's coming up changes with the song (a crossfade or AutoMix included:
  // looked up at once) and with the queue (songs added, moved, shuffled:
  // shortly, once it settles).
  useEffect(() => {
    let timer = null
    const unsubscribe = usePlayerStore.subscribe((state, before) => {
      if (state.currentTrack?.id !== before.currentTrack?.id) { clearTimeout(timer); prefetchUpcoming(state, { getState: usePlayerStore.getState }); return }
      if (state.queue === before.queue && state.shuffleQueue === before.shuffleQueue && state.shuffle === before.shuffle && state.repeat === before.repeat) return
      clearTimeout(timer)
      timer = setTimeout(() => prefetchUpcoming(usePlayerStore.getState(), { getState: usePlayerStore.getState }), 600)
    })
    return () => { clearTimeout(timer); unsubscribe() }
  }, [])

  const beginLastfmPlayback = useCallback((track) => {
    // Online radio is never sent anywhere (Last.fm, ListenBrainz).
    if (!track?.id || isStationTrack(track)) {
      lastfmPlaybackStartedAtRef.current = 0
      lastfmPlaybackKeyRef.current = null
      return
    }

    const startedAt = Math.floor(Date.now() / 1000)
    lastfmPlaybackStartedAtRef.current = startedAt
    lastfmPlaybackKeyRef.current = `${track.id}:${startedAt}`

    api.getSettings().then((settings) => {
      if (settings?.lastfm_enabled === '0') return
      if (!settings?.lastfm_session_key || !settings?.lastfm_api_key || !settings?.lastfm_api_secret) return
      if (!track.artist || !track.title) return
      pushLastfmStatus({
        level: 'info',
        label: 'Now Playing',
        message: `Sending now playing for ${track.artist} - ${track.title}`
      })
      api.lastfmUpdateNowPlaying(
        track.artist,
        track.title,
        track.album || '',
        getLastfmTrackDuration(track)
      ).then((result) => {
        if (result?.error || result?.skipped) {
          pushLastfmStatus({
            level: 'error',
            label: 'Now Playing',
            message: result?.error || result?.reason || 'Now playing was skipped'
          })
          return
        }
        pushLastfmStatus({
          level: 'success',
          label: 'Now Playing',
          message: `${track.artist} - ${track.title}`
        })
      }).catch((error) => {
        pushLastfmStatus({
          level: 'error',
          label: 'Now Playing',
          message: error?.message || 'Failed to update now playing'
        })
      })
    }).catch(() => {})
  }, [getLastfmTrackDuration])

  const tryScrobbleLastfmTrack = useCallback((track, playedSeconds) => {
    const playbackKey = lastfmPlaybackKeyRef.current
    const startedAt = lastfmPlaybackStartedAtRef.current
    if (!playbackKey || !startedAt || !track?.artist || !track?.title) return
    if (lastfmScrobbledPlaybackKeyRef.current === playbackKey) return
    // Already checking this play (the check runs every second of playback).
    if (lastfmScrobbleCheckRef.current === playbackKey) return
    if (!shouldScrobbleLastfmTrack(playedSeconds, track)) return
    lastfmScrobbleCheckRef.current = playbackKey

    // Nothing was scrobbled: let a later playback tick try again, after a
    // pause so a switched-off / failing Last.fm isn't asked every second.
    const clearLastfmScrobbleCheck = () => {
      setTimeout(() => {
        if (lastfmScrobbleCheckRef.current === playbackKey) {
          lastfmScrobbleCheckRef.current = null
        }
      }, SCROBBLE_RETRY_MS)
    }

    api.getSettings().then((settings) => {
      if (settings?.lastfm_enabled === '0') {
        clearLastfmScrobbleCheck()
        return
      }
      if (settings?.lastfm_scrobbling !== '1') {
        clearLastfmScrobbleCheck()
        return
      }
      if (!settings?.lastfm_session_key || !settings?.lastfm_api_key || !settings?.lastfm_api_secret) {
        clearLastfmScrobbleCheck()
        return
      }
      pushLastfmStatus({
        level: 'info',
        label: 'Scrobble',
        message: `Scrobbling ${track.artist} - ${track.title}`
      })
      lastfmScrobbledPlaybackKeyRef.current = playbackKey
      api.lastfmScrobble(
        track.artist,
        track.title,
        track.album || '',
        getLastfmTrackDuration(track),
        startedAt
      ).then((result) => {
        if (result?.error || result?.skipped) {
          lastfmScrobbledPlaybackKeyRef.current = null
          clearLastfmScrobbleCheck()
          pushLastfmStatus({
            level: 'error',
            label: 'Scrobble',
            message: result?.error || result?.reason || 'Scrobble was skipped'
          })
          return
        }
        if (result?.queued) {
          // Kept and sent automatically once Last.fm can be reached.
          pushLastfmStatus({
            level: 'info',
            label: 'Scrobble',
            message: `Saved for later (${result.reason || 'Last.fm unreachable'}): ${track.artist} - ${track.title}`
          })
          return
        }
        if (result?.ignored) {
          pushLastfmStatus({
            level: 'error',
            label: 'Scrobble',
            message: `${result.reason || 'Last.fm ignored this scrobble'}: ${track.artist} - ${track.title}`
          })
          return
        }
        pushLastfmStatus({
          level: 'success',
          label: 'Scrobble',
          message: `${track.artist} - ${track.title}`
        })
      }).catch(() => {
        lastfmScrobbledPlaybackKeyRef.current = null
        clearLastfmScrobbleCheck()
        pushLastfmStatus({
          level: 'error',
          label: 'Scrobble',
          message: `Failed to scrobble ${track.artist} - ${track.title}`
        })
      })
    }).catch(clearLastfmScrobbleCheck)
  }, [getLastfmTrackDuration, shouldScrobbleLastfmTrack])

  // ListenBrainz: submitted at the same moment, under the same rule, as a
  // Last.fm scrobble (half the track or 4 minutes, at least 30 s), but tracked
  // separately so either service works without the other.
  /** Submit a ListenBrainz listen once the track has played long enough. */
  const trySubmitListenBrainz = useCallback((track, playedSeconds) => {
    const playbackKey = lastfmPlaybackKeyRef.current
    const startedAt = lastfmPlaybackStartedAtRef.current
    if (!playbackKey || !startedAt || !track?.artist || !track?.title) return
    if (listenbrainzSubmittedPlaybackKeyRef.current === playbackKey) return
    if (!shouldScrobbleLastfmTrack(playedSeconds, track)) return
    listenbrainzSubmittedPlaybackKeyRef.current = playbackKey
    // Allow another try for this play later (not on the next tick), and never
    // clear a newer track's marker when this request settles late.
    const retryLater = () => setTimeout(() => {
      if (listenbrainzSubmittedPlaybackKeyRef.current === playbackKey) {
        listenbrainzSubmittedPlaybackKeyRef.current = null
      }
    }, SCROBBLE_RETRY_MS)
    Promise.resolve(api.listenbrainzSubmit?.(listenBrainzTrack(track), startedAt)).then((result) => {
      if (result?.ok || result?.queued) return // sent, or queued and sent later
      // Refused for good (invalid listen, rejected token): keep it marked.
      if (result?.permanent) return
      // Off / not set up yet, or a failure worth another try.
      retryLater()
    }).catch(retryLater)
  }, [shouldScrobbleLastfmTrack])

  /** ListenBrainz "now playing": once per playback, when the audio starts. */
  const sendListenBrainzNowPlaying = useCallback(() => {
    const playbackKey = lastfmPlaybackKeyRef.current
    const track = currentTrackRef.current
    if (!playbackKey || !track?.id || !track.artist || !track.title) return
    if (listenbrainzNowPlayingKeyRef.current === playbackKey) return
    listenbrainzNowPlayingKeyRef.current = playbackKey
    // It checks its own on/off switch.
    Promise.resolve(api.listenbrainzNowPlaying?.(listenBrainzTrack(track))).catch(() => {})
  }, [])

  useEffect(() => {
    scrobbleTickRef.current = () => {
      const track = currentTrackRef.current
      if (!track) return
      tryScrobbleLastfmTrack(track, playSecsRef.current)
      trySubmitListenBrainz(track, playSecsRef.current)
    }
  }, [tryScrobbleLastfmTrack, trySubmitListenBrainz])

  const flushTime = useCallback((trackId) => {
    const secs = playSecsRef.current
    const flushedTrack = currentTrackRef.current
    playSecsRef.current = 0
    if (trackId) lastFlushedTrackIdRef.current = trackId
    tryScrobbleLastfmTrack(flushedTrack, secs)
    trySubmitListenBrainz(flushedTrack, secs)
    if (secs >= 3 && trackId && !isStationTrack(flushedTrack)) api.incrementPlayTime(trackId, userRef.current?.id, secs)
  }, [tryScrobbleLastfmTrack, trySubmitListenBrainz])

  // Top up ordinary queues when fewer than 3 tracks remain.
  // Flow never ends: more of its own songs instead (src/flow/session.js).
  const topUpRelated = useCallback(() => {
    const state = usePlayerStore.getState()
    if (state.playbackContext?.type === 'flow') {
      if (flowNeedsMore(state)) continueFlow().catch(() => {})
      return
    }
    const { queue, queueIndex, _fetchingRelated } = state
    if (['discovery', 'mix', 'library-folder', RADIO_CONTEXT].includes(state.playbackContext?.type) || isStationTrack(currentTrackRef.current) || queue.length - queueIndex - 1 >= 3 || !currentTrackRef.current || _fetchingRelated) return
    const generation = state.playbackGeneration
    state.setFetchingRelated(true)
    api.getRelated(currentTrackRef.current.id, userRef.current?.id).then(related => {
      if (usePlayerStore.getState().playbackGeneration === generation && Array.isArray(related) && related.length) usePlayerStore.getState().appendRelated(related)
      usePlayerStore.getState().setFetchingRelated(false)
    }).catch(() => usePlayerStore.getState().setFetchingRelated(false))
  }, [])

  useCastPlayback({ startTimer, stopTimer, beginLastfmPlayback, sendListenBrainzNowPlaying, flushTime, topUpRelated })

  useEffect(() => {
    const previousTrack = currentTrackRef.current
    const previousTrackId = previousTrack?.id || null
    const nextTrackId = currentTrack?.id || null

    if (
      previousTrackId &&
      nextTrackId &&
      previousTrackId !== nextTrackId &&
      !isCrossfadingRef.current &&
      lastFlushedTrackIdRef.current !== previousTrackId
    ) {
      flushTime(previousTrackId)
    }

    if (previousTrackId !== nextTrackId) {
      prevTrackIdRef.current = previousTrackId
      if (lastFlushedTrackIdRef.current === previousTrackId) {
        lastFlushedTrackIdRef.current = null
      }
    }

    currentTrackRef.current = currentTrack
  }, [currentTrack, flushTime])

  // The bass-swap filters open again (an AutoMix transition over, or called off).
  const openMixFilters = useCallback(() => {
    const now = audioCtxRef.current?.currentTime || 0
    for (const filter of [mixFilterRef.current.primary, mixFilterRef.current.cf]) {
      if (!filter) continue
      filter.frequency.cancelScheduledValues(now)
      filter.frequency.setValueAtTime(MIX_FILTER_OPEN_HZ, now)
    }
  }, [])

  const cancelCrossfade = useCallback(() => {
    crossfadeTokenRef.current += 1
    isCrossfadingRef.current = false
    expectedCrossfadeTrackIdRef.current = null
    if (crossfadeTimeoutRef.current) {
      clearTimeout(crossfadeTimeoutRef.current)
      crossfadeTimeoutRef.current = null
    }
    const ctx = audioCtxRef.current
    const now = ctx?.currentTime
    const activeSide = usePlayerStore.getState().activeAudioElement
    const activeGain = activeSide === 'primary' ? gainNodeRef.current : cfGainNodeRef.current
    const inactiveGain = activeSide === 'primary' ? cfGainNodeRef.current : gainNodeRef.current
    if (activeGain?.gain) {
      activeGain.gain.cancelScheduledValues(now || 0)
      if (ctx && now !== undefined) activeGain.gain.setValueAtTime(volumeRef.current, now)
      else activeGain.gain.value = volumeRef.current
    }
    if (inactiveGain?.gain) {
      inactiveGain.gain.cancelScheduledValues(now || 0)
      if (ctx && now !== undefined) inactiveGain.gain.setValueAtTime(0, now)
      else inactiveGain.gain.value = 0
    }
    for (const fade of [fadeGainRef.current.primary, fadeGainRef.current.cf]) {
      if (!fade?.gain) continue
      fade.gain.cancelScheduledValues(now || 0)
      if (ctx && now !== undefined) fade.gain.setValueAtTime(1, now)
      else fade.gain.value = 1
    }
    // An AutoMix transition called off: filters open, both songs at their own speed.
    openMixFilters()
    clearInterval(rateGlideRef.current)
    for (const el of [audioRef.current, cfAudioRef.current]) { try { if (el && el.playbackRate !== 1) el.playbackRate = 1 } catch {} }
    if (usePlayerStore.getState().mixing) usePlayerStore.setState({ mixing: null })
  }, [openMixFilters])

  // AutoMix's song analyses, asked for once each (the playing song, the next).
  const automixAnalysis = useCallback((track) => {
    if (!track?.id) return undefined
    const store = automixRef.current
    const id = String(track.id)
    if (store.analyses.has(id)) return store.analyses.get(id)
    if (!store.asked.has(id)) {
      store.asked.add(id)
      Promise.resolve(api.automixAnalyze(track)).catch(() => null).then(result => {
        store.analyses.set(id, result || null)
        if (store.analyses.size > 400) store.analyses.delete(store.analyses.keys().next().value)
      })
    }
    return undefined
  }, [])

  // AutoMix's plan for a song pair, worked out again only when one of the
  // two analyses arrives instead of on every timeupdate (several a second,
  // which made playback stutter on slower machines). A plan that throws,
  // takes too long or makes no sense becomes AUTOMIX_FALLBACK: that pair
  // gets an ordinary crossfade.
  const automixPlanFor = useCallback((outTrack, nextTrack, outDuration, out, next, sameAlbum) => {
    const plans = automixRef.current.plans || (automixRef.current.plans = new Map())
    const key = `${outTrack.id}>${nextTrack.id}|${sameAlbum ? 1 : 0}|${Math.round(outDuration)}`
    const known = (analysis) => (analysis === undefined ? '?' : analysis ? 'a' : '-')
    const inputs = known(out) + known(next)
    const cached = plans.get(key)
    if (cached && (cached.inputs === inputs || cached.plan === AUTOMIX_FALLBACK)) return cached.plan
    let plan
    const began = performance.now()
    try {
      plan = planTransition({ out: out || null, outTrack, outDuration, next: next || null, nextTrack, sameAlbum })
      if (plan && !(Number.isFinite(plan.start) && Number.isFinite(plan.length) && plan.length > 0)) plan = AUTOMIX_FALLBACK
    } catch (error) {
      console.warn('[automix] planning failed, crossfading instead:', error)
      plan = AUTOMIX_FALLBACK
    }
    const took = performance.now() - began
    if (took > AUTOMIX_PLAN_BUDGET_MS) {
      console.warn(`[automix] planning took ${Math.round(took)} ms, crossfading instead`)
      plan = AUTOMIX_FALLBACK
    }
    plans.set(key, { inputs, plan })
    if (plans.size > 50) plans.delete(plans.keys().next().value)
    return plan
  }, [])

  const triggerCrossfade = useCallback((nextTrack, plan = null) => {
    if (isCrossfadingRef.current) return
    if (!cfAudioRef.current || !audioRef.current || !nextTrack || !audioCtxRef.current) return
    if (!gainNodeRef.current || !cfGainNodeRef.current) return
    if (!fadeGainRef.current.primary || !fadeGainRef.current.cf) return

    isCrossfadingRef.current = true
    const token = ++crossfadeTokenRef.current
    expectedCrossfadeTrackIdRef.current = nextTrack.id
    const ctx = audioCtxRef.current
    const options = usePlayerStore.getState().crossfade

    const isPrimaryActive = usePlayerStore.getState().activeAudioElement === 'primary'
    const fadeOutEl = isPrimaryActive ? audioRef.current : cfAudioRef.current
    const fadeInEl = isPrimaryActive ? cfAudioRef.current : audioRef.current
    const fadeOutGain = isPrimaryActive ? gainNodeRef.current : cfGainNodeRef.current
    const fadeInGain = isPrimaryActive ? cfGainNodeRef.current : gainNodeRef.current
    const fadeOutNode = isPrimaryActive ? fadeGainRef.current.primary : fadeGainRef.current.cf
    const fadeInNode = isPrimaryActive ? fadeGainRef.current.cf : fadeGainRef.current.primary

    const encodedSrc = audioSrcFor(nextTrack)
    if (!encodedSrc) { isCrossfadingRef.current = false; expectedCrossfadeTrackIdRef.current = null; return }

    // Keep the old source identity until the replacement reaches canplay.
    // An ended event already queued by the old source must not be relabeled as
    // the next track while the media element is being replaced.
    fadeInEl.dataset.lokalTrackPending = String(nextTrack.id)
    fadeInEl.dataset.fallbackFor = ''
    fadeInEl.dataset.fallbackSrc = ''
    const replayGainReady = applyReplayGainToElement(fadeInEl, nextTrack)
    replaceAudioSource(fadeInEl, encodedSrc)

    // The current track stays the active one until the next one can play
    // (a stream can take several seconds to start). If it can't -- it fails,
    // or doesn't get ready in time -- the crossfade is called off and the
    // current track plays out; if the current track ends first, the next one
    // is played the usual way, without a crossfade.
    const waitForCanplay = new Promise((resolve) => {
      let timer = null
      let settled = false
      const done = (outcome) => {
        if (settled) return
        settled = true
        fadeInEl.removeEventListener('canplay', onReady)
        fadeInEl.removeEventListener('error', onFailed)
        fadeOutEl.removeEventListener('ended', onEnded)
        clearTimeout(timer)
        resolve(outcome)
      }
      const onReady = async () => {
        const ref = streamRef(nextTrack)
        let addonError = ''
      const unavailable = ref ? await playbackAvailability({ id: ref.id }, ref.provider, api, undefined, error => { addonError = String(error || '') }).catch(() => 'unavailable') : null
        done(unavailable ? 'failed' : 'ready')
      }
      const onFailed = () => done('failed')
      const onEnded = () => done('ended')
      fadeInEl.addEventListener('canplay', onReady)
      fadeInEl.addEventListener('error', onFailed)
      fadeOutEl.addEventListener('ended', onEnded)
      timer = setTimeout(() => done('timeout'), CROSSFADE_READY_TIMEOUT_MS)
    })

    waitForCanplay.then((outcome) => {
      if (!isCrossfadingRef.current || token !== crossfadeTokenRef.current) return

      if (outcome !== 'ready') {
        cancelCrossfade()
        try { fadeInEl.removeAttribute('src'); fadeInEl.load() } catch {}
        fadeInEl.dataset.lokalTrackPending = ''
        fadeInEl.dataset.lokalTrackId = ''
        if (outcome === 'ended') {
          // Its "ended" was ignored while the crossfade was pending: do what
          // it would have done (repeat one plays the track again).
          stopTimer()
          flushTime(currentTrackRef.current?.id)
          if (usePlayerStore.getState().repeat === 'one') {
            beginLastfmPlayback(currentTrackRef.current)
            fadeOutEl.currentTime = 0
            fadeOutEl.play().catch(() => {})
          } else {
            autoNext()
          }
        }
        return
      }

      if (plan) {
        // AutoMix: the next song waits, ready, at its entry point, until the
        // playing one reaches the transition (it was loaded ahead of it).
        try { fadeInEl.currentTime = plan.inOffset || 0 } catch {}
        try { fadeInEl.playbackRate = plan.rate || 1 } catch {}
        const waitForStart = () => {
          if (!isCrossfadingRef.current || token !== crossfadeTokenRef.current) return
          const left = plan.start - fadeOutEl.currentTime
          if (left <= 0.03 || fadeOutEl.ended) { beginCrossfade(); return }
          crossfadeTimeoutRef.current = setTimeout(waitForStart, Math.min(250, Math.max(5, left * 1000 / (fadeOutEl.playbackRate || 1) - 8)))
        }
        waitForStart()
        return
      }
      beginCrossfade()
    })

    const beginCrossfade = async () => {
      if (!isCrossfadingRef.current || token !== crossfadeTokenRef.current) return
      await replayGainReady
      if (!isCrossfadingRef.current || token !== crossfadeTokenRef.current) return
      flushTime(currentTrackRef.current?.id)

      fadeInEl.dataset.lokalTrackId = String(nextTrack.id)
      fadeInEl.dataset.lokalTrackPending = ''

      const nextSide = isPrimaryActive ? 'cf' : 'primary'
      setActiveAudioElement(nextSide)
      activeElementRef.current = nextSide

      // The next track is the current one from here on: set the ref now, not
      // when React re-renders, so the fading-in element's "play" (ListenBrainz
      // now playing, scrobble ticks) already reads the new track.
      prevTrackIdRef.current = currentTrackRef.current?.id || null
      currentTrackRef.current = nextTrack

      const state = usePlayerStore.getState()
      const nextIdx = state.shuffle ? state.shuffleIndex + 1 : state.queueIndex + 1
      const nextHistory = [...(state.playHistory || []), nextTrack.id]
      usePlayerStore.setState({
        currentTrack: nextTrack,
        queueIndex: !state.shuffle ? nextIdx : state.queueIndex,
        shuffleIndex: state.shuffle ? nextIdx : state.shuffleIndex,
        isPlaying: true,
        playHistory: nextHistory,
        futureHistory: [],
      })
      beginLastfmPlayback(nextTrack)

      fadeInEl.play().catch(() => {})

      // The old song fades out over what it has left at most; the new one
      // fades in on its own (usually shorter) schedule. AutoMix's plan says both.
      const { fadeIn, fadeOut } = crossfadeDurations(plan ? { fadeIn: plan.fadeIn, fadeOut: plan.length } : options, fadeOutEl.duration - fadeOutEl.currentTime)
      const rampNow = ctx.currentTime
      // A transition worth seeing (2 s or more): the "mixing" mark shows, and
      // with AutoMix the cover dissolves into the next song's (MixCovers).
      const transitionSeconds = Math.max(fadeIn, fadeOut)
      if (transitionSeconds >= 2) usePlayerStore.setState({ mixing: { kind: plan ? plan.kind : 'crossfade', until: Date.now() + transitionSeconds * 1000 } })
      if (plan?.bassSwap) {
        // A bass swap halfway: the next song comes in without its bass, then
        // takes the low end over from the playing one (two basslines clash).
        const inFilter = (isPrimaryActive ? mixFilterRef.current.cf : mixFilterRef.current.primary)?.frequency
        const outFilter = (isPrimaryActive ? mixFilterRef.current.primary : mixFilterRef.current.cf)?.frequency
        if (inFilter && outFilter) {
          const swap = rampNow + plan.swapAt
          inFilter.cancelScheduledValues(rampNow)
          outFilter.cancelScheduledValues(rampNow)
          inFilter.setValueAtTime(plan.highpass, rampNow)
          inFilter.setValueAtTime(plan.highpass, swap)
          inFilter.exponentialRampToValueAtTime(MIX_FILTER_OPEN_HZ, swap + 0.4)
          outFilter.setValueAtTime(MIX_FILTER_OPEN_HZ, swap)
          outFilter.exponentialRampToValueAtTime(plan.highpass, swap + 0.4)
        }
      }
      for (const gain of [fadeOutGain.gain, fadeInGain.gain]) {
        gain.cancelScheduledValues(rampNow)
        gain.setValueAtTime(volumeRef.current, rampNow)
      }
      fadeOutNode.gain.cancelScheduledValues(rampNow)
      fadeOutNode.gain.setValueCurveAtTime(fadeCurve(Math.min(1, fadeOutNode.gain.value), 0, options.curve), rampNow, fadeOut)
      fadeInNode.gain.cancelScheduledValues(rampNow)
      fadeInNode.gain.setValueCurveAtTime(fadeCurve(0, 1, options.curve), rampNow, fadeIn)

      crossfadeTimeoutRef.current = setTimeout(() => {
        if (!isCrossfadingRef.current || token !== crossfadeTokenRef.current) return

        const endNow = ctx.currentTime
        fadeInGain.gain.cancelScheduledValues(endNow)
        fadeOutGain.gain.cancelScheduledValues(endNow)
        for (const fade of [fadeInNode.gain, fadeOutNode.gain]) {
          fade.cancelScheduledValues(endNow)
          fade.setValueAtTime(1, endNow)
        }
        
        if (fadeInGain === gainNodeRef.current) {
          gainNodeRef.current.gain.setValueAtTime(volumeRef.current, endNow)
          cfGainNodeRef.current.gain.setValueAtTime(0, endNow)
        } else {
          cfGainNodeRef.current.gain.setValueAtTime(volumeRef.current, endNow)
          gainNodeRef.current.gain.setValueAtTime(0, endNow)
        }

        isCrossfadingRef.current = false
        expectedCrossfadeTrackIdRef.current = null
        crossfadeTimeoutRef.current = null
        openMixFilters()
        usePlayerStore.setState({ mixing: null })
        // A beat-matched song back to its own tempo, gently (8 s).
        if (plan && fadeInEl.playbackRate !== 1) {
          clearInterval(rateGlideRef.current)
          const from = fadeInEl.playbackRate
          const began = Date.now()
          // Every playbackRate change makes the media pipeline re-time its
          // audio (costly on Linux): a few coarse steps, not 80 tiny ones.
          rateGlideRef.current = setInterval(() => {
            const part = Math.min(1, (Date.now() - began) / 8000)
            const rate = from + (1 - from) * part
            try { fadeInEl.playbackRate = Math.abs(rate - 1) < 0.004 ? 1 : Math.round(rate * 1000) / 1000 } catch {}
            if (part >= 1 || fadeInEl.playbackRate === 1) clearInterval(rateGlideRef.current)
          }, 500)
        }

        pauseSuppressRef.current = true
        try { fadeOutEl.pause() } catch {}
        try { fadeOutEl.src = '' } catch {}
        try { fadeOutEl.currentTime = 0 } catch {}
        fadeOutEl.dataset.lokalTrackPending = ''
        fadeOutEl.dataset.lokalTrackId = ''
        setTimeout(() => { pauseSuppressRef.current = false }, 200)
      }, Math.max(fadeIn, fadeOut) * 1000)
    }
  }, [flushTime, setActiveAudioElement, beginLastfmPlayback, cancelCrossfade, stopTimer, autoNext, openMixFilters, applyReplayGainToElement])

  useEffect(() => {
    if (isCrossfadingRef.current) {
      if (castActive || !(currentTrack?.id && currentTrack.id === expectedCrossfadeTrackIdRef.current)) cancelCrossfade()
      else return
    }

    if (castActive) {
      // Casting: the TV plays. Both players are parked, so nothing here makes
      // a sound (a stray play() has no source to play).
      for (const el of [audioRef.current, cfAudioRef.current]) {
        if (!el) continue
        el.dataset.lokalTrackPending = ''
        el.dataset.lokalTrackId = ''
        el.dataset.fallbackPending = ''
        try { el.pause(); el.removeAttribute('src'); el.load() } catch {}
      }
      if (usePlayerStore.getState().activeAudioElement !== 'primary') setActiveAudioElement('primary')
      return
    }

    setIsBuffering(!!streamRef(currentTrack))
    if (!audioRef.current || !currentTrack) return
    if (streamRecoveryRef.current.track !== currentTrack) streamRecoveryRef.current = { track: currentTrack, pending: false, failed: [] }

    if (cfAudioRef.current) { 
      try { 
        cfAudioRef.current.dataset.lokalTrackPending = ''
        cfAudioRef.current.dataset.lokalTrackId = ''
        if (cfGainNodeRef.current) cfGainNodeRef.current.gain.value = 0
        cfAudioRef.current.pause(); 
        cfAudioRef.current.src = '' 
      } catch {} 
    }
    
    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setValueAtTime(volume, audioCtxRef.current.currentTime)
    }
    
    const currentActive = usePlayerStore.getState().activeAudioElement
    if (currentActive !== 'primary') {
      setActiveAudioElement('primary')
    }

    initAudioCtx()

    // Online radio: icecast-metadata-player plays the station on the primary
    // element (src/radio/radioSession.js). The cover goes back to the
    // station's own straight away; each song heard then brings its own.
    if (isStationTrack(currentTrack)) {
      const el = audioRef.current
      const station = currentTrack
      setStreamError(null)
      beginLastfmPlayback(null)
      resetStationDisplay(station)
      el.dataset.lokalTrackPending = String(station.id)
      el.dataset.fallbackFor = ''
      el.dataset.fallbackSrc = ''
      el.dataset.fallbackPending = ''
      setIsBuffering(usePlayerStore.getState().isPlaying)
      const isCurrent = () => usePlayerStore.getState().currentTrack?.id === station.id
      startRadio(el, station, {
        bufferSec: radioBufferSeconds(peekSettings()?.radio_buffer_sec),
        autoplay: usePlayerStore.getState().isPlaying,
        handlers: {
          onTitle: (text, audioTime) => { handleStationTitle(station.id, text, audioTime).catch(() => {}) },
          onStreamInfo: info => useRadioStore.getState().setStreamInfo(station.station?.id || station.id, info),
          onBuffering: busy => { if (isCurrent()) setIsBuffering(busy) },
          onFailed: message => {
            if (!isCurrent()) return
            usePlayerStore.getState().setIsPlaying(false)
            setIsBuffering(false)
            setStreamError({ title: station.station?.title || station.title, message })
            showToast(translate("“{title}” isn't playing: {message}", { title: station.station?.title || station.title, message: translate(message) }))
          },
          onLog: (message, level) => playbackLog(message, level),
        },
      }).catch(error => playbackLog(`[radio] ${station.title}: starting failed: ${error?.message || error}`, 'warn'))
      return () => { el.dataset.lokalTrackPending = '' }
    }

    // A file, or an online song streamed from YouTube; other ghost tracks
    // (imported entries with no file) can't be played.
    const src = audioSrcFor(currentTrack)
    const leavingRadio = radioTrackId() != null
    if (!src) {
      if (leavingRadio) releaseRadio()
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current.dataset.lokalTrackPending = ''
      audioRef.current.dataset.lokalTrackId = ''
      setIsPlaying(false)
      setIsBuffering(false)
      return
    }
    setStreamError(null)
    prepareNextStream()
    const el = audioRef.current
    // Do not relabel the element until its new source is established. This
    // leaves any queued event from the previous source unable to match the
    // new current track.
    el.dataset.lokalTrackPending = String(currentTrack.id)
    el.dataset.fallbackFor = ''
    el.dataset.fallbackSrc = ''
    el.dataset.fallbackPending = '1'
    el.pause()
    el.removeAttribute('src')
    try { el.currentTime = 0 } catch {}
    el.load()
    // Back from casting: on from where the TV was.
    const resumeFrom = takeResumePosition(currentTrack.id)
    let cancelled = false
    const start = async () => {
      // The radio player lets go of the element first (it would otherwise
      // put its own silent clip back on it after this song's source).
      if (leavingRadio) await releaseRadio()
      if (cancelled) return
      const replayGainReady = applyReplayGainToElement(el, currentTrack)
      const generation = usePlayerStore.getState().playbackGeneration
      const ref = streamRef(currentTrack)
      let addonError = ''
      const unavailable = ref ? await playbackAvailability({ id: ref.id }, ref.provider, api, undefined, error => { addonError = String(error || '') }).catch(() => 'unavailable') : null
      const live = usePlayerStore.getState()
      if (cancelled || live.playbackGeneration !== generation || live.currentTrack?.id !== currentTrack.id || live.currentTrack?.file_path !== currentTrack.file_path) return
      await replayGainReady
      const afterGain = usePlayerStore.getState()
      if (cancelled || afterGain.playbackGeneration !== generation || afterGain.currentTrack?.id !== currentTrack.id || afterGain.currentTrack?.file_path !== currentTrack.file_path) return
      // An addon that still needs verifying says so, rather than only
      // falling back to the next source.
      // The addon's own reason (also in Lokal's log) goes into the fallback
      // notice, not just "trying the next source".
      let detail = ''
      if (unavailable && isAddonProvider(ref.provider) && addonError) {
        const access = ADDON_ACCESS_ERROR.test(addonError)
        detail = access ? 'it needs verifying: Settings → Addons → Verify access' : addonError.slice(0, 160)
        if (access) {
          window.dispatchEvent(new Event('lokal:addons-changed'))
          // A verification failure is actionable, not a missing match. Keep
          // this song selected and paused instead of trying other providers or
          // advancing Discovery/Flow to another song.
          el.pause()
          el.dataset.fallbackPending = ''
          setIsPlaying(false)
          setIsBuffering(false)
          const key = ref.provider.slice(2)
          addonVerificationRetryRef.current = {
            key, provider: ref.provider, title: live.currentTrack.title || 'this song',
            trackId: live.currentTrack.id, retry: null, isCurrentPlayback: true,
          }
          setAddonVerificationMessage('')
          setAddonVerificationPrompt({
            key,
            provider: ref.provider,
            title: live.currentTrack.title || 'this song',
            isCurrentPlayback: true,
          })
          return
        }
      }
      if (unavailable) { await recoverOnlinePlayback(el, live.currentTrack, ref, unavailable, detail); return }
      el.dataset.fallbackPending = ''
      replaceAudioSource(el, src)
      if (resumeFrom > 0) { try { el.currentTime = resumeFrom } catch {} }
      else beginLastfmPlayback(live.currentTrack)
      if (usePlayerStore.getState().isPlaying) el.play().catch(() => {})
    }
    start()
    return () => { cancelled = true; el.dataset.fallbackPending = ''; el.dataset.lokalTrackPending = '' }
  }, [currentTrack?.id, currentTrack?.file_path, playbackRetryNonce, castActive, cancelCrossfade, beginLastfmPlayback, recoverOnlinePlayback, setIsBuffering, applyReplayGainToElement])

  useEffect(() => {
    if (!api.isElectron) return
    const publish = createDiscordPublisher({ getState: usePlayerStore.getState, send: api.discordSetActivity })
    publish()
    const unsubscribe = usePlayerStore.subscribe(publish)
    const interval = setInterval(publish, 1000)
    return () => {
      unsubscribe()
      clearInterval(interval)
      api.discordSetActivity(null, false).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (isCrossfadingRef.current) return
    if (!audioRef.current || !cfAudioRef.current) return
    if (usePlayerStore.getState().castActive) return // the TV plays (src/cast/useCastPlayback.js)
    
    const activeSide = usePlayerStore.getState().activeAudioElement
    const activeEl = activeSide === 'primary' ? audioRef.current : cfAudioRef.current

    // Online radio: pausing stops the stream; playing reconnects, live.
    if (isStationTrack(usePlayerStore.getState().currentTrack)) {
      if (isPlaying) { setIsBuffering(audioRef.current.paused); playRadio(); if (!playTimerRef.current) startTimer() }
      else { pauseRadio(); setIsBuffering(false); stopTimer() }
      return
    }
    
    if (isPlaying) { 
      activeEl.play().catch(() => {})
      if (activeSide === 'primary' && !playTimerRef.current) startTimer()
    }
    else { 
      activeEl.pause(); 
      stopTimer() 
    }
  }, [isPlaying])

  useEffect(() => {
    const ctx = audioCtxRef.current
    const primary = gainNodeRef.current?.gain
    const secondary = cfGainNodeRef.current?.gain
    if (!ctx || !primary || !secondary) return
    try {
      const now = ctx.currentTime
      if (isCrossfadingRef.current) {
        // The fade runs on the fade gains: both sides just take the new volume.
        primary.cancelScheduledValues(now)
        secondary.cancelScheduledValues(now)
        primary.setValueAtTime(volume, now)
        secondary.setValueAtTime(volume, now)
        return
      }
      const activeSide = usePlayerStore.getState().activeAudioElement
      const activeGain = activeSide === 'primary' ? primary : secondary
      const inactiveGain = activeSide === 'primary' ? secondary : primary
      activeGain.cancelScheduledValues(now)
      inactiveGain.cancelScheduledValues(now)
      activeGain.setValueAtTime(volume, now)
      inactiveGain.setValueAtTime(0, now)
    } catch {}
  }, [volume])

  useEffect(() => {
    const state = usePlayerStore.getState()
    const tracks = [state.currentTrack, ...state.queue, ...state.shuffleQueue, ...state.originalQueue].filter(Boolean)
    for (const element of [audioRef.current, cfAudioRef.current]) {
      if (!element) continue
      const id = element.dataset.lokalTrackPending || element.dataset.lokalTrackId
      const track = id ? tracks.find(item => String(item.id) === id) : null
      applyReplayGainToElement(element, track)
    }
  }, [replayGainMode, audioOutputReady, applyReplayGainToElement])

  const handleTimeUpdate = useCallback((e) => {
    if (!isEventFromActive(e)) return;

    const cur = e.target.currentTime
    const dur = e.target.duration

    // Online radio: the time into the song heard now (when it's known), and
    // its length only if the station's API said.
    const playing = usePlayerStore.getState().currentTrack
    if (isStationTrack(playing)) {
      setProgress(stationSongTime(playing, cur) ?? 0)
      setDuration(Number(playing.song_duration) || 0)
      return
    }
    
    setProgress(cur)
    setDuration(dur)
    
    if (!dur || isNaN(dur) || isCrossfadingRef.current) return

    const state = usePlayerStore.getState()
    const cf = state.crossfade?.beforeEnd || 0
    const remaining = dur - cur

    if (state.crossfade?.automix && state.repeat !== 'one') {
      // AutoMix: the transition its plan says, loaded ahead and started on time.
      const nextTrack = upcomingTrack(state)
      const current = currentTrackRef.current
      if (nextTrack && current && remaining > 0.3) {
        const out = automixAnalysis(current)
        // The next song is analysed a while ahead (an online one is downloaded to be).
        const next = remaining < 150 ? automixAnalysis(nextTrack) : undefined
        if (remaining < 90) {
          const plan = automixPlanFor(current, nextTrack, dur, out, next, !!state.crossfade.automixSameAlbum)
          if (plan === AUTOMIX_FALLBACK) {
            // Planning failed or was too slow: an ordinary crossfade instead.
            if (remaining <= Math.max(CROSSFADE_MIN_S, state.crossfade?.fadeOut || cf || AUTOMIX_FALLBACK_S)) triggerCrossfade(nextTrack)
          } else if (plan && cur >= plan.start - AUTOMIX_PRELOAD_S) triggerCrossfade(nextTrack, plan)
        }
      }
    } else if (state.repeat !== 'one' && cf > CROSSFADE_MIN_S && remaining <= cf && remaining > 0.3) {
      const { shuffle, shuffleQueue, shuffleIndex, queue, queueIndex } = state
      let nextTrack = null
      
      if (shuffle && shuffleQueue.length > 0 && shuffleIndex + 1 < shuffleQueue.length) {
        nextTrack = shuffleQueue[shuffleIndex + 1]
      } else if (!shuffle && queueIndex + 1 < queue.length) {
        nextTrack = queue[queueIndex + 1]
      }
      
      if (nextTrack) triggerCrossfade(nextTrack)
    }

    topUpRelated()
  }, [triggerCrossfade, isEventFromActive, topUpRelated, automixAnalysis, automixPlanFor])

  const handlePrimaryDurationChange = useCallback((e) => {
    if (isEventFromActive(e) && !isStationTrack(usePlayerStore.getState().currentTrack)) setDuration(e.target.duration)
  }, [isEventFromActive])

  const handleCfDurationChange = useCallback((e) => {
    if (isEventFromActive(e) && !isStationTrack(usePlayerStore.getState().currentTrack)) setDuration(e.target.duration)
  }, [isEventFromActive])

  const handleAudioCanPlay = useCallback((e) => {
    const el = e.currentTarget
    const pending = el.dataset.lokalTrackPending
    if (!pending) return
    el.dataset.lokalTrackId = pending
    el.dataset.lokalTrackPending = ''
    // The element's play event came while it was still pending and was
    // ignored: start what it would have (the listening timer, ListenBrainz
    // now playing), or an auto-advanced song is never counted.
    const { activeAudioElement, isPlaying, currentTrack } = usePlayerStore.getState()
    const active = (activeAudioElement === 'primary') === (el === audioRef.current)
    if (active && isPlaying && !el.paused && String(currentTrack?.id) === pending) {
      startTimer()
      sendListenBrainzNowPlaying()
    }
  }, [startTimer, sendListenBrainzNowPlaying])

  const handlePrimaryEnded = useCallback((e) => {
    if (typeof e.currentTarget?.ended === 'boolean' && !e.currentTarget.ended) return
    // A station's stream ending is a dropped connection: the radio player reconnects.
    if (isStationTrack(usePlayerStore.getState().currentTrack)) return
    if (!isEventFromActive(e) || isCrossfadingRef.current) return
    
    stopTimer()
    flushTime(currentTrackRef.current?.id)
    
    if (repeat === 'one') { 
      beginLastfmPlayback(currentTrackRef.current)
      audioRef.current.currentTime = 0; 
      audioRef.current.play().catch(() => {}) 
    }
    else autoNext()
  }, [isEventFromActive, repeat, beginLastfmPlayback, autoNext, stopTimer, flushTime])

  const handleCfEnded = useCallback((e) => {
    if (typeof e.currentTarget?.ended === 'boolean' && !e.currentTarget.ended) return
    if (!isEventFromActive(e) || isCrossfadingRef.current) return
    
    stopTimer()
    flushTime(currentTrackRef.current?.id)
    
    if (repeat === 'one') { 
      beginLastfmPlayback(currentTrackRef.current)
      cfAudioRef.current.currentTime = 0; 
      cfAudioRef.current.play().catch(() => {}) 
    }
    else autoNext()
  }, [isEventFromActive, repeat, beginLastfmPlayback, autoNext, stopTimer, flushTime])

  const handleStartDownload = async () => {
    setUpdateState(prev => ({ ...prev, status: 'downloading' }));

    try {
      const result = await api.updaterDownload();
      if (result?.error) {
        setUpdateState(prev => ({ ...prev, status: 'error', error: result.error }));
      }
    } catch (err) {
      setUpdateState(prev => ({ ...prev, status: 'error', error: err.message }));
    }
  };

  const MarkdownLite = ({ text }) => {
    const lines = text.split('\n');

    const renderInline = (str) => {
      const parts = str.split(/(\*\*.*?\*\*)/g);
      return parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="font-bold text-white/90">{part.slice(2, -2)}</strong>;
        }
        return part;
      });
    };

    return (
      <div className="space-y-2">
        {lines.map((line, i) => {
          const trimmedLine = line.trim();

          if (line.startsWith('### ')) {
            return <h3 key={i} className="text-sm font-bold text-white mt-4">{renderInline(line.replace('### ', ''))}</h3>;
          }
          if (line.startsWith('## ')) {
            return <h2 key={i} className="text-base font-bold text-white mt-4 border-b border-white/10 pb-1">{renderInline(line.replace('## ', ''))}</h2>;
          }

          if (line.startsWith('> ')) {
            return (
              <blockquote key={i} className="border-l-2 border-accent/50 pl-3 py-1 my-2 bg-white/5 italic text-xs text-muted/90 rounded-r-sm">
                {renderInline(line.replace('> ', ''))}
              </blockquote>
            );
          }

          if (line.startsWith('- ') || line.startsWith('* ')) {
            return (
              <div key={i} className="flex gap-2 text-xs text-muted ml-2">
                <span className="text-accent">•</span>
                <span>{renderInline(line.replace(/^[-*]\s+/, ''))}</span>
              </div>
            );
          }

          if (!trimmedLine) return <div key={i} className="h-1" />;
          
          return (
            <p key={i} className="text-xs text-muted leading-relaxed">
              {renderInline(line)}
            </p>
          );
        })}
      </div>
    );
  };

  const scrollbarStyles = `
    .update-scrollbar::-webkit-scrollbar {
      width: 6px;
    }
    .update-scrollbar::-webkit-scrollbar-track {
      background: transparent;
    }
    .update-scrollbar::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
    }
    .update-scrollbar::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.2);
    }
  `;

  const renderUpdateToast = () => {
    if (updateState.status === 'idle') return null;
    // A failed check with no update found (offline, GitHub hiccup...) is not
    // an update: don't open the "Update Available" dialog for it. Errors while
    // downloading a real update still show, since `info` is set then.
    if (updateState.status === 'error' && !updateState.info?.version) return null;

    const isReady = updateState.status === 'ready';
    const isDownloading = updateState.status === 'downloading';

    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
        <style>{scrollbarStyles}</style>
        <div className="bg-elevated/90 backdrop-blur-2xl border border-white/10 rounded-3xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] w-full max-w-xl overflow-hidden ring-1 ring-white/5">
          
          <div className="p-8 flex items-center justify-between bg-white/5">
            <div className="flex items-center gap-5">
              <div className={`p-4 rounded-2xl ${isReady ? 'bg-green-500/20 text-green-400' : 'bg-accent/20 text-accent'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div>
                <h4 className="text-xl font-black text-white tracking-tight">
                  {t(isReady ? 'Update Ready' : isDownloading ? 'Downloading…' : 'Update Available')}
                </h4>
                <p className="text-xs text-accent uppercase tracking-[0.2em] font-bold mt-1 opacity-80">
                  Lokal v{updateState.info?.version}
                </p>
              </div>
            </div>
            
            <button 
              onClick={handleDismissUpdate}
              className="p-2 hover:bg-white/10 rounded-full transition-colors text-muted hover:text-white"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>

          <div className="p-8 space-y-6">
            <div className="max-h-[350px] overflow-y-auto pr-4 update-scrollbar">
              {loadingChangelog ? (
                <div className="space-y-4">
                  <div className="h-4 w-full bg-white/5 animate-pulse rounded-lg" />
                  <div className="h-4 w-5/6 bg-white/5 animate-pulse rounded-lg" />
                  <div className="h-4 w-4/6 bg-white/5 animate-pulse rounded-lg" />
                </div>
              ) : (
                <MarkdownLite text={changelog} />
              )}
            </div>

            {isDownloading && (
              <div className="space-y-3 pt-4 border-t border-white/5">
                <div className="flex justify-between text-xs font-bold uppercase tracking-wider">
                  <span className="text-muted">{t('Downloading package')}</span>
                  <span className="text-accent">{Math.round(updateState.progress)}%</span>
                </div>
                <div className="h-2.5 bg-white/5 rounded-full overflow-hidden p-[2px]">
                  <div 
                    className="h-full bg-accent rounded-full transition-all duration-500 ease-out shadow-[0_0_15px_rgba(var(--accent-rgb),0.6)]"
                    style={{ width: `${updateState.progress}%` }}
                  />
                </div>
              </div>
            )}
            
            <div className="flex gap-3 pt-2">
              {!isDownloading && !isReady && (
                <button
                  onClick={handleStartDownload}
                  className="flex-1 py-4 bg-accent text-base text-sm font-bold rounded-2xl hover:brightness-110 active:scale-[0.98] transition-all"
                >
                  {t('Download update')}
                </button>
              )}
              
              {isReady && (
                <button
                  onClick={handleInstallUpdate}
                  className="flex-1 py-4 bg-white text-black text-sm font-black rounded-2xl hover:bg-gray-100 active:scale-[0.98] transition-all uppercase tracking-widest"
                >
                  {t('Restart & install')}
                </button>
              )}

              {!isReady && (
                <button
                  onClick={handleDismissUpdate}
                  className="px-6 py-4 bg-white/5 text-white text-sm font-bold rounded-2xl hover:bg-white/10 transition-all"
                >
                  {t('Later')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderYtDlpNotice = () => {
    if (!ytDlpVersionState.visible) return null

    const isDownloading = ytDlpVersionState.downloadState === 'downloading'
    const isDone = ytDlpVersionState.downloadState === 'done'
    const summary = ytDlpVersionState.releasesBehind
      ? `${ytDlpVersionState.releasesBehind} release${ytDlpVersionState.releasesBehind === 1 ? '' : 's'} behind`
      : formatRelativeDays(ytDlpVersionState.daysBehind, t)
    const latestDate = ytDlpVersionState.latestPublishedAt
      ? new Date(ytDlpVersionState.latestPublishedAt).toLocaleDateString()
      : null

    return (
      <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget && !isDownloading) handleDismissYtDlpNotice() }}>
        <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-elevated/90 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] ring-1 ring-white/5">
          <div className="flex items-center justify-between bg-white/5 p-7">
            <div className="flex items-center gap-4">
              <div className="rounded-2xl bg-yellow-500/15 p-4 text-yellow-300">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                </svg>
              </div>
              <div>
                <h4 className="text-xl font-black tracking-tight text-white">{t('yt-dlp update recommended')}</h4>
                <p className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-yellow-200/80">{summary}</p>
              </div>
            </div>
            <button
              onClick={handleDismissYtDlpNotice}
              className="rounded-full p-2 text-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>

          <div className="space-y-5 p-7">
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-4 text-sm">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('Installed')}</p>
                  <p className="mt-1 font-semibold text-white">{ytDlpVersionState.installedVersion || t('Unknown')}</p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('Latest')}</p>
                  <p className="mt-1 font-semibold text-white">{ytDlpVersionState.latestVersion || t('Unknown')}</p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted">
                {ytDlpVersionState.source && <span className="rounded-full border border-white/10 px-2.5 py-1 uppercase tracking-[0.18em]">{ytDlpVersionState.source}</span>}
                {Number.isFinite(ytDlpVersionState.daysBehind) && ytDlpVersionState.daysBehind > 0 && <span className="rounded-full border border-white/10 px-2.5 py-1">{formatRelativeDays(ytDlpVersionState.daysBehind, t)}</span>}
                {latestDate && <span className="rounded-full border border-white/10 px-2.5 py-1">{t('Latest released {date}', { date: latestDate })}</span>}
              </div>
            </div>

            <p className="text-sm leading-relaxed text-muted">
              {t('Older yt-dlp builds can break when sites change. Updating usually fixes downloader errors without changing your library.')}
            </p>

            {ytDlpVersionState.error && (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {ytDlpVersionState.error}
              </div>
            )}

            {ytDlpVersionState.downloadMessage && (
              <div className={`rounded-2xl border px-4 py-3 text-sm ${isDone ? 'border-green-500/20 bg-green-500/10 text-green-200' : 'border-white/10 bg-white/5 text-muted'}`}>
                {ytDlpVersionState.downloadMessage}
                {isDownloading && (
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                    {Number.isFinite(ytDlpVersionState.downloadPercent) ? (
                      <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(3, ytDlpVersionState.downloadPercent)}%` }} />
                    ) : (
                      <div className="h-full w-1/3 rounded-full bg-accent/70 animate-pulse" />
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              {!isDone && (
                <button
                  onClick={handleUpdateYtDlp}
                  disabled={isDownloading}
                  className="flex-1 rounded-2xl bg-accent py-4 text-sm font-bold text-[rgb(var(--bg-rgb))] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isDownloading
                    ? t('Updating yt-dlp{progress}', { progress: Number.isFinite(ytDlpVersionState.downloadPercent) ? ` · ${ytDlpVersionState.downloadPercent}%` : '…' })
                    : t('Update yt-dlp')}
                </button>
              )}
              <button
                onClick={handleDismissYtDlpNotice}
                className="rounded-2xl bg-white/5 px-6 py-4 text-sm font-bold text-white transition-all hover:bg-white/10"
              >
                {isDownloading ? t('Hide') : isDone ? t('Close') : t('Later')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Router>
  <NativeHistoryNavigation />
  <KeyboardShortcuts />
  <TvController />
      <div className="relative flex flex-col h-screen bg-transparent overflow-hidden" onClick={initAudioCtx} style={showMiniPlayer || !glassPlayerBar ? undefined : { '--player-space': '104px' }}>
        {/* Covers the window (overlays included) while it switches to or from
            the mini player: the window is resized behind it, so neither view
            is ever seen at the other's size. */}
        <div aria-hidden className="pointer-events-none fixed inset-0 z-[400] bg-bg transition-opacity duration-100 ease-out" style={{ opacity: miniSwitching ? 1 : 0 }} />
        {showMiniPlayer && <MiniPlayer windowed />}
        {/* Kept mounted (hidden) while the mini player shows: leaving it
            brings the page back as it was instead of rebuilding the app. */}
        <Activity mode={showMiniPlayer ? 'hidden' : 'visible'}>
          <>
            <div 
              className="fixed inset-0 bg-no-repeat -z-10"
              style={{ 
                backgroundImage: 'var(--bg-image)', 
                filter: 'blur(var(--bg-blur))', 
                transform: 'scale(1.02)',
                backgroundSize: 'var(--bg-size)',
                backgroundPosition: 'var(--bg-position)'
              }}
            />
            <div 
              className="fixed inset-0 bg-bg -z-10" 
              style={{ opacity: 'var(--bg-overlay)' }} 
            />

            <TitleBar />
            <ReleaseRefreshBanner />
            <div className="flex flex-1 overflow-hidden" data-app-layout>
              <Sidebar />
              <main ref={pageWidthRef} className="min-w-0 flex-1 overflow-y-auto bg-transparent pb-[var(--player-space,0px)] [scrollbar-gutter:stable]">
                <AnimatedRoutes />
              </main>
              <RightSidebar />
              {!exclusiveSidePanels && <QueuePanel />}
              {!exclusiveSidePanels && <LyricsSidePanel />}
            </div>
            <PlayerBar />
            {/* Also full-screen lyrics: one overlay, two layouts. */}
            <FullscreenPlayer />
            <MusicVideoPlayer />
            <AuthModal />
            <ProfileModal />
            <AddToPlaylistModal />
            <BulkLosslessModal />
            <LosslessModal />
            <SmartPlaylistModal />
            <ImportPlaylistModal />
            <ShareCardModal />
            <RecapStories
              open={showRecapStories}
              onClose={() => {
                try { localStorage.removeItem('lokal-dev-recap') } catch {}
                setShowRecapStories(false)
              }}
            />
            
            {!onboardingLoading && showOnboarding && (
              <Onboarding isOpen={showOnboarding} onComplete={completeOnboarding} />
            )}
            
            <PostOnboardingTour />
            
            {renderYtDlpNotice()}
            {renderUpdateToast()}
            <Toaster />
            <AnimatePresence>
              {addonVerificationPrompt && (
                <motion.div
                  className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={event => { if (event.target === event.currentTarget && !addonVerificationBusy) dismissAddonVerificationPrompt() }}
                >
                  <motion.div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="addon-verification-title"
                    initial={{ opacity: 0, y: 10, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.98 }}
                    className="w-full max-w-md rounded-2xl border border-border bg-elevated p-5 shadow-2xl"
                  >
                    <p id="addon-verification-title" className="text-base font-semibold text-text">{t('Provider verification required')}</p>
                    <p className="mt-2 text-sm text-muted">{addonVerificationPrompt.isCurrentPlayback
                      ? t('Playback of “{title}” is paused because this provider needs verification. Verify access to continue; Lokal will not skip to another song.', { title: addonVerificationPrompt.title })
                      : t('The selected song “{title}” needs this provider to be verified before it can play. Current playback will continue until verification finishes.', { title: addonVerificationPrompt.title })}</p>
                    {addonVerificationMessage && <p role="status" className="mt-3 text-xs text-muted">{t(addonVerificationMessage)}</p>}
                    <div className="mt-5 flex justify-end gap-2">
                      <button
                        disabled={addonVerificationBusy}
                        onClick={dismissAddonVerificationPrompt}
                        className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text disabled:opacity-50"
                      >{t('Not now')}</button>
                      <button
                        disabled={addonVerificationBusy}
                        onClick={async () => {
                          setAddonVerificationBusy(true)
                          setAddonVerificationMessage('')
                          try {
                            const result = await api.addonsPackages({ action: 'package.verify', key: addonVerificationPrompt.key })
                            if (result?.authenticated) {
                              window.dispatchEvent(new Event('lokal:addons-changed'))
                              await completeAddonVerification(addonVerificationPrompt.key)
                            } else if (result?.opened) {
                              setAddonVerificationMessage('Complete verification in the browser window that opened. Lokal will start the selected song automatically when access is confirmed.')
                            } else {
                              setAddonVerificationMessage(result?.error || "Verification couldn't be started. Open Settings → Addons to verify this provider.")
                            }
                          } catch (error) {
                            setAddonVerificationMessage(error?.message || "Verification couldn't be started. Open Settings → Addons to verify this provider.")
                          } finally {
                            setAddonVerificationBusy(false)
                          }
                        }}
                        className="rounded-lg bg-accent px-3 py-2 text-sm text-base disabled:opacity-50"
                      >{addonVerificationBusy ? t('Opening…') : t('Verify access')}</button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
              {streamError && (
                <motion.div
                  role="status"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 12 }}
                  className="fixed bottom-28 right-6 z-[60] max-w-sm rounded-xl border border-border bg-elevated px-4 py-3 shadow-2xl"
                >
                  <p className="text-sm font-medium text-text truncate">{t('Couldn’t stream “{title}”', { title: streamError.title })}</p>
                  <p className="text-xs text-muted mt-1">{streamError.message}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        </Activity>

        {/* crossOrigin: both players feed the Web Audio graph (EQ, analyser).
            Without it, Chromium treats lokal-stream:// media as cross-origin
            and the graph outputs silence. */}
        <audio
          ref={audioRef}
          onLoadStart={(e) => logAddonMediaEvent('loadstart', e, 'primary')}
          onLoadedMetadata={(e) => logAddonMediaEvent('loadedmetadata', e, 'primary')}
          onCanPlay={(e) => { logAddonMediaEvent('canplay', e, 'primary'); handleAudioCanPlay(e) }}
          onSeeking={onAudioSeeking}
          preload="auto"
          crossOrigin="anonymous"
          onTimeUpdate={handleTimeUpdate}
          onDurationChange={handlePrimaryDurationChange}
          onEnded={(e) => { logAddonMediaEvent('ended', e, 'primary'); handlePrimaryEnded(e) }}
          onError={(e) => { logAddonMediaEvent('error', e, 'primary'); handleAudioError(e) }}
          onWaiting={(e) => { logAddonMediaEvent('waiting', e, 'primary'); const playing = usePlayerStore.getState().currentTrack; if (isEventFromActive(e) && (streamRef(playing) || isStationTrack(playing))) setIsBuffering(true) }}
          onStalled={(e) => logAddonMediaEvent('stalled', e, 'primary')}
          onSuspend={(e) => logAddonMediaEvent('suspend', e, 'primary')}
          onAbort={(e) => logAddonMediaEvent('abort', e, 'primary')}
          onEmptied={(e) => logAddonMediaEvent('emptied', e, 'primary')}
          onPlaying={(e) => { logAddonMediaEvent('playing', e, 'primary'); if (isEventFromActive(e)) { setIsBuffering(false); clearPlaybackError() } }}
          onPlay={(e) => { logAddonMediaEvent('play', e, 'primary'); if (!isEventFromActive(e) || usePlayerStore.getState().castActive) return; setIsPlaying(true); startTimer(); sendListenBrainzNowPlaying() }}
          onPause={(e) => { logAddonMediaEvent('pause', e, 'primary'); if (pauseSuppressRef.current || usePlayerStore.getState().castActive) return; if (!isEventFromActive(e)) return; if (ignoreElementPause(e.currentTarget)) return; setIsPlaying(false); stopTimer() }}
        />
        <audio
          ref={cfAudioRef}
          onLoadStart={(e) => logAddonMediaEvent('loadstart', e, 'cf')}
          onLoadedMetadata={(e) => logAddonMediaEvent('loadedmetadata', e, 'cf')}
          onCanPlay={(e) => { logAddonMediaEvent('canplay', e, 'cf'); handleAudioCanPlay(e) }}
          onSeeking={onAudioSeeking}
          preload="auto"
          crossOrigin="anonymous"
          onTimeUpdate={handleTimeUpdate}
          onDurationChange={handleCfDurationChange}
          onEnded={(e) => { logAddonMediaEvent('ended', e, 'cf'); handleCfEnded(e) }}
          onError={(e) => { logAddonMediaEvent('error', e, 'cf'); handleAudioError(e) }}
          onWaiting={(e) => { logAddonMediaEvent('waiting', e, 'cf'); if (isEventFromActive(e) && streamRef(usePlayerStore.getState().currentTrack)) setIsBuffering(true) }}
          onStalled={(e) => logAddonMediaEvent('stalled', e, 'cf')}
          onSuspend={(e) => logAddonMediaEvent('suspend', e, 'cf')}
          onAbort={(e) => logAddonMediaEvent('abort', e, 'cf')}
          onEmptied={(e) => logAddonMediaEvent('emptied', e, 'cf')}
          onPlaying={(e) => { logAddonMediaEvent('playing', e, 'cf'); if (isEventFromActive(e)) { setIsBuffering(false); clearPlaybackError() } }}
          onPlay={(e) => { logAddonMediaEvent('play', e, 'cf'); if (!isEventFromActive(e) || usePlayerStore.getState().castActive) return; setIsPlaying(true); startTimer(); sendListenBrainzNowPlaying() }}
          onPause={(e) => { logAddonMediaEvent('pause', e, 'cf'); if (pauseSuppressRef.current || usePlayerStore.getState().castActive) return; if (!isEventFromActive(e)) return; if (ignoreElementPause(e.currentTarget)) return; setIsPlaying(false); stopTimer() }}
        />
        {/* Never connect this to the Web Audio graph (no createMediaElementSource) -
            it exists purely to keep a native, audible HTMLMediaElement "playing"
            so Windows SMTC / OS media-session surfaces recognize Lokal. */}
        <audio ref={smtcKeepAliveRef} src="silence.wav" loop preload="auto" />
      </div>
    </Router>
  )
}
