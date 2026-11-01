import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, ChevronRight, Folder, Music, Search, Pencil, Trash2, Check, X } from 'lucide-react'
import { api } from '../api'
import { isSuspect, tierOf } from '../quality'
import { fetchAllErrorTrackIds, getFolderPlaybackTracks } from '../libraryHelpers'
import TrackList from './TrackList'
import FadeImg from './FadeImg'
import { useTranslation } from '../i18n'
import ContextMenu, { useContextMenu } from './ContextMenu'

function FolderArtwork({ folder, artSrc }) {
  const explicit = folder?.artwork_path
    ? (api.isElectron ? api.fileURL(folder.artwork_path) : api.folderArtworkURL(folder.artwork_path))
    : null
  const covers = explicit ? [] : (Array.isArray(folder?.artwork_tracks) ? folder.artwork_tracks : [])
    .map(track => track.artwork_path ? artSrc(track) : (track.artwork_url || (track.id ? api.artworkURL(track.id) : null)))
    .filter(Boolean)
    .slice(0, 4)

  if (explicit) return <FadeImg src={explicit} alt="" className="h-full w-full object-cover" />
  if (!covers.length) return null
  if (covers.length === 1) return <FadeImg src={covers[0]} alt="" className="h-full w-full object-cover" />

  return (
    <div className={`grid h-full w-full overflow-hidden ${covers.length === 2 ? 'grid-cols-2 grid-rows-1' : 'grid-cols-2 grid-rows-2'}`}>
      {covers.map((src, index) => (
        <FadeImg key={src + ':' + index} src={src} alt="" className="h-full w-full min-h-0 min-w-0 object-cover" />
      ))}
    </div>
  )
}

