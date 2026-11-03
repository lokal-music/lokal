import React, { useState, useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Heart, FolderOpen, AudioWaveform, Mic2, PanelRight, Maximize2, ListMusic, Plus, Moon, X, Radio, Gem, Cast, Clock, ListEnd, Disc3, Edit2, Camera, Download, SlidersHorizontal } from 'lucide-react'
import { usePlayerStore, useAppStore } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { useNavigate } from 'react-router-dom'
import { api, peekSettings } from '../api'
import { useTranslation } from '../i18n'
import { navigateToTrackAlbum } from '../playbackContext'
import { isOnlineTrack } from '../onlineBrowse'
import { isStationTrack } from '../radio/stations'
import { useRadioStore } from '../store/radio'
import { resolveStationSong } from '../radio/stationSong'
import { navigateToRadioAlbum } from '../radio/stationAlbum'
import { showToast } from './Toaster'
import Waveform from './Waveform'
import Spectrum from '../visualizers/Spectrum'
import Waves from '../visualizers/Waves'
import Lightning from '../visualizers/Lightning'
import { useAppearanceFlag } from '../appearanceFlags'
import Modal from './Modal'
import AudioPipelineModal from './AudioPipelineModal'
import EqualizerModal from './EqualizerModal'
import { trackArtURL, isStreamed, streamLabel } from '../onlineTracks'
import SaveToLibraryButton from './SaveToLibraryButton'
import { TIERS, formatLabel, qualityTagLabel, isSuspect, tierOf, losslessMenuItem } from '../quality'
import { useFullResolutionTags } from '../resolutionTagPreferences'
import { atmosDownloadRef, downloadAtmosVersion } from '../atmosDownloads'
import AudioOutputPicker from './AudioOutputPicker'
import MixingMark from './MixingMark'
import ContextMenu, { useContextMenu } from './ContextMenu'
import TrackEditModal from './TrackEditModal'
import { openRadio } from '../radioActions'
import { addToQueueMany, playNextMany } from '../trackActions'
import { useCastStore } from '../cast/castStore'
import MarqueeText from './MarqueeText'
import TrackArtistLinks from './TrackArtistLinks'
import { useVolumeWheel } from '../volumeWheel'

const folderPathForTrack = (trackPath, musicRoot) => {
  if (!trackPath || String(trackPath).startsWith('ghost://') || !musicRoot) return null
  const rootOriginal = String(musicRoot).replace(/\\/g, '/')
  let root = rootOriginal.replace(/\/+$/, '').replace(/^([a-z]:)$/i, '$1/') || (rootOriginal.startsWith('/') ? '/' : '')
  const track = String(trackPath).replace(/\\/g, '/')
  const windowsPath = /^[a-z]:\//i.test(root) || root.startsWith('//')
  const rootCompare = windowsPath ? root.toLowerCase() : root
  const trackCompare = windowsPath ? track.toLowerCase() : track
  const prefix = rootCompare.endsWith('/') ? rootCompare : `${rootCompare}/`
  if (trackCompare !== rootCompare && !trackCompare.startsWith(prefix)) return null
  const relative = track.slice(root.length).replace(/^\/+/, '')
  return relative.split('/').slice(0, -1).join('/')
}

function fmt(s) { return `${Math.floor((s||0)/60)}:${Math.floor((s||0)%60).toString().padStart(2,'0')}` }

