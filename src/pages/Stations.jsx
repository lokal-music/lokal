import React, { memo, useEffect, useMemo, useState } from 'react'
import { Globe2, Heart, Loader2, Music2, Pause, Play, Radio, RefreshCw, Search } from 'lucide-react'
import { useTranslation } from '../i18n'
import { usePageReady } from '../pageCache'
import { api } from '../api'
import { usePlayerStore } from '../store/player'
import { useRadioStore } from '../store/radio'
import { useStationFavorites } from '../store/stationFavorites'
import { RADIO_CONTEXT, stationTrack } from '../radio/stations'

const COUNTRIES = [
  ['', 'Worldwide'], ['FR', 'France'], ['US', 'United States'], ['GB', 'United Kingdom'],
  ['DE', 'Germany'], ['CA', 'Canada'], ['NL', 'Netherlands'], ['IT', 'Italy'],
  ['ES', 'Spain'], ['JP', 'Japan'], ['AU', 'Australia'], ['BR', 'Brazil'],
  ['BE', 'Belgium'], ['CH', 'Switzerland'],
]
const GENRES = ['', 'jazz', 'electronic', 'rock', 'classical', 'hip hop', 'ambient', 'soul', 'pop', 'world']

const qualifies = station => station?.lossless === true ||
  (Number(station?.bitrate) >= 256 && ['MP3', 'AAC', 'AAC+', 'HE-AAC', 'OPUS', 'OGG', 'VORBIS'].includes(String(station?.codec).toUpperCase()))
const quality = station => station.lossless ? (station.codec || 'Lossless') + ' · Lossless' : (station.codec || 'Audio') + ' · ' + station.bitrate + ' kbps'

