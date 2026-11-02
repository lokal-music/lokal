// An artist who isn't in the library (the artist shortcut of a streamed
// song): their popular songs and their albums, from the catalogue, played
// and downloaded from the playback sources. Shown by the Artist page when
// the library has no such artist. The library's artist pages use the same
// sections ("More online"): with the songs the library has marked, and only
// the albums it doesn't have.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, CircleDashed, Clock, Disc3, Download, Music, Play, Radio, Shuffle } from 'lucide-react'
import ContextMenu, { useContextMenu } from './ContextMenu'
import DiscoveryImage from './DiscoveryImage'
import ImageZoom from './ImageZoom'
import OnlineSongList from './OnlineSongList'
import RefreshButton from './RefreshButton'
import ReleaseTypeFilter from './ReleaseTypeFilter'
import { classifyOnlineReleases, groupReleases, releaseTypeCounts, useReleaseTypes } from '../releaseTypes'
import { libraryAlbumCounts, releaseOwnership, artistCacheKey, keepOnline, peekOnline, loadOnlineAlbumCached, loadAddonArtist, loadArtistChannel, loadOnlineArtistAlbums, loadOnlineArtistSongs, mergeWithLibrary, onlineAlbumPath, releaseTitleKey } from '../onlineBrowse'
import { downloadOnline, playOnline } from '../onlineActions'
import { playNextMany } from '../trackActions'
import { openRadio } from '../radioActions'
import { recommendationKey } from '../recommendations'
import { showToast } from './Toaster'
import { useAppStore } from '../store/player'
import { api } from '../api'
import FollowArtistButton from './FollowArtistButton'
import { useTranslation } from '../i18n'
import { useArtistVisuals } from '../artistVisuals'
import { ArtistTitle, ArtistMotionPortrait } from './ArtistEditorialMedia'

/**
 * "In library" (all of a release) or "1/9" / "1 song" (part of it), for a
 * release card. `ownership` from releaseOwnership.
 */
