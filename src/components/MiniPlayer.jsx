import { useTranslation } from '../i18n'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Play, Pause, SkipBack, SkipForward, X, Volume2, VolumeX, Heart, Clapperboard, Gamepad2, Minimize2, Maximize2, ChevronLeft, ChevronRight } from 'lucide-react'
import { usePlayerStore, useAppStore } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { api, peekSettings, wordSyncEnabled as getWordSyncEnabled } from '../api'
import Waveform from './Waveform'
import { useAppearanceFlag } from '../appearanceFlags'
import { trackArtURL, isStreamed } from '../onlineTracks'
import StreamArtwork from './StreamArtwork'
import { useMusicVideo, useMusicVideoView } from '../musicVideo'
import MusicVideoPlayer from './MusicVideoPlayer'
import VideoOffsetControl from './VideoOffsetControl'
import { useVolumeWheel } from '../volumeWheel'
import MilkDrop from '../visualizers/MilkDrop'
import { loadMilkDropPresetNames, normalizeEnabledMilkDropPresets } from '../visualizers/milkDropPresets.mjs'

function fmt(s) { return `${Math.floor((s||0)/60)}:${Math.floor((s||0)%60).toString().padStart(2,'0')}` }

export default function MiniPlayer({ windowed = false }) {
  const { t } = useTranslation()
  const showWaveform = useAppearanceFlag('player_waveform')
  const {
    currentTrack, isPlaying, progress, duration, volume,
    togglePlay, next, prev, setProgressWithAudioUpdate, setVolume,
    toggleMiniPlayer, likedIds, setLiked,
    showMiniVisualizer, setShowMiniVisualizer
  } = usePlayerStore(useShallow(({
    currentTrack, isPlaying, progress, duration, volume,
    togglePlay, next, prev, setProgressWithAudioUpdate, setVolume,
    toggleMiniPlayer, likedIds, setLiked,
    showMiniVisualizer, setShowMiniVisualizer
  }) => ({
    currentTrack, isPlaying, progress, duration, volume,
    togglePlay, next, prev, setProgressWithAudioUpdate, setVolume,
    toggleMiniPlayer, likedIds, setLiked,
    showMiniVisualizer, setShowMiniVisualizer
  })))
  const { user } = useAppStore()
  const volumeWheelRef = useVolumeWheel(volume, setVolume)
  const { video: musicVideo } = useMusicVideo(currentTrack)
  const videoMode = useMusicVideoView(s => s.mini)
  const toggleVideo = useMusicVideoView(s => s.toggleMini)
  const [visualizerSettings, setVisualizerSettings] = useState(() => peekSettings() || {})
  const [availablePresets, setAvailablePresets] = useState([])
  const [currentPreset, setCurrentPreset] = useState('')
  const milkDropRef = useRef(null)
  const enabledPresets = useMemo(
    () => normalizeEnabledMilkDropPresets(visualizerSettings.fullscreen_milkdrop_presets, availablePresets),
    [visualizerSettings.fullscreen_milkdrop_presets, availablePresets],
  )

  useEffect(() => {
    if (!showMiniVisualizer) return undefined
    let live = true
    loadMilkDropPresetNames()
      .then(names => { if (live) setAvailablePresets(names) })
      .catch(error => console.warn('[mini visualizer] Could not load MilkDrop preset names:', error))
    const refresh = () => api.getSettings().then(next => {
      if (live && next && !next.error) setVisualizerSettings(next)
    }).catch(() => {})
    refresh()
    window.addEventListener('lokal:settings-saved', refresh)
    return () => {
      live = false
      window.removeEventListener('lokal:settings-saved', refresh)
    }
  }, [showMiniVisualizer])

  const cyclePreset = delta => {
    if (enabledPresets.length < 2) return
    if (delta < 0) milkDropRef.current?.previousPreset()
    else milkDropRef.current?.nextPreset()
  }

  const enterFullscreenVisualizer = async () => {
    await toggleMiniPlayer()
    if (!usePlayerStore.getState().showMiniPlayer) {
      usePlayerStore.setState({ showMiniVisualizer: false, showFullscreen: false, showFullscreenVisualizer: true })
    }
  }

  const [lyricsLines, setLyricsLines] = useState([])
  const [lyricsType, setLyricsType] = useState(null)
  const [lyricsCurrent, setLyricsCurrent] = useState('')
  const [lyricsNext, setLyricsNext] = useState('')
  const [lyricsWords, setLyricsWords] = useState([])
  const [activeWordIdx, setActiveWordIdx] = useState(-1)
  const [activeCharCount, setActiveCharCount] = useState(0)
  const [bgVars, setBgVars] = useState({
    image: '',
    blur: '0px',
    size: 'cover',
    position: 'center',
    overlay: '0.7'
  })

  const wordSyncEnabled = useMemo(() => {
    try {
      return getWordSyncEnabled()
    } catch {
      return false
    }
  }, [])

  const isLiked = currentTrack && likedIds.has(currentTrack.id)
  // The line being sung, for the video's caption.
  const lyricLine = lyricsCurrent
  const miniRootRef = useRef(null)

  // The native window resize/always-on-top toggle used to happen here, in a
  // mount/unmount effect keyed on showMiniPlayer -- but that runs AFTER
  // React has already committed and painted the swap between this component
  // and the full app UI in App.jsx, and the resize itself is an async IPC
  // round-trip on top of that. The result was a visible frame or two of the
  // wrong-size window showing the wrong-size content on every transition.
  // toggleMiniPlayer (src/store/player.js) now awaits the resize BEFORE
  // flipping showMiniPlayer, so the window is already correctly sized by
  // the time this component (or the full app UI) actually mounts.

  useEffect(() => {
    if (!windowed || !api.isElectron || !window.electron?.fitMiniHeight || !miniRootRef.current) return

    const root = miniRootRef.current
    let frame = 0
    let lastHeight = 0

    const measure = () => {
      frame = 0
      const height = Math.ceil(root.getBoundingClientRect().height)
      if (!height || height === lastHeight) return
      lastHeight = height
      window.electron.fitMiniHeight(height).catch(() => {})
    }

    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })

    observer.observe(root)
    measure()

    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [windowed])

  useEffect(() => {
    if (!currentTrack?.id) {
      setLyricsLines([])
      setLyricsType(null)
      setLyricsCurrent('')
      setLyricsNext('')
      setLyricsWords([])
      setActiveWordIdx(-1)
      setActiveCharCount(0)
      return
    }
    let active = true
    api.getLyrics(
      currentTrack.id,
      currentTrack.title,
      currentTrack.artist,
      currentTrack.album,
      currentTrack.duration,
      currentTrack.file_path
    ).then((r) => {
      if (!active) return
      if (!Array.isArray(r?.lines) || r.lines.length === 0) {
        setLyricsLines([])
        setLyricsType(null)
        setLyricsCurrent('')
        setLyricsNext('')
        setLyricsWords([])
        setActiveWordIdx(-1)
        setActiveCharCount(0)
        return
      }
      setLyricsLines(r.lines)
      setLyricsType(r.type || null)
    }).catch(() => {
      if (!active) return
      setLyricsLines([])
      setLyricsType(null)
      setLyricsCurrent('')
      setLyricsNext('')
      setLyricsWords([])
      setActiveWordIdx(-1)
      setActiveCharCount(0)
    })
    return () => { active = false }
  }, [currentTrack?.id])

  useEffect(() => {
    if (!lyricsLines.length) {
      setLyricsCurrent('')
      setLyricsNext('')
      setLyricsWords([])
      setActiveWordIdx(-1)
      setActiveCharCount(0)
      return
    }

    if (lyricsType === 'synced') {
      let idx = 0
      for (let i = 0; i < lyricsLines.length; i++) {
        if ((lyricsLines[i].time ?? 0) <= progress) idx = i
        else break
      }
      const line = lyricsLines[idx] || {}
      const nextLine = lyricsLines[idx + 1] || {}
      const words = Array.isArray(line.words) ? line.words.filter(w => w?.word) : []

      setLyricsCurrent(line.text || '')
      setLyricsNext(nextLine.text || '')
      setLyricsWords(words)

      if (!words.length) {
        setActiveWordIdx(-1)
        setActiveCharCount(0)
        return
      }

      let wIdx = 0
      for (let i = 0; i < words.length; i++) {
        const start = words[i].time ?? 0
        const end = words[i].end ?? start
        if (progress >= start || progress >= end) wIdx = i
        if (progress < start) break
      }
      setActiveWordIdx(wIdx)
      const aw = words[wIdx]
      const start = aw?.time ?? 0
      const end = aw?.end ?? start
      const denom = Math.max(0.01, end - start)
      const ratio = Math.max(0, Math.min(1, (progress - start) / denom))
      const count = Math.max(0, Math.min(aw?.word?.length || 0, Math.ceil((aw?.word?.length || 0) * ratio)))
      setActiveCharCount(count)
      return
    }

    const idx = Math.max(0, Math.min(lyricsLines.length - 1, Math.floor(progress / 4)))
    setLyricsCurrent(lyricsLines[idx]?.text || lyricsLines[0]?.text || '')
    setLyricsNext(lyricsLines[idx + 1]?.text || '')
    setLyricsWords([])
    setActiveWordIdx(-1)
    setActiveCharCount(0)
  }, [lyricsLines, lyricsType, progress])

  useEffect(() => {
    const syncBgVars = () => {
      try {
        const root = getComputedStyle(document.documentElement)
        const image = root.getPropertyValue('--bg-image').trim()
        const blur = root.getPropertyValue('--bg-blur').trim() || '0px'
        const size = root.getPropertyValue('--bg-size').trim() || 'cover'
        const position = root.getPropertyValue('--bg-position').trim() || 'center'
        const overlay = root.getPropertyValue('--bg-overlay').trim() || '0.7'
        setBgVars({ image, blur, size, position, overlay })
      } catch {}
    }
    syncBgVars()
    const id = setInterval(syncBgVars, 1200)
    return () => clearInterval(id)
  }, [])

  const artSrc = trackArtURL(currentTrack)

  const handleScrub = (e) => {
    if (!duration) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration
    setProgressWithAudioUpdate(t)
  }

  const toggleLike = async () => {
    if (!currentTrack) return
    const r = await api.toggleLike(currentTrack.id, user?.id, currentTrack)
    const liked = typeof r === 'boolean' ? r : r?.liked ?? false
    setLiked(currentTrack.id, liked)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      ref={miniRootRef}
      className={windowed
        ? 'relative w-full shrink-0 bg-transparent border border-border rounded-none shadow-none overflow-hidden'
        : 'fixed bottom-4 right-4 w-72 bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden z-50'}
    >
      {windowed && (
        <>
          <div
            className="absolute inset-0 bg-no-repeat -z-10"
            style={{
              backgroundImage: bgVars.image || (artSrc ? `url("${artSrc}")` : 'none'),
              filter: `blur(${bgVars.blur})`,
              transform: 'scale(1.05)',
              backgroundSize: bgVars.size,
              backgroundPosition: bgVars.position
            }}
          />
          <div className="absolute inset-0 bg-bg -z-10" style={{ opacity: Math.min(0.55, parseFloat(bgVars.overlay || '0.55')) }} />
          <div className="mini-dim absolute inset-0 bg-black/20 -z-10" />
        </>
      )}

      {!showMiniVisualizer && (
      <div className="flex items-center justify-between px-3 py-2 bg-surface/50 backdrop-blur-sm border-b border-white/10" style={windowed && api.isElectron ? { WebkitAppRegion: 'drag' } : undefined}>
        <span className="min-w-0 flex-1 truncate pr-2 text-xs text-muted font-medium">{videoMode && currentTrack ? <><span className="text-white/90">{currentTrack.title}</span>{currentTrack.artist ? ` · ${currentTrack.artist}` : ''}</> : 'Mini Player'}</span>
        {(musicVideo?.videoId || videoMode) && <button onClick={toggleVideo} aria-pressed={videoMode} aria-label={videoMode ? 'Show artwork' : 'Show music video'} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="inline-flex items-center gap-1 text-[10px] text-muted hover:text-white transition-colors" title={videoMode ? 'Show artwork' : 'Show music video'}><Clapperboard size={13} />{videoMode ? 'Artwork' : 'Video'}</button>}
        <button onClick={() => setShowMiniVisualizer(true)} title={t('Show visualizer')} aria-label={t('Show visualizer')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="inline-flex items-center gap-1 text-[10px] text-muted hover:text-white transition-colors"><Gamepad2 size={13} /></button>
        <button
          onClick={toggleMiniPlayer}
          className="text-muted hover:text-white transition-colors p-1"
          style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined}
        >
          <X size={14} />
        </button>
      </div>
      )}

      {showMiniVisualizer ? (
        <div className="relative h-[246px] w-full overflow-hidden bg-[#030305] text-white">
          <MilkDrop
            ref={milkDropRef}
            className="absolute inset-0 h-full w-full"
            isPlaying={isPlaying}
            trackId={currentTrack?.id}
            presetNames={enabledPresets}
            onPresetChange={setCurrentPreset}
            showNextButton={false}
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/70" />
          <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 px-3 py-2" style={windowed && api.isElectron ? { WebkitAppRegion: 'drag' } : undefined}>
            <Gamepad2 size={14} className="shrink-0 text-white/70" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-white/90">{currentTrack?.title || t('Nothing playing')}</p>
              <p className="truncate text-[10px] text-white/55">{currentTrack?.artist || currentPreset || 'MilkDrop'}</p>
            </div>
            <button onClick={() => setShowMiniVisualizer(false)} title={t('Show mini player controls')} aria-label={t('Show mini player controls')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="rounded-md p-1.5 text-white/75 hover:bg-white/15 hover:text-white"><Minimize2 size={14} /></button>
            <button onClick={enterFullscreenVisualizer} title={t('Open full-screen visualizer')} aria-label={t('Open full-screen visualizer')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="rounded-md p-1.5 text-white/75 hover:bg-white/15 hover:text-white"><Maximize2 size={14} /></button>
            <button onClick={toggleMiniPlayer} title={t('Close mini player')} aria-label={t('Close mini player')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="rounded-md p-1.5 text-white/75 hover:bg-white/15 hover:text-white"><X size={14} /></button>
          </div>
          <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-1 px-3 py-2.5">
            <button onClick={() => cyclePreset(-1)} disabled={enabledPresets.length < 2} title={t('Previous preset')} aria-label={t('Previous preset')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="rounded-full p-1.5 text-white/70 hover:bg-white/15 hover:text-white disabled:opacity-30"><ChevronLeft size={16} /></button>
            <div className="flex items-center gap-2">
              <button onClick={prev} title={t('Previous')} aria-label={t('Previous')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="p-1 text-white/85 hover:text-white"><SkipBack size={16} fill="currentColor" /></button>
              <button onClick={togglePlay} disabled={!currentTrack} title={isPlaying ? t('Pause') : t('Play')} aria-label={isPlaying ? t('Pause') : t('Play')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-black disabled:opacity-40">{isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</button>
              <button onClick={next} title={t('Next')} aria-label={t('Next')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="p-1 text-white/85 hover:text-white"><SkipForward size={16} fill="currentColor" /></button>
            </div>
            <button onClick={() => cyclePreset(1)} disabled={enabledPresets.length < 2} title={t('Next preset')} aria-label={t('Next preset')} style={windowed && api.isElectron ? { WebkitAppRegion: 'no-drag' } : undefined} className="rounded-full p-1.5 text-white/70 hover:bg-white/15 hover:text-white disabled:opacity-30"><ChevronRight size={16} /></button>
          </div>
          <div className="pointer-events-none absolute bottom-14 inset-x-0 text-center text-[10px] tracking-wide text-white/60">{currentPreset || 'MilkDrop'}</div>
        </div>
      ) : videoMode ? (
        // Video mode: just the video and its lyrics. The seek bar and the
        // controls show over it while the mouse is on it (or keyboard focus
        // is in them); a click doesn't keep them up.
        <div className="on-media group/video relative">
          <MusicVideoPlayer compact />
          {musicVideo?.videoId && <VideoOffsetControl compact videoId={musicVideo.videoId} className="absolute left-2 top-2 opacity-0 transition-opacity duration-200 group-hover/video:opacity-100 has-[:focus-visible]:opacity-100" />}
          {lyricLine && <p className={`pointer-events-none absolute inset-x-3 bottom-2.5 text-center text-[13px] font-medium leading-snug text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.9)] transition-transform duration-200 group-hover/video:-translate-y-[4.25rem] group-has-[:focus-visible]/video:-translate-y-[4.25rem]`}>{lyricLine}</p>}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-2 pt-6 opacity-0 transition-opacity duration-200 group-hover/video:opacity-100 has-[:focus-visible]:opacity-100">
            <div className="h-1 cursor-pointer rounded-full bg-white/25 outline-none focus-visible:ring-2 focus-visible:ring-accent/70" onClick={handleScrub} role="slider" tabIndex={0} aria-label={t("Seek")} aria-valuemin={0} aria-valuemax={Math.round(duration || 0)} aria-valuenow={Math.round(progress || 0)} aria-valuetext={`${fmt(progress)} of ${fmt(duration)}`}
              onKeyDown={event => {
                // Arrows step five seconds, like the main player's keys.
                if (!duration || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
                event.preventDefault()
                setProgressWithAudioUpdate(Math.min(duration, Math.max(0, (progress || 0) + (event.key === 'ArrowRight' ? 5 : -5))))
              }}>
              <div className="h-full rounded-full bg-accent" style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }} />
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="w-20 text-[10px] tabular-nums text-white/70">{fmt(progress)} / {fmt(duration)}</span>
              <div className="flex items-center gap-1">
                <button onClick={prev} aria-label={t("Previous")} className="p-1.5 text-white/80 hover:text-white"><SkipBack size={15} fill="currentColor" /></button>
                <button onClick={togglePlay} disabled={!currentTrack} aria-label={isPlaying ? 'Pause' : 'Play'} className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 disabled:opacity-40">{isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="translate-x-px" />}</button>
                <button onClick={next} aria-label={t("Next")} className="p-1.5 text-white/80 hover:text-white"><SkipForward size={15} fill="currentColor" /></button>
              </div>
              <div className="flex w-20 items-center justify-end gap-0.5">
                <button onClick={toggleLike} disabled={!currentTrack} aria-label={isLiked ? 'Unlike' : 'Like'} className={`p-1.5 disabled:opacity-40 ${isLiked ? 'text-accent' : 'text-white/80 hover:text-white'}`}><Heart size={14} fill={isLiked ? 'currentColor' : 'none'} /></button>
                <button onClick={() => setVolume(volume > 0 ? 0 : 0.8)} aria-label={volume === 0 ? 'Unmute' : 'Mute'} className="p-1.5 text-white/80 hover:text-white">{volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
              </div>
            </div>
          </div>
        </div>
      ) : <>
      <div className={`flex items-center gap-3 ${windowed ? 'p-4' : 'p-3'}`}>
        {!videoMode && <div className={`${windowed ? 'w-20 h-20' : 'w-16 h-16'} rounded-lg overflow-hidden flex-shrink-0 bg-card`}>
          {isStreamed(currentTrack) ? (
            <StreamArtwork track={currentTrack} src={artSrc} alt={t("Artwork")}
              className="w-full h-full object-cover"
              fallback={<div className="w-full h-full flex items-center justify-center text-subtle text-2xl">-</div>} />
          ) : artSrc ? (
            <img src={artSrc} alt={t("Artwork")} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-subtle text-2xl">-</div>
          )}
        </div>}

        <div className="min-w-0 flex-1">
          <p className={`${windowed ? 'text-base' : 'text-sm'} font-medium truncate text-white`}>{currentTrack?.title || '-'}</p>
          <p className={`${windowed ? 'text-sm' : 'text-xs'} text-muted truncate`}>{currentTrack?.artist || 'No track'}</p>

          {wordSyncEnabled && lyricsType === 'synced' && lyricsWords.length > 0 ? (
            <p className={`${windowed ? 'text-xs mt-1' : 'text-[10px] mt-0.5'} truncate`}>
              {lyricsWords.map((w, i) => (
                <span key={`${w.word}-${i}`} className={i <= activeWordIdx ? 'text-white/85 italic' : 'text-white/35 italic'}>
                  {/* Syllables of one word carry space:false and must stay joined. */}
                  {i > 0 && lyricsWords[i - 1]?.space !== false ? ' ' : ''}
                  {i === activeWordIdx
                    ? w.word.split('').map((ch, ci) => (
                        <span key={`${w.word}-${ci}`} className={ci < activeCharCount ? 'text-white/95' : 'text-white/45'}>
                          {ch}
                        </span>
                      ))
                    : w.word}
                </span>
              ))}
            </p>
          ) : (
            <>
              {lyricsCurrent ? <p className={`${windowed ? 'text-xs mt-1' : 'text-[10px] mt-0.5'} text-white/75 truncate italic`}>{lyricsCurrent}</p> : null}
              {lyricsNext ? <p className={`${windowed ? 'text-[11px]' : 'text-[9px]'} text-white/35 truncate italic`}>{lyricsNext}</p> : null}
            </>
          )}
        </div>
      </div>

      <div className={windowed ? 'px-4' : 'px-3'}>
        <div
          className="h-1.5 bg-elevated rounded-full cursor-pointer group"
          onClick={handleScrub}
        >
          <div
            className="h-full bg-accent rounded-full relative"
            style={{ width: `${duration ? (progress/duration)*100 : 0}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-muted mt-1">
          <span>{fmt(progress)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      {/* flex-wrap: if the mini window is resized narrower than this row's
          content needs, the groups wrap onto a second line instead of
          overflowing past the window's right edge and getting clipped. */}
      <div className={`${windowed ? 'px-4 pb-4 pt-3' : 'px-3 pb-3 pt-2'} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setVolume(volume > 0 ? 0 : 0.8)}
            className="text-muted hover:text-white transition-colors p-2"
          >
            {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button
            onClick={toggleLike}
            disabled={!currentTrack}
            className={`transition-colors p-2 disabled:opacity-40 ${isLiked ? 'text-accent' : 'text-muted hover:text-white'}`}
          >
            <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={prev}
            className="text-muted hover:text-white transition-colors p-2"
          >
            <SkipBack size={18} fill="currentColor" />
          </button>

          <button
            onClick={togglePlay}
            disabled={!currentTrack}
            className="w-10 h-10 bg-accent text-base rounded-full flex items-center justify-center hover:scale-105 transition-transform disabled:opacity-40"
          >
            {isPlaying ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" className="translate-x-0.5" />
            )}
          </button>

          <button
            onClick={next}
            className="text-muted hover:text-white transition-colors p-2"
          >
            <SkipForward size={18} fill="currentColor" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {currentTrack && showWaveform && (
            <div className={windowed ? 'w-12 h-4' : 'w-10 h-4'}>
              <Waveform
                isPlaying={isPlaying}
                barCount={windowed ? 18 : 14}
                defaultWidth={windowed ? 48 : 40}
                defaultHeight={16}
              />
            </div>
          )}
          <input
            ref={volumeWheelRef}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className={windowed ? 'w-24 accent-accent cursor-pointer h-1' : 'w-16 accent-accent cursor-pointer h-1'}
          />
        </div>
      </div>
      </>}
    </motion.div>
  )
}
