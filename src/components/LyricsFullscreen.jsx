import { useTranslation } from '../i18n'
import React, { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Download, RotateCcw, Search, Disc3, Expand, Minimize } from 'lucide-react'
import { usePlayerStore } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import LyricsPanel from './LyricsPanel'
import SearchDrawer from './LyricsSearchDrawer'
import { api, wordSyncEnabled } from '../api'
import { trackFullArtURL } from '../onlineTracks'
import { announceLyricsChanged } from '../lyricLine'
import { showToast } from './Toaster'

// How the player and full-screen lyrics trade places (FullscreenPlayer uses
// these too): the view being left fades out quickly, the one arriving fades in
// just after (so the two sets of text never sit on top of each other), and the
// cover flies between them over the whole switch.
export const FULLSCREEN_SWITCH = { duration: 0.42, ease: [0.22, 1, 0.36, 1] }
export const FULLSCREEN_OUT = { duration: 0.18, ease: [0.4, 0, 1, 1] }
export const FULLSCREEN_IN = { duration: 0.34, delay: 0.1, ease: [0.22, 1, 0.36, 1] }

// Full-screen lyrics is a layout of the full-screen player, not an overlay of
// its own: FullscreenPlayer renders this over its (shared) backdrop and keeps
// it mounted -- lyrics loaded and following the song -- the whole time it's
// open, so switching is only a crossfade (nothing to fetch or build at the
// click). The cover flies into this header's cover (data-fullscreen-thumb).
// The player owns the idle timer and the whole-screen state: after a few
// seconds without the mouse moving, this header and the lyrics' buttons fade
// out and the cursor hides, as in the player.
export default function LyricsFullscreen({ idle = false, onChromeHover = null, screenFull = false, onToggleScreen = null }) {
  const { t } = useTranslation()
  const { showLyricsFullscreen, toggleLyricsFullscreen, switchFullscreenView, currentTrack, progress } = usePlayerStore(useShallow(({ showLyricsFullscreen, toggleLyricsFullscreen, switchFullscreenView, currentTrack, progress }) => ({ showLyricsFullscreen, toggleLyricsFullscreen, switchFullscreenView, currentTrack, progress })))
  const [refreshKey, setRefreshKey] = useState(0)
  const [showSearch, setShowSearch] = useState(false)
  const [searchSessions, setSearchSessions] = useState({})
  const [settings, setSettings] = useState({})
  const wordSync = wordSyncEnabled()
  const active = showLyricsFullscreen
  // Faded out (opacity 0, not visibility: hidden: that would drop what's
  // drawn and make switching back redraw every line on its first frame), the
  // lyrics keep following the song, so they're in place when it shows.
  const layerRef = useRef(null)
  useLayoutEffect(() => { if (layerRef.current) layerRef.current.inert = !active }, [active])
  useEffect(() => { if (!active) setShowSearch(false) }, [active])

  // LyricsFullscreen stays mounted as long as the full-screen player overlay
  // (it just hides its own JSX), so a settings fetch
  // tied to mount only ever ran once at startup -- toggling and saving
  // Unsynced Lyrics Auto-Sync later in Settings never updated this component,
  // and lyrics kept auto-syncing (or not) based on whatever was cached at
  // launch. Re-fetching whenever the overlay actually opens picks up the
  // current saved value.
  // (Also on mount: the layer is ready, hidden, while the player shows.)
  useEffect(() => {
    api.getSettings().then(s => setSettings(s || {}))
  }, [showLyricsFullscreen])

  // This overlay can now be reached from inside FullscreenPlayer (its Expand
  // Lyrics button), where it renders on top of that other fullscreen view --
  // without its own Escape handler, FullscreenPlayer's Escape listener (bound
  // whenever *it's* open, regardless of what's stacked on top) was the only
  // one that fired, closing the player underneath instead of just this panel.
  useEffect(() => {
    // The search drawer sits on top of this overlay, so Escape closes it
    // first; otherwise showSearch stays true and the drawer reappears the
    // next time the overlay opens.
    const h = (e) => {
      if (e.key !== 'Escape') return
      if (showSearch) setShowSearch(false)
      else toggleLyricsFullscreen()
    }
    if (showLyricsFullscreen) document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [showLyricsFullscreen, toggleLyricsFullscreen, showSearch])

  const importLyrics = async () => {
    if (!currentTrack || !api.isElectron) return
    try {
      const fp = await api.openFile([{ name: 'Lyrics', extensions: ['lrc', 'elrc', 'txt', 'ttml', 'xml'] }])
      if (!fp) return
      const content = await api.readFileBinary(fp)
      if (!content?.trim()) throw new Error('This lyrics file is empty.')
      const ext = fp.split('.').pop().toLowerCase()
      const type = ext === 'ttml' || ext === 'xml' ? 'ttml' : ext === 'elrc' ? 'elrc' : ext === 'lrc' ? 'lrc' : 'txt'
      const imported = await api.importLyrics(currentTrack.id, content, type)
      if (!imported?.lines?.length) throw new Error('The selected lyrics file could not be parsed.')
      announceLyricsChanged(currentTrack.id)
      setRefreshKey(k => k + 1)
    } catch (error) {
      showToast(error?.message || 'Could not import lyrics.')
    }
  }

  const artSrc = trackFullArtURL(currentTrack)

  const handleSearchRequest = () => {
    setShowSearch(true)
  }

  const activeSearchSession = currentTrack?.id
    ? searchSessions[currentTrack.id] || {
        title: currentTrack?.title || '',
        artist: currentTrack?.artist || '',
        results: [],
        loading: false,
        error: null,
      }
    : null

  const updateSearchSession = (patch) => {
    if (!currentTrack?.id) return
    setSearchSessions(prev => ({
      ...prev,
      [currentTrack.id]: {
        ...(prev[currentTrack.id] || {
          title: currentTrack?.title || '',
          artist: currentTrack?.artist || '',
          results: [],
          loading: false,
          error: null,
        }),
        ...patch,
      },
    }))
  }

  const isAutoSynced = settings.unsynced_auto_sync === '1'
  // Not while the lyrics search is open.
  const hidden = active && idle && !showSearch

  return (
        <motion.div
          ref={layerRef}
          initial={false}
          animate={{ opacity: active ? 1 : 0 }}
          transition={active ? FULLSCREEN_IN : FULLSCREEN_OUT}
          aria-hidden={active ? undefined : true}
          // Hidden, the cursor goes too, over the clickable lines as well.
          className={`absolute inset-0 z-20 flex flex-col overflow-hidden ${hidden ? 'cursor-none [&_*]:!cursor-none' : ''}`}
          style={{ pointerEvents: active ? undefined : 'none' }}
        >
          <div className={`relative z-10 flex items-center justify-between px-8 py-5 flex-shrink-0 transition-opacity duration-300 ${hidden ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
            inert={hidden}
            onMouseEnter={() => onChromeHover?.(true)}
            onMouseLeave={() => onChromeHover?.(false)}>
            <div className="flex items-center gap-4">
              {artSrc && (
                // The player's big cover flies into this one (and back), and
                // clicking it goes back to the player, like the Player button.
                <button type="button" onClick={() => switchFullscreenView('player')}
                  title={t("Switch to the full-screen player")} aria-label={t("Back to the full-screen player")}
                  className="flex-shrink-0 rounded-lg transition-transform hover:scale-105 active:scale-95">
                  <img data-fullscreen-thumb src={artSrc} alt=""
                    className="w-10 h-10 rounded-lg object-cover border border-white/10" />
                </button>
              )}
              <div>
                <p className="text-xs font-display text-white/30 uppercase tracking-widest">{t("Lyrics")}</p>
                {currentTrack && <p className="text-sm text-white/60 mt-0.5 truncate max-w-sm">{currentTrack.title} — {currentTrack.artist}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {currentTrack && (
                <button onClick={() => switchFullscreenView('player')} title={t("Switch to the full-screen player")}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/40 hover:text-white border border-white/10 hover:border-white/30 rounded-lg transition-colors">
                  <Disc3 size={12} /> {t("Player")}
                </button>
              )}
              {currentTrack && (
                <button onClick={() => setShowSearch(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/40 hover:text-white border border-white/10 hover:border-white/30 rounded-lg transition-colors">
                  <Search size={12} /> {t("Search")}
                </button>
              )}
              {api.isElectron && currentTrack && (
                <>
                  <button onClick={importLyrics}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/40 hover:text-white border border-white/10 hover:border-white/30 rounded-lg transition-colors">
                    <Download size={12} /> {t("Import .lrc / .elrc / .ttml")}
                  </button>
                  <button onClick={() => { api.clearLyricsCache(currentTrack.id); setRefreshKey(k => k + 1) }}
                    className="p-1.5 text-white/30 hover:text-white transition-colors rounded-lg hover:bg-white/8">
                    <RotateCcw size={14} />
                  </button>
                </>
              )}
              {onToggleScreen && (
                <button onClick={onToggleScreen} title={screenFull ? 'Exit full screen' : 'Fill the whole screen'} aria-label={screenFull ? 'Exit full screen' : 'Fill the whole screen'}
                  className="p-1.5 text-white/30 hover:text-white transition-colors">
                  {screenFull ? <Minimize size={16} /> : <Expand size={16} />}
                </button>
              )}
              <button onClick={toggleLyricsFullscreen} className="p-1.5 text-white/30 hover:text-white transition-colors">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="relative z-10 flex-1 min-h-0">
            <LyricsPanel
              key={`${currentTrack?.id}-${refreshKey}`}
              track={currentTrack}
              progress={progress}
              darkMode
              fullscreen
              wordSync={wordSync}
              active={active}
              onSearchRequest={handleSearchRequest}
              textScale={1.15}
              isAutoSynced={isAutoSynced}
              toolbarHidden={hidden}
            />
          </div>

          <AnimatePresence>
            {showSearch && currentTrack && (
              <SearchDrawer
                track={currentTrack}
                session={activeSearchSession}
                onSessionChange={updateSearchSession}
                onClose={() => setShowSearch(false)}
                onSelect={(lyrics, type) => {
                  const trackId = currentTrack.id
                  setShowSearch(false)
                  Promise.resolve(api.importLyrics(trackId, lyrics, type)).then(imported => {
                    if (!imported?.lines?.length) throw new Error('No usable lyrics were found.')
                    announceLyricsChanged(trackId)
                    if (usePlayerStore.getState().currentTrack?.id === trackId) setRefreshKey(k => k + 1)
                  }).catch(error => showToast(error?.message || 'Could not import lyrics.'))
                }}
              />
            )}
          </AnimatePresence>
        </motion.div>
  )
}
