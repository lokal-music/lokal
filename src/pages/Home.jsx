import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CalendarDays, ChevronDown, ChevronUp, Clock, Disc3, Download, History, ListEnd, ListPlus, Music, Play, Plus, Radio, RefreshCw, Sparkles, User, UserMinus, UserPlus, Pencil } from 'lucide-react'
import { usePlayerStore, useAppStore } from '../store/player'
import TrackList from '../components/TrackList'
import FadeImg from '../components/FadeImg'
import QualityImage from '../components/QualityImage'
import DiscoveryImage from '../components/DiscoveryImage'
import SaveToLibraryButton from '../components/SaveToLibraryButton'
import SectionSwap from '../components/SectionSwap'
import { api } from '../api'
import { useCachedState, usePageReady } from '../pageCache'
import { plural } from '../plural'
import ContextMenu, { useContextMenu } from '../components/ContextMenu'
import { showToast, showLoadingToast } from '../components/Toaster'
import { addToPlaylistMany, addToQueueMany, playNextMany, saveAsPlaylist } from '../trackActions'
import { artistPath } from '../releaseActions'
import ProviderConnections from '../components/ProviderConnections'
import { libraryDownloadMessage, saveTracksToLibrary, trackArtURL } from '../onlineTracks'
import { openRadio } from '../radioActions'
import { songKey, sourceName, resolveRecommendationTracks, playbackFallbackMessage, dispatchAddonVerificationRequired, isAddonVerificationRequiredError } from '../recommendations'
import { recommendationSession, rememberHomePath } from '../recommendationSession'
import { useTranslation } from '../i18n'
import { playRecommendationPool } from '../recommendationPlayback'
import { loadDiscoveryCatalogue } from '../discoveryCatalogue'
import { discoveryArtistKey, initFollowedArtists, loadDiscoveryArtists, setArtistFollowed, useDiscoveryArtists } from '../discoveryArtists'
import ReleasesPanel from '../components/ReleasesPanel'
import { onlineAlbumPath } from '../onlineBrowse'
import UnfollowedArtists from '../components/UnfollowedArtists'
import MadeForYou from '../components/MadeForYou'
import DiscoveryShelfEditor from '../components/DiscoveryShelfEditor'
import { DISCOVERY_SHELF_DEFAULTS, DISCOVERY_SHELF_TITLES, readShelfLayout, restoreShelfLayout, visibleShelfIds, writeShelfLayout } from '../discoveryShelfLayout.mjs'
import FlowPanel from '../components/FlowPanel'
import { madeForYou } from '../madeForYou'
import { personalizedHomeMessages } from '../homeGreeting.mjs'
import { useAppearanceFlag } from '../appearanceFlags'

const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
const mixTitle = (mix) => (mix.type === 'artist' ? `${mix.name} Mix` : mix.name)

function homeRoute(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean)
  if (parts[0] !== 'home') return { tab: 'home', section: null }
  // Mix became Flow: an old /home/mixlab (a remembered Home tab) opens Flow.
  const tab = parts[1] === 'mixlab' ? 'flow' : parts[1]
  return { tab: ['discovery', 'flow', 'releases', 'history'].includes(tab) ? tab : 'home', section: parts[2] || null }
}

