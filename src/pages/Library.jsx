import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { LayoutGrid, List, Music, Search, X, Clock, Shuffle, Play, FolderPlus, Loader2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/player'
import TrackList from '../components/TrackList'
import FadeImg from '../components/FadeImg'
import ScanBanner from '../components/ScanBanner'
import LibraryFolderBrowser from '../components/LibraryFolderBrowser'
import { api } from '../api'
import { useCachedState, usePageReady } from '../pageCache'
import { useTranslation } from '../i18n'
import { showToast } from '../components/Toaster'
import { playNextMany } from '../trackActions'
import { fetchAllTrackPages, shuffledLibraryTracks } from '../libraryHelpers'

const LIBRARY_PAGE_SIZE = 50
const PLAYBACK_FETCH_PAGE_SIZE = 5000
const HEAVY_GRID_THRESHOLD = 80
const readLibraryPreference = (key, fallback, choices) => {
  try {
    const value = localStorage.getItem(key)
    return choices.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

function configuredRoots(settings) {
  let roots = []
  try {
    const parsed = JSON.parse(settings?.music_folders || 'null')
    if (Array.isArray(parsed)) roots = parsed
  } catch {}
  if (!roots.length && typeof settings?.music_folder === 'string' && settings.music_folder.trim()) roots = [settings.music_folder]
  const seen = new Set()
  return roots.filter(value => {
    if (typeof value !== 'string' || !value.trim()) return false
    const key = value.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(value => value.trim())
}

export default function Library() {
  const { t } = useTranslation()
  // Kept across visits (with the sort and view they were shown in), so coming
  // back paints the list at once instead of "No tracks yet" first.
  const [tracks, setTracks, wasCached] = useCachedState('library:tracks', [])
  const [sort, setSort] = useCachedState('library:sort', 'added_at DESC')
  // Where the songs came from (see sourceFilter in electron/ipc/scanner.js).
  const [source, setSource] = useCachedState('library:source', 'all')
  // One genre, or '' for all (matches a song's main genre or any of its genres).
  const [genre, setGenre] = useCachedState('library:genre', '')
  const [genres, setGenres] = useCachedState('library:genres', [])
  // One audio quality tier, or '' for all (the Audio Quality page's tiers).
  const [quality, setQuality] = useCachedState('library:quality', '')
  const [format, setFormat] = useCachedState('library:format', '')
  const problemsOnly = source === 'errors'
  const [view, setCachedView] = useCachedState('library:view', () => readLibraryPreference('lokal-library-view', 'list', ['list', 'grid']))
  const setView = value => {
    if (value !== 'list' && value !== 'grid') return
    try { localStorage.setItem('lokal-library-view', value) } catch {}
    setCachedView(value)
  }
  const [libraryMode, setCachedLibraryMode] = useCachedState('library:mode', () => readLibraryPreference('lokal-library-mode', 'simple', ['simple', 'advanced']))
  const setLibraryMode = value => {
    if (value !== 'simple' && value !== 'advanced') return
    try { localStorage.setItem('lokal-library-mode', value) } catch {}
    setCachedLibraryMode(value)
  }
  const [folderPath, setFolderPath] = useCachedState('library:folderPath', '')
  const [folderSearch, setFolderSearch] = useState('')
  const [simpleSearch, setSimpleSearch] = useCachedState('library:simpleSearch', '')
  const [debouncedSimpleSearch, setDebouncedSimpleSearch] = useState(() => simpleSearch.trim())
  const [folderData, setFolderData] = useState(null)
  const [folderViewOverride, setFolderViewOverride] = useState(null)
  const [musicRoots, setMusicRoots] = useState([])
  const [activeMusicRoot, setActiveMusicRoot] = useCachedState('library:activeMusicRoot', '')
  const [addingMusicFolder, setAddingMusicFolder] = useState(false)
  const [musicRootError, setMusicRootError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingPlaybackTracks, setLoadingPlaybackTracks] = useState(false)
  const [hasMore, setHasMore] = useCachedState('library:hasMore', true)
  // The empty state waits for the first answer instead of showing meanwhile.
  const [loaded, setLoaded] = useState(wasCached)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSimpleSearch(simpleSearch.trim()), 180)
    return () => clearTimeout(timer)
  }, [simpleSearch])

  useEffect(() => {
    let live = true
    api.getSettings().then(settings => {
      if (!live) return
      const roots = configuredRoots(settings || {})
      setMusicRoots(roots)
      setActiveMusicRoot(current => roots.includes(current) ? current : (roots[0] || ''))
    }).catch(() => {})
    return () => { live = false }
  }, [])
  usePageReady(loaded)
  const playQueue = usePlayerStore(s => s.playQueue)
  const navigate = useNavigate()
  const location = useLocation()
  const offsetRef = useRef(tracks.length)
  const loadingRef = useRef(false)
  const loadingPlaybackTracksRef = useRef(false)
  const loadMoreRef = useRef(null)
  const requestIdRef = useRef(0)
  const shouldAnimateGrid = tracks.length <= HEAVY_GRID_THRESHOLD
  const isTrackOnlyFolder = !!folderData?.relativePath &&
    folderData.relativePath === folderPath &&
    folderData.folders?.length === 0 &&
    folderData.tracks?.length > 0
  const activeView = libraryMode === 'advanced' && isTrackOnlyFolder
    ? (folderViewOverride?.path === folderPath ? folderViewOverride.view : 'list')
    : view

  /** Update the shared view and preserve an explicit choice for the current folder. */
  const changeView = nextView => {
    setView(nextView)
    if (libraryMode === 'advanced') setFolderViewOverride({ path: folderPath, view: nextView })
  }

  const addMusicFolder = async () => {
    if (!api.isElectron || addingMusicFolder) return
    setMusicRootError('')
    const selected = await api.openFolder()
    if (!selected || typeof selected !== 'string') return
    if (musicRoots.some(root => root.toLowerCase() === selected.toLowerCase())) {
      setActiveMusicRoot(selected)
      setLibraryMode('advanced')
      return
    }
    const nextRoots = [...musicRoots, selected]
    setAddingMusicFolder(true)
    try {
      const result = await api.scanFolders(nextRoots)
      if (result?.error) throw new Error(result.error)
      const savedRoots = Array.isArray(result?.folders) && result.folders.length ? result.folders : nextRoots
      setMusicRoots(savedRoots)
      setActiveMusicRoot(selected)
      setLibraryMode('advanced')
      setFolderPath('')
      setFolderData(null)
      await api.saveSettings({ music_folders: JSON.stringify(savedRoots), music_folder: savedRoots[0] || '' })
      window.dispatchEvent(new Event('lokal:refresh'))
    } catch (error) {
      setMusicRootError(error?.message === 'Choose at least one existing music folder' ? t(error.message) : t('Could not add this music folder'))
    } finally {
      setAddingMusicFolder(false)
    }
  }
  const playAllTracks = libraryMode === 'simple'
    ? (simpleSearch.trim() === debouncedSimpleSearch ? tracks : [])
    : (folderData?.filteredTracks || (folderData?.tracks?.length ? folderData.tracks : folderData?.allTracks) || [])

  /**
   * Run a Simple-mode playback action against every track matching current filters.
   * Fetching all pages avoids using only the rows currently rendered in the library.
   * @param {'play'|'next'|'shuffle'} action Playback action to execute.
   */
  const runSimplePlaybackAction = async (action) => {
    if (loadingPlaybackTracksRef.current || simpleSearch.trim() !== debouncedSimpleSearch) return
    loadingPlaybackTracksRef.current = true
    setLoadingPlaybackTracks(true)
    try {
      const filters = {
        sort,
        ...(source !== 'all' && source !== 'errors' ? { source } : {}),
        ...(genre ? { genre } : {}),
        ...(quality ? { quality } : format ? { format } : {}),
        ...(problemsOnly ? { problems: true } : {}),
        ...(debouncedSimpleSearch ? { search: debouncedSimpleSearch } : {}),
      }
      const results = await fetchAllTrackPages(options => api.getTracks(options), filters, PLAYBACK_FETCH_PAGE_SIZE)
      const allTracks = problemsOnly ? results : results.filter(track => !String(track?.file_path || '').startsWith('ghost://'))
      if (!allTracks.length) return
      if (action === 'play') playQueue(allTracks, 0, null)
      else if (action === 'next') playNextMany(allTracks)
      else if (action === 'shuffle') playQueue(shuffledLibraryTracks(allTracks), 0, null)
    } catch (error) {
      console.error('[Library] Could not fetch every matching track for playback:', error)
      showToast(t('Could not load all matching tracks. Please try again.'))
    } finally {
      loadingPlaybackTracksRef.current = false
      setLoadingPlaybackTracks(false)
    }
  }
  const folderFilters = useMemo(() => ({ source, genre, format: quality ? '' : format, quality, sort }), [source, genre, format, quality, sort])

  useEffect(() => {
    if (typeof location.state?.openFolder !== 'string') return
    setLibraryMode('advanced')
    setFolderPath(location.state.openFolder)
    setFolderSearch('')
    navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.state, navigate])

  const load = async (append = false) => {
    // Synchronous in-flight check: the observer's `loading` can be stale, and a
    // load-more mustn't supersede the first-page refresh (or run twice).
    if (loadingRef.current && append) return
    const requestId = ++requestIdRef.current
    const nextOffset = append ? offsetRef.current : 0
    loadingRef.current = true
    setLoading(true)
    try {
      const result = await api.getTracks({ sort, limit: LIBRARY_PAGE_SIZE, offset: nextOffset, ...(source !== 'all' && source !== 'errors' ? { source } : {}), ...(genre ? { genre } : {}), ...(quality ? { quality } : format ? { format } : {}), ...(problemsOnly ? { problems: true } : {}), ...(debouncedSimpleSearch ? { search: debouncedSimpleSearch } : {}) })
      if (requestId !== requestIdRef.current) return
      // A failed request keeps the list already shown (and cached).
      if (!Array.isArray(result)) return
      const items = problemsOnly ? result : result.filter(track => !String(track?.file_path || '').startsWith('ghost://'))
      offsetRef.current = nextOffset + items.length
      setTracks(prev => append ? [...prev, ...items] : items)
      setHasMore(items.length === LIBRARY_PAGE_SIZE)
      // Only a real answer ends the first load ("No tracks yet" must be true).
      setLoaded(true)
    } finally {
      if (requestId === requestIdRef.current) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }

  // The list on screen (from last time, or the previous sort) stays until
  // the new first page replaces it; a failed request leaves it as it is.
  useEffect(() => {
    // Another sort or source: nothing more is fetched (or appended) until its
    // first page is in, so two lists are never mixed.
    offsetRef.current = 0
    setHasMore(false)
    load(false)
  }, [sort, source, genre, quality, format, problemsOnly, debouncedSimpleSearch])

  useEffect(() => {
    const handleRefresh = () => { load(false); loadGenres() }
    window.addEventListener('lokal:refresh', handleRefresh)
    return () => window.removeEventListener('lokal:refresh', handleRefresh)
  }, [sort, source, genre, quality, format, problemsOnly, debouncedSimpleSearch])

  // The genres to pick from: every one in the library, on opening and after a refresh.
  const loadGenres = () => Promise.resolve(api.getAllGenres())
    .then(list => { if (Array.isArray(list)) setGenres(list.filter(g => typeof g === 'string' && g.trim())) })
    .catch(() => {})
  useEffect(() => { loadGenres() }, [])

  useEffect(() => {
    if (!hasMore || loading || simpleSearch.trim() !== debouncedSimpleSearch) return
    const node = loadMoreRef.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        load(true)
      }
    }, { rootMargin: '300px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, sort, source, genre, quality, format, problemsOnly, tracks.length, simpleSearch, debouncedSimpleSearch])

  const artSrc = (t) => t.artwork_path
    ? (api.isElectron ? api.fileURL(t.artwork_path) : api.artworkURL(t.id))
    : null

  return (
    <div className="p-6 space-y-4 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <h1 className="font-display text-lg uppercase tracking-widest text-white">{t("Library")}</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <select value={source} onChange={e => setSource(e.target.value)} aria-label={t("Source")}
            className="bg-elevated border border-border rounded-lg px-3 py-1.5 text-xs text-muted outline-none focus:border-accent/50">
            <option value="all">{t("All sources")}</option>
            <option value="local">{t("Music folder")}</option>
            <option value="mobile">{t("Mobile")}</option>
            <option value="yt">{t("YouTube")}</option>
            <option value="sc">{t("SoundCloud")}</option>
            <option value="addon">{t("Addons")}</option>
            <option value="soulseek">{t("Soulseek")}</option>
            <option value="web">{t("Other sites")}</option>
            <option value="errors">{t("Errors")}</option>
          </select>
          <select value={genre} onChange={e => setGenre(e.target.value)} aria-label={t("Genres")}
            className={`max-w-[11rem] truncate bg-elevated border rounded-lg px-3 py-1.5 text-xs outline-none focus:border-accent/50 ${genre ? 'border-accent/40 text-accent' : 'border-border text-muted'}`}>
            <option value="">{t("All genres")}</option>
            {genre && !genres.some(g => g.toLowerCase() === genre.toLowerCase()) && <option value={genre}>{genre}</option>}
            {genres.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select
            value={quality ? `quality:${quality}` : format ? `format:${format}` : ''}
            onChange={e => {
              const value = e.target.value
              if (value.startsWith('quality:')) { setQuality(value.slice(8)); setFormat('') }
              else if (value.startsWith('format:')) { setFormat(value.slice(7)); setQuality('') }
              else { setQuality(''); setFormat('') }
            }}
            aria-label={t("Format and quality")}
            className={`bg-elevated border rounded-lg px-3 py-1.5 text-xs outline-none focus:border-accent/50 ${quality || format ? 'border-accent/40 text-accent' : 'border-border text-muted'}`}
          >
            <option value="">{t("All formats and qualities")}</option>
            <optgroup label={t("Quality")}>
              <option value="quality:hires">{t("Hi-res")}</option>
              <option value="quality:lossless">{t("Lossless")}</option>
              <option value="quality:high">{t("High")}</option>
              <option value="quality:low">{t("Low")}</option>
              <option value="quality:suspect">{t("Suspect")}</option>
            </optgroup>
            <optgroup label={t("Format")}>
              <option value="format:16-44100">16-bit / 44.1 kHz</option>
              <option value="format:16-48000">16-bit / 48 kHz</option>
              <option value="format:16-88200">16-bit / 88.2 kHz</option>
              <option value="format:16-96000">16-bit / 96 kHz</option>
              <option value="format:16-192000">16-bit / 192 kHz</option>
              <option value="format:24-44100">24-bit / 44.1 kHz</option>
              <option value="format:24-48000">24-bit / 48 kHz</option>
              <option value="format:24-88200">24-bit / 88.2 kHz</option>
              <option value="format:24-96000">24-bit / 96 kHz</option>
              <option value="format:24-176400">24-bit / 176.4 kHz</option>
              <option value="format:24-192000">24-bit / 192 kHz</option>
              <option value="format:32-44100">32-bit / 44.1 kHz</option>
              <option value="format:32-48000">32-bit / 48 kHz</option>
              <option value="format:32-88200">32-bit / 88.2 kHz</option>
              <option value="format:32-96000">32-bit / 96 kHz</option>
              <option value="format:32-192000">32-bit / 192 kHz</option>
            </optgroup>
          </select>
          <select value={sort} onChange={e => setSort(e.target.value)} aria-label={t("Sort")}
            className="bg-elevated border border-border rounded-lg px-3 py-1.5 text-xs text-muted outline-none focus:border-accent/50">
            <option value="added_at DESC">{t("Recently Added")}</option>
            <option value="title ASC">{t("Title A-Z")}</option>
            <option value="artist ASC">{t("Artist A-Z")}</option>
            <option value="play_count DESC">{t("Most Played")}</option>
            <option value="duration DESC">{t("Longest")}</option>
          </select>
          <div className="flex bg-elevated border border-border rounded-lg overflow-hidden">
            <button onClick={() => changeView('list')} aria-label={t("List view")} className={`p-1.5 transition-colors ${activeView === 'list' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'}`}><List size={14} /></button>
            <button onClick={() => changeView('grid')} aria-label={t("Grid view")} className={`p-1.5 transition-colors ${activeView === 'grid' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'}`}><LayoutGrid size={14} /></button>
          </div>
        </div>
      </div>

      <ScanBanner />

      <div className="flex flex-col items-start gap-3">
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted font-display">
            {libraryMode === 'simple'
              ? (simpleSearch.trim() !== debouncedSimpleSearch || (loading && debouncedSimpleSearch)
                  ? t('Searching…')
                  : debouncedSimpleSearch
                    ? tracks.length + (hasMore ? '+' : '') + ' ' + (tracks.length === 1 ? t('match') : t('matches'))
                    : tracks.length + ' ' + t('loaded tracks'))
              : folderData?.available
                ? (folderSearch.trim() && folderData.matchCount != null
                    ? `${folderData.matchCount} ${folderData.matchCount === 1 ? t('match') : t('matches')} · ${folderData.relativePath || folderData.rootName}`
                    : `${folderData.totalTracks != null ? folderData.totalTracks : (folderData.tracks?.length || 0)} ${(folderData.totalTracks != null ? folderData.totalTracks : (folderData.tracks?.length || 0)) === 1 ? t('track') : t('tracks')} · ${folderData.relativePath || folderData.rootName}`)
                : t('Browse your music folders')}
          </p>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {api.isElectron && (
              <button type="button" onClick={addMusicFolder} disabled={addingMusicFolder}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:text-white disabled:opacity-50">
                {addingMusicFolder ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
                {addingMusicFolder ? t('Adding folder…') : t('Add music folder')}
              </button>
            )}
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs text-white">
              <Search size={14} className="flex-shrink-0 text-muted" />
              <input
                type="text"
                value={libraryMode === 'simple' ? simpleSearch : folderSearch}
                onChange={e => libraryMode === 'simple' ? setSimpleSearch(e.target.value) : setFolderSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { if (libraryMode === 'simple') setSimpleSearch(''); else setFolderSearch('') } }}
                placeholder={libraryMode === 'simple' ? t("Search tracks…") : t("Search folders & tracks…")}
                aria-label={libraryMode === 'simple' ? t("Search tracks") : t("Search folders and tracks")}
                className="w-36 bg-transparent text-xs text-white outline-none placeholder:text-muted focus:w-48 transition-all @sm:w-44"
              />
              {(libraryMode === 'simple' ? simpleSearch : folderSearch) && (
                <button
                  type="button"
                  onClick={() => { if (libraryMode === 'simple') setSimpleSearch(''); else setFolderSearch('') }}
                  aria-label={t("Clear search")}
                  className="flex-shrink-0 text-muted transition-colors hover:text-white"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2">
          {playAllTracks.length > 0 && (libraryMode === 'advanced' ? (
            <>
              <button onClick={() => playQueue(playAllTracks, 0, { type: 'library-folder' })} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90"><Play size={15} fill="currentColor" /> {t('Play')}</button>
              <button onClick={() => playNextMany(playAllTracks)} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50"><Clock size={15} /> {t('Play next')}</button>
              <button onClick={() => { const list = shuffledLibraryTracks(playAllTracks); if (list.length) playQueue(list, 0, { type: 'library-folder' }) }} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50"><Shuffle size={15} /> {t('Shuffle')}</button>
            </>
          ) : (
            <>
              <button onClick={() => runSimplePlaybackAction('play')} disabled={loadingPlaybackTracks} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90 disabled:opacity-50">
                {loadingPlaybackTracks ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} fill="currentColor" />}
                {loadingPlaybackTracks ? t('Loading…') : t('Play All')}
              </button>
              <button onClick={() => runSimplePlaybackAction('next')} disabled={loadingPlaybackTracks} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-50"><Clock size={15} /> {t('Play next')}</button>
              <button onClick={() => runSimplePlaybackAction('shuffle')} disabled={loadingPlaybackTracks} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-50"><Shuffle size={15} /> {t('Shuffle')}</button>
            </>
          ))}
          <button
            type="button"
            onClick={() => setLibraryMode(libraryMode === 'simple' ? 'advanced' : 'simple')}
            aria-pressed={libraryMode === 'advanced'}
            className={`ml-auto inline-flex items-center rounded-full border px-4 py-2 text-sm transition-colors ${libraryMode === 'advanced' ? 'border-accent/40 bg-accent/15 text-accent' : 'border-border bg-elevated text-muted hover:text-white'}`}
          >
            {libraryMode === 'simple' ? t('Advanced') : t('Simple')}
          </button>
        </div>
      </div>

      {libraryMode === 'advanced' && (
        <>
          {musicRoots.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2">
              <label htmlFor="library-root-select" className="text-xs text-muted">{t('Music folder')}</label>
              <select id="library-root-select" value={activeMusicRoot} onChange={event => {
                setActiveMusicRoot(event.target.value)
                setFolderPath('')
                setFolderData(null)
                setFolderSearch('')
              }} className="min-w-0 max-w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-white">
                {musicRoots.map(root => <option key={root} value={root}>{root.split(/[\\/]/).filter(Boolean).pop() || root}</option>)}
              </select>
              <span className="text-xs text-muted">{t('{n} folders', { n: musicRoots.length })}</span>
            </div>
          )}
          {musicRootError && <p className="text-xs text-red-400" role="alert">{musicRootError}</p>}
          <LibraryFolderBrowser
            folderPath={folderPath}
            onFolderChange={setFolderPath}
            onDataChange={setFolderData}
            view={activeView}
            playQueue={playQueue}
            artSrc={artSrc}
            searchQuery={folderSearch}
            onSearchQueryChange={setFolderSearch}
            rootPath={activeMusicRoot}
            filters={folderFilters}
          />
        </>
      )}

      {libraryMode === 'simple' && tracks.length > 0 && view === 'list' && (
        <>
          {/* No per-row entrance: the page fades in as a whole, and 50 row
              animations in the same frames made that fade stutter. */}
          <TrackList tracks={tracks} showQuality reduceMotion />
        </>
      )}

      {libraryMode === 'simple' && tracks.length > 0 && view === 'grid' && (
        <div className="grid grid-cols-3 @sm:grid-cols-4 @md:grid-cols-5 gap-3">
          {tracks.map((t, i) => {
            const src = artSrc(t)
            return (
              <motion.button
                key={t.id}
                initial={false}
                whileHover={shouldAnimateGrid ? { scale: 1.04 } : undefined}
                onDoubleClick={() => playQueue(tracks, i)}
                className="flex flex-col gap-2 text-left group"
              >
                <div className="w-full aspect-square rounded-xl bg-elevated border border-border overflow-hidden flex items-center justify-center">
                  {src ? <FadeImg src={src} className="w-full h-full object-cover" /> : <Music size={28} className="text-muted" />}
                </div>
                <div>
                  <p className="text-xs font-medium text-white truncate">{t.title}</p>
                  <p className="text-xs text-muted truncate">{t.artist}</p>
                </div>
              </motion.button>
            )
          })}
        </div>
      )}

      {libraryMode === 'simple' && (hasMore || loading) && (
        <div ref={loadMoreRef} className="flex justify-center pt-2 min-h-10">
          {loading && tracks.length > 0 && <p className="text-xs text-muted">{t("Loading more tracks...")}</p>}
        </div>
      )}

      {libraryMode === 'simple' && loaded && !loading && simpleSearch.trim() === debouncedSimpleSearch && !tracks.length && (
        <div className="text-center py-24 text-muted">
          <Music size={48} className="mx-auto mb-4 opacity-20" />
          <p>{debouncedSimpleSearch
            ? `${t('No tracks match')} “${debouncedSimpleSearch}”.`
            : problemsOnly ? t('No songs with errors: everything here can be played.') : source === 'all' && !genre && !quality && !format ? t('No tracks yet — add a music folder above.') : (quality || format) ? t('No tracks match this format or quality.') : genre ? t(source === 'all' ? 'No {genre} songs.' : 'No {genre} songs from this source.', { genre }) : t('No songs from this source.')}</p>
          {debouncedSimpleSearch && (
            <button onClick={() => setSimpleSearch('')} className="mt-3 text-xs text-accent transition-colors hover:text-accent/70">{t("Clear search")}</button>
          )}
          {genre && (
            <button onClick={() => setGenre('')} className="mt-3 text-xs text-accent transition-colors hover:text-accent/70">{t("Show all genres")}</button>
          )}
          {quality && (
            <button onClick={() => setQuality('')} className="mt-3 ml-3 text-xs text-accent transition-colors hover:text-accent/70">{t("Show all qualities")}</button>
          )}
        </div>
      )}
    </div>
  )
}