export default function PlayerBar() {
  const { t } = useTranslation()
  const glass = useAppearanceFlag('glass_player_bar')
  const fullResolutionTags = useFullResolutionTags()
  const showWaveform = useAppearanceFlag('player_waveform')
  const [playerVisualizer, setPlayerVisualizer] = useState(() => peekSettings()?.player_visualizer || null)
  const visualizerRequest = useRef(0)
  useEffect(() => {
    const refreshVisualizer = () => {
      const request = ++visualizerRequest.current
      const cached = peekSettings()
      if (cached) { setPlayerVisualizer(cached.player_visualizer || null); return }
      api.getSettings().then(value => {
        if (request === visualizerRequest.current) setPlayerVisualizer(value?.player_visualizer || null)
      }).catch(() => {})
    }
    refreshVisualizer()
    window.addEventListener('lokal:settings-saved', refreshVisualizer)
    return () => window.removeEventListener('lokal:settings-saved', refreshVisualizer)
  }, [])
  const visualizerMode = playerVisualizer || (showWaveform ? 'waveform' : 'off')
  const nav = useNavigate()
  const {
    currentTrack, isPlaying, isBuffering, progress, duration, volume, shuffle, repeat,
    showRightSidebar, showQueue, showLyricsPanel, sidePanelView, exclusiveSidePanels,
    togglePlay, next, prev, setProgress, setVolume, toggleShuffle, toggleRepeat,
    toggleLyricsButton, toggleRightSidebar, toggleFullscreen, toggleQueueButton,
    likedIds, setLiked, audioRef, cfAudioRef, activeAudioElement,
    sleepTimerMinutes, sleepTimerEndTime, setSleepTimer, cancelSleepTimer,
    toggleMiniPlayer,
  } = usePlayerStore(useShallow(({
    currentTrack, isPlaying, isBuffering, progress, duration, volume, shuffle, repeat,
    showRightSidebar, showQueue, showLyricsPanel, sidePanelView, exclusiveSidePanels,
    togglePlay, next, prev, setProgress, setVolume, toggleShuffle, toggleRepeat,
    toggleLyricsButton, toggleRightSidebar, toggleFullscreen, toggleQueueButton,
    likedIds, setLiked, audioRef, cfAudioRef, activeAudioElement,
    sleepTimerMinutes, sleepTimerEndTime, setSleepTimer, cancelSleepTimer,
    toggleMiniPlayer,
  }) => ({
    currentTrack, isPlaying, isBuffering, progress, duration, volume, shuffle, repeat,
    showRightSidebar, showQueue, showLyricsPanel, sidePanelView, exclusiveSidePanels,
    togglePlay, next, prev, setProgress, setVolume, toggleShuffle, toggleRepeat,
    toggleLyricsButton, toggleRightSidebar, toggleFullscreen, toggleQueueButton,
    likedIds, setLiked, audioRef, cfAudioRef, activeAudioElement,
    sleepTimerMinutes, sleepTimerEndTime, setSleepTimer, cancelSleepTimer,
    toggleMiniPlayer,
  })))
  const stationInfo = useRadioStore(s => s.streamInfo[currentTrack?.station?.id || currentTrack?.id])
  const { user, openAddToPlaylist } = useAppStore()
  const [likeAnim, setLikeAnim] = useState(false)
  const [showAudioPipeline, setShowAudioPipeline] = useState(false)
  const [showEqualizer, setShowEqualizer] = useState(false)
  const [editingTrack, setEditingTrack] = useState(null)
  const [keepCommaArtists, setKeepCommaArtists] = useState([])
  const volumeWheelRef = useVolumeWheel(volume, setVolume)
  const scrubbing = useRef(false)
  const [localProg, setLocalProg] = useState(null)
  const [showSleepTimer, setShowSleepTimer] = useState(false)
  const [sleepTimerDisplay, setSleepTimerDisplay] = useState(null)
  const menu = useContextMenu()
  const display = localProg ?? progress
  const contextMenuTrackKey = currentTrack
    ? (isStationTrack(currentTrack) && currentTrack.song_key ? `station:${currentTrack.song_key}` : `track:${currentTrack.id ?? ''}`)
    : null
  const previousContextMenuTrackKey = useRef(contextMenuTrackKey)
  useEffect(() => {
    if (previousContextMenuTrackKey.current === contextMenuTrackKey) return
    previousContextMenuTrackKey.current = contextMenuTrackKey
    // A player-bar context menu belongs to the track that opened it. Close it
    // on track changes rather than letting an action target a different song.
    menu.close()
  }, [contextMenuTrackKey, menu.close])
  const [stationLikeId, setStationLikeId] = useState({}) // radio: song_key -> the found song's id
  const currentIsStationSong = isStationTrack(currentTrack) && !!currentTrack?.song_key
  const currentStationLikeId = currentIsStationSong ? stationLikeId[currentTrack.song_key] : null
  const isLiked = currentTrack && (currentIsStationSong
    ? currentStationLikeId != null && likedIds.has(currentStationLikeId)
    : !isStationTrack(currentTrack) && currentTrack.id != null && likedIds.has(currentTrack.id))
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat

  useEffect(() => {
    if (!sleepTimerEndTime) {
      setSleepTimerDisplay(null)
      return
    }
    
    const updateDisplay = () => {
      const remaining = sleepTimerEndTime - Date.now()
      if (remaining <= 0) {
        setSleepTimerDisplay(null)
        return
      }
      const minutes = Math.floor(remaining / 60000)
      const seconds = Math.floor((remaining % 60000) / 1000)
      setSleepTimerDisplay(`${minutes}:${seconds.toString().padStart(2, '0')}`)
    }
    
    updateDisplay()
    const interval = setInterval(updateDisplay, 1000)
    return () => clearInterval(interval)
  }, [sleepTimerEndTime])

  useEffect(() => {
    return () => {
      if (sleepTimerEndTime && Date.now() >= sleepTimerEndTime) {
        cancelSleepTimer()
      }
    }
  }, [])

  useEffect(() => {
    api.getKeepCommaArtists().then(artists => {
      if (Array.isArray(artists)) {
        setKeepCommaArtists(artists)
      } else if (artists?.value) {
        try { setKeepCommaArtists(JSON.parse(artists.value)) } catch {}
      }
    }).catch(() => {})
  }, [])


  const handleScrub = useCallback((e) => {
    if (!duration || isStationTrack(usePlayerStore.getState().currentTrack)) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration
    setLocalProg(t)
    // Through the store: it seeks the playing element, or the TV while casting.
    if (scrubbing.current) usePlayerStore.getState().setProgressWithAudioUpdate(t)
  }, [duration])

  // A radio station playing a named song: Like and Save act on that song, found online.
  const stationSongKnown = isStationTrack(currentTrack) && !!currentTrack?.song_key

  useEffect(() => {
    if (!stationSongKnown) return undefined
    const target = currentTrack
    let alive = true
    resolveStationSong(target).then(track => {
      if (!alive || track?.id == null) return
      setStationLikeId(ids => ids[target.song_key] === track.id ? ids : { ...ids, [target.song_key]: track.id })
    }).catch(() => {})
    return () => { alive = false }
  }, [stationSongKnown, currentTrack?.song_key])

  const toggleLike = async (target = currentTrack, desiredLiked = null) => {
    if (!target) return
    const userId = user?.id ?? null
    let track = target
    const targetIsStationSong = isStationTrack(target) && !!target.song_key
    if (targetIsStationSong) {
      track = await resolveStationSong(target)
      if (!track) { showToast(t("Couldn't find this song online")); return }
      setStationLikeId(ids => ({ ...ids, [target.song_key]: track.id }))
    }
    // Don't apply an async response to a different account's in-memory likes.
    if ((useAppStore.getState().user?.id ?? null) !== userId) return
    if (desiredLiked != null && usePlayerStore.getState().likedIds.has(track.id) === desiredLiked) return
    const r = await api.toggleLike(track.id, userId, track)
    const liked = typeof r === 'boolean' ? r : r?.liked ?? false
    if ((useAppStore.getState().user?.id ?? null) !== userId) return
    setLiked(track.id, liked)
    if (liked) { setLikeAnim(true); setTimeout(() => setLikeAnim(false), 600) }
  }

  const artSrc = trackArtURL(currentTrack)

  // An online song (YouTube, SoundCloud): label, and a button to save it.
  const streamed = isStreamed(currentTrack)
  const station = isStationTrack(currentTrack)

  const hasAlbum = !station && (!!currentTrack?.album || (!!isOnlineTrack(currentTrack) && !!(currentTrack?.source_album_id || currentTrack?.sourceAlbumId || currentTrack?.albumId)))
  // A radio song: its album, found online (the playing song's lookup, as for Like and Save).
  const openStationAlbum = async (target = currentTrack) => {
    if (!await navigateToRadioAlbum(nav, target)) showToast(t("Couldn't find this song's album"))
  }
  const handleTitleClick = (target = currentTrack) => {
    if (!target?.album && !target?.source_album_id && !target?.sourceAlbumId && !target?.albumId) return
    navigateToTrackAlbum(nav, target)
  }

  const openCurrentTrackFolder = async (target = currentTrack) => {
    const root = peekSettings()?.music_folder || (await api.getSettings())?.music_folder
    const relativePath = folderPathForTrack(target?.file_path, root)
    if (relativePath === null) return
    nav('/library', { state: { openFolder: relativePath } })
  }

  const replaceArtwork = async (target) => {
    if (!api.isElectron || !target?.id || !target.file_path || String(target.file_path).startsWith('ghost://')) return
    try {
      const fp = await api.openFile([{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }])
      if (!fp) return
      const dataUrl = await api.readFileAsDataURL(fp)
      const updatedTrack = await api.trackSetArtwork(target.id, dataUrl)
      if (updatedTrack?.error) { showToast(updatedTrack.error); return }
      if (updatedTrack?.id) {
        usePlayerStore.getState().syncTrack(updatedTrack)
        window.dispatchEvent(new Event('lokal:refresh'))
        showToast(t('Artwork updated!'))
      }
    } catch (error) {
      showToast(error?.message || t('Could not replace artwork'))
    }
  }

  const openTrackMenu = (event) => {
    if (!currentTrack) return
    const target = currentTrack
    const targetIsStation = isStationTrack(target)
    const targetIsStationSong = targetIsStation && !!target.song_key
    const targetStreamed = isStreamed(target)
    const targetLocal = !targetIsStation && !targetStreamed && !!target.file_path && !String(target.file_path).startsWith('ghost://')
    const targetHasAlbum = !!(target.album || target.source_album_id || target.sourceAlbumId || target.albumId)
    const mappedStationLikeId = targetIsStationSong ? stationLikeId[target.song_key] : null
    const targetLiked = targetIsStationSong
      ? mappedStationLikeId != null && likedIds.has(mappedStationLikeId)
      : target.id != null && likedIds.has(target.id)
    const shouldPlay = !isPlaying
    menu.open(event, [
      { label: isPlaying ? 'Pause' : 'Play', icon: isPlaying ? Pause : Play, onSelect: () => {
        const state = usePlayerStore.getState()
        if (state.isPlaying !== shouldPlay) state.togglePlay()
      } },
      !targetIsStation && { label: 'Play next', icon: Clock, onSelect: () => playNextMany([target]) },
      !targetIsStation && { label: 'Add to queue', icon: ListEnd, onSelect: () => addToQueueMany([target]) },
      !targetIsStation && { label: 'Add to playlist…', icon: Plus, onSelect: () => openAddToPlaylist(target) },
      (targetIsStationSong || !targetIsStation) && { label: targetLiked ? 'Remove from Liked Songs' : 'Like', icon: Heart, onSelect: () => toggleLike(target, !targetLiked) },
      targetIsStationSong && { label: 'Go to album', icon: Disc3, onSelect: () => openStationAlbum(target) },
      !targetIsStation && targetHasAlbum && { label: 'Go to album', icon: Disc3, onSelect: () => navigateToTrackAlbum(nav, target) },
      targetStreamed && !targetIsStation && { label: 'Save to library / Find another source…', icon: Download, onSelect: () => window.dispatchEvent(new CustomEvent('lokal:open-save-source-menu', { detail: { key: target.id } })) },
      targetIsStationSong && { label: 'Save to library / Find another source…', icon: Download, onSelect: () => window.dispatchEvent(new CustomEvent('lokal:open-save-source-menu', { detail: { key: target.song_key } })) },
      atmosDownloadRef(target) && { label: 'Download Dolby Atmos', icon: Download, onSelect: async () => {
        const response = await downloadAtmosVersion(target).catch(error => ({ error: error.message }))
        showToast(response?.error || 'Dolby Atmos download queued.')
      } },
      !targetIsStation && losslessMenuItem(target, Gem),
      targetLocal && { label: 'Edit info', icon: Edit2, onSelect: () => setEditingTrack(target) },
      targetLocal && api.isElectron && { label: 'Replace artwork', icon: Camera, onSelect: () => replaceArtwork(target) },
      targetLocal && api.isElectron && { label: 'Open in file manager', icon: FolderOpen, onSelect: () => api.showItemInFolder(target.file_path) },
      !targetIsStation && target.file_path && !String(target.file_path).startsWith('ghost://') && { label: 'Open folder in Library', icon: FolderOpen, onSelect: () => openCurrentTrackFolder(target) },
      !targetIsStation && { label: 'Start radio', icon: Radio, onSelect: () => openRadio(nav, target, user?.id) },
      target.artist && { label: 'Start artist radio', icon: Radio, onSelect: () => openRadio(nav, { artist: target.artist, type: 'artist' }, user?.id) },
    ].filter(Boolean))
  }

  // The playing song's audio quality, when it's been read (not for streams).
  // Casting: the device it plays on (the chip under the artist).
  const castActive = usePlayerStore(s => s.castActive)
  // Playing a Flow: the play button takes the Flow orb's colours (Home → Flow).
  const flowPlaying = usePlayerStore(s => s.playbackContext?.type === 'flow')
  const castStatusDevice = useCastStore(s => s.status?.device)
  const castDevice = castActive ? castStatusDevice : null
  const nativeAtmos = currentTrack?.atmosNative === true
  // Native output status is distinct from a search result's Atmos availability.
  // The active output backend has received the original JOC stream, while a
  // library file is tagged Atmos only after ffprobe confirms its JOC profile.
  const qualityTier = currentTrack && !station
    ? nativeAtmos ? 'atmos' : isSuspect(currentTrack) ? 'suspect' : tierOf(currentTrack)
    : 'unknown'
  const quality = qualityTier !== 'unknown'
    ? { info: TIERS[qualityTier], format: nativeAtmos ? 'E-AC-3 JOC' : formatLabel(currentTrack) }
    : null
  const qualityDisplay = quality && qualityTagLabel(currentTrack, qualityTier, fullResolutionTags)
  const displayedRadioCodec = stationInfo?.codec || currentTrack?.station?.codec || ''
  const displayedRadioBitrate = Number(stationInfo?.bitrate) || Number(currentTrack?.station?.bitrate) || 0
  const stationQuality = station && (displayedRadioCodec || displayedRadioBitrate)
    ? [displayedRadioCodec, currentTrack?.station?.lossless ? 'Lossless' : displayedRadioBitrate > 0 ? displayedRadioBitrate + ' kbps' : ''].filter(Boolean).join(' · ')
    : ''
  const nativeAtmosHint = nativeAtmos
    ? isBuffering || !isPlaying
      ? 'Dolby Atmos source selected; native output not yet playing.'
      : currentTrack.atmosMode === 'headphones'
        ? 'E-AC-3 JOC playing through Windows native headphones. Spatial object rendering is not independently verified.'
        : 'E-AC-3 JOC is playing over native HDMI passthrough.'
    : null

  return (
    <>
      {/* Glass (Settings > Appearance > Player Bar), like the downloads popup:
          a card floating over the bottom of the pages, which scroll on
          underneath it (App leaves --player-space for it). Off: the plain
          strip below the pages. */}
      <div data-player-bar onContextMenu={openTrackMenu} className={glass
        ? 'absolute inset-x-3 bottom-3 z-30 h-20 rounded-2xl border border-white/10 flex items-center px-4 gap-4 shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-lg backdrop-saturate-150'
        : 'h-20 border-t border-border flex items-center px-4 gap-4 flex-shrink-0 z-10'}
        style={glass ? { backgroundColor: 'rgba(var(--surface-rgb), 0.55)' } : { backgroundColor: 'rgba(var(--surface-rgb), 0.9)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-3 w-[370px] max-[1360px]:w-[320px] min-w-0">
        <button onClick={toggleFullscreen} disabled={!currentTrack}
          className="relative w-12 h-12 rounded-md overflow-hidden flex-shrink-0 bg-elevated hover:ring-2 ring-accent/30 transition-all disabled:cursor-default">
          {/* Not "wait": with the window minimized no animation runs, and a
              wait for an exit that never finishes left the old song's cover
              (and title) up for good while songs changed. Layers crossfade. */}
          <AnimatePresence initial={false}>
            {artSrc ? (
              <motion.img key={station ? artSrc : currentTrack?.id} src={artSrc}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-subtle text-xl">♪</div>
            )}
          </AnimatePresence>
        </button>

        <div className="min-w-0 w-[136px] flex-shrink-0">
          {/* The new song's title in at once (fading in), never waiting on the old one's way out. */}
            <motion.div key={currentTrack?.id||'none'} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
              <div className="flex items-center gap-2 min-w-0">
                <MarqueeText className="flex-1 min-w-0">
                  {hasAlbum || stationSongKnown ? (
                    <button
                      onClick={hasAlbum ? () => handleTitleClick() : () => openStationAlbum()}
                      onContextMenu={openTrackMenu}
                      title={hasAlbum ? `Go to album: ${currentTrack.album || t('Album · Online')}` : t('Go to album')}
                      className="text-sm font-medium text-text hover:text-accent hover:underline transition-colors text-left">
                      {currentTrack.title}
                    </button>
                  ) : (
                    <span onContextMenu={openTrackMenu} className="text-sm font-medium text-text">{currentTrack?.title || '—'}</span>
                  )}
                </MarqueeText>
                {!!currentTrack?.explicit && (
                  <span className="px-1.5 py-0.5 rounded border border-border bg-card text-[10px] font-display uppercase tracking-wide text-muted flex-shrink-0">
                    E
                  </span>
                )}
              </div>
              {currentTrack ? (
                <div className="min-w-0">
                  <MarqueeText className="text-xs text-muted">
                    <TrackArtistLinks track={currentTrack} nav={nav} keepCommaArtists={keepCommaArtists} onContextMenu={openTrackMenu}
                      linkClassName="text-xs text-muted hover:text-accent transition-colors text-left" />
                  </MarqueeText>
                  {castDevice && (
                    // Casting: where it plays; a click opens the Cast menu.
                    <button onClick={() => window.dispatchEvent(new Event('lokal:open-cast-menu'))}
                      title={`Playing on ${castDevice.name}`}
                      className="mt-1 flex max-w-full items-center gap-1 text-[9px] font-display uppercase tracking-wider text-accent hover:opacity-80">
                      <Cast size={10} className="flex-shrink-0" aria-hidden="true" />
                      <span className="truncate">Playing on {castDevice.name}</span>
                    </button>
                  )}
                  {streamed && !castDevice && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span title={`Streaming from ${streamLabel(currentTrack)}, not in your library`} className="text-[9px] font-display uppercase tracking-wider text-accent">
                        {streamLabel(currentTrack)}
                      </span>
                      {quality && <span title={nativeAtmosHint || `Source-reported catalogue quality: ${quality.info.label}${quality.format ? ` (${quality.format})` : ''}. Actual stream may differ.`}
                        className={`inline-block max-w-[200px] truncate align-middle rounded-full border px-1.5 py-px text-[9px] font-semibold ${quality.info.className}`}>
                        {qualityDisplay}
                      </span>}
                    </div>
                  )}
                  {station && (
                    <span className="mt-1 block truncate text-[9px] font-display uppercase tracking-wider text-accent"
                      title={t('Live radio station: {station}', { station: currentTrack.station?.title || currentTrack.title })}>
                      {t('Live radio')} · {currentTrack.station?.title || currentTrack.title}
                    </span>
                  )}
                  {station && stationQuality && (
                    <span className="mt-0.5 block truncate text-[10px] font-medium text-muted"
                      title={stationInfo?.codec ? 'Codec reported by the live stream; bitrate may be directory-reported.' : 'Directory-reported stream quality; actual bitrate may differ.'}>
                      {stationQuality}
                    </span>
                  )}
                </div>
              ) : <p className="text-xs text-muted">{t("No track playing")}</p>}
              {quality && !streamed && (
                // The Audio Quality page's pill (same colours), what it means on hover.
                <button onClick={() => nav('/quality', { state: { tier: qualityTier } })}
                  title={`${quality.info.label}: ${quality.info.desc}${quality.format ? ` (${quality.format})` : ''}${quality.info.hint ? `\n${quality.info.hint}` : ''}`}
                  aria-label={`${fullResolutionTags && qualityDisplay !== quality.info.label ? 'Audio resolution' : 'Audio quality'}: ${qualityDisplay}, ${quality.info.desc}`}
                  className={`mt-1 block w-fit max-w-[200px] truncate rounded-full border px-1.5 py-px text-[9px] font-semibold leading-[14px] tracking-wide transition-opacity hover:opacity-80 ${quality.info.className}`}>
                  {qualityDisplay}
                </button>
              )}
            </motion.div>
        </div>

        <div className="flex h-5 w-[99px] flex-shrink-0 items-center gap-3">
          {currentTrack && (!station || stationSongKnown) && (
            <div className="relative flex-shrink-0">
              <motion.button onClick={() => toggleLike()} whileTap={{ scale: 0.75 }}
                className={`flex h-5 w-5 items-center justify-center leading-none transition-colors ${isLiked ? 'text-accent' : 'text-text/90 hover:text-text'}`}
                title={isLiked ? t("Unlike") : t("Like")} aria-label={isLiked ? t("Unlike") : t("Like")}>
                <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
              </motion.button>
              <AnimatePresence>
                {likeAnim && (
                  <motion.div initial={{ scale: 0.5, opacity: 1 }} animate={{ scale: 2.8, opacity: 0 }} exit={{}}
                    transition={{ duration: 0.5 }}
                    className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <Heart size={16} className="text-accent" fill="currentColor" />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
          {currentTrack && !station && (
            <button onClick={() => openAddToPlaylist(currentTrack)} title={t("Add to playlist")} aria-label={t("Add to playlist")}
              className="flex-shrink-0 text-text/90 hover:text-accent transition-colors">
              <Plus size={14} />
            </button>
          )}
          {currentTrack && !station && (
            <button type="button" onClick={() => setShowAudioPipeline(true)} title={t("Audio Pipeline")}
              aria-label={t("Audio Pipeline")} aria-haspopup="dialog"
              className="flex-shrink-0 text-text/90 hover:text-accent transition-colors">
              <AudioWaveform size={15} />
            </button>
          )}
          {streamed && <SaveToLibraryButton key={currentTrack.id} track={currentTrack} openMenuOnEvent openMenuEventKey={currentTrack.id} className="text-text/90" />}
          {stationSongKnown && <SaveToLibraryButton key={currentTrack.song_key} getTrack={() => resolveStationSong(currentTrack)} meta={{ title: currentTrack.title, artist: currentTrack.artist }} openMenuOnEvent openMenuEventKey={currentTrack.song_key} className="text-text/90" />}
        </div>
        </div>

        <div className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
        <div className="relative flex items-center gap-4">
          {/* Beside the buttons (not over the seek bar), without moving them. */}
          <MixingMark className="absolute left-full top-1/2 ml-4 -translate-y-1/2 whitespace-nowrap pointer-events-none" />
          <button onClick={toggleShuffle} className={`transition-colors ${shuffle ? 'text-accent' : 'text-text/90 hover:text-text'}`} title={shuffle ? t("Shuffle on") : t("Shuffle off")}><Shuffle size={15} /></button>
          <button onClick={prev} className="text-text/90 hover:text-text transition-colors" title={t("Previous")}><SkipBack size={18} fill="currentColor" /></button>
          <motion.button onClick={togglePlay} disabled={!currentTrack} whileTap={{ scale: 0.88 }}
            className={`w-9 h-9 rounded-full flex items-center justify-center hover:scale-105 transition-transform disabled:opacity-40 ${flowPlaying ? 'flow-play' : 'bg-accent text-base'}`}>
            {isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="translate-x-0.5" />}
          </motion.button>
          <button onClick={next} className="text-text/90 hover:text-text transition-colors" title={t("Next")}><SkipForward size={18} fill="currentColor" /></button>
          <button onClick={toggleRepeat} className={`transition-colors ${repeat !== 'none' ? 'text-accent' : 'text-text/90 hover:text-text'}`} title={t(repeat === 'none' ? 'Repeat off' : repeat === 'one' ? 'Repeat one' : 'Repeat all')}><RepeatIcon size={15} /></button>
        </div>
        <div className="relative flex items-center gap-2 w-full max-w-md">
          <span className="text-xs text-muted w-8 text-right font-display">{station && !duration ? '' : fmt(display)}</span>
          <div className={`flex-1 h-1 bg-elevated rounded-full group relative overflow-hidden ${station ? 'cursor-default' : 'cursor-pointer'}`}
            onMouseMove={station ? undefined : handleScrub}
            onMouseDown={station ? undefined : e => { scrubbing.current = true; handleScrub(e) }}
            onMouseUp={station ? undefined : () => { scrubbing.current = false; setLocalProg(null) }}
            onMouseLeave={station ? undefined : () => { if (!scrubbing.current) setLocalProg(null) }}>
            <div className="h-full bg-accent rounded-full relative" style={{ width: `${duration ? (display/duration)*100 : 0}%` }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            {isBuffering && (streamed || station) && (
              <div role="progressbar" aria-label={t("Loading track")} className="absolute inset-0 overflow-hidden rounded-full bg-elevated">
                <div className="queue-loading-seekbar h-full w-1/3 rounded-full bg-accent" />
              </div>
            )}
          </div>
          <span className="text-xs text-muted w-8 font-display">{station && !duration ? '' : fmt(duration)}</span>
        </div>
        </div>

        <div className="flex items-center gap-2 w-[370px] max-[1360px]:gap-1.5 min-w-0 justify-end">
          {currentTrack && visualizerMode !== 'off' && (
            <div className="relative flex h-7 min-w-0 shrink basis-[120px] items-center justify-center overflow-hidden max-[1360px]:hidden">
              {['spectrum', 'spectrumCenter'].includes(visualizerMode) ? <Spectrum isPlaying={isPlaying} bars={39} barWidth={2} height={24} strength={0.8} color="accent" opacity={0.8} className="max-w-full" /> :
               visualizerMode === 'waves' ? <Waves isPlaying={isPlaying} width={120} height={26} strength={1} colorBack="accent" colorFront="#ffffff" opacity={0.72} className="max-w-full" /> :
               visualizerMode === 'lightning' ? <Lightning isPlaying={isPlaying} strength={0.8} opacity={0.75} className="h-7 w-[120px]" /> :
               <Waveform isPlaying={isPlaying} className="w-full" />}
            </div>
          )}
          <button onClick={toggleLyricsButton} className={`transition-[color,transform] hover:scale-110 focus-visible:text-accent ${(exclusiveSidePanels ? (showRightSidebar && sidePanelView === 'lyrics') : showLyricsPanel) ? 'text-accent' : 'text-text/90 hover:text-accent'}`} title={t("Lyrics")}><Mic2 size={16} /></button>
          <button onClick={() => setShowEqualizer(true)} aria-label={t('Equalizer')} title={t('Equalizer')} aria-haspopup="dialog" className="text-text/90 hover:text-accent transition-[color,transform] hover:scale-110 focus-visible:text-accent"><SlidersHorizontal size={16}/></button>
          {!castDevice && <AudioOutputPicker />}
          <button onClick={toggleQueueButton} className={`transition-[color,transform] hover:scale-110 focus-visible:text-accent ${(exclusiveSidePanels ? (showRightSidebar && sidePanelView === 'queue') : showQueue) ? 'text-accent' : 'text-text/90 hover:text-accent'}`} title={t("Queue")}><ListMusic size={16} /></button>
          <button onClick={toggleRightSidebar} className={`transition-[color,transform] hover:scale-110 focus-visible:text-accent ${showRightSidebar ? 'text-accent' : 'text-text/90 hover:text-accent'}`} title={t("Now Playing")}>< PanelRight size={16} /></button>
          <button onClick={toggleMiniPlayer} disabled={!currentTrack} className="text-text/90 hover:text-accent transition-[color,transform] hover:scale-110 focus-visible:text-accent disabled:opacity-30" title={t("Mini Player")}><Radio size={15} /></button>
          <button onClick={toggleFullscreen} disabled={!currentTrack} className="text-text/90 hover:text-accent transition-[color,transform] hover:scale-110 focus-visible:text-accent disabled:opacity-30" title={t("Fullscreen")}><Maximize2 size={15} /></button>
          
          <div className="relative flex items-center justify-center">
            <button 
              onClick={() => setShowSleepTimer(!showSleepTimer)} 
              className={`flex items-center justify-center transition-[color,transform] hover:scale-110 focus-visible:text-accent ${sleepTimerEndTime ? 'text-accent' : 'text-text/90 hover:text-accent'}`} 
              title={sleepTimerEndTime ? `${t("Sleep Timer")}: ${sleepTimerDisplay}` : t("Sleep Timer")}
            >
              <Moon size={16} />
            </button>
            {sleepTimerEndTime && (
              <span className="absolute -top-2 -right-3 text-[8px] text-accent font-mono bg-surface px-1 rounded-full">
                {sleepTimerDisplay}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-1.5 ml-1">
            <button onClick={() => setVolume(volume > 0 ? 0 : 0.8)} className="text-text/90 hover:text-accent transition-[color,transform] hover:scale-110 focus-visible:text-accent">
              {volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <input ref={volumeWheelRef} type="range" min={0} max={1} step={0.01} value={volume}
              onChange={e => setVolume(parseFloat(e.target.value))}
              className="w-18 accent-accent cursor-pointer h-1" style={{ width: 72 }} />
          </div>
        </div>
      </div>

      <EqualizerModal open={showEqualizer} onClose={() => setShowEqualizer(false)} />
      <Modal open={showSleepTimer} onClose={() => setShowSleepTimer(false)} title={t("Sleep Timer")} width="max-w-xs">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Music will stop after the selected time. Use this if you would like the app to stop while you are sleeping. 
          </p>
          
          <div className="grid grid-cols-2 gap-2">
            {[5, 10, 15, 30, 45, 60].map(mins => (
              <button
                key={mins}
                onClick={() => { setSleepTimer(mins); setShowSleepTimer(false) }}
                className={`py-2.5 px-3 rounded-lg text-sm font-medium transition-colors ${
                  sleepTimerMinutes === mins 
                    ? 'bg-accent text-base' 
                    : 'bg-card border border-border text-muted hover:text-white hover:border-accent/30'
                }`}
              >
                {mins} min
              </button>
            ))}
          </div>
          
          {sleepTimerEndTime && (
            <div className="pt-3 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-sm text-accent">Timer active: {sleepTimerDisplay}</span>
                <button 
                  onClick={() => { cancelSleepTimer(); setShowSleepTimer(false) }}
                  className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                >
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          )}
          
          <button 
            onClick={() => setShowSleepTimer(false)}
            className="w-full py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors"
          >
            Close
          </button>
        </div>
      </Modal>
      <AudioPipelineModal open={showAudioPipeline} onClose={() => setShowAudioPipeline(false)} track={currentTrack} />
      <TrackEditModal track={editingTrack} open={!!editingTrack} onClose={() => setEditingTrack(null)}
        onSave={updatedTrack => {
          if (!updatedTrack?.id) return
          usePlayerStore.getState().syncTrack(updatedTrack)
          setEditingTrack(updatedTrack)
          window.dispatchEvent(new Event('lokal:refresh'))
        }} />
      <ContextMenu menu={menu} />
    </>
  )
}