function secureImage(value) {
  const url = String(value || '').trim()
  if (!url || /2a96cbd8b46e442fc41c2b86b821562f/i.test(url)) return ''
  return url.replace(/^http:\/\//i, 'https://')
}

function relativeAge(timestamp, t) {
  const value = Number(timestamp) || 0
  if (!value) return t('Unknown time')
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - value)
  if (seconds < 60) return t('Just now')
  if (seconds < 3600) return t('{count} min ago', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('{count} hr ago', { count: Math.floor(seconds / 3600) })
  if (seconds < 604800) return t('{count} days ago', { count: Math.floor(seconds / 86400) })
  return t('{count} weeks ago', { count: Math.floor(seconds / 604800) })
}

function dateLabel(timestamp, t) {
  const value = Number(timestamp) || 0
  if (!value) return t('Unknown date')
  return new Date(value * 1000).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function MixCard({ mix, onClick, onOpen, onSave, saving, onContextMenu }) {
  const { t } = useTranslation()
  const arts = [...new Map(mix.tracks.map(track => [trackArtURL(track), track]).filter(([art]) => art)).values()].slice(0, 4)
  return (
    <motion.div whileHover={{ scale: 1.03 }} className="relative group" onContextMenu={onContextMenu}>
      <motion.button whileTap={{ scale: 0.98 }} onClick={onClick}
        aria-label={`Play ${mixTitle(mix)}`}
        className="w-full flex flex-col gap-3 p-3 bg-elevated border border-border rounded-xl hover:border-accent/30 transition-all text-left">
        <div className="w-full aspect-square rounded-lg overflow-hidden bg-card relative">
          {arts.length === 0 && <div className="w-full h-full flex items-center justify-center text-subtle"><Radio size={36} /></div>}
          {arts.length === 1 && <QualityImage src={trackArtURL(arts[0])} className="w-full h-full object-cover" />}
          {arts.length > 1 && <div className="w-full h-full grid grid-cols-2">{arts.map((track, index) => <QualityImage key={index} src={trackArtURL(track)} className="w-full h-full object-cover" />)}</div>}
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"><div className="w-10 h-10 bg-accent rounded-full flex items-center justify-center shadow-xl"><Play size={16} fill="currentColor" className="text-base translate-x-0.5" /></div></div>
        </div>
      </motion.button>
      <button type="button" onClick={onOpen}
        aria-label={`Open ${mixTitle(mix)} playlist`}
        className="w-full px-3 pb-1 text-left rounded-md hover:text-accent focus-visible:ring-2 focus-visible:ring-accent">
        <p className="text-sm font-medium truncate">{mix.name}</p>
        <p className="text-xs text-muted">{plural(mix.tracks.length, 'track')} · {mixTitle(mix)}</p>
      </button>
      <button onClick={onSave} disabled={saving} title={t("Save as playlist")} aria-label={`Save ${mixTitle(mix)} as a playlist`} className={`absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white/85 backdrop-blur transition-all hover:bg-black/80 hover:text-accent focus:opacity-100 ${saving ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        {saving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" /> : <ListPlus size={15} />}
      </button>
    </motion.div>
  )
}

function SectionHeader({ icon: Icon, eyebrow, title, count, subtitle, onExpand, expanded, action, onContextMenu }) {
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex items-end justify-between gap-4" onContextMenu={onContextMenu} title={onContextMenu ? t('Right-click to edit Discovery sections') : undefined}>
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-[11px] font-display uppercase tracking-[0.24em] text-muted">{t(eyebrow)}</p>}
        <div className="flex items-center gap-2"><Icon size={15} className="text-accent" /><h2 className="text-xl font-medium text-white">{t(title)}</h2>{count != null && <span className="text-sm text-muted">{count}</span>}</div>
        {subtitle && <p className="mt-1 text-sm text-muted">{t(subtitle)}</p>}
      </div>
      {(onExpand || action) && <div className="flex shrink-0 items-center gap-3">{action}{onExpand && <button type="button" onClick={onExpand} className="inline-flex items-center gap-1 text-xs text-muted hover:text-white">{expanded ? t('Show less') : t('See all')}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>}</div>}
    </div>
  )
}

function DiscoveryTrack({ track, onPlay, onRadio, onContextMenu, getDownloadTrack }) {
  const { t } = useTranslation()
  const artwork = trackArtURL(track) || secureImage(track?.artwork_url)
  return (
    <div onContextMenu={event => onContextMenu?.(event, track)} className="group flex min-w-0 items-center gap-1 rounded-xl p-2 transition-colors hover:bg-white/[0.06]">
      <button type="button" onClick={() => onPlay(track)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-card"><DiscoveryImage item={track} src={artwork} className="h-full w-full object-cover" /></div>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-white">{track.title}</p><p className="truncate text-xs text-muted">{track.artist}{track.scrobbleCount ? ` · ${t('{count} this week', { count: track.scrobbleCount })}` : ''}</p></div>
      </button>
      <SaveToLibraryButton track={track} getTrack={() => getDownloadTrack(track)} meta={track} className="p-2 opacity-0 group-hover:opacity-100 focus:opacity-100" />
      {onRadio && <button type="button" aria-label={`Start radio for ${track.title}`} onClick={() => onRadio(track)} className="rounded-full p-2 text-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100" title={t("Start radio")}><Radio size={14} /></button>}
    </div>
  )
}

function ArtistRecommendation({ artist, onClick, onContextMenu }) {
  const { t } = useTranslation()
  const image = secureImage(artist?.image)
  return <button type="button" onClick={() => onClick(artist)} onContextMenu={event => onContextMenu?.(event, artist)} className="group min-w-0 text-center">
    <div className="mx-auto aspect-square w-full max-w-28 overflow-hidden rounded-full bg-card ring-1 ring-white/10 transition-transform group-hover:scale-105"><DiscoveryImage item={artist} type="artist" src={image} className="h-full w-full object-cover" fallback={<div className="flex h-full items-center justify-center bg-accent/20 text-2xl font-medium text-accent">{artist.name.charAt(0)}</div>} /></div>
    <p className="mt-2 truncate text-sm text-white">{artist.name}</p><p className="text-xs text-muted">{artist.source === 'library' ? t('In your library') : t('Play artist songs')}</p>
  </button>
}

function AlbumRecommendation({ album, onClick, onContextMenu }) {
  const { t } = useTranslation()
  const image = secureImage(album?.artwork_url)
  return <button type="button" onClick={() => onClick(album)} onContextMenu={event => onContextMenu?.(event, album)} className="group w-full min-w-0 text-left">
    <div className="relative aspect-square overflow-hidden rounded-xl bg-card"><DiscoveryImage item={album} type="album" src={image} className="h-full w-full object-cover transition-transform group-hover:scale-105" fallback={<div className="flex h-full items-center justify-center text-muted"><Disc3 size={30} /></div>} /><span className="absolute bottom-2 right-2 rounded-full bg-black/65 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100"><Play size={13} /></span></div>
    <p className="mt-2 truncate text-sm font-medium text-white">{album.title}</p><p className="truncate text-xs text-muted">{album.artist}{album.year ? ` · ${album.year}` : ''}</p>
  </button>
}

const historyColumns = t => [
  { key: 'scrobbled', label: t('Scrobbled'), width: 5.5, render: track => new Date(Number(track.scrobbledAt) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
  { key: 'age', label: t('Age'), width: 5.5, render: track => relativeAge(track.scrobbledAt, t) },
]
const recommendationRows = tracks => tracks.map((track, index) => ({ ...track, id: track.id || `recommendation:${songKey(track)}:${track.scrobbledAt || index}` }))

function ScrobbleHistory({ entries, resolveTracks }) {
  const { t } = useTranslation()
  const groups = []
  const byDate = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const timestamp = Number(entry?.scrobbledAt || entry?.played_at) || 0
    const date = dateLabel(timestamp, t)
    if (!byDate.has(date)) { const group = { date, entries: [] }; byDate.set(date, group); groups.push(group) }
    byDate.get(date).entries.push(entry)
  }
  return <div className="space-y-6">{groups.map(group => <section key={group.date}><div className="mb-2 flex items-center gap-2 text-xs font-display uppercase tracking-widest text-muted"><CalendarDays size={14} />{group.date}</div><div className="rounded-xl border border-border bg-elevated p-3"><TrackList tracks={recommendationRows(group.entries)} extraColumns={historyColumns(t)} resolveTracks={resolveTracks} reduceMotion context={{ type: 'discovery', name: 'Scrobble History' }} /></div></section>)}</div>
}

function RecommendationSections({ data, localArtists, allArtists, source: selectedSource, layout, onEditCategory, loading, error, onRefresh, onSourceChange, onPlay, resolveTracks, getDownloadTrack, onTrackMenu, onRadio, onArtistPlay, onArtistMenu, onAlbumPlay, onAlbumMenu, onProviderMixPlay, onProviderMixMenu, onSaveFresh, onSaveQuick, saving, onOpenSettings, activeSection, onSection }) {
  const { t } = useTranslation()
  const source = sourceName(selectedSource)
  const quick = Array.isArray(data?.quickPicks) ? data.quickPicks : []
  const history = Array.isArray(data?.history) ? data.history : []
  const albums = Array.isArray(data?.albums) ? data.albums : []
  const providerMixes = Array.isArray(data?.mixes) ? data.mixes : []
  const artists = Array.isArray(data?.artists) ? data.artists : []
  const fresh = Array.isArray(data?.freshFinds) ? data.freshFinds : []
  const categoryMap = new Map((data?.categories || []).filter(group =>
    ['community', 'newReleases', 'trending', 'featuredPlaylists', 'dailyDiscover'].includes(group.id)
  ).map(group => [group.id, group]))
  const toggle = key => onSection?.(activeSection === key ? null : key)
  const categoryMenu = id => event => onEditCategory?.(event, id)
  const header = (id, Icon, count, { eyebrow, subtitle, action } = {}) => (
    <SectionHeader icon={Icon} title={t(DISCOVERY_SHELF_TITLES[id] || id)}
      eyebrow={eyebrow} subtitle={subtitle} count={count}
      onExpand={count ? () => toggle(id) : undefined} expanded={activeSection === id}
      action={action} onContextMenu={categoryMenu(id)} />
  )
  const trackShelf = (id, tracks, { icon = Music, subtitle, action } = {}) => tracks.length ? (
    <section key={id} data-discovery-shelf={id}>
      {header(id, icon, tracks.length, { subtitle, action })}
      <div className="grid gap-2 @md:grid-cols-2 @lg:grid-cols-3">
        {(activeSection === id ? tracks : tracks.slice(0, 6)).map(track =>
          <DiscoveryTrack key={songKey(track)} track={track} getDownloadTrack={getDownloadTrack}
            onPlay={item => onPlay(item, id)} onRadio={onRadio}
            onContextMenu={(event, item) => onTrackMenu(event, item, id)} />)}
      </div>
    </section>
  ) : null
  const albumShelf = (id, entries) => entries.length ? (
    <section key={id} data-discovery-shelf={id}>
      {header(id, Disc3, entries.length)}
      <div className="grid grid-cols-2 gap-4 @md:grid-cols-3 @lg:grid-cols-6">
        {(activeSection === id ? entries : entries.slice(0, 6)).map(album =>
          <AlbumRecommendation key={album.albumId || `${album.artist}-${album.title}`}
            album={album} onClick={onAlbumPlay} onContextMenu={onAlbumMenu} />)}
      </div>
    </section>
  ) : null
  const mixCards = (mixes, id) => (
    <div className="grid grid-cols-2 gap-4 @md:grid-cols-3 @lg:grid-cols-6">
      {(activeSection === id ? mixes : mixes.slice(0, 6)).map((mix, index) =>
        <div key={mix.id} className={activeSection === id || index < 2 ? '' : index < 3 ? 'hidden @md:block' : 'hidden @lg:block'}>
          <AlbumRecommendation album={{ ...mix, artist: mix.author || source }}
            onClick={() => onProviderMixPlay(mix)} onContextMenu={event => onProviderMixMenu(event, mix)} />
        </div>)}
    </div>
  )
  // Each entry is a provider-native shelf, not a generic set of search
  // results relabelled as Trending or Daily Discover.
  const youtubeCategory = id => {
    const category = categoryMap.get(id)
    if (!category) return null
    const tracks = category.tracks || [], mixes = category.mixes || [], releases = category.albums || []
    const count = tracks.length + mixes.length + releases.length
    if (!count) return null
    const expanded = activeSection === id
    return (
      <section key={id} data-discovery-shelf={id}>
        {header(id, Sparkles, count)}
        {mixes.length > 0 && mixCards(mixes, id)}
        {releases.length > 0 && <div className="mt-3 grid grid-cols-2 gap-4 @md:grid-cols-3 @lg:grid-cols-6">
          {(expanded ? releases : releases.slice(0, 6)).map(album =>
            <AlbumRecommendation key={album.albumId || `${album.artist}-${album.title}`}
              album={album} onClick={onAlbumPlay} onContextMenu={onAlbumMenu} />)}
        </div>}
        {tracks.length > 0 && <div className="mt-3 grid gap-2 @md:grid-cols-2 @lg:grid-cols-3">
          {(expanded ? tracks : tracks.slice(0, 6)).map(track =>
            <DiscoveryTrack key={songKey(track)} track={track} getDownloadTrack={getDownloadTrack}
              onPlay={item => onPlay(item, id)} onRadio={onRadio}
              onContextMenu={(event, item) => onTrackMenu(event, item, id)} />)}
        </div>}
      </section>
    )
  }
  const sections = {
    mixes: ['youtube', 'spotify'].includes(selectedSource) && data ? (
      <section key="mixes" data-discovery-shelf="mixes">
        {header('mixes', Radio, providerMixes.length)}
        {providerMixes.length ? mixCards(providerMixes, 'mixes')
          : <p role="status" className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted">
            {loading ? t('Loading your {source} mixes…', { source })
              : data.mixError ? t('Could not load your {source} mixes. {error}', { source, error: data.mixError })
                : t('{source} did not return your personalized mixes. Refresh to try again.', { source })}
          </p>}
      </section>
    ) : null,
    fresh: trackShelf('fresh', fresh, { subtitle: t('More music from {source}.', { source }),
      action: <button type="button" aria-label={t('Save Fresh Finds as a playlist')}
        onClick={onSaveFresh} disabled={!!saving} className="p-1.5 text-accent disabled:opacity-50">
        <ListPlus size={16} /></button> }),
    quick: trackShelf('quick', quick, { icon: Sparkles,
      action: <button type="button" aria-label={t('Save Quick Picks as a playlist')}
        onClick={onSaveQuick} disabled={!!saving} className="p-1.5 text-accent disabled:opacity-50">
        <ListPlus size={16} /></button> }),
    history: history.length ? (
      <section key="history" data-discovery-shelf="history">
        {header('history', History, history.length)}
        <ScrobbleHistory entries={activeSection === 'history' ? history : history.slice(0, 6)} resolveTracks={resolveTracks} />
      </section>
    ) : null,
    albums: albumShelf('albums', albums),
    artists: artists.length ? (
      <section key="artists" data-discovery-shelf="artists">
        {header('artists', User, artists.length)}
        <div className="grid grid-cols-3 gap-4 @sm:grid-cols-4 @md:grid-cols-6 @lg:grid-cols-8">
          {(activeSection === 'artists' ? artists : artists.slice(0, 8)).map(artist =>
            <ArtistRecommendation key={artist.name} artist={artist} onClick={onArtistPlay}
              onContextMenu={onArtistMenu} />)}
        </div>
      </section>
    ) : null,
    ...Object.fromEntries(['community', 'newReleases', 'trending', 'featuredPlaylists', 'dailyDiscover']
      .map(id => [id, youtubeCategory(id)])),
  }
  const visible = visibleShelfIds(layout)
  const available = visible.map(id => sections[id]).filter(Boolean)
  return <div className="space-y-7">
    <div data-discovery-header title={t('Right-click to edit Discovery sections')}
      onContextMenu={categoryMenu(null)}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-border/60 pb-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10"><Sparkles size={16} className="text-accent" /></div>
        <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="text-sm font-medium text-white">{t('Discovery')}</h2><span className="text-xs uppercase tracking-[0.18em] text-muted">{source}</span></div>
          <p className="mt-0.5 truncate text-xs text-muted">{t('Right-click a category to edit its order or visibility.')}</p></div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div role="group" aria-label={t('Discovery provider')} className="flex items-center gap-0.5 rounded-lg border border-border bg-card/70 p-0.5">
          {[['lastfm', 'Last.fm'], ['youtube', 'YouTube Music'], ['spotify', 'Spotify']].map(([id, label]) =>
            <button key={id} type="button" aria-pressed={selectedSource === id}
              onClick={() => onSourceChange?.(id)} className={`rounded-md px-2.5 py-1 !text-[11px] transition-colors ${selectedSource === id ? 'bg-accent text-base' : 'text-muted hover:text-white'}`}>{t(label)}</button>)}
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent/70 disabled:opacity-50"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />{t('Refresh')}</button>
      </div>
    </div>
    {error && <p role="status" className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">{t(error)}</p>}
    {!data && (loading
      ? <p className="py-10 text-center text-sm text-muted">{t('Building your {source} recommendations…', { source })}</p>
      : <div className="rounded-xl border border-border bg-elevated p-4"><ProviderConnections compact onOpenSettings={onOpenSettings} /></div>)}
    {data && available.length === 0 && <p className="py-10 text-center text-sm text-muted">
      {visible.length === 0 ? t('All Discovery sections are hidden. Right-click the Discovery header to edit them.')
        : t('No {source} recommendations are available yet.', { source })}
    </p>}
    {available}
    <UnfollowedArtists artists={allArtists} />
  </div>
}

export default function Home() {
  const { user } = useAppStore()
  return <HomeContent key={user?.id || 'guest'} user={user} />
}

function HomeContent({ user }) {
  const { t } = useTranslation()
  const showHomeGreeting = useAppearanceFlag('home_greeting')
  const uidKey = user?.id || 'guest'
  const [recentTracks, setRecentTracks] = useCachedState(`home:recent:${uidKey}`, [])
  const [suggestions, setSuggestions] = useCachedState(`home:suggestions:${uidKey}`, [])
  const [localHistory, setLocalHistory] = useCachedState(`home:history:${uidKey}`, [])
  const [mixes, setMixes] = useCachedState(`home:mixes:${uidKey}`, [])
  const session = recommendationSession(uidKey)
  const sessionState = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const { data: discovery, source: recommendationSource, loading: discoveryLoading, error: discoveryError } = sessionState
  const [loaded, setLoaded, wasCached] = useCachedState(`home:loaded:${uidKey}`, false)
  usePageReady(loaded || wasCached)
  const location = useLocation()
  const route = homeRoute(location.pathname)
  const tab = route.tab
  useEffect(() => { rememberHomePath(uidKey, location.pathname) }, [uidKey, location.pathname])
  const playQueue = usePlayerStore(s => s.playQueue)
  const navigate = useNavigate()
  const menu = useContextMenu()
  const [showDiscoveryEditor, setShowDiscoveryEditor] = useState(false)
  const [shelfLayouts, setShelfLayouts] = useState(() => Object.fromEntries(
    Object.keys(DISCOVERY_SHELF_DEFAULTS).map(provider => {
      try { return [provider, readShelfLayout(window.localStorage, uidKey, provider)] }
      catch { return [provider, restoreShelfLayout(provider)] }
    })
  ))
  const changeShelfLayout = (provider, next) => {
    const safe = restoreShelfLayout(provider, next)
    setShelfLayouts(previous => ({ ...previous, [provider]: safe }))
    try { writeShelfLayout(window.localStorage, uidKey, provider, safe) }
    catch { showToast(t('Could not save Discovery section preferences.')) }
  }
  const [saving, setSaving] = useState(null)
  const [localArtists, setLocalArtists] = useState([])
  const [artistsLoaded, setArtistsLoaded] = useState(false)
  const hiddenArtists = useDiscoveryArtists(s => s.hidden)
  const followedArtists = useDiscoveryArtists(s => s.followed)
  // Follow / Unfollow for an artist's menu: an artist neither followed nor
  // unfollowed (one Discovery suggests) gets both.
  const followMenu = name => {
    if (!name) return []
    const key = discoveryArtistKey(name)
    const change = follow => () => setArtistFollowed(name, follow).then(() => showToast(follow ? `Following ${name}` : `Unfollowed ${name}`)).catch(error => showToast(error.message))
    const follow = { label: 'Follow artist', icon: UserPlus, onSelect: change(true) }
    const unfollow = { label: 'Unfollow artist', icon: UserMinus, onSelect: change(false) }
    return followedArtists.has(key) ? [unfollow] : hiddenArtists.has(key) ? [follow] : [follow, unfollow]
  }
  const playRequestRef = useRef(0)
  const pendingPlayRef = useRef(null)
  const accountRef = useRef(sessionState.account)
  accountRef.current = sessionState.account
  const saveBusyRef = useRef(false)

  const saveList = async (key, name, items, description) => {
    if (saveBusyRef.current) return
    saveBusyRef.current = true
    setSaving(key)
    try {
      const tracks = typeof items === 'function' ? await items() : items
      if (!tracks.length) { showToast(t("No playable matches were found.")); return }
      const playlist = await saveAsPlaylist(name, tracks, { userId: user?.id, description })
      showToast(playlist ? `Saved "${name}" (${plural(new Set(tracks.map(t => t.id)).size, 'song')})` : 'Could not create playlist')
    } catch { showToast(t("Could not create playlist")) }
    finally { saveBusyRef.current = false; setSaving(null) }
  }
  const saveMix = mix => saveList(`mix:${mix.id}`, `${mixTitle(mix)} - ${today()}`, mix.tracks, `Your ${mixTitle(mix)} from Home`)

  const playRecommendation = async (entry, context = 'recommendations', pool = [entry]) => {
    const track = entry?.track || entry
    if (!track) return
    const key = `track:${songKey(track)}`
    if (pendingPlayRef.current === key) return
    const request = ++playRequestRef.current
    pendingPlayRef.current = key
    const toast = showLoadingToast(`Finding “${track.title}”…`)
    const account = accountRef.current
    const isCurrent = () => request === playRequestRef.current && account === session.getSnapshot().account
    let detail = ''
    try {
      const started = await playRecommendationPool(pool, {
        selected: track, context: { type: 'discovery', name: context }, isCurrent,
        onProgress: (message, progress) => { if (isCurrent()) toast.update(message, progress?.percent) },
        onProviderFailure: failure => { if (isCurrent()) { if (failure.detail) detail = failure.detail; toast.update(playbackFallbackMessage(failure)) } },
      })
      toast.close(isCurrent() && started === false ? detail ? `Could not play “${track.title}”. ${detail}` : `No matching playback source was found for ${track.title}.` : '')
    } catch { toast.close(isCurrent() ? `Could not load “${track.title}”.` : '') }
    finally { if (request === playRequestRef.current) pendingPlayRef.current = null }
  }

  const playCatalogue = async (type, item) => {
    const key = `${type}:${item.artist || item.name}:${item.title || ''}`
    if (pendingPlayRef.current === key) return
    const request = ++playRequestRef.current
    pendingPlayRef.current = key
    const account = session.getSnapshot().account
    const isCurrent = () => request === playRequestRef.current && account === session.getSnapshot().account
    let playbackVersion = usePlayerStore.getState().playbackGeneration
    const catalogueCurrent = () => isCurrent() && usePlayerStore.getState().playbackGeneration === playbackVersion
    const artist = type === 'artist' ? item.name : item.artist
    const toast = showLoadingToast(type === 'album' ? `Loading ${item.title}…` : `Loading songs by ${artist}…`)
    try {
      const progress = (message, info) => { if (isCurrent()) toast.update(message, info?.percent) }
      const skipSources = []
      let detail = ''
      while (catalogueCurrent()) {
        const result = await loadDiscoveryCatalogue({ source: recommendationSource, type, artist, album: type === 'album' ? item.title : '', albumId: item.albumId }, api, { isCurrent: catalogueCurrent, onProgress: progress, skipSources })
        if (!catalogueCurrent()) { toast.close(); return }
        if (!result.tracks.length) { toast.close(detail || result.error || `No playable songs were found for ${artist}.`); return }
        const started = await playRecommendationPool(result.tracks, {
          firstPlayable: true, isCurrent, onProgress: progress,
          onReserved: version => { playbackVersion = version },
          onStarted: () => { playbackVersion = usePlayerStore.getState().playbackGeneration },
          onProviderFailure: failure => { if (failure.detail) detail = failure.detail; toast.update(playbackFallbackMessage(failure)) },
          context: { type: 'discovery', name: type === 'album' ? item.title : artist },
        })
        if (started !== false || !catalogueCurrent()) { toast.close(); return }
        if (type !== 'artist' || !result.catalogueSource) { toast.close(detail || `No playable tracks were found for ${item.title || artist} in your sources.`); return }
        skipSources.push(result.catalogueSource)
      }
      toast.close()
    } catch { toast.close(isCurrent() ? `Could not load ${type === 'album' ? item.title : artist} from your sources.` : '') }
    finally { if (request === playRequestRef.current) pendingPlayRef.current = null }
  }

  const resolveRecommendedAlbum = async (album, onProgress = () => {}) => {
    const account = accountRef.current
    const isCurrent = () => account === accountRef.current
    const catalogue = await loadDiscoveryCatalogue({
      source: recommendationSource,
      type: 'album',
      artist: album.artist,
      album: album.title,
      albumId: album.albumId,
    }, api, { isCurrent, onProgress })
    if (!isCurrent()) return []
    if (!catalogue.tracks.length) {
      showToast(catalogue.error || `No matching songs were found for ${album.title} in your sources.`)
      return []
    }
    const resolved = await resolveRecommendationTracks(catalogue.tracks, api, { isCurrent, onProgress, prepareStreams: false })
    if (!resolved.length) {
      showToast(`No playable songs were found for ${album.title} in your sources.`)
      return []
    }
    return resolved
  }

  const saveRecommendedAlbum = async album => {
    const toast = showLoadingToast(`Loading ${album.title}…`)
    try {
      const tracks = await resolveRecommendedAlbum(album, (message, progress) => toast.update(message, progress?.percent))
      if (!tracks.length) { toast.close(); return }
      toast.update('Saving playlist…', null)
      const playlist = await saveAsPlaylist(`${album.title} - ${today()}`, tracks, { userId: user?.id, description: `Recommended album by ${album.artist}` })
      toast.close(playlist ? `Saved “${album.title}” as a playlist.` : `Could not save “${album.title}”.`)
    } catch {
      toast.close(`Could not save “${album.title}”.`)
    }
  }

  const downloadRecommendedAlbum = async album => {
    const toast = showLoadingToast(`Loading ${album.title}…`)
    try {
      const tracks = await resolveRecommendedAlbum(album, (message, progress) => toast.update(message, progress?.percent))
      if (!tracks.length) { toast.close(); return }
      toast.update('Queuing downloads…', null)
      const result = await saveTracksToLibrary(tracks, { onProgress: (message, progress) => toast.update(message, progress?.percent) })
      toast.close(libraryDownloadMessage(result))
    } catch {
      toast.close(`Could not download “${album.title}”.`)
    }
  }

  const startRadio = async seed => {
    if (!seed) return
    await openRadio(navigate, seed, user?.id)
  }

  const load = () => {
    const uid = user?.id
    const soft = promise => Promise.resolve(promise).catch(() => null)
    Promise.all([
      soft(api.getTracks({ sort: 'added_at DESC', limit: 10 })),
      soft(api.getSuggestions(uid)),
      soft(api.getHistory(uid, 100)),
      soft(api.getMixes(uid)),
      soft(api.getArtists()),
    ]).then(([tracks, suggested, history, userMixes, artists]) => {
      const nonGhost = items => (Array.isArray(items) ? items.filter(item => !String(item?.file_path || '').startsWith('ghost://')) : [])
      if (Array.isArray(tracks)) setRecentTracks(nonGhost(tracks))
      if (Array.isArray(suggested)) setSuggestions(nonGhost(suggested))
      if (Array.isArray(history)) setLocalHistory(history.map(entry => ({ ...entry, scrobbledAt: entry.played_at })))
      if (Array.isArray(userMixes)) setMixes(userMixes.map(mix => ({ ...mix, tracks: nonGhost(mix.tracks) })).filter(mix => mix.tracks.length > 0))
      if (Array.isArray(artists)) setArtistsLoaded(true)
      if (Array.isArray(artists)) setLocalArtists(artists.map(artist => ({ ...artist, image: artist.image || (artist.image_path ? (api.isElectron ? `file://${artist.image_path}` : `/api/artist-image/${encodeURIComponent(artist.id)}`) : ''), source: 'library' })))
      if ([tracks, suggested, history, userMixes, artists].every(Array.isArray)) setLoaded(true)
    })
  }

  useEffect(() => { load() }, [user?.id])
  useEffect(() => { loadDiscoveryArtists().catch(() => {}) }, [])
  // Once, with the library loaded: follow everyone already in it (not hidden).
  useEffect(() => { if (artistsLoaded) initFollowedArtists(localArtists).catch(() => {}) }, [artistsLoaded]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { session.ensure() }, [session])
  useEffect(() => {
    const refresh = () => load()
    window.addEventListener('lokal:refresh', refresh)
    return () => { window.removeEventListener('lokal:refresh', refresh) }
  }, [user?.id])

  const allowedDiscovery = item => !hiddenArtists.has(discoveryArtistKey(item?.artist)) && !hiddenArtists.has(discoveryArtistKey(item?.seedArtist))
  const data = discovery ? {
    ...discovery,
    ...Object.fromEntries(['albums', 'freshFinds', 'quickPicks', 'liked', 'history']
      .map(key => [key, discovery[key]?.filter(allowedDiscovery)])),
    categories: (discovery.categories || []).map(category => ({
      ...category, tracks: (category.tracks || []).filter(allowedDiscovery),
    })),
  } : discovery
  const recommendationTracks = data?.freshFinds || []
  const goHome = (next, section = null) => navigate(next === 'home' ? '/' : `/home/${next}${section ? `/${section}` : ''}`)
  const openMixMenu = (event, mix) => menu.open(event, [
    { label: 'Play', icon: Play, onSelect: () => playQueue(mix.tracks, 0) },
    { label: 'Play next', icon: Clock, onSelect: () => playNextMany(mix.tracks) },
    { label: 'Add to queue', icon: ListEnd, onSelect: () => addToQueueMany(mix.tracks) },
    { label: 'Add to playlist…', icon: Plus, onSelect: () => addToPlaylistMany(mix.tracks) },
    { separator: true },
    { label: 'Save as playlist', icon: ListPlus, onSelect: () => saveMix(mix), disabled: !!saving },
  ])
  const visibleArtists = artists => (Array.isArray(artists) ? artists : []).filter(artist => !hiddenArtists.has(discoveryArtistKey(artist.name)))
  const openArtistMenu = (event, artist) => menu.open(event, [
    { label: 'Start artist radio', icon: Radio, onSelect: () => startRadio({ artist: artist.name, type: 'artist' }) },
    { label: 'Go to artist', icon: User, onSelect: () => navigate(artist.source === 'library' ? `/artist/${encodeURIComponent(artist.id)}` : artistPath(artist.name), { state: { name: artist.name } }) },
    { separator: true },
    ...followMenu(artist.name),
  ])
  const resolveDownloadTrack = async track => {
    const account = accountRef.current
    const isCurrent = () => account === session.getSnapshot().account
    const toast = showLoadingToast(`Finding “${track.title}”…`)
    try {
      const [resolved] = await resolveRecommendationTracks([track], api, { isCurrent, prepareStreams: false, onProgress: (message, progress) => { if (isCurrent()) toast.update(message, progress?.percent) }, onProviderFailure: failure => { if (isCurrent()) toast.update(playbackFallbackMessage(failure)) } })
      toast.close(!resolved && isCurrent() ? `No matching source was found for ${track.title}.` : '')
      return isCurrent() ? resolved : null
    } catch { toast.close(isCurrent() ? `Could not load “${track.title}”.` : ''); return null }
  }
  const withRecommendation = async (track, action) => {
    const resolved = await resolveDownloadTrack(track)
    if (resolved) return action([resolved])
  }
  const downloadRecommendations = async tracks => {
    const result = await saveTracksToLibrary(tracks)
    showToast(libraryDownloadMessage(result))
  }
  const loadProviderMix = async mix => {
    if (mix.source === 'spotify') {
      const result = await api.spotifyPlaylist(mix.id)
      if (result?.error) throw new Error(result.error)
      return result?.tracks || []
    }
    const result = await api.youtubeAccountPlaylist(mix.id)
    if (result?.error) throw new Error(result.error)
    return (result?.tracks || []).map(track => ({ ...track, source: 'youtube', artwork_url: track.artwork_url || track.thumbnail }))
  }
  const playProviderMix = async mix => {
    const key = `${mix.source || 'youtube'}-mix:${mix.id}`
    if (pendingPlayRef.current === key) return
    const request = ++playRequestRef.current
    pendingPlayRef.current = key
    const account = session.getSnapshot().account
    const version = usePlayerStore.getState().playbackGeneration
    const isCurrent = () => request === playRequestRef.current && account === session.getSnapshot().account
    const toast = showLoadingToast(`Loading ${mix.title}…`)
    try {
      const tracks = await loadProviderMix(mix)
      if (!isCurrent() || usePlayerStore.getState().playbackGeneration !== version) { toast.close(); return }
      const started = await playRecommendationPool(tracks, { firstPlayable: true, context: { type: 'discovery', name: mix.title }, isCurrent, onProgress: (message, progress) => { if (isCurrent()) toast.update(message, progress?.percent) }, onProviderFailure: failure => { if (isCurrent()) toast.update(playbackFallbackMessage(failure)) } })
      toast.close(started === false && isCurrent() ? `No playable songs were found in ${mix.title}.` : '')
    } catch (error) { toast.close(isCurrent() ? error.message || `Could not load ${mix.title}.` : '') }
    finally { if (request === playRequestRef.current) pendingPlayRef.current = null }
  }
  const saveProviderMix = async (mix, download = false) => {
    const account = session.getSnapshot().account
    const isCurrent = () => account === session.getSnapshot().account
    const toast = showLoadingToast(`Loading ${mix.title}…`)
    try {
      const candidates = await loadProviderMix(mix)
      const tracks = await resolveRecommendationTracks(candidates, api, {
        isCurrent, prepareStreams: false,
        onProgress: (message, progress) => { if (isCurrent()) toast.update(message, progress?.percent) },
        onAddonVerificationRequired: error => dispatchAddonVerificationRequired(error, () => saveProviderMix(mix, download)),
      })
      if (!isCurrent()) { toast.close(); return }
      if (!tracks.length) { toast.close(`No matching songs were found in ${mix.title}.`); return }
      if (download) {
        toast.update('Queuing downloads…', null)
        const result = await saveTracksToLibrary(tracks, { isCurrent, onProgress: (message, progress) => toast.update(message, progress?.percent) })
        result.failed += candidates.length - tracks.length
        toast.close(libraryDownloadMessage(result))
      } else {
        toast.update('Saving playlist…', null)
        const playlist = await saveAsPlaylist(`${mix.title} - ${today()}`, tracks, { userId: user?.id, description: `Mixed for you on ${sourceName(mix.source || 'youtube')}`, coverURL: secureImage(mix.artwork_url || mix.thumbnail) })
        toast.close(playlist ? `Saved “${mix.title}” as a playlist.` : `Could not save “${mix.title}”.`)
      }
    } catch (error) { toast.close(isCurrent() && !isAddonVerificationRequiredError(error) ? error.message || `Could not load ${mix.title}.` : '') }
  }
  const openTrackMenu = (event, track, section = 'fresh') => {
    const isLiked = section === 'liked'
    const isQuick = section === 'quick'
    const category = data?.categories?.find(group => group.id === section)
    const context = category ? DISCOVERY_SHELF_TITLES[section] : isLiked ? 'YouTube Music Likes' : isQuick ? 'Quick Picks' : 'Fresh Finds'
    const pool = category ? category.tracks || [] : isLiked ? data?.liked || [] : isQuick ? data?.quickPicks || [] : recommendationTracks
    return menu.open(event, [
      { label: 'Play', icon: Play, onSelect: () => playRecommendation(track, context, pool) },
      { label: 'Play next', icon: Clock, onSelect: () => withRecommendation(track, playNextMany) },
      { label: 'Add to queue', icon: ListEnd, onSelect: () => withRecommendation(track, addToQueueMany) },
      { label: 'Add to playlist…', icon: Plus, onSelect: () => withRecommendation(track, addToPlaylistMany) },
      { label: 'Download song', icon: Download, onSelect: () => withRecommendation(track, downloadRecommendations) },
      { label: 'Start radio', icon: Radio, onSelect: () => startRadio(track) },
      { separator: true },
      ...followMenu(track.artist),
    ])
  }
  const saveRecommendations = (key, title, tracks, description) => {
    const account = accountRef.current
    return saveList(key, `${title} - ${today()}`, () => resolveRecommendationTracks(tracks, api, { isCurrent: () => account === accountRef.current }), description)
  }
  const sectionProps = {
    data: data ? { ...data, artists: visibleArtists(data.artists) } : data, localArtists: visibleArtists(localArtists), allArtists: [...localArtists, ...(discovery?.artists || [])], source: recommendationSource, loading: discoveryLoading, error: discoveryError,
    layout: shelfLayouts[recommendationSource] || restoreShelfLayout(recommendationSource),
    onEditCategory: event => menu.open(event, [{ label: 'Edit', icon: Pencil, onSelect: () => setShowDiscoveryEditor(true) }]),
    getDownloadTrack: resolveDownloadTrack,
    onProviderMixPlay: playProviderMix,
    onProviderMixMenu: (event, mix) => menu.open(event, [
      { label: 'Play mix', icon: Play, onSelect: () => playProviderMix(mix) },
      { label: 'Save as playlist', icon: ListPlus, onSelect: () => saveProviderMix(mix) },
      { label: 'Download mix', icon: Download, onSelect: () => saveProviderMix(mix, true) },
    ]),
    onRefresh: () => { session.refresh() }, onSourceChange: async source => {
      if (source === recommendationSource) return
      const result = await api.saveSettings({ recommendation_source: source }).catch(error => ({ error: error.message }))
      if (result?.error) showToast(result.error)
    }, activeSection: route.section, onSection: section => goHome('discovery', section), onPlay: (track, section = 'fresh') => {
      const isLiked = section === 'liked'
      const isQuick = section === 'quick'
      const category = data?.categories?.find(group => group.id === section)
      const pool = category ? category.tracks || [] : isLiked ? data.liked : isQuick ? data.quickPicks : recommendationTracks
      playRecommendation(track, category ? DISCOVERY_SHELF_TITLES[section] : isLiked ? 'YouTube Music Likes' : isQuick ? 'Quick Picks' : 'Fresh Finds', pool)
    }, onTrackMenu: openTrackMenu,
    resolveTracks: (rows, options = {}) => {
      const account = sessionState.account
      return resolveRecommendationTracks(rows, api, {
        ...options,
        isCurrent: () => account === session.getSnapshot().account && (!options.isCurrent || options.isCurrent()),
      })
    },
    onRadio: startRadio, onArtistMenu: openArtistMenu,
    onArtistPlay: artist => artist.source === 'library' ? navigate(`/artist/${encodeURIComponent(artist.id)}`) : playCatalogue('artist', artist),
    onAlbumPlay: album => playCatalogue('album', album),
    onAlbumMenu: (event, album) => menu.open(event, [
      { label: 'Play album', icon: Play, onSelect: () => playCatalogue('album', album) },
      { label: 'Save as playlist', icon: ListPlus, onSelect: () => saveRecommendedAlbum(album) },
      { label: 'Download album', icon: Download, onSelect: () => downloadRecommendedAlbum(album) },
      { separator: true },
      { label: 'Start album radio', icon: Radio, onSelect: () => startRadio({ title: album.title, artist: album.artist, type: 'album' }) },
      ...followMenu(album.artist),
    ]),
    onSaveFresh: () => saveRecommendations('fresh-finds', 'Fresh Finds', recommendationTracks, `Fresh Finds from ${sourceName(recommendationSource)}`),
    onSaveQuick: () => recommendationSource === 'youtube'
      ? saveRecommendations('youtube-likes', 'YouTube Music Likes', data?.liked || [], 'Recently liked on YouTube Music')
      : saveRecommendations('quick-picks', 'Quick Picks', data?.quickPicks || [], `Quick Picks from ${sourceName(recommendationSource)}`),
    saving,
    onOpenSettings: () => navigate('/settings', { state: { category: 'integrations' } }),
  }
  // Four songs from each of Your Mixes, picked once per start (src/madeForYou.js).
  const picks = madeForYou(uidKey, mixes)
  const pickTracks = picks.map(pick => pick.track)
  const madeForYouContext = { type: 'made-for-you', name: 'Made for you' }
  const openPickMenu = (event, track) => menu.open(event, [
    { label: 'Play next', icon: ListEnd, onSelect: () => playNextMany([track]) },
    { label: 'Add to queue', icon: ListPlus, onSelect: () => addToQueueMany([track]) },
    { label: 'Add to playlist…', icon: Plus, onSelect: () => addToPlaylistMany([track]) },
    { separator: true },
    { label: 'Go to artist', icon: User, onSelect: () => navigate(artistPath(track.artist)) },
  ])
  const selectedMixId = tab === 'home' && route.section?.startsWith('mix-')
    ? decodeURIComponent(route.section.slice(4)) : null
  const selectedMix = mixes.find(mix => String(mix.id) === selectedMixId)
  useEffect(() => {
    if (!selectedMixId) return
    const main = document.querySelector('main.flex-1.overflow-y-auto')
    if (main) main.scrollTop = 0
  }, [selectedMixId])
  const localHome = selectedMix ? (
    <section className="space-y-5" data-local-mix-detail>
      <button type="button" onClick={() => navigate('/home/home')}
        className="text-xs text-muted hover:text-white">← {t('Your Mixes')}</button>
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-xl font-semibold text-white">{mixTitle(selectedMix)}</h2>
          <p className="text-sm text-muted">{plural(selectedMix.tracks.length, 'track')}</p></div>
        <button type="button" onClick={() => playQueue(selectedMix.tracks, 0)}
          className="rounded-lg bg-accent px-4 py-2 text-sm text-base">{t('Play')}</button>
      </div>
      <TrackList tracks={selectedMix.tracks} reduceMotion
        context={{ type: 'playlist', name: mixTitle(selectedMix) }} />
    </section>
  ) : <>
    {picks.length > 0 && <MadeForYou picks={picks}
      onPlay={index => playQueue(pickTracks, index, madeForYouContext)}
      onContextMenu={openPickMenu} />}
    {mixes.length > 0 && <section><div className="flex items-center gap-2 mb-4"><Radio size={14} className="text-accent" /><h2 className="text-xs font-display text-muted uppercase tracking-widest">{t("Your Mixes")}</h2></div><div className="grid grid-cols-2 @md:grid-cols-3 gap-3">{mixes.slice(0, 6).map(mix => <MixCard key={mix.id} mix={mix} onClick={() => playQueue(mix.tracks, 0)} onOpen={() => navigate(`/home/home/mix-${encodeURIComponent(mix.id)}`)} onSave={() => saveMix(mix)} saving={saving === `mix:${mix.id}`} onContextMenu={event => openMixMenu(event, mix)} />)}</div></section>}
    {suggestions.length > 0 && <section><div className="flex items-center gap-2 mb-4"><Sparkles size={14} className="text-accent" /><h2 className="text-xs font-display text-muted uppercase tracking-widest">{t("Suggested for You")}</h2><button onClick={() => saveList('suggestions', `Suggested for You - ${today()}`, suggestions, 'Suggested for you on Home')} disabled={!!saving} className="ml-auto inline-flex items-center gap-1 text-xs text-accent disabled:opacity-50"><ListPlus size={13} />{t("Save as playlist")}</button></div><TrackList tracks={suggestions.slice(0, 8)} reduceMotion /></section>}
    {recentTracks.length > 0 && <section><div className="flex items-center justify-between mb-4"><h2 className="text-xs font-display text-muted uppercase tracking-widest">{t("Recently Added")}</h2><button onClick={() => playQueue(recentTracks, 0)} className="text-xs text-accent hover:text-accent/70">{t("Play All")}</button></div><TrackList tracks={recentTracks} reduceMotion /></section>}
    {loaded && !recentTracks.length && !suggestions.length && !mixes.length && <p className="py-10 text-center text-sm text-muted">{t("No local tracks yet. Pick your music folder in Library.")}</p>}
  </>

  const hour = new Date().getHours()
  // Every Home tab shares one header and one appearance preference.
  // Omitting the entire block removes its height and the container gap.
  const homeMessages = showHomeGreeting
    ? personalizedHomeMessages(localHistory, { hour })
    : null

  return <div className="p-6 space-y-7 w-full max-w-6xl mx-auto pb-10">
    {showHomeGreeting && <div data-home-greeting>
      <h1 className="text-2xl font-display text-white">{t(homeMessages.headline)}</h1>
      <p className="text-sm text-muted mt-1">{t(homeMessages.subheader)}</p>
    </div>}
    <div className="flex gap-1 p-0.5 bg-elevated rounded-lg border border-border w-fit">{[['home', 'Local'], ['discovery', 'Discovery'], ['flow', 'Flow'], ['releases', 'Releases'], ['history', 'History']].map(([id, label]) => <button key={id} onClick={() => goHome(id)} className={`px-4 py-1.5 text-xs font-display uppercase tracking-wider rounded transition-colors ${tab === id ? 'bg-accent text-base' : 'text-muted hover:text-white'}`}>{label}</button>)}</div>
    <SectionSwap id={tab} className="space-y-10">
      {tab === 'history' ? <section>
        <SectionHeader icon={History} eyebrow={t("History")} title={t("Listen History")} count={localHistory.length} />
        {localHistory.length ? <TrackList tracks={localHistory} reduceMotion context={{ type: 'history', name: 'Listen History' }} /> : <p className="py-10 text-center text-sm text-muted">{t("No listen history yet.")}</p>}
      </section>
        : tab === 'flow' ? <FlowPanel userId={uidKey} />
        : tab === 'releases' ? <ReleasesPanel artists={[...followedArtists.values()].map(name => ({ name }))} libraryArtists={localArtists}
            onPlay={album => playCatalogue('album', album)}
            onOpen={album => navigate(onlineAlbumPath({ artist: album.artist, album: album.title, albumId: album.albumId }), { state: { artwork: album.artwork_url || '' } })}
            onMenu={sectionProps.onAlbumMenu}
            onArtist={album => { const local = localArtists.find(artist => discoveryArtistKey(artist.name) === discoveryArtistKey(album.seedArtist || album.artist)); if (local?.id) navigate(`/artist/${encodeURIComponent(local.id)}`); else playCatalogue('artist', { name: album.artist }) }} />
        : tab === 'discovery' ? <RecommendationSections {...sectionProps} />
        : localHome
      }
    </SectionSwap>
    <DiscoveryShelfEditor open={showDiscoveryEditor} provider={recommendationSource}
      layout={shelfLayouts[recommendationSource] || restoreShelfLayout(recommendationSource)}
      onChange={layout => changeShelfLayout(recommendationSource, layout)}
      onClose={() => setShowDiscoveryEditor(false)} />
    <ContextMenu menu={menu} />
  </div>
}