export function OwnershipBadge({ ownership }) {
  const { t } = useTranslation()
  if (!ownership) return null
  const { owned, total, full } = ownership
  const countLabel = total ? t('{owned} of {total} songs in your library', { owned, total }) : t('{count} songs in your library', { count: owned })
  return (
    <span title={full ? t('In your library') : countLabel}
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${full ? 'bg-accent/15 text-accent' : 'border border-accent/40 text-accent/90'}`}>
      {full ? <CheckCircle2 size={10} /> : <CircleDashed size={10} />}
      {full ? t('In library') : total ? `${owned}/${total}` : t('{count} songs', { count: owned })}
    </span>
  )
}

/** "a-earth-wind-fire" -> "Earth Wind Fire" (until the songs give the real name). */
export const nameFromSlug = id => String(id || '').replace(/^a-/, '').split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ')

/**
 * An artist's popular songs and albums online: { songs, albums, name,
 * refresh, loadedAt } (nothing loads until `enabled`). From their YouTube
 * Music channel when it can be told apart from namesakes (`anchor`: a song
 * of theirs; `hints`: the library's titles by them), else by name. Kept once
 * loaded (see cachedOnline): coming back shows it at once; refresh() looks
 * it up again.
 */
export function useOnlineArtist(fallbackName, enabled = true, { anchor = null, hints = [] } = {}) {
  const cacheKey = artistCacheKey(fallbackName, anchor)
  const fromCache = () => peekOnline(cacheKey)
  const [songs, setSongs] = useState(() => fromCache()?.value.songs || { loading: true, tracks: [], error: '' })
  const [albums, setAlbums] = useState(() => fromCache()?.value.albums || { loading: true, items: [] })
  const [loadedAt, setLoadedAt] = useState(() => fromCache()?.at || 0)
  const [reload, setReload] = useState(0)
  const request = useRef(0)

  // The artist's own spelling ("Earth, Wind & Fire"), from their songs.
  const searched = songs.name || fallbackName
  const wanted = recommendationKey(searched)
  const name = songs.tracks.flatMap(track => [...(track.artists || []), track.artist]).find(artist => recommendationKey(artist) === wanted) || searched

  useEffect(() => {
    if (!enabled || !fallbackName) return undefined
    // Spotify/Apple artist IDs scope this page and its cache; they are not
    // YouTube channel IDs or Morneye add-on artist IDs.
    const lookupAnchor = String(anchor?.provider || '').startsWith('catalogue:')
      ? null : anchor
    const version = ++request.current
    const isCurrent = () => version === request.current
    const cached = reload ? null : fromCache()
    if (cached) {
      setSongs(cached.value.songs)
      setAlbums(cached.value.albums)
      setLoadedAt(cached.at)
      return () => { request.current++ }
    }
    setSongs({ loading: true, tracks: [], error: '' })
    setAlbums({ loading: true, items: [] })
    const done = (nextSongs, nextAlbums) => {
      if (!isCurrent()) return
      setSongs(nextSongs)
      setAlbums(nextAlbums)
      setLoadedAt(Date.now())
      if (nextSongs.tracks.length || nextAlbums.items.length) keepOnline(cacheKey, { songs: nextSongs, albums: nextAlbums })
    }
    ;(async () => {
      // A click from an add-on's Artists tab already identifies the source and
      // artist ID. Load that exact artist before any name-based lookup, which
      // could otherwise open a namesake from YouTube Music or another source.
      if (anchor?.artistId && String(anchor?.provider || '').startsWith('a-')) {
        const direct = await loadAddonArtist(fallbackName, { anchor: lookupAnchor, hints }).catch(() => null)
        if (!isCurrent()) return
        if (direct) {
          done({ loading: false, tracks: direct.tracks, error: '', name: direct.name, image: direct.image }, { loading: false, items: direct.albums })
          return
        }
      }

      // YouTube Music's channel of this very artist first, then the
      // catalogues by name (YouTube Music, Last.fm), then an addon with artist
      // pages, then a search of the playback sources.
      const channel = await loadArtistChannel(fallbackName, { anchor: lookupAnchor, hints })
      if (!isCurrent()) return
      if (channel) {
        done({ loading: false, tracks: channel.tracks, error: '', name: channel.name, image: channel.image }, { loading: false, items: channel.albums })
        return
      }
      // "Drake, Future": the whole name first, then the first artist.
      const names = [...new Set([fallbackName, fallbackName.split(',')[0].trim()])].filter(Boolean)
      let result = { tracks: [], error: '' }
      let found = fallbackName
      for (const candidate of names) {
        result = await loadOnlineArtistSongs(candidate, undefined, { isCurrent, searchSources: false })
        if (!isCurrent()) return
        found = candidate
        if (result.tracks.length) break
      }
      if (!result.tracks.length) {
        const fromAddon = await loadAddonArtist(fallbackName, { anchor: lookupAnchor, hints }).catch(() => null)
        if (!isCurrent()) return
        if (fromAddon) {
          done({ loading: false, tracks: fromAddon.tracks, error: '', name: fromAddon.name, image: fromAddon.image }, { loading: false, items: fromAddon.albums })
          return
        }
        result = await loadOnlineArtistSongs(fallbackName, undefined, { isCurrent, skipSources: ['youtube', 'lastfm'] })
        if (!isCurrent()) return
        found = fallbackName
      }
      const nextSongs = { loading: false, tracks: result.tracks, error: result.error, name: found }
      setSongs(nextSongs)
      const items = await loadOnlineArtistAlbums(found, result.tracks)
      done(nextSongs, { loading: false, items })
    })()
    return () => { request.current++ }
  }, [fallbackName, enabled, reload, anchor?.provider, anchor?.artistId, anchor?.title]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => setReload(n => n + 1), [])
  return { songs, albums, name, refresh, loadedAt, loading: songs.loading || albums.loading }
}

/**
 * Popular songs and albums of `data` (useOnlineArtist).
 * @param libraryTracks  the library's songs by them: marked in the list, played from the files
 * @param libraryAlbums  the library's releases by them: left out of the albums ("More albums")
 */
export function OnlineArtistSections({ data, path, libraryTracks = null, libraryAlbums = null, shownTypes = null }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const menu = useContextMenu()
  const { songs, albums, name } = data
  const [busy, setBusy] = useState(false)
  const inLibrary = !!libraryTracks
  // On the library's artist page (it passes its releases): owned albums are
  // left out here. On the online page: they're shown, marked.
  const libraryPage = !!libraryAlbums
  const albumCounts = useMemo(() => libraryAlbumCounts(libraryTracks || []), [libraryTracks])
  const popular = useMemo(() => {
    const top = songs.tracks.slice(0, 10)
    return inLibrary ? mergeWithLibrary(top, libraryTracks) : { tracks: top, missing: top }
  }, [songs.tracks, libraryTracks, inLibrary])
  // Only what the library has as merged in: not its other songs at the end.
  const popularTracks = inLibrary ? popular.tracks.slice(0, Math.min(10, songs.tracks.length)) : popular.tracks
  // Five, then ten with "Show more" (playing one queues all ten).
  const [allPopular, setAllPopular] = useState(false)
  const shownPopular = allPopular ? popularTracks : popularTracks.slice(0, 5)
  const owned = useMemo(() => new Set((libraryAlbums || []).map(album => releaseTitleKey(album.title))), [libraryAlbums])
  const albumItems = useMemo(() => classifyOnlineReleases(
    libraryAlbums ? albums.items.filter(album => !owned.has(releaseTitleKey(album.title))) : albums.items,
  ), [albums.items, owned, libraryAlbums])
  // In sections by type; the types shown chosen per artist (the library's
  // artist page passes its own choice in, so both follow one setting).
  const [ownShown, toggleType] = useReleaseTypes(name)
  const shown = shownTypes || ownShown
  const albumGroups = useMemo(() => groupReleases(albumItems, shown), [albumItems, shown])
  const albumTypes = useMemo(() => releaseTypeCounts(albumItems), [albumItems])

  const play = (selected, list = popularTracks) => playOnline(list, { selected, name, path })
  const albumPath = album => onlineAlbumPath({ artist: album.artist || name, album: album.title, albumId: album.albumId, provider: album.provider, sourceAlbumId: album.sourceAlbumId })
  const openAlbum = album => nav(albumPath(album), { state: { artwork: album.artwork_url || null } })
  const albumTracks = async album => {
    const result = await loadOnlineAlbumCached({ artist: album.artist || name, album: album.title, albumId: album.albumId, artwork: album.artwork_url, provider: album.provider, sourceAlbumId: album.sourceAlbumId })
    if (!result.tracks.length) showToast(result.error || `No songs were found for “${album.title}”.`)
    return result.tracks
  }
  const withBusy = async work => {
    if (busy) return
    setBusy(true)
    try { await work() } finally { setBusy(false) }
  }
  const openAlbumMenu = (event, album) => menu.open(event, [
    { label: t('Play album'), icon: Play, onSelect: async () => { const tracks = await albumTracks(album); if (tracks.length) playOnline(tracks, { name: album.title, path: albumPath(album) }) } },
    { label: t('Download album'), icon: Download, onSelect: () => withBusy(async () => { const tracks = await albumTracks(album); if (tracks.length) await downloadOnline(tracks, { label: `“${album.title}”` }) }) },
    { separator: true },
    { label: t('Open album'), icon: Disc3, onSelect: () => openAlbum(album) },
  ])

  return (
    <>
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xs font-display uppercase tracking-widest text-muted">{t(libraryPage ? 'Popular online' : 'Popular')}</h2>
          {inLibrary && popular.missing.length > 0 && (libraryPage || popular.missing.length < popularTracks.length) && (
            <button onClick={() => withBusy(() => downloadOnline(popular.missing, { label: t('{count} songs', { count: popular.missing.length }) }))} disabled={busy} className="inline-flex items-center gap-1.5 text-xs text-accent transition-opacity hover:opacity-80 disabled:opacity-50"><Download size={13} /> {busy ? t('Finding songs…') : t('Download missing ({count})', { count: popular.missing.length })}</button>
          )}
        </div>
        {songs.loading
          ? <p role="status" className="text-sm text-muted">Loading {name}'s songs…</p>
          : popularTracks.length
            ? <>
              <OnlineSongList tracks={shownPopular} showAlbum markOwned={inLibrary} onPlay={track => play(track)} />
              {popularTracks.length > 5 && (
                <button type="button" onClick={() => setAllPopular(value => !value)} aria-expanded={allPopular}
                  className="mt-2 px-2 text-xs font-medium text-muted transition-colors hover:text-white">
                  {t(allPopular ? 'Show less' : 'Show more')}
                </button>
              )}
            </>
            : <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted">{songs.error ? t(songs.error) : t('No songs were found for {artist}.', { artist: name })}</p>}
      </section>

      {(albums.loading ? !songs.loading : albumItems.length > 0) && (
        <section aria-label={t(libraryAlbums ? 'More releases online' : 'Releases')}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-display uppercase tracking-widest text-muted">{t(libraryAlbums ? 'More releases online' : 'Releases')}</h2>
            {!shownTypes && !albums.loading && <ReleaseTypeFilter types={albumTypes} shown={shown} onToggle={toggleType} />}
          </div>
          {albums.loading
            ? <p role="status" className="text-sm text-muted">{t('Loading albums…')}</p>
            : albumGroups.length === 0
              ? <p className="text-sm text-muted">{t('No releases of the types chosen.')}</p>
              : (
                <div className="space-y-6">
                  {albumGroups.map(group => (
                    <div key={group.type}>
                      {(albumGroups.length > 1 || group.type !== 'album') && <h3 className="mb-2 text-[11px] font-display uppercase tracking-[0.28em] text-white/50">{group.label} <span className="text-muted">· {group.items.length}</span></h3>}
                      <div className="grid grid-cols-2 gap-4 @md:grid-cols-4 @xl:grid-cols-6">
                        {group.items.map(album => (
            <button key={`${album.title}-${album.sourceAlbumId || album.albumId || ''}`} onClick={() => openAlbum(album)} onContextMenu={event => openAlbumMenu(event, album)} className="group text-left">
                            <div className="aspect-square overflow-hidden rounded-xl border border-border bg-elevated">
                              <DiscoveryImage item={album} type="album" src={album.artwork_url} lookup className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" fallback={<div className="flex h-full w-full items-center justify-center text-muted"><Disc3 size={32} /></div>} />
                            </div>
                            <p className="mt-2 flex items-center gap-1.5 text-sm text-white"><span className="truncate">{album.title}</span><OwnershipBadge ownership={releaseOwnership(album, albumCounts)} /></p>
                            <p className="truncate text-xs text-muted">{[album.year, album.track_count ? t('{count} tracks', { count: album.track_count }) : null].filter(Boolean).join(' · ') || t(group.label.replace(/s$/, ''))}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
        </section>
      )}
      <ContextMenu menu={menu} />
    </>
  )
}

export default function OnlineArtist({ id, name: givenName, anchor = null, catalogueIdentity = null }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const userId = useAppStore(state => state.user?.id)
  const data = useOnlineArtist(givenName || nameFromSlug(id), true, { anchor })
  // Songs of theirs in the library (downloaded since this page opened, say):
  // marked "In library" here; the page itself stays as it is.
  const [libraryTracks, setLibraryTracks] = useState([])
  useEffect(() => {
    // The slug can refer to a different library namesake. Without a proven
    // identity match, never mark its songs as owned by a catalogue artist.
    if (catalogueIdentity) { setLibraryTracks([]); return }
    let current = true
    const read = () => Promise.resolve(api.getArtist(id)).then(found => { if (current) setLibraryTracks(Array.isArray(found?.tracks) ? found.tracks : []) }).catch(() => {})
    read()
    window.addEventListener('lokal:refresh', read)
    return () => { current = false; window.removeEventListener('lokal:refresh', read) }
  }, [id, catalogueIdentity?.catalogue, catalogueIdentity?.artistId])
  const { songs, albums, name } = data
  const artistEvidence = useMemo(() => [...songs.tracks.map(track => track.title), ...albums.items.map(album => album.title)].filter(Boolean), [songs.tracks, albums.items])
  const artistVisuals = useArtistVisuals(`online:${catalogueIdentity?.catalogue || anchor?.provider || 'unknown'}:${catalogueIdentity?.artistId || anchor?.artistId || id}`, name, artistEvidence)
  const [busy, setBusy] = useState(false)
  // The artist's picture, big (click it).
  const [zoom, setZoom] = useState(false)
  const play = (selected, list = songs.tracks) => playOnline(list, { selected, name, path: `/artist/${id}` })
  const downloadPopular = async () => {
    if (busy) return
    setBusy(true)
    try { await downloadOnline(songs.tracks, { label: `${name}'s popular songs` }) } finally { setBusy(false) }
  }
  const image = songs.image || songs.tracks.find(track => track.artwork_url)?.artwork_url || albums.items.find(album => album.artwork_url)?.artwork_url || ''

  return (
    <div className="pb-8">
      <div className="relative h-56 overflow-hidden">
        <button onClick={() => nav(-1)} className="absolute left-6 top-4 z-10 inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-sm transition-colors hover:text-white @md:left-8 @md:top-5">
          <ArrowLeft size={14} /> {t('Back')}
        </button>
        {image ? <img src={image} alt="" className="h-full w-full object-cover opacity-30 blur-sm" /> : <div className="h-full w-full bg-gradient-to-b from-accent/8 to-transparent" />}
        <div className="absolute inset-0 bg-gradient-to-t from-base via-base/20" />
        <div className="absolute bottom-5 left-8 right-8 flex items-end gap-5">
          <button type="button" onClick={image ? () => setZoom(true) : undefined} disabled={!image} title={image ? t('View the picture') : undefined} className={`flex h-24 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-border bg-elevated ${image ? 'cursor-zoom-in' : 'cursor-default'}`}>
            {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : <Music size={36} className="text-muted" />}
            <ArtistMotionPortrait src={artistVisuals.motionSrc} />
          </button>
          <ImageZoom src={image} alt={name} open={zoom} onClose={() => setZoom(false)} />
          <div className="min-w-0">
            <p className="mb-1 text-xs font-display uppercase tracking-widest text-muted">{t('Artist · Online')}</p>
            <ArtistTitle name={name} logoSrc={artistVisuals.logoSrc} logoAspect={artistVisuals.logoAspect} />
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => play(songs.tracks[0])} disabled={!songs.tracks.length} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-base transition-opacity hover:opacity-90 disabled:opacity-40"><Play size={15} fill="currentColor" /> {t('Play')}</button>
              <button onClick={() => playNextMany(songs.tracks)} disabled={!songs.tracks.length} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-4 py-2 text-sm text-white backdrop-blur-sm transition-colors hover:border-accent/50 disabled:opacity-40"><Clock size={15} /> {t('Play next')}</button>
              <button onClick={() => { const list = [...songs.tracks]; for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]] } if (list.length) play(list[0], list) }} disabled={!songs.tracks.length} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-4 py-2 text-sm text-white backdrop-blur-sm transition-colors hover:border-accent/50 disabled:opacity-40"><Shuffle size={15} /> {t('Shuffle')}</button>
              <button onClick={() => openRadio(nav, { artist: name, type: 'artist' }, userId)} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-4 py-2 text-sm text-white backdrop-blur-sm transition-colors hover:border-accent/50"><Radio size={15} /> {t('Artist radio')}</button>
              <button onClick={downloadPopular} disabled={!songs.tracks.length || busy} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-4 py-2 text-sm text-white backdrop-blur-sm transition-colors hover:border-accent/50 disabled:opacity-40"><Download size={15} /> {busy ? t('Finding songs…') : t('Download popular songs')}</button>
              <RefreshButton onClick={data.refresh} loading={data.loading} loadedAt={data.loadedAt} className="border-white/15 bg-black/30 backdrop-blur-sm" />
              <FollowArtistButton name={name} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-4 py-2 text-sm text-white" />
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-8 px-6 pt-6 @md:px-8">
        <OnlineArtistSections data={data} path={`/artist/${id}`} libraryTracks={libraryTracks} />
      </div>
    </div>
  )
}