export default function LibraryFolderBrowser({
  folderPath,
  onFolderChange,
  onDataChange,
  view,
  playQueue,
  artSrc,
  searchQuery = '',
  onSearchQueryChange,
  rootPath = '',
  filters = {},
}) {
  const { t } = useTranslation()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [errorTrackIds, setErrorTrackIds] = useState(null)
  const [selectedFolderPaths, setSelectedFolderPaths] = useState([])
  const [renameTargets, setRenameTargets] = useState(null)
  const [renameError, setRenameError] = useState('')
  const [folderActionBusy, setFolderActionBusy] = useState(false)
  const [folderActionMessage, setFolderActionMessage] = useState('')
  const [folderActionIsError, setFolderActionIsError] = useState(false)
  const folderMenu = useContextMenu()
  const requestRef = useRef(0)

  useEffect(() => {
    setSelectedFolderPaths([])
    setFolderActionMessage('')
    setRenameTargets(null)
  }, [folderPath, rootPath])

  useEffect(() => {
    if (filters.source !== 'errors') {
      setErrorTrackIds(null)
      return
    }
    let active = true
    fetchAllErrorTrackIds(options => api.getTracks(options))
      .then(ids => { if (active) setErrorTrackIds(ids) })
      .catch(() => { if (active) setErrorTrackIds(new Set()) })
    return () => { active = false }
  }, [filters.source, refreshKey])

  // Folder navigation history stack
  const [history, setHistory] = useState([folderPath || ''])
  const [historyIndex, setHistoryIndex] = useState(0)
  const historyRef = useRef(history)
  historyRef.current = history
  const historyIndexRef = useRef(historyIndex)
  historyIndexRef.current = historyIndex

  const navigateToFolder = (nextPath) => {
    if (nextPath === folderPath) return
    const curHistory = historyRef.current
    const curIndex = historyIndexRef.current
    const newHistory = curHistory.slice(0, curIndex + 1)
    if (newHistory[newHistory.length - 1] !== nextPath) {
      newHistory.push(nextPath)
    }
    setHistory(newHistory)
    setHistoryIndex(newHistory.length - 1)
    onFolderChange(nextPath)
  }

  const goBack = () => {
    const curHistory = historyRef.current
    const curIndex = historyIndexRef.current
    if (curIndex > 0) {
      const prevPath = curHistory[curIndex - 1]
      setHistoryIndex(curIndex - 1)
      onFolderChange(prevPath)
      return true
    }
    const segments = String(folderPath || '').split('/').filter(Boolean)
    if (segments.length > 0) {
      const parent = segments.slice(0, -1).join('/')
      const newHistory = [parent, ...curHistory]
      setHistory(newHistory)
      setHistoryIndex(0)
      onFolderChange(parent)
      return true
    }
    return false
  }

  const goForward = () => {
    const curHistory = historyRef.current
    const curIndex = historyIndexRef.current
    if (curIndex < curHistory.length - 1) {
      const nextPath = curHistory[curIndex + 1]
      setHistoryIndex(curIndex + 1)
      onFolderChange(nextPath)
      return true
    }
    return false
  }

  useEffect(() => {
    const onHistoryNavigate = (event) => {
      const direction = event.detail?.direction
      if (direction === -1) {
        if (goBack()) {
          event.preventDefault()
        }
      } else if (direction === 1) {
        if (goForward()) {
          event.preventDefault()
        }
      }
    }
    window.addEventListener('lokal:history-navigate', onHistoryNavigate)
    return () => window.removeEventListener('lokal:history-navigate', onHistoryNavigate)
  }, [folderPath])

  useEffect(() => {
    const refresh = () => setRefreshKey(value => value + 1)
    window.addEventListener('lokal:refresh', refresh)
    return () => window.removeEventListener('lokal:refresh', refresh)
  }, [])

  useEffect(() => {
    let active = true
    const requestId = ++requestRef.current
    setLoading(true)
    setError('')
    onDataChange?.(null)

    const timer = setTimeout(() => {
      Promise.resolve(api.getLibraryFolders(folderPath, searchQuery.trim(), rootPath)).then(result => {
        if (!active || requestId !== requestRef.current) return
        if (result?.notFound && folderPath) {
          setData(null)
          onDataChange?.(null)
          // Drop a deleted/unavailable path from Back and Forward history.
          const resetHistory = ['']
          historyRef.current = resetHistory
          historyIndexRef.current = 0
          setHistory(resetHistory)
          setHistoryIndex(0)
          onFolderChange('')
          return
        }
        setData(result || null)
        setError(result?.error || '')
      }).catch(err => {
        if (!active || requestId !== requestRef.current) return
        setError(err?.message || 'Could not load this folder')
        onDataChange?.(null)
      }).finally(() => {
        if (active && requestId === requestRef.current) setLoading(false)
      })
    }, searchQuery.trim() ? 150 : 0)

    return () => {
      active = false
      clearTimeout(timer)
      requestRef.current++
    }
  }, [folderPath, rootPath, refreshKey, searchQuery, onFolderChange])


  const handleFolderClick = (event, folder) => {
    if (api.isElectron && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      setFolderActionMessage('')
      setSelectedFolderPaths(current => current.includes(folder.path)
        ? current.filter(folderPath => folderPath !== folder.path)
        : [...current, folder.path])
      return
    }
    setSelectedFolderPaths([])
    navigateToFolder(folder.path)
  }

  const startFolderRename = paths => {
    const targets = paths.map(folderPath => {
      const folder = data?.folders?.find(item => item.path === folderPath)
      const name = folder?.name || folderPath.split('/').pop()
      return { path: folderPath, oldName: name, newName: name }
    })
    setRenameError('')
    setRenameTargets(targets)
  }

  const openFolderMenu = (event, folder) => {
    if (!api.isElectron) return
    const paths = selectedFolderPaths.includes(folder.path) ? selectedFolderPaths : [folder.path]
    if (!selectedFolderPaths.includes(folder.path)) setSelectedFolderPaths(paths)
    setFolderActionMessage('')
    folderMenu.open(event, [
      { label: paths.length === 1 ? 'Rename folder' : 'Rename {n} folders', labelValues: { n: paths.length }, icon: Pencil, onSelect: () => startFolderRename(paths) },
      { separator: true },
      { label: paths.length === 1 ? 'Delete folder…' : 'Delete {n} folders…', labelValues: { n: paths.length }, icon: Trash2, danger: true, onSelect: () => { void deleteFolders(paths) } },
    ])
  }

  const deleteFolders = async paths => {
    if (!api.isElectron || !paths?.length || folderActionBusy) return
    const names = paths.map(folderPath => data?.folders?.find(item => item.path === folderPath)?.name || folderPath.split('/').pop())
    const confirmation = paths.length === 1
      ? t('Move the folder "{name}" and all its contents to the Trash? Its tracks will also be removed from Lokal.', { name: names[0] })
      : t('Move {n} selected folders and all their contents to the Trash? Their tracks will also be removed from Lokal.', { n: paths.length })
    if (!window.confirm(confirmation)) return
    setFolderActionBusy(true)
    setFolderActionMessage('')
    setFolderActionIsError(false)
    try {
      const result = await api.deleteLibraryFolders(paths, rootPath)
      if (result?.deleted?.length) {
        const deleted = new Set(result.deleted)
        setSelectedFolderPaths(current => current.filter(folderPath => !deleted.has(folderPath)))
        window.dispatchEvent(new Event('lokal:refresh'))
      }
      if (result?.error) throw new Error(result.error)
      if (result?.failed?.length) {
        setFolderActionIsError(true)
        setFolderActionMessage(t('Some folders could not be deleted: {folders}', { folders: result.failed.map(item => item.path || item.error).join(', ') }))
      } else {
        setFolderActionMessage(t(paths.length === 1 ? 'Folder moved to Trash.' : 'Folders moved to Trash.'))
      }
    } catch (error) {
      setFolderActionIsError(true)
      setFolderActionMessage(error?.message || t('Could not delete folder'))
    } finally {
      setFolderActionBusy(false)
    }
  }

  const saveFolderRenames = async event => {
    event?.preventDefault?.()
    if (!renameTargets?.length || folderActionBusy) return
    if (renameTargets.some(item => !item.newName?.trim())) {
      setRenameError(t('Folder names cannot be empty'))
      return
    }
    setFolderActionBusy(true)
    setRenameError('')
    try {
      const result = await api.renameLibraryFolders(renameTargets.map(item => ({ path: item.path, newName: item.newName })), rootPath)
      if (result?.error) throw new Error(result.error)
      setRenameTargets(null)
      setSelectedFolderPaths([])
      setFolderActionMessage(t(renameTargets.length === 1 ? 'Folder renamed.' : 'Folders renamed.'))
      setFolderActionIsError(false)
      window.dispatchEvent(new Event('lokal:refresh'))
    } catch (error) {
      setRenameError(error?.message || t('Could not rename folders'))
    } finally {
      setFolderActionBusy(false)
    }
  }

  const term = (searchQuery || '').trim().toLowerCase()
  const matchesFilters = useCallback(track => {
    const selectedSource = filters.source || 'all'
    const downloadSource = String(track.download_source || '')
    if (selectedSource === 'errors' && !errorTrackIds?.has(String(track.id))) return false
    if (selectedSource === 'local' && downloadSource) return false
    if (selectedSource === 'yt' && downloadSource !== 'yt') return false
    if (selectedSource === 'sc' && downloadSource !== 'sc') return false
    if (selectedSource === 'soulseek' && downloadSource !== 'soulseek') return false
    if (selectedSource === 'web' && downloadSource !== 'web') return false
    if (selectedSource === 'addon' && !downloadSource.startsWith('a-')) return false
    if (filters.genre) {
      const genres = [track.genre, track.genres].filter(Boolean).join(',').toLowerCase().split(/[,;]+/).map(value => value.trim())
      if (!genres.includes(String(filters.genre).toLowerCase())) return false
    }
    if (filters.quality) {
      const tier = filters.quality === 'suspect' ? (isSuspect(track) ? 'suspect' : '') : tierOf(track)
      if (tier !== filters.quality) return false
    }
    if (filters.format && `${track.bit_depth}-${track.sample_rate}` !== filters.format) return false
    return true
  }, [filters, errorTrackIds])
  const sortTracks = useCallback(list => {
    const sorted = [...list]
    const cmpText = key => (a, b) => String(a[key] || '').localeCompare(String(b[key] || ''), undefined, { numeric: true, sensitivity: 'base' })
    const cmpTrackNumber = (a, b) => {
      const left = Number(a.track_num)
      const right = Number(b.track_num)
      const hasLeft = Number.isFinite(left) && left > 0
      const hasRight = Number.isFinite(right) && right > 0
      if (hasLeft !== hasRight) return hasLeft ? -1 : 1
      return hasLeft ? left - right : 0
    }
    if (filters.sort === 'title ASC') sorted.sort(cmpText('title'))
    else if (filters.sort === 'artist ASC') sorted.sort(cmpText('artist'))
    else if (filters.sort === 'track_num ASC') sorted.sort(cmpTrackNumber)
    else if (filters.sort === 'play_count DESC') sorted.sort((a, b) => Number(b.play_count || 0) - Number(a.play_count || 0))
    else if (filters.sort === 'duration DESC') sorted.sort((a, b) => Number(b.duration || 0) - Number(a.duration || 0))
    else sorted.sort((a, b) => Number(b.added_at || b.created_at || 0) - Number(a.added_at || a.created_at || 0))
    return sorted
  }, [filters.sort])
  const filterActive = (filters.source && filters.source !== 'all') || !!filters.genre || !!filters.quality || !!filters.format
  const visibleFolders = useMemo(() => {
    if (!data?.folders?.length) return []
    if (!term) return data.folders
    return data.folders.filter(f => f.name.toLowerCase().includes(term))
  }, [data?.folders, term])

  const visibleTracks = useMemo(() => {
    if (!data?.tracks?.length) return []
    return sortTracks(data.tracks.filter(track => (
      (!term ||
        (track.title || '').toLowerCase().includes(term) ||
        (track.artist || '').toLowerCase().includes(term) ||
        (track.album || '').toLowerCase().includes(term)) &&
      matchesFilters(track)
    )))
  }, [data?.tracks, term, matchesFilters, sortTracks])

  const matchingDeepTracks = useMemo(() => {
    if (!term || !data?.deepTracks?.length) return []
    return sortTracks(data.deepTracks.filter(track =>
      !visibleTracks.some(visible => visible.id === track.id) &&
      matchesFilters(track) &&
      ((track.title || '').toLowerCase().includes(term) ||
       (track.artist || '').toLowerCase().includes(term) ||
       (track.album || '').toLowerCase().includes(term))
    ))
  }, [data?.deepTracks, visibleTracks, term, matchesFilters, sortTracks])

  const allVisibleTracks = useMemo(() => getFolderPlaybackTracks({
    term,
    directTracks: visibleTracks,
    hasDirectTracks: !!data?.tracks?.length,
    deepTracks: matchingDeepTracks,
    allTracks: data?.allTracks || [],
    matchesFilters,
    sortTracks,
  }), [term, visibleTracks, data?.tracks, matchingDeepTracks, data?.allTracks, matchesFilters, sortTracks])

  // Sync with parent for Play All and status header
  useEffect(() => {
    if (!data) {
      onDataChange?.(null)
      return
    }
    onDataChange?.({
      ...data,
      filteredTracks: term || filterActive || !!data.tracks?.length || !!data.allTracks?.length ? allVisibleTracks : null,
      matchCount: term || filterActive ? (visibleFolders.length + allVisibleTracks.length) : null,
    })
  }, [data, term, filterActive, allVisibleTracks, visibleFolders.length, onDataChange])

  const segments = String(data?.relativePath || '').split('/').filter(Boolean)
  const currentFolder = segments.length ? segments[segments.length - 1] : (data?.rootName || 'Music folder')
  const isCurrentPath = !!data && data.relativePath === folderPath
  const displayedError = error || (isCurrentPath ? data?.error : '')
  const canGoBack = historyIndex > 0 || segments.length > 0
  const canGoForward = historyIndex < history.length - 1

  return (
    <div className="space-y-4">
      {isCurrentPath && data?.available && !data.error && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted" aria-label="Library folder path">
          <div className="mr-1 flex items-center gap-1">
            {canGoBack && (
              <button
                type="button"
                onClick={goBack}
                aria-label={t("Go back")}
                title={t("Go back")}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-elevated transition-colors hover:text-white"
              >
                <ArrowLeft size={13} />
              </button>
            )}
            {canGoForward && (
              <button
                type="button"
                onClick={goForward}
                aria-label={t("Go forward")}
                title={t("Go forward")}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-elevated transition-colors hover:text-white"
              >
                <ArrowRight size={13} />
              </button>
            )}
          </div>
          <button type="button" onClick={() => navigateToFolder('')} className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 transition-colors hover:text-white">
            <Folder size={13} className="flex-shrink-0" />
            <span className="max-w-36 truncate">{data.rootName}</span>
          </button>
          {segments.map((segment, index) => {
            const target = segments.slice(0, index + 1).join('/')
            return (
              <React.Fragment key={target}>
                <ChevronRight size={12} className="flex-shrink-0 opacity-50" />
                <button type="button" onClick={() => navigateToFolder(target)} className="max-w-40 truncate rounded-md px-1 py-1 text-white transition-colors hover:text-accent" title={segment}>
                  {segment}
                </button>
              </React.Fragment>
            )
          })}
          <span className="sr-only">{currentFolder}</span>
        </div>
      )}

      {loading && <p className="text-xs text-muted" role="status">{t("Loading folder…")}</p>}

      {displayedError && (
        <div className="rounded-xl border border-border bg-elevated px-5 py-10 text-center text-muted">
          <Folder size={34} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{displayedError}</p>
          {!data?.available && <p className="mt-2 text-xs">{t("Select a music folder above to browse it here.")}</p>}
        </div>
      )}

      {isCurrentPath && data?.available && !displayedError && (
        <motion.div
          key={data.relativePath || 'library-root'}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16 }}
          className="space-y-5"
        >
          {api.isElectron && selectedFolderPaths.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2">
              <span className="mr-auto text-xs text-white">{t('{n} folders selected', { n: selectedFolderPaths.length })}</span>
              <span className="text-[11px] text-muted">{t('Ctrl/Cmd-click folders to add or remove selection')}</span>
              <button type="button" disabled={folderActionBusy} onClick={() => startFolderRename(selectedFolderPaths)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-white hover:border-accent/40 disabled:opacity-50"><Pencil size={13} /> {t('Rename')}</button>
              <button type="button" disabled={folderActionBusy} onClick={() => { void deleteFolders(selectedFolderPaths) }} className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/15 disabled:opacity-50"><Trash2 size={13} /> {t('Delete')}</button>
              <button type="button" onClick={() => setSelectedFolderPaths([])} className="rounded-lg px-2 py-1.5 text-xs text-muted hover:text-white">{t('Clear')}</button>
            </div>
          )}
          {folderActionMessage && (
            <p role={folderActionIsError ? 'alert' : 'status'} className={`text-xs ${folderActionIsError ? 'text-red-400' : 'text-emerald-400'}`}>{folderActionMessage}</p>
          )}
          {visibleFolders.length > 0 && view === 'grid' && (
            <div className="grid grid-cols-2 @sm:grid-cols-3 @md:grid-cols-4 @lg:grid-cols-5 gap-3">
              {visibleFolders.map(folder => {
                const selected = selectedFolderPaths.includes(folder.path)
                return (
                  <motion.button
                    key={folder.path}
                    type="button"
                    initial={false}
                    whileHover={{ y: -3 }}
                    aria-pressed={selected}
                    onClick={event => handleFolderClick(event, folder)}
                    onContextMenu={event => openFolderMenu(event, folder)}
                    className={`group flex min-w-0 flex-col gap-2 rounded-xl p-1.5 text-left transition-colors ${selected ? 'bg-accent/10 ring-1 ring-accent/60' : 'hover:bg-elevated/40'}`}
                  >
                    <div className={`relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl border bg-elevated transition-colors ${selected ? 'border-accent' : 'border-border group-hover:border-accent/40 group-hover:bg-accent/5'}`}>
                      <FolderArtwork folder={folder} artSrc={artSrc} />
                      {!folder.artwork_path && !(folder.artwork_tracks || []).length && (
                        <Folder size={42} strokeWidth={1.5} className={`transition-colors ${selected ? 'text-accent' : 'text-muted group-hover:text-accent'}`} />
                      )}
                      {selected && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-base shadow"><Check size={14} /></span>}
                    </div>
                    <div className="w-full min-w-0 px-1">
                      <p className="truncate text-xs font-medium text-white" title={folder.name}>{folder.name}</p>
                      <p className="text-[11px] text-muted">
                        {folder.trackCount != null ? `${folder.trackCount} ${folder.trackCount === 1 ? t('track') : t('tracks')}` : t('Folder')}
                      </p>
                    </div>
                  </motion.button>
                )
              })}
            </div>
          )}

          {visibleFolders.length > 0 && view === 'list' && (
            <div className="overflow-hidden rounded-xl border border-border bg-card/40 divide-y divide-border">
              {visibleFolders.map(folder => {
                const selected = selectedFolderPaths.includes(folder.path)
                return (
                  <button
                    key={folder.path}
                    type="button"
                    aria-pressed={selected}
                    onClick={event => handleFolderClick(event, folder)}
                    onContextMenu={event => openFolderMenu(event, folder)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${selected ? 'bg-accent/10 ring-1 ring-inset ring-accent/60' : 'hover:bg-elevated/80'}`}
                  >
                    <div className={`relative flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border bg-elevated ${selected ? 'border-accent' : 'border-border'}`}>
                      <FolderArtwork folder={folder} artSrc={artSrc} />
                      {!folder.artwork_path && !(folder.artwork_tracks || []).length && <Folder size={17} className={selected ? 'text-accent' : 'text-muted'} />}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-sm text-white">{folder.name}</span>
                    {folder.trackCount != null && (
                      <span className="flex-shrink-0 text-xs text-muted">
                        {folder.trackCount} {folder.trackCount === 1 ? t('track') : t('tracks')}
                      </span>
                    )}
                    {selected ? <Check size={15} className="flex-shrink-0 text-accent" /> : <ChevronRight size={14} className="flex-shrink-0 text-muted" />}
                  </button>
                )
              })}
            </div>
          )}

          {visibleTracks.length > 0 && view === 'list' && (
            <TrackList tracks={visibleTracks} showQuality reduceMotion context={{ type: 'library-folder' }} />
          )}

          {visibleTracks.length > 0 && view === 'grid' && (
            <div className="grid grid-cols-3 @sm:grid-cols-4 @md:grid-cols-5 gap-3">
              {visibleTracks.map((track, index) => {
                const src = artSrc(track)
                return (
                  <motion.button
                    key={track.id}
                    type="button"
                    initial={false}
                    whileHover={{ y: -2 }}
                    onDoubleClick={() => playQueue(visibleTracks, index, { type: 'library-folder' })}
                    className="group flex min-w-0 flex-col gap-2 text-left"
                  >
                    <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-elevated">
                      {src
                        ? <FadeImg src={src} alt={track.title} className="h-full w-full object-cover" />
                        : <Music size={28} className="text-muted" />}
                    </div>
                    <div className="w-full min-w-0">
                      <p className="truncate text-xs font-medium text-white">{track.title}</p>
                      <p className="truncate text-xs text-muted">{track.artist}</p>
                    </div>
                  </motion.button>
                )
              })}
            </div>
          )}

          {matchingDeepTracks.length > 0 && view === 'list' && (
            <div className="space-y-3 pt-4 border-t border-border/50">
              <div className="flex items-center gap-2">
                <Folder size={14} className="text-muted" />
                <h2 className="text-xs font-display text-muted uppercase tracking-widest">{t("Tracks in subfolders")}</h2>
              </div>
              <TrackList
                tracks={matchingDeepTracks}
                showQuality
                reduceMotion
                context={{ type: 'library-folder' }}
                extraColumns={[{ key: 'subfolderPath', label: t('Music folder'), width: 10, render: track => track.subfolderPath || '' }]}
              />
            </div>
          )}

          {matchingDeepTracks.length > 0 && view === 'grid' && (
            <div className="space-y-3 pt-4 border-t border-border/50">
              <div className="flex items-center gap-2">
                <Folder size={14} className="text-muted" />
                <h2 className="text-xs font-display text-muted uppercase tracking-widest">{t("Tracks in subfolders")}</h2>
              </div>
              <div className="grid grid-cols-3 @sm:grid-cols-4 @md:grid-cols-5 gap-3">
                {matchingDeepTracks.map((track, index) => {
                  const src = artSrc(track)
                  return (
                    <motion.button
                      key={track.id}
                      type="button"
                      initial={false}
                      whileHover={{ y: -2 }}
                      onDoubleClick={() => playQueue(matchingDeepTracks, index, { type: 'library-folder' })}
                      className="group flex min-w-0 flex-col gap-2 text-left"
                    >
                      <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-elevated">
                        {src
                          ? <FadeImg src={src} alt={track.title} className="h-full w-full object-cover" />
                          : <Music size={28} className="text-muted" />}
                      </div>
                      <div className="w-full min-w-0">
                        <p className="truncate text-xs font-medium text-white">{track.title}</p>
                        <p className="truncate text-xs text-muted">{track.artist}</p>
                        {track.subfolderPath && (
                          <p className="truncate text-[10px] text-accent/80" title={track.subfolderPath}>{track.subfolderPath}</p>
                        )}
                      </div>
                    </motion.button>
                  )
                })}
              </div>
            </div>
          )}

          {term && !visibleFolders.length && !visibleTracks.length && !matchingDeepTracks.length && (
            <div className="rounded-xl border border-border bg-elevated px-5 py-16 text-center text-muted">
              <Search size={36} className="mx-auto mb-3 opacity-25" />
              <p className="text-sm">{t("No folders or tracks match")} “{searchQuery}”.</p>
              {onSearchQueryChange && (
                <button
                  type="button"
                  onClick={() => onSearchQueryChange('')}
                  className="mt-3 text-xs text-accent transition-colors hover:text-accent/70"
                >
                  {t("Clear search")}
                </button>
              )}
            </div>
          )}

          {!term && !data.folders?.length && !data.tracks?.length && (
            <div className="py-20 text-center text-muted">
              <Folder size={42} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm">{t("This folder is empty.")}</p>
            </div>
          )}
        </motion.div>
      )}
      {renameTargets && (
        <div className="fixed inset-0 z-[190] flex items-center justify-center bg-black/65 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !folderActionBusy) setRenameTargets(null) }}>
          <form onSubmit={saveFolderRenames} className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="rename-folders-title">
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 id="rename-folders-title" className="text-sm font-semibold text-white">{renameTargets.length === 1 ? t('Rename folder') : t('Rename {n} folders', { n: renameTargets.length })}</h2>
                <p className="mt-1 text-xs text-muted">{t('Enter a new name for each selected folder.')}</p>
              </div>
              <button type="button" disabled={folderActionBusy} onClick={() => setRenameTargets(null)} aria-label={t('Cancel')} className="rounded-lg p-1.5 text-muted hover:text-white disabled:opacity-50"><X size={16} /></button>
            </div>
            <div className="space-y-3 overflow-y-auto px-5 py-4">
              {renameTargets.map((item, index) => (
                <label key={item.path} className="block min-w-0">
                  <span className="mb-1 block truncate text-xs text-muted" title={item.oldName}>{item.oldName}</span>
                  <input
                    autoFocus={index === 0}
                    value={item.newName}
                    onChange={event => setRenameTargets(current => current?.map((target, targetIndex) => targetIndex === index ? { ...target, newName: event.target.value } : target) || null)}
                    disabled={folderActionBusy}
                    maxLength={255}
                    className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-white outline-none focus:border-accent/50 disabled:opacity-50"
                  />
                </label>
              ))}
              {renameError && <p className="text-xs text-red-400" role="alert">{renameError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
              <button type="button" disabled={folderActionBusy} onClick={() => setRenameTargets(null)} className="rounded-lg border border-border px-3 py-2 text-xs text-muted hover:text-white disabled:opacity-50">{t('Cancel')}</button>
              <button type="submit" disabled={folderActionBusy || renameTargets.some(item => !item.newName?.trim())} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-base hover:opacity-90 disabled:opacity-50">{folderActionBusy ? t('Renaming…') : t('Save names')}</button>
            </div>
          </form>
        </div>
      )}
      <ContextMenu menu={folderMenu} />
    </div>
  )
}