const StationRow = memo(function StationRow({ station, onPlay, isFavorite, onFavorite }) {
  // Select only this station's metadata: changing an unrelated stream never
  // rebuilds this row, and only the playing stream opens an audio connection.
  const playingHere = usePlayerStore(s => s.currentTrack?.id === station.id && s.isPlaying)
  const selectedHere = usePlayerStore(s => s.currentTrack?.id === station.id)
  const currentSong = usePlayerStore(s => s.currentTrack?.id === station.id ? s.currentTrack?.song_key : null)
  const track = usePlayerStore(s => s.currentTrack?.id === station.id ? s.currentTrack : null)
  const listed = useRadioStore(s => s.nowPlaying[station.id])
  const now = currentSong ? [track?.artist, track?.title].filter(Boolean).join(' — ') :
    listed?.title ? [listed.artist, listed.title].filter(Boolean).join(' — ') : ''
  return (
    <div role="listitem" className={'group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors ' + (selectedHere ? 'bg-accent/10' : 'hover:bg-elevated')}>
      <button type="button" onClick={() => onPlay(station)} title={playingHere ? 'Pause' : 'Play'} aria-label={(playingHere ? 'Pause ' : 'Play ') + station.title}
        className="relative h-12 w-12 shrink-0 rounded-xl bg-card overflow-hidden flex items-center justify-center focus-visible:outline focus-visible:outline-accent">
        {station.icon ? <img src={station.icon} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={e => { e.currentTarget.style.display = 'none' }} /> : <Radio size={21} className="text-muted" />}
        <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white">
          {playingHere ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </span>
      </button>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onPlay(station)}>
        <p className={'truncate text-sm font-semibold ' + (selectedHere ? 'text-accent' : 'text-text')}>{station.title}</p>
        <p title={now || undefined} className="truncate text-xs text-muted mt-0.5">{now || [station.country, station.genre].filter(Boolean).join(' · ') || 'Live broadcast'}</p>
      </button>
      <span className="hidden md:block shrink-0 text-xs text-muted tabular-nums w-36 text-right">{quality(station)}</span>
      <button type="button" onClick={() => onFavorite(station)} aria-label={(isFavorite ? 'Remove ' : 'Favorite ') + station.title}
        className={'p-2 rounded-full hover:bg-card focus-visible:outline focus-visible:outline-accent ' + (isFavorite ? 'text-accent' : 'text-muted')}>
        <Heart size={19} fill={isFavorite ? 'currentColor' : 'none'} />
      </button>
      <button type="button" onClick={() => onPlay(station)} aria-label={playingHere ? 'Pause' : 'Play'}
        className="p-2 rounded-full text-text hover:bg-card focus-visible:outline focus-visible:outline-accent">
        {playingHere ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
      </button>
    </div>
  )
})

export default function Stations() {
  const { t } = useTranslation()
  usePageReady(true)
  const favorites = useStationFavorites(s => s.favorites)
  const toggle = useStationFavorites(s => s.toggle)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [country, setCountry] = useState('')
  const [genre, setGenre] = useState('')
  const [view, setView] = useState('explore')
  const [onlyLossless, setOnlyLossless] = useState(false)
  const [stations, setStations] = useState([])
  const [nextOffset, setNextOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setStations([])
    api.radioBrowse({ name: debouncedQuery, countrycode: country, tag: genre, limit: 60, offset: 0 })
      .then(result => {
        if (!active) return
        setStations((result?.stations || []).filter(qualifies))
        setNextOffset(result?.nextOffset || 0)
        setHasMore(!!result?.hasMore)
      })
      .catch(e => { if (active) setError(String(e?.message || 'Could not load stations')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [debouncedQuery, country, genre, reload])

  const shown = useMemo(() => {
    let list = view === 'favorites' ? Object.values(favorites) : stations
    if (view === 'favorites') {
      const search = query.trim().toLowerCase()
      list = list.filter(s => (!search || [s.title, s.country, s.genre].join(' ').toLowerCase().includes(search)) &&
        (!country || s.countrycode === country) && (!genre || (s.genres || []).some(tag => tag.toLowerCase().includes(genre))))
    }
    return list.filter(qualifies).filter(s => !onlyLossless || s.lossless)
  }, [view, favorites, stations, query, country, genre, onlyLossless])

  const play = station => {
    const player = usePlayerStore.getState()
    if (player.currentTrack?.id === station.id) { player.togglePlay(); return }
    const queue = shown.map(item => stationTrack(item, 'Stations'))
    player.playTrack(stationTrack(station, 'Stations'), queue, { type: RADIO_CONTEXT, name: 'Stations' })
  }
  const loadMore = async () => {
    if (moreLoading || loading || !hasMore) return
    setMoreLoading(true)
    try {
      const result = await api.radioBrowse({ name: debouncedQuery, countrycode: country, tag: genre, limit: 60, offset: nextOffset })
      const incoming = (result?.stations || []).filter(qualifies)
      setStations(previous => {
        const seen = new Set(previous.map(s => s.id))
        return [...previous, ...incoming.filter(s => !seen.has(s.id) && seen.add(s.id))]
      })
      setNextOffset(result?.nextOffset || nextOffset)
      setHasMore(!!result?.hasMore)
    } catch (e) { setError(String(e?.message || e)) }
    finally { setMoreLoading(false) }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 md:px-8 pb-16 pt-6 min-h-full">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="font-display text-3xl text-text flex items-center gap-3"><Radio size={26} className="text-accent" />{t('Stations')}</h1>
          <p className="mt-1 text-xs text-muted">Worldwide live audio · 256 kbps+ or lossless · Powered by Radio Browser</p>
        </div>
        <button type="button" onClick={() => setReload(n => n + 1)} title={t('Refresh')} className="p-2.5 rounded-full bg-card hover:bg-elevated text-muted" disabled={loading}>
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {[['explore', 'Explore', Globe2], ['favorites', 'Favorites', Heart]].map(([id, label, Icon]) =>
          <button type="button" key={id} onClick={() => setView(id)}
            className={'inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm border ' + (view === id ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted hover:text-text')}>
            <Icon size={15} />{t(label)}{id === 'favorites' && Object.keys(favorites).length ? ' (' + Object.keys(favorites).length + ')' : ''}
          </button>
        )}
        <button type="button" onClick={() => setOnlyLossless(x => !x)} aria-pressed={onlyLossless}
          className={'px-4 py-2 rounded-full text-sm border ' + (onlyLossless ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted hover:text-text')}>Lossless only</button>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="flex flex-1 min-w-[210px] items-center gap-2 px-3 py-2.5 border border-border rounded-xl bg-card text-muted">
          <Search size={17} />
          <input type="search" className="bg-transparent w-full min-w-0 outline-none text-sm text-text placeholder:text-muted" placeholder={t('Search stations')} value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 px-3 py-2.5 border border-border rounded-xl bg-card text-muted">
          <Globe2 size={16} />
          <select aria-label="Country" className="bg-transparent text-sm text-text outline-none" value={country} onChange={e => setCountry(e.target.value)}>
            {COUNTRIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-3 mb-2">
        {GENRES.map(tag => <button type="button" key={tag} onClick={() => setGenre(tag)}
          className={'shrink-0 rounded-full px-3 py-1.5 text-xs border capitalize ' + (genre === tag ? 'bg-accent/15 border-accent text-accent' : 'border-border text-muted hover:text-text')}>
          {tag || 'All genres'}
        </button>)}
      </div>
      <div className="rounded-2xl border border-border bg-card/30 p-2 min-h-48">
        {view === 'explore' && loading ? <div className="flex justify-center py-16"><Loader2 className="animate-spin text-muted" size={25} /></div>
          : shown.length === 0 ? <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted">
              <Music2 size={28} /><p className="text-sm">{view === 'favorites' ? 'No favorite stations yet' : error || 'No qualifying 256 kbps+ stations found'}</p>
            </div>
          : <div role="list" className="space-y-0.5">
              {shown.map(station => <StationRow key={station.id} station={station} onPlay={play} isFavorite={!!favorites[station.id]} onFavorite={toggle} />)}
            </div>}
      </div>
      {error && shown.length > 0 && <p role="status" className="mt-3 text-xs text-muted">{error}</p>}
      {view === 'explore' && hasMore && !loading && <div className="flex justify-center mt-5">
        <button type="button" disabled={moreLoading} onClick={loadMore} className="rounded-full bg-elevated px-5 py-2 text-sm text-text hover:bg-card disabled:opacity-50">
          {moreLoading ? 'Loading…' : 'Show more stations'}
        </button>
      </div>}
      <p className="mt-4 text-xs text-muted">Bitrates are reported by the directory and may differ from the actual stream. Now Playing appears when the broadcaster provides track metadata.</p>
    </div>
  )
}
