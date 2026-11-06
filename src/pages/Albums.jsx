import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Clock, Disc3, Download, Globe, ListEnd, Loader2, Play, Plus, Search, Shuffle, Trash2, Radio, Gem } from 'lucide-react'
import { usePlayerStore, useAppStore } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { api, peekSettings } from '../api'
import { peekCache, writeCache, usePageReady } from '../pageCache'
import { makeAlbumContext } from '../playbackContext'
import FadeImg from '../components/FadeImg'
import ImageZoom from '../components/ImageZoom'
import CoverPlay from '../components/CoverPlay'
import SelectionBar from '../components/SelectionBar'
import { useSelection } from '../selection'
import { addToPlaylistMany, addToQueueMany, playNextMany } from '../trackActions'
import { artistPath, releaseKey, useReleaseActions } from '../releaseActions'
import { openRadio } from '../radioActions'
import OnlineSongList from '../components/OnlineSongList'
import RefreshButton from '../components/RefreshButton'
import ReleaseTypeFilter from '../components/ReleaseTypeFilter'
import { groupReleases, releaseTypeCounts, useAlbumsPageReleaseTypes } from '../releaseTypes'
import { applyCachedReleaseTypes } from '../albumReleaseTypes'
import { startReleaseRefresh, useReleaseRefresh } from '../store/releaseRefresh'
import { albumCacheKey, isConnected, loadOnlineAlbumCached, mergeWithLibrary, onlineAlbumPath, peekOnline, setConnected } from '../onlineBrowse'
import { downloadOnline, playOnline } from '../onlineActions'
import { losslessMenuItem, losslessManyMenuItem } from '../quality'
import { useTranslation } from '../i18n'

const shuffledList = list => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function getAlbumArtwork(album) {
  return api.albumArtURL(album)
}

function getAlbumFullArtwork(album) {
  return api.albumFullArtURL(album) || getAlbumArtwork(album)
}

function releaseLabel(type) {
  if (type === 'single') return 'Single'
  if (type === 'ep') return 'EP'
  return 'Album'
}

// An album's page, laid out like an online album's (OnlineAlbum): the cover,
// what it is, and its actions in one row; the songs below.
function AlbumHero({ album, trackCount, duration, online, onBack, onArtist, children }) {
  const { t } = useTranslation()
  const artSrc = getAlbumArtwork(album)
  const fullArtSrc = getAlbumFullArtwork(album)
  const artistName = album.album_artist || album.artists || ''
  // The cover, big (click it).
  const [zoom, setZoom] = useState(false)
  const songCount = Number(trackCount) || 0
  const facts = [t(songCount === 1 ? '{count} song' : '{count} songs', { count: songCount }), duration ? t('{count} min', { count: Math.round(duration / 60) }) : '', album.year || '', online || ''].filter(Boolean)
  return (
    <div>
      <button onClick={onBack} className="mb-5 inline-flex items-center gap-2 text-xs text-muted transition-colors hover:text-white">
        <ArrowLeft size={14} /> {t('Back')}
      </button>
      <div className="flex flex-col gap-5 @md:flex-row @md:items-end">
        <ImageZoom src={fullArtSrc} alt={album.title} open={zoom} onClose={() => setZoom(false)} />
        <div onClick={artSrc ? () => setZoom(true) : undefined} title={artSrc ? 'View the cover' : undefined}
          className={`h-44 w-44 flex-shrink-0 overflow-hidden rounded-2xl border border-border bg-elevated shadow-xl ${artSrc ? 'cursor-zoom-in' : ''}`}>
          {artSrc
            ? <div className="relative h-full w-full">
                <img src={artSrc} alt={album.title} className="h-full w-full object-cover" />
                {fullArtSrc !== artSrc && <img src={fullArtSrc} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" decoding="async" onError={event => { event.currentTarget.style.display = 'none' }} />}
              </div>
            : <div className="flex h-full w-full items-center justify-center text-muted"><Disc3 size={52} /></div>}
        </div>
        <div className="min-w-0">
          <p className="mb-1 text-xs font-display uppercase tracking-widest text-muted">{t(releaseLabel(album.release_type))} · {t('Library')}</p>
          <h1 className="truncate text-3xl font-display text-white" title={album.title}>{album.title}</h1>
          {artistName
            ? <button onClick={onArtist} className="mt-1 max-w-full truncate text-sm text-muted transition-colors hover:text-accent hover:underline">{artistName}</button>
            : <p className="mt-1 text-sm text-muted">{t("Unknown Artist")}</p>}
          <p className="mt-1 text-xs text-subtle">{facts.join(' · ')}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">{children}</div>
        </div>
      </div>
    </div>
  )
}

// Cards on the first screen skip their own entrance: the page already fades
// in, and dozens of card animations running with it dropped frames.
/**
 * One release in the grid, Spotify style: the cover shows unobstructed and
 * plays the release (darkened, with a play glyph, on hover); the name and
 * the text under it open it.
 */
function AlbumCard({ album, onClick, onPlay, onContextMenu, selected = false }) {
  const { t } = useTranslation()
  const artSrc = getAlbumArtwork(album)
  const fullArtSrc = getAlbumFullArtwork(album)

  return (
    <motion.div
      initial={false}
      whileHover={{ y: -3 }}
      onContextMenu={onContextMenu}
      aria-selected={selected}
      className={`group overflow-hidden rounded-[1.5rem] border bg-card/60 transition-colors ${selected ? 'border-accent ring-2 ring-accent/60' : 'border-border hover:border-accent/35'}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '320px' }}
    >
      <div className="relative aspect-square overflow-hidden bg-black/20">
        {artSrc ? (
          // (A blurred copy used to sit under the cover, entirely hidden by
          // it: a full-size blur per card for nothing.)
          <>
            <FadeImg src={artSrc} alt={album.title} className="relative h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
            {fullArtSrc !== artSrc && <FadeImg src={fullArtSrc} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />}
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Disc3 size={34} className="text-muted" />
          </div>
        )}
        <CoverPlay label={`Play ${album.title}`} onPlay={onPlay} />
        {selected && (
          <span className="pointer-events-none absolute left-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-base shadow-lg">
            <Check size={14} strokeWidth={3} />
          </span>
        )}
      </div>
      <button type="button" onClick={(event) => onClick?.(event)} className="group/open relative block w-full overflow-hidden px-4 py-3 text-left">
        <div
          className="absolute inset-0 scale-110 blur-xl"
          style={{
            backgroundImage: artSrc ? `url("${artSrc}")` : 'none',
            backgroundPosition: 'center',
            backgroundSize: 'cover',
            opacity: artSrc ? 0.18 : 0,
          }}
        />
        <div className="absolute inset-0 bg-black/35" />
        <div className="relative space-y-1">
          <p className="truncate text-sm font-medium text-white decoration-white/60 underline-offset-2 group-hover/open:underline">{album.title}</p>
          <p className="truncate text-xs text-muted">{album.artists || album.album_artist || 'Unknown Artist'}</p>
          <p className="text-[11px] uppercase leading-snug tracking-[0.16em] text-muted/70">
            {t(releaseLabel(album.release_type))} • {t((Number(album.track_count) || 0) === 1 ? '{count} track' : '{count} tracks', { count: Number(album.track_count) || 0 })}{album.year ? ` • ${album.year}` : ''}
          </p>
        </div>
      </button>
    </motion.div>
  )
}

export default function Albums() {
  const { t } = useTranslation()
  // Last visit's releases (and the settings already read) paint at once on
  // the way back, instead of "Loading releases..." first; they refresh quietly.
  const [albums, setAlbumsState] = useState(() => peekCache('albums:all') || [])
  const setAlbums = (list) => { writeCache('albums:all', list); setAlbumsState(list) }
  const [selectedAlbum, setSelectedAlbum] = useState(null)
  const [albumTracks, setAlbumTracks] = useState([])
  const [loadingAlbums, setLoadingAlbums] = useState(() => !peekCache('albums:all'))
  const [loadingTracks, setLoadingTracks] = useState(false)
  const [query, setQuery] = useState('')
  const [hoveredTrack, setHoveredTrack] = useState(null)
  const [settings, setSettings] = useState(() => peekSettings() || {})
  const refreshStatus = useReleaseRefresh()
  const albumRequest = useRef(0)
  const navigate = useNavigate()
  const location = useLocation()
  // Opening a given album: wait for its tracks too, so the grid doesn't show first.
  usePageReady(!loadingAlbums && (!location.state?.album || (selectedAlbum && !loadingTracks)))
  const { playQueue, currentTrack, isPlaying, togglePlay, playTrack } = usePlayerStore(useShallow(({ playQueue, currentTrack, isPlaying, togglePlay, playTrack }) => ({ playQueue, currentTrack, isPlaying, togglePlay, playTrack })))
  const albumContext = useMemo(() => makeAlbumContext(selectedAlbum), [selectedAlbum])

  // "Full album online": the whole tracklist from the catalogue, the songs the
  // library has marked (and played from the files), the others streamed or
  // downloaded (remembered per album).
  const albumArtist = selectedAlbum?.album_artist || String(selectedAlbum?.artists || '').split(',')[0].trim()
  const connectKey = selectedAlbum?.title ? `album:${String(albumArtist).toLowerCase()}|${String(selectedAlbum.title).toLowerCase()}` : ''
  const [connected, setConnectedState] = useState(false)
  const [onlineAlbum, setOnlineAlbum] = useState({ loading: false, tracks: [], error: '' })
  const [downloadingMissing, setDownloadingMissing] = useState(false)
  useEffect(() => { setConnectedState(isConnected(connectKey) || location.state?.connect === true) }, [connectKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Kept once loaded (see cachedOnline): coming back doesn't look it up
  // again; the Refresh button does.
  const [reloadOnline, setReloadOnline] = useState(0)
  useEffect(() => {
    if (!connected || !selectedAlbum?.title) return undefined
    let cancelled = false
    const options = { artist: albumArtist, album: selectedAlbum.title }
    const hit = reloadOnline ? null : peekOnline(albumCacheKey(options))
    if (hit) { setOnlineAlbum({ loading: false, tracks: hit.value.tracks, error: '', loadedAt: hit.at }); return undefined }
    setOnlineAlbum({ loading: true, tracks: [], error: '' })
    loadOnlineAlbumCached(options, undefined, { isCurrent: () => !cancelled }, { refresh: reloadOnline > 0 })
      .then(result => { if (!cancelled) setOnlineAlbum({ loading: false, tracks: result.tracks, error: result.error || '', loadedAt: Date.now() }) })
      .catch(() => { if (!cancelled) setOnlineAlbum({ loading: false, tracks: [], error: 'Could not load this album online.' }) })
    return () => { cancelled = true }
  }, [connected, connectKey, reloadOnline]) // eslint-disable-line react-hooks/exhaustive-deps
  const merged = useMemo(() => mergeWithLibrary(onlineAlbum.tracks, albumTracks), [onlineAlbum.tracks, albumTracks])
  const showOnline = connected && !onlineAlbum.loading && onlineAlbum.tracks.length > 0
  const toggleConnected = () => setConnectedState(on => { setConnected(connectKey, !on); return !on })
  const playMerged = (selected) => playOnline(merged.tracks, { selected, name: selectedAlbum?.title, path: onlineAlbumPath({ artist: albumArtist, album: selectedAlbum?.title }) })
  const downloadMissing = async () => {
    if (downloadingMissing) return
    setDownloadingMissing(true)
    try { await downloadOnline(merged.missing, { label: `${merged.missing.length} missing songs` }) } finally { setDownloadingMissing(false) }
  }
  // Set by the bottom-bar / now-playing shortcuts so we can flash the playing track.
  const [highlightTrackId, setHighlightTrackId] = useState(null)
  const highlightRowRef = useRef(null)

  // True once the highlighted track's row actually exists to flash/scroll
  // to. A plain boolean (not the track object/array) so the timer effect
  // below only restarts when readiness itself flips, not on every
  // unrelated albumTracks re-fetch.
  const highlightTrackReady = !!highlightTrackId && albumTracks.some((track) => track.id === highlightTrackId)

  useEffect(() => {
    if (!highlightTrackReady) return
    const node = highlightRowRef.current
    if (!node) return
    requestAnimationFrame(() => {
      try {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        node.scrollIntoView()
      }
    })
  }, [highlightTrackReady, highlightTrackId])

  // Kept separate so re-renders can't cancel the flash timer. Gated on
  // highlightTrackReady (not just highlightTrackId) so a slow
  // api.getAlbumTracks() can't have this timer clear the highlight before
  // the matching row ever renders -- if getAlbumTracks takes longer than
  // 2s, the countdown now only starts once the row is actually there.
  useEffect(() => {
    if (!highlightTrackReady) return
    const timer = setTimeout(() => setHighlightTrackId(null), 2000)
    return () => clearTimeout(timer)
  }, [highlightTrackReady, highlightTrackId])

  const loadAlbums = () => {
    // The cache, not `albums`: the refresh handler keeps an older render's
    // closure, where the list can still be empty.
    if (!peekCache('albums:all')?.length) setLoadingAlbums(true)

    const request = ++albumRequest.current
    // Always paint the local list first; catalogues are only contacted by the
    // explicit Refresh releases action.
    Promise.resolve(api.getAllAlbums()).then(result => {
      if (request === albumRequest.current && Array.isArray(result)) setAlbums(applyCachedReleaseTypes(result))
    }).catch(() => {}).finally(() => {
      if (request === albumRequest.current) setLoadingAlbums(false)
    })
    api.getSettings().then(result => {
      if (request === albumRequest.current && result && !result.error) setSettings(result)
    }).catch(() => {})
  }

  useEffect(() => {
    loadAlbums()
    return () => { albumRequest.current++ }
  }, [])

  useEffect(() => {
    const cached = peekCache('albums:all')
    if (cached) setAlbums(applyCachedReleaseTypes(cached))
  }, [refreshStatus.finishedAt])

  useEffect(() => {
    const handleRefresh = () => {
      loadAlbums()
      if (selectedAlbum?.title) {
        setLoadingTracks(true)
        api.getAlbumTracks(selectedAlbum).then((tracks) => {
          setAlbumTracks(Array.isArray(tracks) ? tracks : [])
          setLoadingTracks(false)
        }).catch(() => setLoadingTracks(false))
      }
    }
    window.addEventListener('lokal:refresh', handleRefresh)
    return () => window.removeEventListener('lokal:refresh', handleRefresh)
  }, [selectedAlbum?.title, selectedAlbum?.album_artist])

  useEffect(() => {
    const incomingAlbum = location.state?.album

    if (!incomingAlbum) {
      setSelectedAlbum(null)
      setHighlightTrackId(null)
      return
    }

    const match = albums.find((album) => album.title === incomingAlbum.title && (!incomingAlbum.album_artist || album.album_artist === incomingAlbum.album_artist))
    setSelectedAlbum(match || incomingAlbum)
    setHighlightTrackId(location.state?.highlightTrackId || null)
  }, [albums, location.pathname, location.state])

  // Which release types show, in sections (Albums, EPs, Singles...): chosen
  // on the page, like an artist's page (this replaced two switches in
  // Settings; one that hid Singles is carried over).
  const [shownTypes, toggleType] = useAlbumsPageReleaseTypes({ hideSingles: settings.show_singles_in_albums === '0' })

  const filteredAlbums = useMemo(() => {
    const lower = query.trim().toLowerCase()
    const base = albums.filter((album) => {
      if (!lower) return true
      const title = String(album.title || '').toLowerCase()
      const artists = String(album.artists || album.album_artist || '').toLowerCase()
      return title.includes(lower) || artists.includes(lower)
    })

    const sortMode = settings.album_sort_mode || 'default'
    const safeAddedAt = (a) => {
      const v = a?.added_at
      if (v === undefined || v === null || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }

    // default = existing behavior from current server order (don’t reorder)
    if (sortMode === 'newest') {
      return [...base].sort((l, r) => {
        const la = safeAddedAt(l) ?? -Infinity
        const ra = safeAddedAt(r) ?? -Infinity
        if (ra !== la) return ra - la
        const ly = Number(l?.year || 0)
        const ry = Number(r?.year || 0)
        if (ry !== ly) return ry - ly
        return String(l?.title || '').localeCompare(String(r?.title || ''), undefined, { sensitivity: 'base' })
      })
    }

    return base
  }, [albums, query, settings.album_sort_mode])

  const releaseTypes = useMemo(() => releaseTypeCounts(filteredAlbums), [filteredAlbums])
  const groupedAlbums = useMemo(() => groupReleases(filteredAlbums, shownTypes).map(group => ({ key: group.type, label: group.label, items: group.items })), [filteredAlbums, shownTypes])

  useEffect(() => {
    if (!selectedAlbum?.title) return
    const root = document.querySelector('main.flex-1.overflow-y-auto')
    if (!root) return
    root.scrollTop = 0
  }, [selectedAlbum?.title])

  useEffect(() => {
    if (!selectedAlbum?.title) {
      setAlbumTracks([])
      return
    }
    let active = true
    setLoadingTracks(true)
    api.getAlbumTracks(selectedAlbum).then((tracks) => {
      if (!active) return
      setAlbumTracks(Array.isArray(tracks) ? tracks : [])
      setLoadingTracks(false)
    }).catch(() => { if (active) setLoadingTracks(false) })
    return () => {
      active = false
    }
  }, [selectedAlbum?.title, selectedAlbum?.album_artist])

  const handleTrackPlay = (track, index, event) => {
    event?.stopPropagation?.()
    if (currentTrack?.id === track.id) {
      togglePlay()
      return
    }
    playTrack(track, albumTracks, albumContext)
  }

  // ---- Selecting releases (grid) and songs (album page): Ctrl/Cmd+click
  // or Shift+click selects, a right click or the bar acts on them.
  const releases = useReleaseActions({
    onDeleted: (ids) => {
      const gone = new Set(ids.map(String))
      setAlbumTracks(current => current.filter(track => !gone.has(String(track.id))))
      releaseSelection.clear()
      trackSelection.clear()
    },
  })
  const { menu } = releases
  const shownAlbums = useMemo(() => groupedAlbums.flatMap(group => group.items), [groupedAlbums])
  const shownKeys = useMemo(() => shownAlbums.map(releaseKey), [shownAlbums])
  const releasesFor = (keys) => shownAlbums.filter(album => keys.includes(releaseKey(album)))
  const releaseSelection = useSelection(shownKeys, { onDelete: (keys) => releases.askDelete(releasesFor(keys)) })
  const selectedReleases = () => releasesFor([...releaseSelection.selected])
  const openReleaseMenu = (event, album) => releases.openMenu(event, releasesFor(releaseSelection.contextSelect(releaseKey(album))))

  // Songs on the album page: double click (or the number's button) plays.
  const albumTrackIds = useMemo(() => albumTracks.map(track => track.id), [albumTracks])
  const askDeleteTracks = releases.askDeleteTracks
  const trackSelection = useSelection(albumTrackIds, { onDelete: (ids) => askDeleteTracks(albumTracks.filter(track => ids.includes(String(track.id)))) })
  const selectedAlbumTracks = () => albumTracks.filter(track => trackSelection.has(track.id))
  const openTrackMenu = (event, track) => {
    const ids = trackSelection.contextSelect(track.id)
    const list = albumTracks.filter(item => ids.includes(String(item.id)))
    const count = list.length > 1 ? ` ${list.length} songs` : ''
    menu.open(event, [
      { label: `Play${count}`, icon: Play, onSelect: () => (list.length === 1 ? playQueue(albumTracks, albumTracks.indexOf(list[0]), albumContext) : playQueue(list, 0, albumContext)) },
      { label: 'Play next', icon: Clock, onSelect: () => playNextMany(list) },
      { label: 'Add to queue', icon: ListEnd, onSelect: () => addToQueueMany(list) },
      { label: 'Add to playlist…', icon: Plus, onSelect: () => addToPlaylistMany(list) },
      list.length === 1 && { label: 'Start radio', icon: Radio, onSelect: () => openRadio(navigate, list[0], useAppStore.getState().user?.id) },
      list.length === 1 ? losslessMenuItem(list[0], Gem) : losslessManyMenuItem(list, Gem),
      { separator: true },
      { label: list.length > 1 ? `Delete${count} from library` : 'Delete from library', icon: Trash2, danger: true, onSelect: () => askDeleteTracks(list) },
    ])
  }

  const playAlbumRelease = async (album) => {
    const tracks = await api.getAlbumTracks(album)
    if (Array.isArray(tracks) && tracks.length) {
      playQueue(tracks, 0, makeAlbumContext(album))
    }
  }

  return (
    <div className="min-h-full p-6 pb-10">
      <div className="mx-auto max-w-7xl space-y-8">
        {/* An open album has its own page: no collection header above it. */}
        {!selectedAlbum && <>
        <div className="flex flex-col gap-4 @md:flex-row @md:items-end @md:justify-between">
          <div>
            <p className="text-[11px] font-display uppercase tracking-[0.32em] text-muted">{t("Collection")}</p>
            <h1 className="mt-2 font-display text-3xl uppercase tracking-[0.14em] text-white">{t("Albums")}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted">
                {loadingAlbums ? '\u00a0' : t('{count} visible releases', { count: filteredAlbums.length.toLocaleString() })}
              </p>
              <RefreshButton
                label={t("Refresh releases")}
                loading={refreshStatus.running}
                onClick={() => startReleaseRefresh(albums)}
                className="shrink-0"
              />
            </div>
          </div>
          <div className="flex w-full max-w-xl flex-col gap-3 @sm:flex-row @sm:items-center @sm:justify-end">
            <div className="relative w-full">
              <Search size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Search albums, singles, EPs, or artists...")}
                className="w-full rounded-2xl border border-border bg-elevated/90 pl-11 pr-4 py-3 text-sm text-white outline-none transition-colors focus:border-accent/50 placeholder:text-muted"
              />
            </div>

            <div className="flex items-center gap-2 justify-start @sm:justify-end">
              <ReleaseTypeFilter types={releaseTypes} shown={shownTypes} onToggle={toggleType} />
              <label className="text-[11px] text-muted uppercase tracking-[0.16em]">{t("Sort")}</label>
              <select
                value={settings.album_sort_mode || 'default'}
                onChange={(e) => {
                  const v = e.target.value
                  setSettings((s) => ({ ...s, album_sort_mode: v }))
                  api.saveSettings({ ...settings, album_sort_mode: v })
                }}
                className="bg-elevated/90 border border-border rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
              >
                <option value="default">{t("Default")}</option>
                <option value="newest">{t("Newest")}</option>
              </select>
            </div>
          </div>
        </div>

        {(refreshStatus.running || refreshStatus.finishedAt > 0) && (
          <div className="space-y-2 rounded-2xl border border-border bg-elevated/70 p-4">
            <p role="status" className="text-xs text-muted">
              {refreshStatus.error || (refreshStatus.running
                ? `Refreshing releases · ${refreshStatus.done.toLocaleString()} of ${refreshStatus.total.toLocaleString()} checked · ${refreshStatus.matched.toLocaleString()} matched`
                : `Refresh complete · ${refreshStatus.matched.toLocaleString()} matched${refreshStatus.failed ? ` · ${refreshStatus.failed.toLocaleString()} not found` : ''}`)}
            </p>
            <div role="progressbar" aria-label={t("Release refresh")} aria-valuemin={0} aria-valuemax={refreshStatus.total || 1} aria-valuenow={refreshStatus.done} className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${refreshStatus.total ? refreshStatus.done / refreshStatus.total * 100 : refreshStatus.running ? 0 : 100}%` }} />
            </div>
            {refreshStatus.running && <p className="text-[11px] text-muted/70">{t("You can leave this page; the refresh keeps going.")}</p>}
          </div>
        )}
        </>}

        {selectedAlbum ? (
          <div className="space-y-6">
            <AlbumHero
              album={selectedAlbum}
              trackCount={showOnline ? merged.tracks.length : (albumTracks.length || selectedAlbum.track_count || 0)}
              duration={(showOnline ? merged.tracks : albumTracks).reduce((sum, track) => sum + (Number(track.duration) || 0), 0)}
              online={showOnline ? (merged.owned === merged.tracks.length ? t('All songs are in your library.') : t('{owned} of {total} songs are in your library.', { owned: merged.owned, total: merged.tracks.length })) : ''}
              onBack={() => navigate(-1)}
              onArtist={() => navigate(artistPath(selectedAlbum.album_artist || selectedAlbum.artists))}
            >
              <button onClick={() => (showOnline ? playMerged(merged.tracks[0]) : playQueue(albumTracks, 0, albumContext))} disabled={!(showOnline ? merged.tracks.length : albumTracks.length)}
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90 disabled:opacity-40"><Play size={15} fill="currentColor" /> {t("Play")}</button>
              <button onClick={() => playNextMany(showOnline ? merged.tracks : albumTracks)} disabled={!(showOnline ? merged.tracks.length : albumTracks.length)}
                className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40"><Clock size={15} /> {t("Play next")}</button>
              <button onClick={() => { const list = shuffledList(albumTracks); if (list.length) playQueue(list, 0, albumContext) }} disabled={!albumTracks.length}
                className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40"><Shuffle size={15} /> {t("Shuffle")}</button>
              {albumTracks.length > 0 && (
                <button onClick={toggleConnected} aria-pressed={connected}
                  title={t(connected ? 'Show only your library' : 'Show the whole album, with the songs you have marked')}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors ${connected ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-white hover:border-accent/50'}`}>
                  {connected && onlineAlbum.loading ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />} {t('Full album online')}
                </button>
              )}
              {showOnline && merged.missing.length > 0 && (
                <button onClick={downloadMissing} disabled={downloadingMissing}
                  className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-white transition-colors hover:border-accent/50 disabled:opacity-40">
                  <Download size={15} /> {downloadingMissing ? t('Finding the songs not in your library…') : t('Download missing ({count})', { count: merged.missing.length })}
                </button>
              )}
              {connected && <RefreshButton onClick={() => setReloadOnline(n => n + 1)} loading={onlineAlbum.loading} loadedAt={onlineAlbum.loadedAt} />}
            </AlbumHero>

            {connected && !onlineAlbum.loading && !onlineAlbum.tracks.length && (
              <p role="status" className="text-xs text-muted">{onlineAlbum.error ? t(onlineAlbum.error) : t('This album was not found online.')} {t("Showing your library's songs.")}</p>
            )}

            {showOnline && !loadingTracks ? (
              <OnlineSongList tracks={merged.tracks} numbered markOwned onPlay={playMerged} />
            ) : loadingTracks ? (
              <p role="status" className="text-sm text-muted">{t('Loading {album}…', { album: selectedAlbum.title })}</p>
            ) : albumTracks.length === 0 ? (
              <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted">{t("No tracks found for this release.")}</p>
            ) : (
              <div className="flex flex-col" onClick={trackSelection.clear}>
                <SelectionBar
                  open={trackSelection.count > 0}
                  label={t('{count} selected', { count: trackSelection.count })}
                  onClear={trackSelection.clear}
                  actions={[
                    { label: 'Play', icon: Play, onClick: () => playQueue(selectedAlbumTracks(), 0, albumContext) },
                    { label: 'Play next', icon: Clock, onClick: () => playNextMany(selectedAlbumTracks()) },
                    { label: 'Add to queue', icon: ListEnd, onClick: () => addToQueueMany(selectedAlbumTracks()) },
                    { label: 'Add to playlist', icon: Plus, onClick: () => addToPlaylistMany(selectedAlbumTracks()) },
                    { label: 'Delete', icon: Trash2, danger: true, onClick: () => askDeleteTracks(selectedAlbumTracks()) },
                  ]}
                />
                  {albumTracks.map((track, index) => {
                    const isCurrent = currentTrack?.id === track.id
                    const isHovered = hoveredTrack === track.id
                    const isHighlighted = !!highlightTrackId && track.id === highlightTrackId
                    const isSelected = trackSelection.has(track.id)
                    return (
                      // Ctrl/Cmd+click selects (Shift a range), double click or the
                      // number's play button plays, right click for more.
                      <div
                        key={track.id}
                        ref={isHighlighted ? highlightRowRef : undefined}
                        role="row"
                        tabIndex={0}
                        aria-selected={isSelected}
                        onClick={(event) => { event.stopPropagation(); trackSelection.click(track.id, event) }}
                        onDoubleClick={() => playQueue(albumTracks, index, albumContext)}
                        onKeyDown={(event) => { if (event.key === 'Enter') playQueue(albumTracks, index, albumContext) }}
                        onContextMenu={(event) => openTrackMenu(event, track)}
                        onMouseEnter={() => setHoveredTrack(track.id)}
                        onMouseLeave={() => setHoveredTrack(null)}
                        className={`grid cursor-default select-none grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors focus-visible:bg-white/5 ${isSelected ? 'bg-accent/15' : isCurrent ? 'bg-accent/10' : 'hover:bg-white/5'} ${isHighlighted ? 'ring-2 ring-accent bg-accent/15 animate-pulse' : ''}`}
                      >
                        <div className="flex h-8 w-8 items-center justify-center">
                          {isHovered || isCurrent ? (
                            <button type="button" onClick={(event) => handleTrackPlay(track, index, event)}
                              aria-label={isCurrent && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                              className={isCurrent ? 'text-accent' : 'text-white'}>
                              {isCurrent && isPlaying ? (
                                <Disc3 size={14} className="animate-spin" />
                              ) : (
                                <Play size={14} fill="currentColor" className="translate-x-px" />
                              )}
                            </button>
                          ) : (
                            <span className={`text-xs tabular-nums ${isCurrent ? 'text-accent' : 'text-muted'}`}>
                              {track.display_track_num || track.track_num || index + 1}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className={`truncate text-sm ${isCurrent ? 'text-accent' : 'text-white'}`}>{track.title}</p>
                          <p className="truncate text-xs text-muted">{track.artist}</p>
                        </div>
                        <span className="text-xs tabular-nums text-subtle">
                          {track.duration ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}` : ''}
                        </span>
                      </div>
                    )
                  })}
              </div>
            )}
          </div>
        ) : loadingAlbums ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={28} className="animate-spin text-muted" />
          </div>
        ) : filteredAlbums.length === 0 ? (
          <div className="py-24 text-center">
            <Disc3 size={42} className="mx-auto mb-4 text-muted/30" />
            <p className="text-sm text-muted">{query.trim() ? 'No releases matched that search.' : 'No releases in your library yet.'}</p>
          </div>
        ) : (
          <div className="space-y-10">
            <SelectionBar
              open={releaseSelection.count > 0}
              label={t('{count} releases selected', { count: releaseSelection.count })}
              onClear={releaseSelection.clear}
              actions={releases.barActions(selectedReleases())}
            />
            {groupedAlbums.length === 0 && <p className="text-sm text-muted">{t("No releases of the types chosen.")}</p>}
            {groupedAlbums.map((group) => (
              <section key={group.key} className="space-y-4">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-display uppercase tracking-[0.32em] text-muted">{group.label}</p>
                    <p className="mt-1 text-sm text-white/60">{t('{count} shown', { count: group.items.length })}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 @sm:grid-cols-3 @lg:grid-cols-5 @xl:grid-cols-6">
                  {group.items.map((album, index) => (
                    <AlbumCard
                      key={`${group.key}-${album.title}-${album.album_artist || album.artists || 'release'}-${index}`}
                      album={album}
                      selected={releaseSelection.has(releaseKey(album))}
                      // Ctrl/Cmd or Shift + click selects instead of opening or playing.
                      onClick={(event) => {
                        if (!releaseSelection.click(releaseKey(album), event)) navigate('/albums', { state: { album } })
                      }}
                      onPlay={(event) => {
                        if (!releaseSelection.click(releaseKey(album), event)) playAlbumRelease(album)
                      }}
                      onContextMenu={(event) => openReleaseMenu(event, album)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {releases.elements}
    </div>
  )
}
