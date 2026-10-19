import OutputPrecisionSettings from '../components/OutputPrecisionSettings'
import { usePanelWidths } from '../panelWidths.jsx'
import { KEYBOARD_SHORTCUTS } from '../useKeyboardShortcuts'
import SplitWordsSettings from '../components/SplitWordsSettings'
import { collectLocalPrefs, restoreLocalPrefs } from '../localPrefsBackup'
import AppTabsSettings from '../components/AppTabsSettings'
import { APP_LANGUAGES, useTranslation } from '../i18n'
import TvModeSettings from '../tv/TvModeSettings'
﻿import React, { useEffect, useLayoutEffect, useState, useRef, createContext, useContext } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useLocation, useNavigate } from 'react-router-dom'
import { Info, Tags, FolderOpen, RefreshCw, Trash2, AlertTriangle, Link, CheckCircle, Disc3, Zap, Download, Music2, X, MoreHorizontal, ListMusic, Palette, ChevronDown, ChevronUp, RefreshCcw, Image as ImageIcon, Blocks, Search } from 'lucide-react'
import { api, peekSettings } from '../api'
import { FORMATS, MP3_BITRATES, savedFormat } from '../downloadLinks'
import { peekCache, writeCache, usePageReady } from '../pageCache'
import { useLibraryJobs, startLyricsIndex, cancelLyricsIndex, startGenres, readGenresStatus } from '../libraryJobs'
import SectionSwap, { ReadyWhen } from '../components/SectionSwap'
import AddonsSettings from '../components/AddonsSettings'
import ProviderConnections from '../components/ProviderConnections'
import { DEFAULT_DISCORD_CLIENT_ID } from '../discord'
import PlaybackSourceSettings from '../components/PlaybackSourceSettings'
import { useAppStore, usePlayerStore } from '../store/player'
import Modal from '../components/Modal'
import LyricsSourcesSettings from '../components/LyricsSourcesSettings'
import { THEMES, ACCENT_COLORS, applyTheme } from '../theme'
import { useTheme } from '../themeHooks'
import { ARTIST_SOURCES } from '../artistSources'
import { repairMissingTracks } from '../ghostDownloads'
import { plural } from '../plural'
import { readCrossfadeSettings, CROSSFADE_MIN_S } from '../audio/crossfade'
import SoulseekSignIn from '../components/SoulseekSignIn'

const EQ_BANDS = ['31Hz', '62Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '16kHz']
const EQ_PRESETS = {
  flat: { label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bassBoost: { label: 'Bass Boost', gains: [5, 4.5, 3, 1.5, 0.5, 0, -0.5, -1, -1.5, -2] },
  vocalBoost: { label: 'Vocal Boost', gains: [-1.5, -1, -0.5, 0.5, 1.5, 3, 3.5, 2.5, 1, 0] },
  bright: { label: 'Bright', gains: [-1, -0.5, 0, 0.5, 1, 1.5, 2.5, 3, 3.5, 3] },
  electronic: { label: 'Electronic', gains: [4, 3, 1, 0, -1, 1, 2, 3, 4, 4.5] },
  mellow: { label: 'Mellow', gains: [1.5, 1, 0.5, 0, -0.5, -1, -0.5, 0.5, 1, 1.5] },
}
const DEFAULT_EQ_PRESET = 'flat'
const LASTFM_STATUS_KEY = 'lokal-lastfm-status-feed'
const SETTINGS_CATEGORIES = [
  { key: 'integrations', label: 'Integrations', icon: Zap },
  { key: 'playback', label: 'Playback', icon: Disc3 },
  { key: 'library', label: 'Library', icon: Music2 },
  { key: 'addons', label: 'Addons', icon: Blocks },
  { key: 'appearance', label: 'Appearance', icon: Palette },
  { key: 'data', label: 'Data', icon: Download },
  { key: 'about', label: 'About', icon: Info },
]
// Tabs that were folded into others: a link to one opens where it went.
const MOVED_CATEGORIES = { artists: 'library', plugins: 'addons' }

const TRANSLATION_LANGUAGES = [
  ['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['de', 'Deutsch'], ['it', 'Italiano'], ['pt', 'Português'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ru', 'Русский'], ['uk', 'Українська'], ['ar', 'العربية'],
  ['hi', 'हिन्दी'], ['id', 'Bahasa Indonesia'], ['vi', 'Tiếng Việt'], ['th', 'ไทย'], ['ja', '日本語'], ['ko', '한국어'],
  ['zh-CN', '中文（简体）'], ['zh-TW', '中文（繁體）'], ['sv', 'Svenska'], ['el', 'Ελληνικά'], ['he', 'עברית'], ['sw', 'Kiswahili'],
]

// The search box in the header: while it has text, every category shows,
// cut down to the rows (or whole sections, by title) that match it.
const SettingsSearchContext = createContext({ query: '' })
const searchText = (...parts) => parts.filter(part => typeof part === 'string').join(' ').toLowerCase()

// Each section (heading + card) keeps a readable width and sits centred in
// the page, so on a wide or full-screen window the cards don't stretch edge
// to edge. The page header and category tabs above still span the width.
function Section({ title, children }) {
  const { t } = useTranslation()
  const { query } = useContext(SettingsSearchContext)
  const titleMatches = !!query && searchText(title, t(title)).includes(query)
  const filtering = !!query && !titleMatches
  return (
    <SettingsSearchContext.Provider value={filtering ? { query } : { query: '' }}>
      <div data-settings-match={titleMatches ? '' : undefined}
        className={`space-y-3 w-full max-w-2xl mx-auto ${filtering ? '[&:not(:has([data-settings-match]))]:hidden' : ''}`}>
        <h2 className="text-xs font-display text-muted uppercase tracking-widest">{t(title)}</h2>
        <div className={`bg-elevated border border-border rounded-xl p-5 space-y-5 ${filtering ? '[&>*:not([data-settings-match]):not(:has([data-settings-match]))]:hidden' : ''}`}>{children}</div>
      </div>
    </SettingsSearchContext.Provider>
  )
}
/** 1536 -> "1.5 KB" */
function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

// `stacked`: the control goes under the text, full width (a wide control
// beside it would squeeze the description into a narrow column).
function Row({ label, desc, children, stacked = false }) {
  const { t } = useTranslation()
  const { query } = useContext(SettingsSearchContext)
  const matches = !query || searchText(label, t(label), desc, t(desc)).includes(query)
  return (
    <div data-settings-match={query && matches ? '' : undefined} className={`${stacked ? 'space-y-3' : 'flex items-center justify-between gap-6'} ${matches ? '' : 'hidden'}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white font-medium">{t(label)}</p>
        {desc && <p className="text-xs text-muted mt-0.5 leading-relaxed whitespace-pre-line">{t(desc)}</p>}
      </div>
      <div className={stacked ? '' : 'flex-shrink-0'}>{children}</div>
    </div>
  )
}

function ThreeDotsMenu({ items = [], align = 'right' }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        aria-label={t('More options')}
        title={t('More options')}
        className="p-1.5 rounded-full hover:bg-card text-muted hover:text-white transition-colors"
      >
        <MoreHorizontal size={16} />
      </button>
      
      {open && (
        <div className={`absolute z-50 mt-1 min-w-40 bg-elevated border border-border rounded-lg shadow-xl py-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {items.map((item, i) => (
            item.divider ? (
              <div key={i} className="h-px bg-border my-1" />
            ) : (
              <button
                key={i}
                onClick={() => { item.onClick?.(); setOpen(false) }}
                disabled={item.disabled}
                className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors ${
                  item.danger 
                    ? 'text-red-400 hover:bg-red-500/10' 
                    : 'text-muted hover:text-white hover:bg-card'
                } ${item.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {item.icon}
                {t(item.label)}
              </button>
            )
          ))}
        </div>
      )}
    </div>
  )
}

function normalizeEqGains(values) {
  const safeValues = Array.isArray(values) ? values.map(v => Number(v) || 0) : []
  if (safeValues.length === EQ_BANDS.length) {
    return safeValues.slice(0, EQ_BANDS.length)
  }
  if (safeValues.length === 5) {
    return [safeValues[0], safeValues[0], safeValues[1], safeValues[1], safeValues[2], safeValues[2], safeValues[3], safeValues[3], safeValues[4], safeValues[4]]
  }
  return EQ_BANDS.map((_, i) => safeValues[i] || 0)
}

function getEqPresetKey(gains) {
  const normalized = normalizeEqGains(gains)
  const match = Object.entries(EQ_PRESETS).find(([, preset]) =>
    preset.gains.length === normalized.length && preset.gains.every((value, index) => value === normalized[index])
  )
  return match?.[0] || 'custom'
}

// The Side Panels toggle saves on every click rather than waiting for the
// "Save Settings" button, so a quick double-click could otherwise fire two
// overlapping requests and let the first one's response land after the
// second's, leaving the backend on the stale value. Chaining each save onto
// the previous one's settled promise keeps them applied in click order;
// sidePanelsSaveSeq lets only the most recent attempt update the error
// indicator, so a failure that's since been superseded by a successful
// retry doesn't leave a stale error showing.
//
// Deliberately module scope, not useRef: Settings can unmount and remount
// (it's a route, not a singleton), and a useRef resets on every mount --
// which meant a save still in flight from before an unmount could land
// after the remount initialized a fresh, unrelated chain/seq pair, letting
// it race a save started post-remount exactly the way the chaining above is
// meant to prevent. A module-level binding persists across mounts, so the
// chain and sequence counter stay continuous for the life of the app.
let sidePanelsSaveChain = Promise.resolve()
let sidePanelsSaveSeq = 0

// Settings save as they change. Each change saves only its own keys (saving
// the whole page's copy used to write back stale values -- e.g. the theme it
// loaded when opened, undoing a theme picked since). Changes within a short
// pause are batched, so typing isn't a save per keystroke, and saves are
// chained so they land in order. Module scope, like the chain above, so a
// save still pending when Settings closes isn't lost or reordered.
let settingsSaveChain = Promise.resolve()
let pendingSettings = {}
let pendingSettingsTimer = null
const settingsSaveListeners = new Set()
const notifySettingsSave = (state) => settingsSaveListeners.forEach(fn => fn(state))

function flushSettings() {
  clearTimeout(pendingSettingsTimer)
  pendingSettingsTimer = null
  const patch = pendingSettings
  if (!Object.keys(patch).length) return settingsSaveChain
  pendingSettings = {}
  notifySettingsSave('saving')
  settingsSaveChain = settingsSaveChain
    .catch(() => {})
    .then(() => api.saveSettings(patch))
    .then(r => {
      if (r?.error) throw new Error(r.error)
      // Mounted panels (sidebar lyrics, now playing...) re-read their settings.
      window.dispatchEvent(new Event('lokal:settings-saved'))
      if (!Object.keys(pendingSettings).length) notifySettingsSave('saved')
    })
    .catch(e => {
      // Keep what failed so "Retry" (or the next change) sends it again,
      // without overwriting anything changed since.
      pendingSettings = { ...patch, ...pendingSettings }
      notifySettingsSave({ error: e?.message || 'Save failed' })
    })
  return settingsSaveChain
}

function queueSettings(patch, delay = 400) {
  pendingSettings = { ...pendingSettings, ...patch }
  clearTimeout(pendingSettingsTimer)
  pendingSettingsTimer = setTimeout(flushSettings, delay)
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => { flushSettings() })

/** Settings as the page shows them: the Discord fields get their defaults. */
function withSettingDefaults(s) {
  return {
    ...(s || {}),
    discord_use_default_app_id: s?.discord_use_default_app_id ?? '1',
    discord_client_id: s?.discord_client_id || DEFAULT_DISCORD_CLIENT_ID,
    discord_auto_connect: s?.discord_auto_connect ?? '0',
  }
}

export default function Settings() {
  const location = useLocation()
  const navigate = useNavigate()
  const { t, language, setLanguage } = useTranslation()
  const panelFreeform = usePanelWidths(s => s.freeform)
  const setPanelFreeform = (freeform) => usePanelWidths.getState().set({ freeform })
  const replayGainMode = usePlayerStore(s => s.replayGainMode)
  // Seeded from the settings already read (and the version / tools found on
  // the last visit), so the first frame already has the real values: rows
  // used to appear, change text and push everything below them down.
  const [settings, setSettings] = useState(() => (peekSettings() ? withSettingDefaults(peekSettings()) : {}))
  const [settingsLoaded, setSettingsLoaded] = useState(() => !!peekSettings())
  const touchedSettingsRef = useRef(new Set())
  const [settingsLoadError, setSettingsLoadError] = useState('')
  const [settingsQuery, setSettingsQuery] = useState('')
  const [noSettingsMatch, setNoSettingsMatch] = useState(false)
  useEffect(() => {
    if (!settingsQuery.trim()) { setNoSettingsMatch(false); return }
    const timer = setTimeout(() => setNoSettingsMatch(!rootRef.current?.querySelector('[data-settings-match]')), 80)
    return () => clearTimeout(timer)
  }, [settingsQuery])
  // null | 'saving' | 'saved' | { error }
  const [saveState, setSaveState] = useState(null)
  useEffect(() => {
    let hide = null
    const listener = (state) => {
      clearTimeout(hide)
      setSaveState(state)
      if (state === 'saved') hide = setTimeout(() => setSaveState(null), 1800)
    }
    settingsSaveListeners.add(listener)
    return () => {
      settingsSaveListeners.delete(listener)
      clearTimeout(hide)
      flushSettings() // leaving Settings: send anything still waiting now
    }
  }, [])
  const [scanning, setScanning] = useState(false)
  const [showGenreModal, setShowGenreModal] = useState(false)
  const [eqGains, setEqGains] = useState(EQ_PRESETS[DEFAULT_EQ_PRESET].gains)
  const [eqPreset, setEqPreset] = useState(DEFAULT_EQ_PRESET)
  const [showClearModal, setShowClearModal] = useState(false)
  // Lists a category loads are kept for the next visit, so switching back to
  // it shows them at once (and refreshes them quietly).
  const [dups, setDups] = useState(null)
  const [showDups, setShowDups] = useState(false)
  const [possibleDups, setPossibleDups] = useState(null)
  const [showPossibleDups, setShowPossibleDups] = useState(false)
  const [duplicateMessage, setDuplicateMessage] = useState('')
  const [mergingDuplicate, setMergingDuplicate] = useState(false)
  const [mergingAll, setMergingAll] = useState(false)
  const [mergeAllResult, setMergeAllResult] = useState(null)
  const [showMergeAllConfirm, setShowMergeAllConfirm] = useState(false)
  const [deduplicatePlaylists, setDeduplicatePlaylists] = useState([])
  const [deduplicatePlaylistId, setDeduplicatePlaylistId] = useState('')
  const [deduplicatingPlaylist, setDeduplicatingPlaylist] = useState(false)
  const [deduplicateResult, setDeduplicateResult] = useState('')
  const [keepCommaArtists, setKeepCommaArtists] = useState([])
  const [commaInput, setCommaInput] = useState('')
  const [showCommaModal, setShowCommaModal] = useState(false)
  const [exportingHistory, setExportingHistory] = useState(false)
  const [historyExported, setHistoryExported] = useState(false)
  const [exportingAllData, setExportingAllData] = useState(false)
  const [fullExported, setFullExported] = useState(false)
  const [importingAllData, setImportingAllData] = useState(false)
  const [importPreview, setImportPreview] = useState(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [appUsers, setAppUsers] = useState(() => peekCache('settings:users') || [])
  const [usersLoading, setUsersLoading] = useState(false)
  // A users request has answered (or failed): the Data category can show.
  const [usersTried, setUsersTried] = useState(() => peekCache('settings:users') !== undefined)
  const [accountStatus, setAccountStatus] = useState('')
  const [userToDelete, setUserToDelete] = useState(null)
  const [showFactoryResetModal, setShowFactoryResetModal] = useState(false)
  const [showFactoryResetConfirmModal, setShowFactoryResetConfirmModal] = useState(false)
  const [resetConfirmText, setResetConfirmText] = useState('')
  const [resetConfirmArmed, setResetConfirmArmed] = useState(false)
  const [factoryResetting, setFactoryResetting] = useState(false)
  const [toolsStatus, setToolsStatusState] = useState(() => peekCache('settings:tools') || null)
  const setToolsStatus = (status) => { writeCache('settings:tools', status); setToolsStatusState(status) }
  const [toolsLoading, setToolsLoading] = useState(false)
  // ListenBrainz: its token is saved only once ListenBrainz confirms it.
  const [lbStatus, setLbStatus] = useState(null)
  const [cacheInfo, setCacheInfo] = useState(null) // { motion, playback, musicVideo, web, limit, limits } | { busy }
  const refreshCache = () => { Promise.resolve(api.cacheUsage?.()).then(info => { if (info && !info.error) setCacheInfo(info) }).catch(() => {}) }
  const setCacheLimit = async (mb) => {
    await Promise.resolve(api.saveSettings({ cache_limit_mb: String(mb) })).catch(() => {})
    setSettings(prev => ({ ...prev, cache_limit_mb: String(mb) }))
    const info = await Promise.resolve(api.cacheTrim?.()).catch(() => null)
    if (info && !info.error) setCacheInfo(info)
  }
  const clearCache = async () => {
    setCacheInfo(info => ({ ...info, busy: true }))
    const info = await Promise.resolve(api.cacheClear?.()).catch(() => null)
    if (info && !info.error) setCacheInfo(info)
    else setCacheInfo(prev => ({ ...prev, busy: false }))
  }
  /** Reload the ListenBrainz connection status. */
  const refreshListenBrainz = () => { Promise.resolve(api.listenbrainzStatus?.()).then(s => { if (s && !s.error) setLbStatus(s) }).catch(() => {}) }
  const [spotifyCheck, setSpotifyCheck] = useState(null)
  const testSpotifyCanvas = async () => {
    setSpotifyCheck({ loading: true })
    try {
      const saved = await api.saveSettings({ spotify_sp_dc: settings.spotify_sp_dc || '' })
      if (saved?.error) { setSpotifyCheck({ error: t("Couldn't save the cookie: {error}", { error: t(saved.error) }) }); return }
      // Never leave the button on "Checking...": give up after a minute.
      const status = await Promise.race([
        api.spotifyCanvasCheck(),
        new Promise(resolve => setTimeout(() => resolve({ error: t('No answer from Spotify after a minute. Try again, or check your connection.') }), 60000)),
      ])
      setSpotifyCheck(status || { error: t('No answer') })
      window.dispatchEvent(new Event('lokal:settings-saved'))
    } catch (e) {
      setSpotifyCheck({ error: t(e.message || 'Could not reach Spotify') })
    }
  }
  // Live progress of a yt-dlp / ffmpeg download, so the button doesn't look stuck.
  const [toolProgress, setToolProgress] = useState({})
  useEffect(() => api.onToolsDownloadProgress((_, p) => {
    if (!p?.tool) return
    setToolProgress(prev => ({ ...prev, [p.tool]: p.status === 'done' || p.status === 'error' ? null : p }))
  }), [])
  const progressLabel = (tool) => {
    const p = toolProgress[tool]
    if (!p) return 'Downloading...'
    if (p.status === 'installing') return 'Installing...'
    return Number.isFinite(p.percent) ? `Downloading ${p.percent}%` : 'Downloading...'
  }
  const [toolsError, setToolsError] = useState('')
  const [toolsErrorTool, setToolsErrorTool] = useState(null)
  const [showPlatformImportGuide, setShowPlatformImportGuide] = useState(false)
  const [platformImportPlatform, setPlatformImportPlatform] = useState('spotify')
  const [platformImportFileName, setPlatformImportFileName] = useState('')
  const [platformImportFileContent, setPlatformImportFileContent] = useState('')
  const [platformImportFileType, setPlatformImportFileType] = useState('csv')
  const [platformImportFiles, setPlatformImportFiles] = useState([])
  const [platformImportPreview, setPlatformImportPreview] = useState(null)
  const [platformImportStatus, setPlatformImportStatus] = useState('')
  const [platformImporting, setPlatformImporting] = useState(false)
  // hardwareAcceleration is what the next launch uses; running is what this
  // launch started with (main only applies it at startup).
  const [perfSettings, setPerfSettings] = useState({ hardwareAcceleration: true, performanceMode: false, platform: null, running: null })
  const [perfSaveError, setPerfSaveError] = useState(null) // { key, message }
  const [sidePanelsSaveError, setSidePanelsSaveError] = useState(false)
  // sidePanelsSaveChain/sidePanelsSaveSeq (module scope, below) serialize
  // the Side Panels toggle's saves -- see their declaration for why this
  // can't be a useRef here.
  const [appVersion, setAppVersionState] = useState(() => peekCache('settings:version') || '')
  const setAppVersion = (version) => { writeCache('settings:version', version); setAppVersionState(version) }
  usePageReady(settingsLoaded && (!api.isElectron || (!!appVersion && !!toolsStatus)))
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateCheckResult, setUpdateCheckResult] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [statusMessageValues, setStatusMessageValues] = useState(null)
  const [statusMessageIsError, setStatusMessageIsError] = useState(false)
  // Fill In Genres and Index Lyrics run in the background (src/libraryJobs.js,
  // shared with the Downloads panel, which can start them too).
  const genreJob = useLibraryJobs(s => s.genres)
  const [missingRepairJob, setMissingRepairJob] = useState(null)
  const lyricsIndexJob = useLibraryJobs(s => s.lyrics)
  const indexAllLyrics = () => (lyricsIndexJob?.running ? cancelLyricsIndex() : startLyricsIndex())
  const indexText = (job, what) => job?.running
    ? t('{done} of {total} songs · {found} {what} found{title}', { done: job.done || 0, total: job.total || '…', found: job.found || 0, what: t(what), title: job.title ? ` · ${job.title}` : '' })
    : job ? t('Done: {found} {what} found for {done} songs{cancelled}', { found: job.found || 0, what: t(what), done: job.done || 0, cancelled: job.cancelled ? ` (${t('stopped')})` : '' }) : ''
  useEffect(() => { readGenresStatus() }, [])
  const fillGenres = startGenres
  const genreText = genreJob?.error ? t(genreJob.error)
    : genreJob?.running ? t('Looking up… {done} of {total} albums and songs · {updated} songs filled in', { done: genreJob.done, total: genreJob.total, updated: genreJob.updated })
      : genreJob?.total ? t('Done: {updated} of {songs} songs filled in. Songs iTunes doesn’t know stay empty.', { updated: genreJob.updated, songs: genreJob.songs })
        : genreJob?.started ? t('Every song already has a genre.') : ''
  const loadMissingTracks = async () => {
    const rows = await Promise.resolve(api.getMissingTracks?.()).catch(() => null)
    return Array.isArray(rows) ? rows : []
  }
  useEffect(() => {
    loadMissingTracks().then(rows => setMissingRepairJob(current => ({ ...(current || {}), missing: rows.length })))
  }, [])
  const repairMissingLibraryFiles = async () => {
    if (missingRepairJob?.running) return
    const rows = await loadMissingTracks()
    if (!rows.length) {
      setMissingRepairJob({ missing: 0, message: t('No missing downloaded files found.') })
      return
    }
    setMissingRepairJob({ missing: rows.length, running: true, done: 0, queued: 0, unsupported: 0, failed: 0 })
    const result = await repairMissingTracks(rows, {
      onProgress: ({ done, total }) => setMissingRepairJob(current => ({ ...current, running: true, done, total })),
    })
    const remaining = await loadMissingTracks()
    const summaryParts = []
    if (result.queued) summaryParts.push(t(result.queued === 1 ? 'Queued {count} redownload' : 'Queued {count} redownloads', { count: result.queued }))
    if (result.unsupported) summaryParts.push(t('{count} need manual matching', { count: result.unsupported }))
    if (result.failed) summaryParts.push(t('{count} could not be queued', { count: result.failed }))
    if (result.cancelled) summaryParts.push(t('Repair stopped'))
    const message = summaryParts.join('; ') || (remaining.length ? t('{count} files still missing.', { count: remaining.length }) : t('All missing downloads were queued for repair.'))
    setMissingRepairJob({ missing: remaining.length, done: result.total, total: result.total, queued: result.queued, unsupported: result.unsupported, failed: result.failed, cancelled: result.cancelled, message })
    window.dispatchEvent(new Event('lokal:refresh'))
  }
  const missingRepairText = missingRepairJob?.running
    ? t('Queuing {done} of {total} missing downloads…', { done: missingRepairJob.done || 0, total: missingRepairJob.total || missingRepairJob.missing || 0 })
    : missingRepairJob?.message
      || t(missingRepairJob?.missing ? '{count} downloaded files missing.' : 'No missing downloaded files detected.', { count: missingRepairJob?.missing })
  const [manualGenreArtist, setManualGenreArtist] = useState('')
  const [bgImage, setBgImage] = useState(null)
  const [manualGenreTrack, setManualGenreTrack] = useState('')
  const [manualGenreAlbum, setManualGenreAlbum] = useState('')
  const [manualGenreValue, setManualGenreValue] = useState('')
  const [activeCategory, setActiveCategory] = useState(() => {
    const requested = MOVED_CATEGORIES[location.state?.category] || location.state?.category
    return SETTINGS_CATEGORIES.some(category => category.key === requested) ? requested : SETTINGS_CATEGORIES[0].key
  })
  useEffect(() => {
    const requested = MOVED_CATEGORIES[location.state?.category] || location.state?.category
    if (SETTINGS_CATEGORIES.some(category => category.key === requested)) setActiveCategory(requested)
  }, [location.state?.category])
  // Load the ListenBrainz connection state when Integrations is opened.
  useEffect(() => { if (activeCategory === 'integrations') refreshListenBrainz() }, [activeCategory]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeCategory === 'data' && api.isElectron) refreshCache() }, [activeCategory]) // eslint-disable-line react-hooks/exhaustive-deps
  // Every category shares the page's one scroll container (App's <main>), so
  // switching from halfway down a long category used to land halfway down
  // the next one. Start each category at the top; layout effect so the new
  // content never paints at the old offset first.
  const rootRef = useRef(null)
  const firstCategoryRef = useRef(true)
  useLayoutEffect(() => {
    if (firstCategoryRef.current) { firstCategoryRef.current = false; return }
    const scroller = rootRef.current?.closest('main')
    if (scroller) scroller.scrollTop = 0
  }, [activeCategory])

  
  const { openAlbums, user, logout } = useAppStore()
  const setExclusiveSidePanels = usePlayerStore(s => s.setExclusiveSidePanels)
  const autoOpenSidePanel = usePlayerStore(s => s.autoOpenSidePanel)
  const setAutoOpenSidePanel = usePlayerStore(s => s.setAutoOpenSidePanel)
  const hydrateAutoOpenSidePanel = usePlayerStore(s => s.hydrateAutoOpenSidePanel)
  const hydrateExclusiveSidePanels = usePlayerStore(s => s.hydrateExclusiveSidePanels)
  const exclusiveSidePanels = usePlayerStore(s => s.exclusiveSidePanels)
  const fileInputRef = useRef(null)
  const { themeName, themeOverrides, showAdvanced, setShowAdvanced, selectTheme, setAccent, saveOverride, saveOverrides, resetTheme, textScale, setTextScale } = useTheme()

  useEffect(() => {
    if (activeCategory !== 'library') return
    let live = true
    api.getPlaylists(user?.id).then(result => {
      if (!live || !Array.isArray(result)) return
      const regular = result.filter(playlist => !playlist.smart_rules)
      setDeduplicatePlaylists(regular)
      setDeduplicatePlaylistId(current => regular.some(playlist => String(playlist.id) === String(current)) ? current : String(regular[0]?.id || ''))
    }).catch(() => { if (live) setDeduplicatePlaylists([]) })
    return () => { live = false }
  }, [activeCategory, user?.id])

  useEffect(() => {

    api.getSettings().then(s => {
      if (!s || s.error) {
        // Keep the settings already shown; say the read failed.
        setSettingsLoadError(s?.error || 'No answer')
        setSettingsLoaded(true)
        return
      }
      setSettingsLoadError('')
      // A seeded page is live at once: keep what was changed while this loaded.
      setSettings(prev => {
        const next = withSettingDefaults(s)
        for (const key of touchedSettingsRef.current) next[key] = prev[key]
        return next
      })
      setSettingsLoaded(true)
      // Keep the player store's live `exclusiveSidePanels` in sync with the
      // backend-persisted value on load -- it was previously seeded only
      // from localStorage, so a value saved from another install/profile
      // (or a cleared localStorage) could silently disagree with what
      // Settings displays here until the toggle was clicked again. Uses
      // the hydrate (not set) action, which is a no-op once the user has
      // already made their own live choice this session, so this response
      // -- which can resolve after a selection the user already made
      // while it was loading -- can never overwrite a fresher choice.
      hydrateExclusiveSidePanels(s?.exclusive_side_panels !== '0')
      // Same for "Open the Side Panel on Play": the store ignores it once
      // the switch was clicked this session, on this page or a later one.
      if (s?.auto_open_side_panel === '0' || s?.auto_open_side_panel === '1') {
        hydrateAutoOpenSidePanel(s.auto_open_side_panel === '1')
      }
    }).catch(e => {
      setSettingsLoadError(e?.message || 'No answer')
      setSettingsLoaded(true)
    })

    api.getKeepCommaArtists().then(a => {

      const defaults = ['Tyler, The Creator', 'Earth, Wind & Fire']

      const combined = [...defaults, ...(a || [])]

      setKeepCommaArtists(combined)

      setCommaInput(combined.join('\n'))

    })

    try {
      const nextEq = normalizeEqGains(JSON.parse(localStorage.getItem('lokal-eq') || '[]'))
      setEqGains(nextEq)
      setEqPreset(getEqPresetKey(nextEq))
    } catch {}

    if (api.isElectron) {

      api.getToolsStatus().then(setToolsStatus)
      api.getVersion().then(v => setAppVersion(v || '1.0.0'))

      api.getPerfSettings().then(s => { if (s) setPerfSettings(p => ({ ...p, ...s })) }).catch(() => {})
    }


  }, []) 

  const loadUsers = async () => {
    setUsersLoading(true)
    try {
      const result = await api.listUsers()
      if (Array.isArray(result)) {
        writeCache('settings:users', result)
        setAppUsers(result)
      }
    } catch {
      // Keeps the accounts already shown.
    } finally {
      setUsersLoading(false)
      setUsersTried(true)
    }
  }

  useEffect(() => {
    if (activeCategory === 'data') {
      loadUsers()
    }
  }, [activeCategory])

  useEffect(() => {
    if (themeOverrides['--bg-image']) {
      const match = themeOverrides['--bg-image'].match(/url\(['"]?(.+?)['"]?\)/)
      if (match) setBgImage(match[1])
    } else {
      setBgImage(null)
    }
  }, [themeOverrides])

  const checkForUpdates = async () => {
    if (!api.isElectron) return
    setCheckingUpdate(true)
    setUpdateCheckResult('')
    try {
      const result = await api.updaterCheck()
      if (result?.nightly) {
        // Nightlies aren't offered the stable release; they update by hand.
        setUpdateCheckResult('')
        setCheckingUpdate(false)
        api.openExternal('https://github.com/sipbuu/lokal/releases')
        return
      }
      setUpdateCheckResult(t('Checking for updates...'))
      setTimeout(() => {
        setUpdateCheckResult('')
        setCheckingUpdate(false)
      }, 5000)
    } catch (e) {
      setUpdateCheckResult(t('Error checking for updates'))
      setCheckingUpdate(false)
    }
  }

  // Saves one performance field. On failure only that field (and its error)
  // changes, so overlapping saves of the two fields can't undo each other.
  const savePerfField = async (key, value) => {
    const before = perfSettings[key]
    setPerfSettings(p => ({ ...p, [key]: value }))
    setPerfSaveError(err => (err?.key === key ? null : err))
    try {
      const res = await api.savePerfSettings({ [key]: value })
      if (res?.error) throw new Error(res.error)
    } catch (e) {
      setPerfSettings(p => ({ ...p, [key]: before }))
      setPerfSaveError({ key, message: e.message || 'unknown error' })
    }
  }
  const setHardwareAcceleration = (on) => savePerfField('hardwareAcceleration', on)
  const setPerformanceMode = (on) => savePerfField('performanceMode', on)
  const perfRestartNeeded = !!perfSettings.running && perfSettings.running.hardwareAcceleration !== perfSettings.hardwareAcceleration

  // Every change saves itself (see queueSettings above).
  const set = (k, v) => {
    touchedSettingsRef.current.add(k)
    setSettings(s => ({ ...s, [k]: v }))
    queueSettings({ [k]: v })
    if (k.startsWith('crossfade_') || k === 'song_transitions' || k === 'automix_same_album') usePlayerStore.getState().setCrossfadeOptions(readCrossfadeSettings({ ...settings, [k]: v }))
    if (k === 'replaygain_mode') usePlayerStore.getState().setReplayGainMode(v)
  }
  const crossfade = readCrossfadeSettings(settings)

  const applyEqGains = (nextGains, presetKey = getEqPresetKey(nextGains)) => {
    const normalized = normalizeEqGains(nextGains)
    setEqGains(normalized)
    setEqPreset(presetKey)
    try {
      localStorage.setItem('lokal-eq', JSON.stringify(normalized))
      localStorage.setItem('lokal-eq-preset', presetKey)
    } catch {}
    window.__lokalInitAudio?.()
    normalized.forEach((gain, index) => {
      window.__lokaleq?.setGain(index, gain)
    })
  }

  const setEQ = (i, v) => {
    const next = [...eqGains]
    next[i] = v
    applyEqGains(next)
  }

  const rescan = async () => {
    let roots = []
    try {
      const parsed = JSON.parse(settings.music_folders || 'null')
      if (Array.isArray(parsed)) roots = parsed.filter(folder => typeof folder === 'string' && folder.trim())
    } catch {}
    if (!roots.length && settings.music_folder) roots = [settings.music_folder]
    if (!roots.length) return
    setScanning(true)
    try { await api.scanFolders(roots) } finally { setScanning(false) }
  }

  const checkDuplicates = async () => {
    setDuplicateMessage('')
    const d = await api.checkDuplicates()
    setDups(Array.isArray(d) ? d : [])
    setShowDups(true)
  }

  const mergeDup = async (group) => {
    const ids = group.ids.split(',')
    const keepId = ids[0]
    const removeIds = ids.slice(1)
    if (mergingDuplicate || mergingAll) return
    setMergingDuplicate(true)
    setDuplicateMessage('')
    try {
      const result = await api.mergeDuplicates(keepId, removeIds)
      if (!result?.ok) throw new Error(t(result?.error || 'Could not merge these copies. Please try again.'))
      setDuplicateMessage(t(result.warning || ''))
      setDups(prev => prev.filter(d => d.ids !== group.ids))
    } catch (error) { setDuplicateMessage(t(error.message)) }
    finally { setMergingDuplicate(false) }
  }

  const mergeAllDuplicates = async () => {
    setMergingAll(true)
    setDuplicateMessage('')
    setShowMergeAllConfirm(false)
    try {
      const result = await api.mergeAllDuplicates()
      setMergeAllResult(result)
      setDuplicateMessage([result.error, result.warning].filter(Boolean).map(value => t(value)).join(' '))
      const d = await api.checkDuplicates()
      setDups(Array.isArray(d) ? d : [])
    } catch (e) {
      setMergeAllResult({ error: e.message })
      setDuplicateMessage(t(e.message))
    }
    setMergingAll(false)
  }

  const checkPossibleDuplicates = async () => {
    setDuplicateMessage('')
    const groups = await api.checkPossibleDuplicates()
    setPossibleDups(Array.isArray(groups) ? groups : [])
    setShowPossibleDups(true)
  }

  const removePlaylistDuplicates = async () => {
    if (!deduplicatePlaylistId || deduplicatingPlaylist) return
    setDeduplicatingPlaylist(true)
    setDeduplicateResult('')
    try {
      const result = await api.deduplicatePlaylist(deduplicatePlaylistId)
      if (result?.error === 'Playlist not found') {
        setDeduplicateResult(t('This playlist no longer exists. Please select another playlist.'))
        return
      }
      if (result?.error === 'Smart playlists cannot be deduplicated.') {
        setDeduplicateResult(t('Choose a regular playlist. Smart playlists manage their songs automatically.'))
        return
      }
      if (!result?.ok) throw new Error(t(result?.error || 'Unexpected deduplication response'))
      const count = Number(result.removed) || 0
      setDeduplicateResult(count ? t(count === 1 ? 'Removed {count} duplicate song.' : 'Removed {count} duplicate songs.', { count }) : t('No duplicate songs were found.'))
      window.dispatchEvent(new CustomEvent('lokal:playlist-updated', { detail: { playlistId: deduplicatePlaylistId } }))
    } catch (e) {
      console.error('Playlist duplicate removal failed:', e)
      setDeduplicateResult(t('We couldn’t remove duplicate songs. Please try again. If this keeps happening, restart Lokal and try again.'))
    } finally {
      setDeduplicatingPlaylist(false)
    }
  }

  const mergePossibleDup = async (group, keepId) => {
    const removeIds = (group?.tracks || []).map(track => track.id).filter(id => id !== keepId)
    if (!removeIds.length) return
    if (mergingDuplicate) return
    setMergingDuplicate(true)
    setDuplicateMessage('')
    try {
      const result = await api.mergeDuplicates(keepId, removeIds)
      if (!result?.ok) throw new Error(t(result?.error || 'Could not merge these copies. Please try again.'))
      setDuplicateMessage(t(result.warning || ''))
      setPossibleDups(prev => prev.filter(item => item.id !== group.id))
    } catch (error) { setDuplicateMessage(t(error.message)) }
    finally { setMergingDuplicate(false) }
  }

  const saveCommaArtists = async () => {
    const artists = commaInput.split('\n').map(s => s.trim()).filter(Boolean)
    await api.setKeepCommaArtists(artists)
    setKeepCommaArtists(artists)
    setShowCommaModal(false)
    // RightSidebar keeps its own copy of this list (loaded once at mount,
    // since it stays mounted across normal route navigation) so its artist
    // link can resolve comma-containing names the same way PlayerBar's
    // does. Without this, the fix only takes effect after a remount/reload.
    try { window.dispatchEvent(new CustomEvent('lokal:comma-artists-updated', { detail: artists })) } catch {}
  }

  const triggerDownload = (content, filename, type) => {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleHistoryExport = async (format = 'json') => {
    console.log("Export started for format:", format);
    setExportingHistory(true);
    setShowExportMenu(false);

    try {
        const uid = user?.id || 'guest';
        const data = await api.historyExport(uid, format);
        
        console.log("Data received from API:", data);

        if (!data || (Array.isArray(data) && data.length === 0)) {
            alert(t("No history found to export!"));
            setExportingHistory(false);
            return;
        }

        if (data.error) {
            throw new Error(data.error);
        }

        const content = format === 'json' ? JSON.stringify(data, null, 2) : data;
        const type = format === 'json' ? 'application/json' : 'text/csv';
        const ext = format === 'json' ? 'json' : 'csv';

        triggerDownload(content, `lokal-history-${new Date().toISOString().split('T')[0]}.${ext}`, type)
        setHistoryExported(true);
        setTimeout(() => setHistoryExported(false), 3000);

    } catch (e) {
        console.error('Export error:', e);
        alert(t('Failed to export: {error}', { error: t(e.message) }));
    } finally {
        setExportingHistory(false);
    }
  };

  const handleFullExport = async () => {
    setExportingAllData(true)
    try {
      const data = await api.exportAllData()
      if (!data || data.error) throw new Error(t(data?.error || 'Export failed'))
      data.localPrefs = collectLocalPrefs()
      triggerDownload(
        JSON.stringify(data, null, 2),
        `lokal-app-data-${new Date().toISOString().split('T')[0]}.json`,
        'application/json'
      )
      setFullExported(true)
      setTimeout(() => setFullExported(false), 3000)
    } catch (e) {
      alert(t('Failed to export app data: {error}', { error: t(e.message) }))
    } finally {
      setExportingAllData(false)
    }
  }

  const handleDeleteUser = async () => {
    if (!userToDelete?.id) return
    const result = await api.deleteUser(userToDelete.id)
    if (result?.error) {
      setAccountStatus(result.error)
      return
    }
    if (user?.id === userToDelete.id) {
      logout()
    }
    setAccountStatus(t('Deleted {name}', { name: userToDelete.display_name || userToDelete.username }))
    setUserToDelete(null)
    loadUsers()
    setTimeout(() => setAccountStatus(''), 4000)
  }

  const reloadAfterDataReplace = async () => {
    logout()
    try {
      localStorage.removeItem('lokal-queue')
      localStorage.removeItem('lokal-user')
      localStorage.removeItem(LASTFM_STATUS_KEY)
    } catch {}
    if (api.isElectron) {
      await api.relaunchApp()
      return
    }
    window.location.reload()
  }

  const readImportBackup = async () => {
    const fp = await api.openFile([{ name: 'Lokal Backup', extensions: ['json'] }])
    if (!fp) return
    try {
      const content = await api.readFileBinary(fp)
      const parsed = JSON.parse(content)
      if (!parsed || typeof parsed !== 'object') throw new Error(t('Invalid backup file'))
      if (parsed.version !== 1) throw new Error(t('Unsupported backup version'))
      setImportPreview({
        filePath: fp,
        data: parsed,
        summary: {
          users: Array.isArray(parsed.users) ? parsed.users.length : 0,
          artists: Array.isArray(parsed.artists) ? parsed.artists.length : 0,
          tracks: Array.isArray(parsed.tracks) ? parsed.tracks.length : 0,
          playlists: Array.isArray(parsed.playlists) ? parsed.playlists.length : 0,
          history: Array.isArray(parsed.play_history) ? parsed.play_history.length : 0,
        },
      })
      setShowImportModal(true)
    } catch (e) {
      alert(t('Failed to read backup: {error}', { error: t(e.message) }))
    }
  }

  const handleImportBackup = async () => {
    if (!importPreview?.data) return
    setImportingAllData(true)
    try {
      const result = await api.importAllData(importPreview.data)
      if (!result || result.error) throw new Error(t(result?.error || 'Import failed'))
      restoreLocalPrefs(importPreview.data.localPrefs)
      setShowImportModal(false)
      setImportPreview(null)
      await reloadAfterDataReplace()
    } catch (e) {
      alert(t('Failed to import backup: {error}', { error: t(e.message) }))
    } finally {
      setImportingAllData(false)
    }
  }

  const handleFactoryReset = async () => {
    setFactoryResetting(true)
    try {
      const result = await api.factoryReset()
      if (!result || result.error) throw new Error(t(result?.error || 'Factory reset failed'))
      setShowFactoryResetConfirmModal(false)
      setShowFactoryResetModal(false)
      setResetConfirmText('')
      setResetConfirmArmed(false)
      await reloadAfterDataReplace()
    } catch (e) {
      alert(t('Factory reset failed: {error}', { error: t(e.message) }))
    } finally {
      setFactoryResetting(false)
    }
  }

  const downloadYtDlpTool = async () => {
    if (toolsLoading) return
    setToolsLoading(true)
    setToolsError('')
    setToolsErrorTool(null)
    const result = await api.downloadYtDlp()
    if (result?.error) {
      setToolsError(`yt-dlp: ${result.error}`)
      setToolsErrorTool('yt-dlp')
    }
    setToolsLoading(false)
    setToolProgress(prev => ({ ...prev, 'yt-dlp': null }))
    api.getToolsStatus().then(setToolsStatus)
  }

  const downloadFfmpegTool = async () => {
    if (toolsLoading) return
    setToolsLoading(true)
    setToolsError('')
    setToolsErrorTool(null)
    const result = await api.downloadFfmpeg()
    if (result?.error) {
      setToolsError(`ffmpeg: ${result.error}`)
      setToolsErrorTool('ffmpeg')
    }
    setToolsLoading(false)
    api.getToolsStatus().then(setToolsStatus)
  }

  const retryToolDownload = () => {
    if (toolsErrorTool === 'yt-dlp') downloadYtDlpTool()
    else if (toolsErrorTool === 'ffmpeg') downloadFfmpegTool()
  }

  const setCustomToolPath = async (tool) => {
    const fp = await api.openFile()
    if (fp) {
      await api.setCustomToolPath(tool, fp)
      api.getToolsStatus().then(setToolsStatus)
    }
  }

  const handlePlatformFileSelect = async () => {
    const selected = await api.openFile({
      filters: [{ name: 'Import Files', extensions: ['csv', 'json', 'm3u', 'm3u8'] }],
      multiple: true,
    })
    const paths = Array.isArray(selected) ? selected : (selected ? [selected] : [])
    if (!paths.length) return
    try {
      const files = await Promise.all(paths.map(async (fp) => {
        const content = await api.readFileBinary(fp)
        const ext = fp.split('.').pop().toLowerCase()
        const fileType = ext === 'm3u8' ? 'm3u' : ext
        return {
          fileName: fp.split(/[/\\]/).pop(),
          fileContent: content,
          fileType,
        }
      }))
      const preview = await api.previewExternalPlaylistImport({
        files,
        sourcePlatform: platformImportPlatform,
      })
      if (preview?.error) {
        setPlatformImportStatus(t('Error: {error}', { error: t(preview.error) }))
        setPlatformImportPreview(null)
        return
      }
      setPlatformImportFiles(files)
      setPlatformImportFileName(files.length === 1 ? files[0].fileName : `${files.length} files selected`)
      setPlatformImportFileContent(files[0]?.fileContent || '')
      setPlatformImportFileType(files[0]?.fileType || 'csv')
      setPlatformImportPreview(preview)
      setPlatformImportStatus(preview.total
        ? t('Ready to apply metadata to {total} tracks from {files}', { total: preview.total, files: preview.fileCount || files.length })
        : t('No tracks found in selected files'))
    } catch (e) {
      setPlatformImportStatus(t('Error reading file: {error}', { error: t(e.message) }))
      setPlatformImportPreview(null)
    }
  }

  const handlePlatformImport = async () => {
    const uid = user?.id
    if (!platformImportFiles.length && !platformImportFileContent) {
      setPlatformImportStatus(t('Please choose one or more CSV, JSON, or M3U files'))
      return
    }
    setPlatformImporting(true)
    setPlatformImportStatus(t('Importing...'))
    try {
      const payload = {
        files: platformImportFiles.length ? platformImportFiles : [{
          fileContent: platformImportFileContent,
          fileType: platformImportFileType,
          fileName: platformImportFileName,
        }],
        sourcePlatform: platformImportPlatform,
      }
      const result = await api.importExternalTrackMetadata(payload)
      if (result?.error) {
        setPlatformImportStatus(`${t('Error')}: ${t(result.error)}`)
      } else {
        setPlatformImportStatus(t('Applied metadata to {matched}/{total} tracks and saved {saved} unmatched rows for future matches.', { matched: result.matched, total: result.total, saved: result.savedForLater || 0 }))
        setPlatformImportPreview(prev => prev ? {
          ...prev,
          imported: result,
        } : prev)
        window.dispatchEvent(new Event('lokal:refresh'))
      }
    } catch (e) {
      setPlatformImportStatus(`${t('Error')}: ${t(e.message)}`)
    } finally {
      setPlatformImporting(false)
    }
  }

  const handleBgUpload = async () => {
    const file = await api.openFile([{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }])
    if (file) {
      const dataUrl = await api.readFileAsDataURL(file)
      if (dataUrl) {
        await saveOverride('--bg-image', `url('${dataUrl}')`)
      }
    }
  }

  const handleClearBg = async () => {
    await saveOverride('--bg-image', 'none')
  }

  const handleOpacityChange = async (e) => {
    const val = e.target.value
    await saveOverride('--bg-overlay', val)
  }

  const handleBlurChange = async (e) => {
    const val = e.target.value
    await saveOverride('--bg-blur', `${val}px`)
  }

  const exportMenuItems = [
    { label: 'Export as JSON', icon: <Download size={14} />, onClick: () => handleHistoryExport('json') },
    { label: 'Export as CSV', icon: <Download size={14} />, onClick: () => handleHistoryExport('csv') },
  ]
  const searchQuery = settingsQuery.trim().toLowerCase()
  const inCategory = (key) => !!searchQuery || activeCategory === key
  const lastfmConnected = Boolean(settings.lastfm_session_key && settings.lastfm_username)
  const usingDefaultDiscordId = settings.discord_use_default_app_id !== '0'

  return (
    <div ref={rootRef} className="p-6 space-y-6 pb-10">
      {/* The bar itself spans the page (so it still covers content scrolling
          under it). The title lines up with the cards' centred column (see
          Section); the category buttons use the full width, centred. */}
      <div className="space-y-3 sticky top-0 z-10 bg-bg/80 backdrop-blur-sm py-2">
        <div className="w-full max-w-2xl mx-auto flex items-center justify-between gap-3">
          <h1 className="font-display text-lg uppercase tracking-widest text-white flex-shrink-0">{t("Settings")}</h1>
          <label className="relative flex-1 min-w-0 max-w-xs">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input type="search" value={settingsQuery} onChange={e => setSettingsQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setSettingsQuery('') }}
              placeholder={t('Search settings')} aria-label={t('Search settings')}
              className="w-full bg-card border border-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-muted focus:outline-none focus:border-accent/50" />
          </label>
          <div className="flex items-center gap-3">
            {settingsLoadError && (
              <span className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle size={12} /> {t("Couldn't load settings")} ({t(settingsLoadError)})</span>
            )}
            {/* No Save button: changes save as they're made. */}
            <AnimatePresence mode="wait" initial={false}>
              {saveState?.error ? (
                <motion.span key="error" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                  className="text-xs text-red-400 flex items-center gap-2">
                  <AlertTriangle size={12} /> {t("Couldn't save")} ({t(saveState.error)})
                  <button onClick={() => flushSettings()} className="px-2 py-0.5 rounded border border-red-400/40 hover:bg-red-400/10">{t("Retry")}</button>
                </motion.span>
              ) : saveState === 'saving' ? (
                <motion.span key="saving" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-xs text-muted">{t('Saving...')}</motion.span>
              ) : saveState === 'saved' ? (
                <motion.span key="saved" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                  className="text-xs text-accent flex items-center gap-1">
                  <CheckCircle size={12} /> {t('Saved')}
                </motion.span>
              ) : (
                <motion.span key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-xs text-muted">{t('Changes save automatically')}</motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {SETTINGS_CATEGORIES.filter(item => item.key !== 'about' || api.isElectron).map((item) => {
            const Icon = item.icon
            const active = !searchQuery && activeCategory === item.key
            return (
              <button
                key={item.key}
                onClick={() => { setSettingsQuery(''); setActiveCategory(item.key) }}
                className={`px-3 py-1.5 rounded-lg border text-xs font-display uppercase tracking-wider transition-colors flex items-center gap-1.5 ${
                  active ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white hover:border-accent/30'
                }`}
              >
                <Icon size={13} />
                {t(item.label)}
              </button>
            )
          })}
        </div>
      </div>

      {/* Switching category: the new one fades in once its data is in, not
          through "Loading…" / "No … yet" first. */}
      {searchQuery && noSettingsMatch && (
        <p className="text-sm text-muted text-center py-6">{t('No settings match your search.')}</p>
      )}
      <SettingsSearchContext.Provider value={{ query: searchQuery }}>
      <SectionSwap id={searchQuery ? 'search' : activeCategory} gated={!searchQuery && ['data', 'addons'].includes(activeCategory)} className="space-y-6">
      <ReadyWhen ready={
activeCategory === 'data' ? usersTried
          : activeCategory !== 'addons'
      } />
      {api.isElectron && inCategory('about') && (
        <Section title={t("About")}>
          <Row label={t("Version")} desc={t("The version you're running.")}>
            <span className="text-sm text-muted font-mono">{appVersion || '1.0.0'}</span>
          </Row>
          <Row label={t("Check for Updates")} desc={t(/-nightly\./i.test(appVersion || '') ? 'Nightly builds update from GitHub Releases, not from here.' : 'Look for a newer version now.')}>
            <div className="flex items-center gap-3">
              <button 
                onClick={checkForUpdates}
                disabled={checkingUpdate}
                className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white hover:border-accent/30 disabled:opacity-40 transition-colors"
              >
                <RefreshCcw size={13} className={checkingUpdate ? 'animate-spin' : ''} />
                {checkingUpdate ? t('Checking...') : /-nightly\./i.test(appVersion || '') ? t('Open Releases') : t('Check for updates')}
              </button>
              {updateCheckResult && (
                <span className="text-xs text-muted">{t(updateCheckResult)}</span>
              )}
            </div>
          </Row>
          <Row label={t("Automatic Updates")} desc={t("Off: Lokal no longer looks for a new version when it starts. Check for updates above still works.")}>
            <button
              onClick={() => set('auto_update', settings.auto_update === '0' ? '1' : '0')}
              className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.auto_update !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}
            >
              {settings.auto_update !== '0' ? t('On') : t('Off')}
            </button>
          </Row>
          <Row label={t("Debug Logs")} desc={t("Open the folder with Lokal's logs, to attach to a bug report.")}>
            <button 
              onClick={() => api.openLogs?.()}
              className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white hover:border-accent/30 transition-colors"
            >
              <FolderOpen size={14} /> Show Logs
            </button>
          </Row>
          <Row label={t("Keyboard shortcuts")} desc={t("Not while typing in a search or text box. Esc closes what's open.")} stacked>
            <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {KEYBOARD_SHORTCUTS.map(({ keys, label }) => (
                <div key={label} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted">{t(label)}</span>
                  <span className="flex gap-1">{keys.map(key => <kbd key={key} className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-text">{t(key)}</kbd>)}</span>
                </div>
              ))}
            </div>
          </Row>
          <Row label={t("Hardware Acceleration")} desc={perfSaveError?.key === 'hardwareAcceleration' ? `${t("Couldn't save")} (${perfSaveError.message})` : perfRestartNeeded ? t('Restart Lokal to apply this change') : t('Use the graphics card to draw the app. Turn off if the window flickers or shows glitches.')}>
            <div className="flex items-center gap-3">
              {perfRestartNeeded && (
                <button
                  onClick={() => api.relaunchApp()}
                  className="flex items-center gap-2 px-4 py-1.5 bg-card border border-border rounded-lg text-xs text-muted hover:text-white hover:border-accent/30 transition-colors"
                >
                  <RefreshCcw size={12} /> Restart now
                </button>
              )}
              <button
                onClick={() => setHardwareAcceleration(!perfSettings.hardwareAcceleration)}
                className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${perfSettings.hardwareAcceleration ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
                {perfSettings.hardwareAcceleration ? t('On') : t('Off')}
              </button>
            </div>
          </Row>
          <Row label={t("Performance Mode")} desc={perfSaveError?.key === 'performanceMode' ? `${t("Couldn't save")} (${perfSaveError.message})` : t('Disable visual effects such as backdrop blur, waveform drawing, ambient video glow, and cover-mix transitions to reduce CPU/GPU usage. Changes apply immediately without restarting.') }>
            <button
              onClick={() => setPerformanceMode(!perfSettings.performanceMode)}
              className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${perfSettings.performanceMode ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
              {perfSettings.performanceMode ? t('On') : t('Off')}
            </button>
          </Row>
          <Row label={t("Close to Tray")} desc={t("The close button hides Lokal in the system tray instead of quitting: its taskbar icon goes away and the tray icon brings it back. Quit from the tray icon's menu.")}>
            <button
              onClick={() => set('close_to_tray', settings.close_to_tray === '1' ? '0' : '1')}
              className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.close_to_tray === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
              {settings.close_to_tray === '1' ? t('On') : t('Off')}
            </button>
          </Row>
        </Section>

      )}

      {inCategory('library') && (
      <Section title={t("Maintenance")}>
         <Row label={t("Repair Missing Downloads")} desc={`${missingRepairText} ${t('Known original sources are redownloaded and attached to the existing library entries; files that need manual matching are left untouched.')}`}>
           <button
             onClick={repairMissingLibraryFiles}
             disabled={!!missingRepairJob?.running || !missingRepairJob?.missing}
             className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors disabled:opacity-50"
           >
             {missingRepairJob?.running ? t('Repairing…') : t('Repair All')}
           </button>
         </Row>
        <Row label={t("Rescan Library")}>
          <button onClick={rescan} disabled={scanning || (!settings.music_folder && !settings.music_folders)}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-white hover:border-accent/30 disabled:opacity-40 transition-colors">
            <RefreshCw size={13} className={scanning ? 'animate-spin' : ''} />{scanning ? t('Scanning…') : t('Rescan')}
          </button>
        </Row>
        <Row label={t("Find Duplicates")} desc={t("Exact: the same title and artist. Similar: likely copies with close names and lengths, to check after the exact ones.")}>
          <div className="flex items-center gap-2">
            <button onClick={checkDuplicates}
              className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors">
              Exact
            </button>
            <button onClick={checkPossibleDuplicates}
              className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors">
              Similar
            </button>
          </div>
        </Row>
        {api.isElectron && (
        <Row label={t("Index Lyrics")} desc={`Fetches and keeps the lyrics of every song in your library now, so they open at once later. ${indexText(lyricsIndexJob, 'lyrics')}`.trim()}>
          <button onClick={indexAllLyrics}
            className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors">
            {lyricsIndexJob?.running ? t('Stop') : t('Index All')}
          </button>
        </Row>
        )}
      </Section>
      )}

      {inCategory('library') && (
      <Section title={t("Downloads")}>
        <Row label={t("Download Format")} desc={`${t('What downloaded songs are saved as.')} ${t((FORMATS.find(f => f.id === savedFormat(settings)) || FORMATS[0]).hint)}`}>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {FORMATS.map(option => (
              <button key={option.id} onClick={() => set('download_format', option.id)} title={option.hint}
                className={`px-3 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${savedFormat(settings) === option.id ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
                {option.label}
              </button>
            ))}
            {savedFormat(settings) === 'mp3' && (
              <select value={MP3_BITRATES.includes(String(settings.download_quality)) ? String(settings.download_quality) : '320'} onChange={e => set('download_quality', e.target.value)}
                aria-label={t("MP3 bitrate")}
                className="bg-elevated border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
                {MP3_BITRATES.map(rate => <option key={rate} value={rate}>{rate} kbps</option>)}
              </select>
            )}
          </div>
        </Row>
        <Row label={t("Simultaneous Downloads")} desc={t("How many downloads run at once; the rest wait. A playlist counts as one.")}>
          <select
            value={settings.download_concurrency || '3'}
            onChange={e => set('download_concurrency', e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            {['1', '2', '3', '4', '5'].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Row>
        <Row label={t("Add Lyrics to Downloads")} desc={t("Save the lyrics inside each downloaded file, so other players can show them too.")}>
          <button
            onClick={() => set('download_embed_lyrics', settings.download_embed_lyrics === '0' ? '1' : '0')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.download_embed_lyrics !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.download_embed_lyrics !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Allow Get it in Lossless for Any Song")} desc={t("Allow trying to find a higher-quality lossless version even when the current song is already lossless. When off, the existing eligibility rules apply.")}>
          <button
            onClick={() => set('get_lossless_any_song', settings.get_lossless_any_song === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.get_lossless_any_song === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.get_lossless_any_song === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Simpler Artist Names")} desc={t("Use the main artist for downloaded songs, not every name the file lists.")}>
          <button
            onClick={() => set('clean_download_metadata', settings.clean_download_metadata === '0' ? '1' : '0')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.clean_download_metadata !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.clean_download_metadata !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        {api.isElectron && <Row label={t("Sync Linked Playlists at Launch")} desc={t("Playlists linked to one on Spotify, Tidal, Apple Music, Qobuz or YouTube Music get the songs added there since the last sync each time Lokal starts, downloaded through your sources. Otherwise use Sync on the playlist.")}>
          <button
            onClick={() => set('playlist_sync_on_launch', settings.playlist_sync_on_launch === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.playlist_sync_on_launch === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.playlist_sync_on_launch === '1' ? t('On') : t('Off')}
          </button>
        </Row>}
        <Row label={t("Add Right Away")} desc={t("When downloading a playlist or album, add each song to your library as soon as it's done, not all at the end.")}>
          <button
            onClick={() => set('index_while_downloading', settings.index_while_downloading === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.index_while_downloading === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.index_while_downloading === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        {settings.yt_cookies === '1' && ['chrome', 'edge', 'brave', 'opera'].includes(settings.yt_cookie_browser) && (
          <p className="text-[11px] text-muted -mt-1 mb-2">
            On Windows, Chrome-based browsers lock their cookies, so downloads go ahead without your YouTube sign-in. Use Firefox or a cookies.txt file to keep it.
          </p>
        )}
      </Section>
      )}

      {inCategory('library') && (
      <Section title={t("Genres")}>
        <Row label={t("Set Genres")} desc={t("Choose the genre for an artist, album or song yourself.")}>
          <button 
            onClick={() => setShowGenreModal(true)}
            className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white hover:border-accent/30 transition-colors flex items-center gap-2"
          >
            <Tags size={14} /> {t('Configure Overrides')}
          </button>
        </Row>
        <Row label={t("Fill In Genres")} desc={genreText || t('Look up a genre online for every song that has none, one album at a time. A big library takes a while; it runs in the background.')}>
          <button onClick={fillGenres} disabled={!!genreJob?.running}
            className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors disabled:opacity-50">
            {genreJob?.running ? t('Running…') : t('Fill In')}
          </button>
        </Row>
      </Section>
      )}

      {inCategory('library') && (
      <Section title={t("Artists")}>
              <Row label={t("Names With a Comma")} desc={t("Artists whose name has a comma, like Tyler, The Creator, so they aren't split into two artists.")}>
          <button onClick={() => setShowCommaModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors">
            {t('Configure ({count})', { count: keepCommaArtists.length })}
          </button>
        </Row>
        <Row stacked label={t('Artist separator words')} desc={t('Extra words used to separate featured artists and credits, including in brackets.')}><SplitWordsSettings /></Row>
        <Row label={t("Fill In Artist Pages")} desc={t("When you open an artist, look up their bio and picture if they're missing.")}>
          <button
            onClick={() => set('auto_fetch_artist_metadata', settings.auto_fetch_artist_metadata === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.auto_fetch_artist_metadata === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.auto_fetch_artist_metadata === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row stacked label={t("Artist Info Source")} desc={t("Where artist pictures and bios come from. Automatic tries the best source for each one.")}>
          <div className="inline-flex flex-wrap gap-1 p-0.5 bg-card rounded-lg border border-border">
            {ARTIST_SOURCES.map(([id, label]) => (
              <button key={id} onClick={() => set('artist_metadata_source', id)}
                className={`px-3 py-1 !text-[11px] font-display uppercase tracking-wider rounded transition-colors ${(settings.artist_metadata_source || 'either') === id ? 'bg-accent text-base' : 'text-muted hover:text-white'}`}>
                {t(label)}
              </button>
            ))}
          </div>
        </Row>
      </Section>
      )}

      {inCategory('library') && (
      <Section title={t("Library")}>
        <Row stacked label={t("Remove Duplicate Songs")} desc={t("Choose a playlist to remove repeated songs from it. The first occurrence stays in its original position; other playlist entries are removed. Library files are not touched.")}>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("Playlist to remove duplicates from")}
              value={deduplicatePlaylistId}
              onChange={event => { setDeduplicatePlaylistId(event.target.value); setDeduplicateResult('') }}
              disabled={!deduplicatePlaylists.length || deduplicatingPlaylist}
              className="min-w-48 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-white outline-none focus:border-accent/50 disabled:opacity-50"
            >
              {!deduplicatePlaylists.length && <option value="">{t("No regular playlists")}</option>}
              {deduplicatePlaylists.map(playlist => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
            </select>
            <button
              type="button"
              onClick={removePlaylistDuplicates}
              disabled={!deduplicatePlaylistId || deduplicatingPlaylist}
              className="flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/15 px-4 py-2 text-sm text-accent transition-colors hover:bg-accent/25 disabled:cursor-wait disabled:opacity-40"
            >
              <Trash2 size={14} /> {deduplicatingPlaylist ? t('Removing…') : t('Remove duplicates')}
            </button>
          </div>
          {deduplicateResult && <p role="status" className="text-xs text-muted">{t(deduplicateResult)}</p>}
        </Row>
        <Row label={t("Delete Files Too")} desc={api.isElectron
          ? 'Deleting a song in Lokal also moves its file to the Recycle Bin. Only files in your music folder.'
          : 'Deleting a song in Lokal also deletes its file from the server, for good. Only files in the music folder.'}>
          <button
            onClick={() => set('delete_files_from_disk', settings.delete_files_from_disk === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.delete_files_from_disk === '1' ? 'bg-red-500/15 border-red-500/40 text-red-300' : 'border-border text-muted hover:text-white'}`}>
            {settings.delete_files_from_disk === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Look Up Missing Info")} desc={t("Find a cover online when a song has none, and a genre for songs you stream.")}>
          <button
            onClick={() => set('fetch_online_artwork', settings.fetch_online_artwork === '0' ? '1' : '0')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.fetch_online_artwork !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.fetch_online_artwork !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Skip Sample Packs")} desc={t("Leave out files named like drum kits, loops or samples, for producers who keep sample packs in their music folder.")}>
          <button
            onClick={() => set('skip_drumkit_pattern', settings.skip_drumkit_pattern === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.skip_drumkit_pattern === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.skip_drumkit_pattern === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Minimum Length")} desc={t("Leave out files shorter than this when scanning, like sound effects or samples. 0 keeps everything.")}>
          <div className="flex items-center gap-2">
            <input type="number" min={0} max={300} value={settings.min_duration ?? 0} onChange={e => set('min_duration', e.target.value)}
              className="w-16 bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white text-center outline-none focus:border-accent/50" />
            <span className="text-xs text-muted">{t("sec")}</span>
          </div>
        </Row>
      </Section>
      )}

      {inCategory('playback') && (
      <Section title={t("Equalizer")}>
        <div className="space-y-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-white font-medium">{t("10-Band EQ")}</p>
              <p className="text-xs text-muted mt-1">{t('Preset')}: {eqPreset === 'custom' ? t('Custom') : t(EQ_PRESETS[eqPreset]?.label || EQ_PRESETS[DEFAULT_EQ_PRESET].label)}</p>
            </div>
            <button onClick={() => applyEqGains(EQ_PRESETS[DEFAULT_EQ_PRESET].gains, DEFAULT_EQ_PRESET)}
              className="text-xs text-muted hover:text-white transition-colors">{t("Reset")}</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(EQ_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                onClick={() => applyEqGains(preset.gains, key)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${eqPreset === key ? 'bg-accent/20 border-accent/50 text-accent' : 'bg-card border-border text-muted hover:text-white'}`}
              >
                {t(preset.label)}
              </button>
            ))}
          </div>
          <div className="flex items-end justify-center gap-3 h-40 overflow-x-auto pb-2">
            {EQ_BANDS.map((band, i) => (
              <div key={band} className="flex flex-col items-center gap-2">
                <span className="text-xs font-display" style={{ color: '#e8ff57', fontSize: 10 }}>
                  {eqGains[i] > 0 ? '+' : ''}{(eqGains[i] || 0).toFixed(1)}
                </span>
                <input type="range" min={-12} max={12} step={0.5} value={eqGains[i] || 0}
                  onChange={e => setEQ(i, parseFloat(e.target.value))}
                  className="accent-accent"
                  style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 24, height: 104, cursor: 'pointer' }} />
                <span className="text-muted" style={{ fontSize: 9 }}>{band}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted mt-3 text-center opacity-50">{t("The equalizer starts after your first click in the app.")}</p>
        </div>
      </Section>
      )}

      {inCategory('playback') && (
      <Section title={t("Playback")}>
        <OutputPrecisionSettings />
        <Row label={t("ReplayGain")} desc={t("Use embedded ReplayGain tags to bring tracks closer in loudness. Peak tags limit boosts; tracks without tags are unchanged.")}>
          <select aria-label={t("ReplayGain mode")} value={settings.replaygain_mode ?? replayGainMode ?? 'off'} onChange={e => set('replaygain_mode', e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            <option value="off">{t('Off')}</option>
            <option value="track">{t('Track gain')}</option>
            <option value="album">{t('Album gain')}</option>
            <option value="smart">{t('Smart gain')}</option>
          </select>
        </Row>
        <Row label={t("Fetch Lyrics Automatically")} desc={t("Off: songs only show the lyrics they carry themselves (in their tags or a .lrc next to them). Looking again from the lyrics panel still searches online.")}>
          <button
            onClick={() => set('lyrics_auto_fetch', settings.lyrics_auto_fetch === '0' ? '1' : '0')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.lyrics_auto_fetch !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}
          >
            {settings.lyrics_auto_fetch !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Song Transitions")} desc={crossfade.mode === 'automix'
          ? t('AutoMix listens to both songs and blends them like a DJ: on the beat when their tempos are close (the next one sped up or slowed a touch, pitch kept), on the song\'s own fade-out otherwise, with silence at either end cut. Albums play as made.')
          : crossfade.mode === 'crossfade' ? t('The next song starts before the current one ends, by the amounts below.') : t('Each song plays to its end, then the next starts.')}>
          <div role="radiogroup" aria-label={t("Song transitions")} className="flex rounded-lg bg-card border border-border p-0.5">
            {[['off', 'Off'], ['crossfade', 'Crossfade'], ['automix', 'AutoMix']].map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={crossfade.mode === value} onClick={() => set('song_transitions', value)}
                className={`px-3 py-1 rounded-md text-xs transition-colors ${crossfade.mode === value ? 'bg-accent text-base font-medium' : 'text-muted hover:text-white'}`}>
                {t(label)}
              </button>
            ))}
          </div>
        </Row>
        {crossfade.mode === 'automix' && (
          <Row label={t("Mix Songs on the Same Album")} desc={t("Off: an album's songs, played in order, go one into the next as made (live albums, continuous mixes).")}>
            <button
              onClick={() => set('automix_same_album', settings.automix_same_album === '1' ? '0' : '1')}
              className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.automix_same_album === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
              {settings.automix_same_album === '1' ? t('On') : t('Off')}
            </button>
          </Row>
        )}
        {crossfade.mode === 'crossfade' && (
        <Row label={t("Crossfade")} desc={t("Start the next song this many seconds before the current one ends. Skipping doesn't fade.")}>
          <div className="flex items-center gap-2">
            <input type="range" min={1} max={20} step={0.5} value={crossfade.beforeEnd}
              onChange={e => set('crossfade_seconds', e.target.value)} className="w-24 accent-accent" />
            <span className="text-xs text-muted w-10">{crossfade.beforeEnd}s</span>
          </div>
        </Row>
        )}
        {crossfade.mode === 'crossfade' && crossfade.beforeEnd > CROSSFADE_MIN_S && (<>
          <Row label={t("Fade in")} desc={t("How long the next song takes to reach full volume.")}>
            <div className="flex items-center gap-2">
              <input type="range" min={0} max={10} step={0.1} value={crossfade.fadeIn}
                onChange={e => set('crossfade_fade_in', e.target.value)} className="w-24 accent-accent" />
              <span className="text-xs text-muted w-10">{crossfade.fadeIn.toFixed(1)}s</span>
            </div>
          </Row>
          <Row label={t("Fade out")} desc={t("How long the current song takes to fade away. It stops at the end of the song either way.")}>
            <div className="flex items-center gap-2">
              <input type="range" min={0.5} max={20} step={0.5} value={crossfade.fadeOut}
                onChange={e => set('crossfade_fade_out', e.target.value)} className="w-24 accent-accent" />
              <span className="text-xs text-muted w-10">{crossfade.fadeOut.toFixed(1)}s</span>
            </div>
          </Row>
          <Row label={t("Fade curve")} desc={t("Logarithmic fades evenly to the ear. Linear stays loud, then drops off near the end.")}>
            <select
              value={crossfade.curve}
              onChange={e => set('crossfade_curve', e.target.value)}
              className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50"
            >
              <option value="logarithmic">{t("Logarithmic")}</option>
              <option value="linear">{t("Linear")}</option>
            </select>
          </Row>
        </>)}
        <Row label={t("Streaming Quality")} desc={t("For songs played from YouTube Music. Data saver uses less than half the data. SoundCloud has one quality; addons have their own setting.")}>
          <select
            value={settings.online_quality || 'best'}
            onChange={e => set('online_quality', e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            <option value="best">{t("Best")}</option>
            <option value="saver">{t("Data saver")}</option>
          </select>
        </Row>
        {api.isElectron && (
        <Row label={t("YouTube Playback Engine")} desc={t("Fast: Lokal asks YouTube for the song itself, so YouTube Music songs start in a fraction of a second; a song it can't play that way uses yt-dlp. yt-dlp only: every song through yt-dlp, as before.")}>
          <select
            value={settings.yt_fast_engine === '0' ? '0' : '1'}
            onChange={e => set('yt_fast_engine', e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            <option value="1">{t("Fast")}</option>
            <option value="0">{t("yt-dlp only")}</option>
          </select>
        </Row>
        )}
        {api.isElectron && (
        <Row label={t("Music Video Quality")} desc={t("The most a music video's picture streams at. Lower uses less data and starts faster.")}>
          <select
            value={settings.video_quality || '1080'}
            onChange={e => set('video_quality', e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            <option value="1080">{t("Up to 1080p")}</option>
            <option value="720">{t("Up to 720p")}</option>
            <option value="480">{t("Up to 480p")}</option>
          </select>
        </Row>
        )}
        <Row stacked label={t("Play From")} desc={t("When a song isn't in your library, Lokal looks for it in these, top first. Addons you turn on are added here.")}>
          <PlaybackSourceSettings value={settings.playback_search_order} onChange={value => set('playback_search_order', value)} />
        </Row>
      </Section>
      )}

      {inCategory('playback') && api.isElectron && (
      <Section title={t("Casting")}>
        <Row label={t("Cast Quality")} desc={t("Best sends lossless songs to the TV as they are, up to 24-bit / 96 kHz (higher is brought down to that). Standard sends at most CD quality (16-bit / 48 kHz), for a weak Wi-Fi.")}>
          <select
            value={settings.cast_quality === 'standard' ? 'standard' : 'max'}
            onChange={e => set('cast_quality', e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            <option value="max">{t("Best")}</option>
            <option value="standard">{t("Standard")}</option>
          </select>
        </Row>
      </Section>
      )}

      {inCategory('playback') && (
      <Section title={t("Lyrics")}>
        <Row label={t("Auto-Translate")} desc={t("Show the translation under each line when a song is in another language.")}>
          <button
            onClick={() => set('lyrics_auto_translate', settings.lyrics_auto_translate === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.lyrics_auto_translate === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.lyrics_auto_translate === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Translation Language")} desc={t("The language lyrics are translated into.")}>
          <select value={settings.lyrics_translate_target || 'en'} onChange={e => set('lyrics_translate_target', e.target.value)}
            className="bg-card border border-border rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-accent/50">
            {TRANSLATION_LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </Row>
        <Row label={t("Word-by-Word Sync")} desc={t("Light up each word as it's sung, when the lyrics have word timing.")}>
          <button
            onClick={() => { const v = settings.word_sync === '0'; set('word_sync', v ? '1' : '0'); localStorage.setItem('word-sync', v ? '1' : '0') }}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.word_sync !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.word_sync !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Time Plain Lyrics")} desc={t("Roughly time lyrics that have no timing, so they scroll with the song.")}>
          <button
            onClick={() => set('unsynced_auto_sync', settings.unsynced_auto_sync === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.unsynced_auto_sync === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.unsynced_auto_sync === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <LyricsSourcesSettings onPersist={(patch) => setSettings(s => ({ ...s, ...patch }))} />
        <Row label={t("Clear Lyrics Cache")}>
          <button onClick={() => api.clearLyricsDb()}
            className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors flex items-center gap-2">
            <RefreshCw size={13} /> Clear
          </button>
        </Row>
      </Section>
      )}

      {inCategory('integrations') && (
      <Section title={t("Account Connections")}>
        <ProviderConnections settingsOverride={settings} onSettingsChanged={patch => setSettings(previous => ({ ...previous, ...patch }))} onListenBrainzChanged={setLbStatus} />
      </Section>
      )}

      {inCategory('integrations') && (
      <Section title={t("Scrobbling")}>
        <Row label={t('Last.fm')} desc={lastfmConnected ? '' : t('Sign in to Last.fm in Account Connections first.')}>
          <button disabled={!lastfmConnected} aria-pressed={lastfmConnected && settings.lastfm_scrobbling === '1'}
            onClick={() => set('lastfm_scrobbling', settings.lastfm_scrobbling === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors disabled:opacity-40 ${lastfmConnected && settings.lastfm_scrobbling === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {lastfmConnected && settings.lastfm_scrobbling === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t('ListenBrainz')} desc={lbStatus?.connected ? (lbStatus.queued ? `${lbStatus.queued} ${t(lbStatus.queued === 1 ? 'listen' : 'listens')} ${t('waiting to be sent')}` : '') : t('Sign in to ListenBrainz in Account Connections first.')}>
          <button disabled={!lbStatus?.connected} aria-pressed={!!(lbStatus?.connected && lbStatus.enabled)}
            onClick={async () => {
              // Keep the current state if the change didn't go through.
              const next = await Promise.resolve(api.listenbrainzSetEnabled(!lbStatus.enabled)).catch(() => null)
              if (next && !next.error) setLbStatus(next)
            }}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors disabled:opacity-40 ${!!(lbStatus?.connected && lbStatus.enabled) ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {!!(lbStatus?.connected && lbStatus.enabled) ? t('On') : t('Off')}
          </button>
        </Row>
      </Section>
      )}

      {api.isElectron && inCategory('integrations') && (
      <Section title={t("Spotify")}>
        <Row stacked label={t("Spotify Cookie")} desc={"Your Spotify sign-in, for Liked Songs here and Spotify Canvas covers: open open.spotify.com in your browser and sign in, press F12, go to Application (Storage in Firefox) › Cookies › open.spotify.com, and copy the value of sp_dc. It lasts about a year.\n\nIt stays on this computer and is only sent to Spotify."}>
          <div className="flex flex-wrap items-center gap-2">
            <input type="password" value={settings.spotify_sp_dc || ''} onChange={e => { set('spotify_sp_dc', e.target.value); setSpotifyCheck(null) }}
              placeholder={t("sp_dc value")} spellCheck={false} autoComplete="off" aria-label={t("Spotify cookie (sp_dc)")}
              className="w-full max-w-md bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-accent/50" />
            <button onClick={testSpotifyCanvas} disabled={spotifyCheck?.loading || !settings.spotify_sp_dc}
              className="px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border border-accent/50 bg-accent/20 text-accent disabled:opacity-50">
              {spotifyCheck?.loading ? t('Checking...') : t('Save & Test')}
            </button>
            {spotifyCheck && !spotifyCheck.loading && (
              spotifyCheck.error
                ? <p className="text-xs text-red-400">{t(spotifyCheck.error)}</p>
                : <p className="text-xs text-green-400">{t("Signed in to Spotify.")}</p>
            )}
          </div>
        </Row>
        <SpotifyLikesRow hasCookie={!!settings.spotify_sp_dc} userId={user?.id || 'guest'} />
      </Section>
      )}

      {inCategory('integrations') && (
      <Section title={t("Discord Rich Presence")}>
        <Row label={t("Use Lokal's Discord App")} desc={t("Show Lokal's name and icon on your Discord profile.")}>
          <button
            onClick={() => set('discord_use_default_app_id', usingDefaultDiscordId ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${usingDefaultDiscordId ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {usingDefaultDiscordId ? t('On') : t('Off')}
          </button>
        </Row>
        {!usingDefaultDiscordId && (
          <Row label={t("Your Own Discord App")} desc={t("The ID of a Discord app you made, to show its name and icon instead.")}>
            <input value={settings.discord_client_id || ''} onChange={e => set('discord_client_id', e.target.value)}
              placeholder={DEFAULT_DISCORD_CLIENT_ID}
              className="w-56 bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-accent/50" />
          </Row>
        )}
        <Row label={t("Connect on Startup")} desc={t("Show what you're playing on Discord as soon as Lokal opens.")}>
          <button
            onClick={() => set('discord_auto_connect', settings.discord_auto_connect === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.discord_auto_connect === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.discord_auto_connect === '1' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Hide When Paused")} desc={t("Clear your Discord status while the music is paused.")}>
          <button
            onClick={() => set('discord_hide_paused', settings.discord_hide_paused === '1' ? '0' : '1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.discord_hide_paused === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.discord_hide_paused === '1' ? t('On') : t('Off')}
          </button>
        </Row>
      </Section>
      )}

      {inCategory('integrations') && (
        <Section title={t("Soulseek")}>
          <p className="text-xs text-muted leading-relaxed">
            {t("Search and download from Soulseek, a peer-to-peer network where lossless (FLAC) copies are common. Soulseek is a sharing network and most of what's on it is copyrighted, so only download what you're allowed to.")}
          </p>
          {api.isElectron
            ? <>
                <p className="text-xs text-muted leading-relaxed">{t('Sign in with a Soulseek account. The first time, Lokal downloads the Soulseek client it uses ({client}, about 55 MB) and then runs it in the background while Lokal is open. Nothing to install or configure.', { client: 'slskd' })}</p>
                <SoulseekSignIn settings={settings} set={set} />
              </>
            : <p className="text-xs text-muted">{t("Soulseek runs with the Lokal desktop app.")}</p>}
        </Section>
      )}

      {api.isElectron && inCategory('integrations') && (
        <Section title={t("External Tools")}>
          <p className="text-xs text-muted mb-4">{t("The tools Lokal uses to download and convert songs.")}</p>
          {toolsError && (
            <div className="flex items-center justify-between gap-3 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">
              <span>{toolsError}</span>
              {toolsErrorTool && (
                <button onClick={retryToolDownload} disabled={toolsLoading} className="shrink-0 px-2.5 py-1 bg-red-500/20 border border-red-500/30 rounded-md text-red-300 hover:bg-red-500/30 disabled:opacity-40">
                  {t('Retry')}
                </button>
              )}
            </div>
          )}
          <div className="space-y-3 mb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${toolsStatus?.ytdlp?.found ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm text-white">{t("yt-dlp")}</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => downloadYtDlpTool()} disabled={toolsLoading} className="px-3 py-1.5 bg-card border border-border rounded-lg text-xs text-muted hover:text-white disabled:opacity-40">
                  {toolsLoading ? progressLabel('yt-dlp') : toolsStatus?.ytdlp?.found ? t('Update / Re-download') : t('Download')}
                </button>
                <button onClick={() => setCustomToolPath('yt-dlp')} className="px-3 py-1.5 bg-card border border-border rounded-lg text-xs text-muted hover:text-white">{t("Custom Path")}</button>
              </div>
            </div>
            {toolsStatus?.ytdlp?.path && (
              <p className="text-xs text-muted/50 truncate">
                {toolsStatus.ytdlp.path}{toolsStatus.ytdlp.version ? ` · v${toolsStatus.ytdlp.version}` : ''}
              </p>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${toolsStatus?.ffmpeg?.found ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm text-white">{t("ffmpeg")}</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => downloadFfmpegTool()} disabled={toolsLoading} className="px-3 py-1.5 bg-card border border-border rounded-lg text-xs text-muted hover:text-white disabled:opacity-40">
                  {toolsLoading ? progressLabel('ffmpeg') : toolsStatus?.ffmpeg?.found ? t('Re-download') : t('Download')}
                </button>
                <button onClick={() => setCustomToolPath('ffmpeg')} className="px-3 py-1.5 bg-card border border-border rounded-lg text-xs text-muted hover:text-white">{t("Custom Path")}</button>
              </div>
            </div>
            {toolsStatus?.ffmpeg?.path && (
              <p className="text-xs text-muted/50 truncate">
                {toolsStatus.ffmpeg.path}{toolsStatus.ffmpeg.version ? ` · ${toolsStatus.ffmpeg.version}` : ''}
              </p>
            )}
          </div>
        </Section>
      )}

      {inCategory('addons') && (
      <Section title={t("Addons")}>
        <AddonsSettings />
      </Section>
      )}

      {inCategory('appearance') && (
      <Section title={t("Language")}>
        <Row label={t("App Language")} desc={t("Choose the language used for Lokal’s interface. Track and album titles from your music files are not translated.")}>
          <select
            value={language}
            onChange={event => {
              const code = event.target.value
              setSettings(previous => ({ ...previous, app_language: code }))
              setLanguage(code)
            }}
            aria-label={t('App Language')}
            className="min-w-44 bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
          >
            {APP_LANGUAGES.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
        </Row>
      </Section>
      )}
      {inCategory('appearance') && (
      <Section title={t("Theme")}>
        <div className="space-y-4">
          <div>
            <p className="text-sm text-white font-medium mb-3">{t("Theme")}</p>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(THEMES).map(([key, theme]) => (
                <button
                  key={key}
                  onClick={() => selectTheme(key)}
                  className={`p-3 rounded-lg border transition-all ${
                    themeName === key 
                      ? 'bg-accent/20 border-accent/50' 
                      : 'bg-card border-border hover:border-accent/30'
                  }`}
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex gap-1">
                      <div className="w-4 h-4 rounded" style={{ background: theme.vars['--bg'] }} />
                      <div className="w-4 h-4 rounded" style={{ background: theme.vars['--surface'] }} />
                      <div className="w-4 h-4 rounded" style={{ background: theme.vars['--surface2'] }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="w-2 h-2 rounded-full" style={{ background: theme.vars['--accent'] }} />
                      <span className={`text-xs ${themeName === key ? 'text-accent' : 'text-muted'}`}>
                        {t(theme.name)}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
          
          <div>
            <p className="text-sm text-white font-medium mb-3">{t("Accent Color")}</p>
            <div className="flex flex-wrap gap-2">
              {ACCENT_COLORS.map((color) => (
                <button
                  key={color.value}
                  onClick={() => setAccent(color)}
                  className={`w-8 h-8 rounded-lg transition-all ${
                    themeOverrides['--accent'] === color.value
                      ? 'ring-2 ring-offset-2 ring-offset-elevated ring-white scale-110'
                      : 'hover:scale-110'
                  }`}
                  style={{ background: color.value }}
                  title={t(color.name)}
                />
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm text-white font-medium mb-3">{t("Text Size")}</p>
            <div className="flex items-center gap-4">
              <span className="text-xs text-muted">A</span>
              <input
                type="range"
                min="0.7"
                max="1.5"
                step="0.05"
                value={textScale}
                onChange={(e) => setTextScale(e.target.value)}
                className="flex-1 accent-accent"
              />
              <span className="text-lg text-muted">A</span>
              <span className="text-xs text-muted ml-2 w-12">
                {Math.round(parseFloat(textScale) * 100)}%
              </span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-muted/50">{t("Small")}</span>
              <span className="text-[10px] text-muted/50">{t("Large")}</span>
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-border">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm text-white font-medium">{t("Custom Background")}</p>
                <p className="text-xs text-muted">{t("Set a custom image for the app background.")}</p>
              </div>
              <div className="flex gap-2">
                {bgImage && (
                  <button 
                    onClick={handleClearBg}
                    className="px-3 py-1.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-xs hover:bg-red-500/20 transition-colors"
                  >
                    Clear
                  </button>
                )}
                <button 
                  onClick={handleBgUpload}
                  className="px-3 py-1.5 bg-card border border-border text-white rounded-lg text-xs hover:bg-elevated/80 transition-colors flex items-center gap-2"
                >
                  <ImageIcon size={14} />
                  {bgImage ? t('Change Image') : t('Upload Image')}
                </button>
              </div>
            </div>

            {bgImage && (
              <div className="space-y-4 mt-4">
                <div className="w-full aspect-video rounded-xl border border-border relative overflow-hidden bg-black">
                  <div 
                    className="absolute inset-0 bg-no-repeat"
                    style={{
                      backgroundImage: `url('${bgImage}')`,
                      backgroundSize: themeOverrides['--bg-size'] || 'cover',
                      backgroundPosition: themeOverrides['--bg-position'] || 'center',
                    }}
                  />
                  <div className="absolute inset-0 bg-bg transition-opacity duration-300" style={{ opacity: themeOverrides['--bg-overlay'] || 0, backdropFilter: `blur(${themeOverrides['--bg-blur'] || '0px'})` }} />
                </div>
                
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted">
                    <span>{t("Background Fade / Overlay")}</span>
                    <span>{Math.round((themeOverrides['--bg-overlay'] || 0) * 100)}%</span>
                  </div>
                  <input 
                    type="range" 
                    min="0" 
                    max="1" 
                    step="0.05"
                    value={themeOverrides['--bg-overlay'] || 0}
                    onChange={handleOpacityChange}
                    className="w-full accent-accent h-1 bg-elevated rounded-lg appearance-none cursor-pointer"
                  />
                  <p className="text-[10px] text-muted">{t("Adjusts the visibility of the solid background color over your image.")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted">
                    <span>{t("Background Blur")}</span>
                    <span>{parseInt(themeOverrides['--bg-blur'] || '0')}px</span>
                  </div>
                  <input 
                    type="range" min="0" max="50" step="1"
                    value={parseInt(themeOverrides['--bg-blur'] || '0')} onChange={handleBlurChange}
                    className="w-full accent-accent h-1 bg-elevated rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="text-[10px] text-muted uppercase tracking-wider block mb-1.5">{t("Image Fit")}</label>
                    <select 
                      value={themeOverrides['--bg-size'] || 'cover'}
                      onChange={(e) => saveOverride('--bg-size', e.target.value)}
                      className="w-full bg-elevated border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50"
                    >
                      <option value="cover">{t("Cover (Fill)")}</option>
                      <option value="contain">{t("Contain (Fit)")}</option>
                      <option value="auto">{t("Auto (Original)")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-muted uppercase tracking-wider block mb-1.5">{t("Position")}</label>
                    <select 
                      value={themeOverrides['--bg-position'] || 'center'}
                      onChange={(e) => saveOverride('--bg-position', e.target.value)}
                      className="w-full bg-elevated border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50"
                    >
                      <option value="center">{t("Center")}</option>
                      <option value="top">{t("Top")}</option>
                      <option value="bottom">{t("Bottom")}</option>
                      <option value="left">{t("Left")}</option>
                      <option value="right">{t("Right")}</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-xs text-muted hover:text-white transition-colors"
          >
            {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {t('Advanced Options')}
          </button>

          {showAdvanced && (
            <div className="space-y-3 pt-2 border-t border-border">
              <p className="text-xs text-muted">{t("Override CSS variables")}</p>
              {Object.keys(THEMES.dark.vars).filter(k => k !== '--accent' && k !== '--accent-dim').map((key) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs text-muted w-24 truncate">{key}</span>
                  <input
                    type="text"
                    value={themeOverrides[key] || THEMES[themeName]?.vars[key] || ''}
                    onChange={(e) => saveOverride(key, e.target.value)}
                    className="flex-1 bg-card border border-border rounded px-2 py-1 text-xs text-white outline-none focus:border-accent/50"
                    placeholder={THEMES[themeName]?.vars[key]}
                  />
                </div>
              ))}
              <button
                onClick={resetTheme}
                className="text-xs text-muted hover:text-white transition-colors"
              >
                {t('Reset Overrides')}
              </button>
            </div>
          )}
        </div>
      </Section>
      )}
      {inCategory('appearance') && (
        <Section title="TV Mode">
          <TvModeSettings />
        </Section>
      )}
        
      {inCategory('appearance') && (
      <Section title={t("Now Playing")}>
        <Row label={t("Colour Background")} desc={t("Colour the side panel and full screen player from the album cover. Off: a dark background.")}>
          <button
            onClick={() => set('artwork_backdrop', settings.artwork_backdrop === '0' ? '1' : '0')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.artwork_backdrop !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.artwork_backdrop !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Moving Covers")} desc={t("Play an album's animated cover in the side panel and full screen player, when there is one.")}>
          <button
            onClick={() => set('motion_covers', settings.motion_covers === '0' ? '1' : '0')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.motion_covers !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.motion_covers !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        {settings.motion_covers !== '0' && (() => {
          const all = [['apple', 'Apple Music', 'Animated album covers'], ['tidal', 'Tidal', 'Video album covers'], ['community', 'Community list', 'Clips shared by other listeners'], ['m8tec', 'm8tec Artwork', 'Apple Music animated covers found by artwork.m8tec.top'], ['spotify', 'Spotify Canvas', 'Needs your Spotify cookie (below)']]
          let chosen = ['apple', 'tidal', 'community']
          try { const v = JSON.parse(settings.motion_cover_sources || 'null'); if (Array.isArray(v)) chosen = v } catch {}
          const toggle = (id) => set('motion_cover_sources', JSON.stringify(chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id]))
          return (
            <>
            <Row stacked label={t("Where to Look")} desc={t("Where to find moving covers. These aren't official services, so one can stop working at any time.")}>
              <div className="flex flex-wrap gap-1.5">
                {all.map(([id, label, hint]) => (
                  <button key={id} onClick={() => toggle(id)} title={t(hint)}
                    className={`px-3 py-1 rounded-lg text-xs border transition-colors ${chosen.includes(id) ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
                    {t(label)}
                  </button>
                ))}
              </div>
            </Row>
            {chosen.includes('spotify') && (
              <>
                <Row stacked label={t("Spotify Cookie")} desc={t("Spotify only shows Canvas to signed-in accounts. To sign in here: open open.spotify.com in your browser and sign in, press F12, go to Application (Storage in Firefox) › Cookies › open.spotify.com, and copy the value of sp_dc. It lasts about a year.\n\nIt stays on this computer and is only sent to Spotify.")}>
                  <input type="password" value={settings.spotify_sp_dc || ''} onChange={e => { set('spotify_sp_dc', e.target.value); setSpotifyCheck(null) }}
                    placeholder={t("sp_dc value")} spellCheck={false} autoComplete="off"
                    className="w-full max-w-md bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-accent/50" />
                </Row>
                <Row label={t("Prioritize Spotify Canvas")} desc={t("Ask Spotify first. It has Canvas for many more songs, but they're tall videos, cropped to a square here.")}>
                  <button
                    onClick={() => set('spotify_canvas_first', settings.spotify_canvas_first === '1' ? '0' : '1')}
                    className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.spotify_canvas_first === '1' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
                    {settings.spotify_canvas_first === '1' ? t('On') : t('Off')}
                  </button>
                </Row>
                <div className="flex items-center gap-3">
                  <button onClick={testSpotifyCanvas} disabled={spotifyCheck?.loading}
                    className="px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border border-accent/50 bg-accent/20 text-accent disabled:opacity-50">
                    {spotifyCheck?.loading ? t('Checking...') : t('Save & Test')}
                  </button>
                  {settings.spotify_sp_dc && (
                    <button onClick={async () => {
                      const saved = await api.saveSettings({ spotify_sp_dc: '' }).catch(e => ({ error: e?.message || 'Save failed' }))
                      if (saved?.error) { setSpotifyCheck({ error: `${t("Couldn't remove the cookie")}: ${saved.error}` }); return }
                      set('spotify_sp_dc', ''); setSpotifyCheck(null)
                      window.dispatchEvent(new Event('lokal:settings-saved'))
                    }}
                      className="px-3 py-1.5 rounded-lg text-xs border border-border text-muted hover:text-white transition-colors">
                      {t('Remove')}
                    </button>
                  )}
                  {spotifyCheck && !spotifyCheck.loading && (
                    spotifyCheck.error
                      ? <p className="text-xs text-red-400">{t(spotifyCheck.error)}</p>
                      : <p className="text-xs text-green-400">{t("Signed in -- canvases will be looked up.")}</p>
                  )}
                </div>
              </>
            )}
            </>
          )
        })()}
      </Section>
      )}

      {inCategory('appearance') && (
      <Section title={t("Player Bar")}>
        <Row label={t("Glass")} desc={t("The player bar floats over the page, blurred. Turn off for a plain bar, which is lighter if playback stutters.")}>
          <button
            onClick={() => set('glass_player_bar', settings.glass_player_bar === '0' ? '1' : '0')}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${settings.glass_player_bar !== '0' ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {settings.glass_player_bar !== '0' ? t('On') : t('Off')}
          </button>
        </Row>
        <Row label={t("Visualization")} desc={t("Choose the audio-reactive graphic beside the player controls.")}>
          <select aria-label={t("Player bar visualization")} value={settings.player_visualizer || (settings.player_waveform === '0' ? 'off' : 'waveform')} onChange={e => set('player_visualizer', e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            <option value="off">{t("Off")}</option>
            <option value="waveform">{t("Waveform")}</option>
            <option value="spectrum">{t("Spectrum")}</option>
            <option value="waves">{t("Waves")}</option>
            <option value="lightning">{t("Lightning")}</option>
          </select>
        </Row>
      </Section>
      )}

      {inCategory('appearance') && (
      <Section title={t("Navigation")}>
        <Row stacked label={t("Sidebar order")} desc={t("Drag items to reorder the sidebar. Move items below the divider to group them under More.")}>
          <AppTabsSettings value={settings.sidebar_nav || ''} onChange={value => set('sidebar_nav', value)} />
        </Row>
      </Section>
      )}

      {inCategory('appearance') && (
      <Section title={t("Layout")}>
        <Row label={t("Panel Width")} desc={t("Freeform: drag the inner edge of the sidebar or the side panel to make it wider or narrower (double-click the edge to reset).")}>
          <div className="flex gap-0.5 p-0.5 bg-card rounded-lg border border-border/50">
            {[[false, 'Fixed'], [true, 'Freeform']].map(([value, label]) => (
              <button key={label} onClick={() => setPanelFreeform(value)}
                className={`px-3 py-1 rounded-md text-xs font-display uppercase tracking-wider transition-colors ${panelFreeform === value ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'}`}>
                {t(label)}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label={t("Side Panels")}
          desc={t("Merged: Queue and Lyrics open as tabs in the side panel. Independent: each opens in its own panel next to it.")}
        >
          <div className="flex flex-col items-end gap-1">
          <div className="flex gap-0.5 p-0.5 bg-card rounded-lg border border-border/50">
            {[['1', 'Merged'], ['0', 'Independent']].map(([value, label]) => {
              // Read from the live store, not `settings` -- a click applies
              // the new mode to the store/localStorage immediately, but
              // `settings.exclusive_side_panels` only changes once the
              // backend save resolves (and reverts entirely if "Save
              // Settings" is never clicked), so deriving the highlight from
              // it could show the wrong button as active right after a
              // click, or after a reload before the save round-trips.
              const current = exclusiveSidePanels ? '1' : '0'
              return (
                <button
                  key={value}
                  onClick={() => {
                    set('exclusive_side_panels', value)
                    try { localStorage.setItem('lokal-exclusive-panels', value) } catch {}
                    setExclusiveSidePanels(value === '1')
                    // This takes effect instantly (localStorage + the live
                    // store above), unlike most settings on this page which
                    // wait for the "Save Settings" button -- but set() only
                    // updates this component's own local `settings` copy, so
                    // without this the backend's exclusive_side_panels stayed
                    // on the old value until the user happened to click Save
                    // Settings for some unrelated change. A fresh install, a
                    // browser with no localStorage entry yet, or any other
                    // consumer of the backend setting would then see the old
                    // choice despite the UI already showing the new one.
                    const seq = ++sidePanelsSaveSeq
                    sidePanelsSaveChain = sidePanelsSaveChain
                      .catch(() => {}) // a prior failure shouldn't block this attempt
                      .then(() => api.saveSettings({ exclusive_side_panels: value }))
                      .then(() => {
                        if (seq === sidePanelsSaveSeq) setSidePanelsSaveError(false)
                      })
                      .catch((err) => {
                        console.error('Failed to save Side Panels setting', err)
                        if (seq === sidePanelsSaveSeq) setSidePanelsSaveError(true)
                      })
                  }}
                  className={`px-3 py-1 rounded-md text-xs font-display uppercase tracking-wider transition-colors ${current === value ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'}`}
                >
                  {t(label)}
                </button>
              )
            })}
          </div>
          {sidePanelsSaveError && (
            <p className="text-[11px] text-red-400 flex items-center gap-1">
              <AlertTriangle size={11} /> {t("Couldn't save -- will retry on next change")}
            </p>
          )}
          </div>
        </Row>
        <Row label={t("Open the Side Panel on Play")} desc={t("Open the side panel when you start a song, album or playlist.")}>
          <button
            onClick={() => { const v = !autoOpenSidePanel; setAutoOpenSidePanel(v); set('auto_open_side_panel', v ? '1' : '0') }}
            className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors ${autoOpenSidePanel ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
            {autoOpenSidePanel ? t('On') : t('Off')}
          </button>
        </Row>
      </Section>
      )}

      {inCategory('data') && (
      <Section title={t("Accounts")}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-white font-medium">{t("Local Accounts")}</p>
            <button
              onClick={loadUsers}
              disabled={usersLoading}
              className="px-3 py-1.5 bg-card border border-border rounded-lg text-xs text-muted hover:text-white transition-colors disabled:opacity-50"
            >
              {usersLoading ? t('Loading...') : t('Refresh')}
            </button>
          </div>
          <p className="text-xs text-muted">
            {t('Delete accounts directly from Lokal if one was created with the wrong password or is no longer needed.')}
          </p>
          {accountStatus && <p className="text-xs text-accent">{t(accountStatus)}</p>}
          <div className="space-y-2">
            {!usersLoading && usersTried && appUsers.length === 0 && (
              <p className="text-xs text-muted">{t("No local accounts found.")}</p>
            )}
            {appUsers.map((account) => (
              <div key={account.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-card/40">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">
                    {account.display_name || account.username}
                    {user?.id === account.id && <span className="text-xs text-accent ml-2">{t("Current")}</span>}
                  </p>
                  <p className="text-xs text-muted truncate">@{account.username}</p>
                </div>
                <button
                  onClick={() => setUserToDelete(account)}
                  className="px-3 py-1.5 rounded-lg text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      </Section>
      )}

      {inCategory('data') && (
      <Section title={t("Metadata")}>
        <Row label={t("Import Track Metadata")} desc={t("Add genres, labels and other details from an export (like Exportify) to the songs you already have.")}>
          <button onClick={() => { setPlatformImportStatus(''); setPlatformImportPreview(null); setPlatformImportFiles([]); setPlatformImportFileName(''); setPlatformImportFileContent(''); setShowPlatformImportGuide(true) }}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white hover:border-accent/30 transition-colors">
            <Link size={14} /> Import Metadata
          </button>
        </Row>
      </Section>
      )}

      {inCategory('data') && (
      <Section title={t("Backup")}>
        <Row label={t("Full App Export")} desc={t("Save everything (accounts, settings, themes, playlists, likes, history) to one file. Your music files aren't included.")}>
          <button
            onClick={handleFullExport}
            disabled={exportingAllData}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors disabled:opacity-50"
          >
            <Download size={13} /> {exportingAllData ? t('Exporting...') : t('Export All')}
            {fullExported && <span className="text-accent text-xs ml-1">✓</span>}
          </button>
        </Row>
        <Row label={t("Import Backup")} desc={t("Restore from a backup file. You'll see what it holds before anything is replaced.")}>
          <button
            onClick={readImportBackup}
            disabled={importingAllData}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCcw size={13} /> {importingAllData ? t('Importing...') : t('Import')}
          </button>
        </Row>
      </Section>
      )}

      {inCategory('data') && (
      <Section title={t("History")}>
        <Row label={t("Export History")} desc={t("Save your listening history as a file.")}>
          <div className="relative">
            <button 
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors"
            >
              <Download size={13} /> {t('Export')}
              {historyExported && <span className="text-accent text-xs ml-1">✓</span>}
            </button>
            {showExportMenu && (
              <div className="absolute right-0 mt-1 min-w-32 bg-elevated border border-border rounded-lg shadow-xl py-1 z-50">
                <button
                  onClick={() => handleHistoryExport('json')}
                  className="w-full px-3 py-2 text-left text-sm text-muted hover:text-white hover:bg-card flex items-center gap-2"
                >
                  <Download size={14} /> {t('JSON')}
                </button>
                <button
                  onClick={() => handleHistoryExport('csv')}
                  className="w-full px-3 py-2 text-left text-sm text-muted hover:text-white hover:bg-card flex items-center gap-2"
                >
                  <Download size={14} /> {t('CSV')}
                </button>
              </div>
            )}
          </div>
        </Row>
      </Section>
      )}

      {api.isElectron && inCategory('data') && (
      <Section title={t("Cache Analysis")}>
        <Row label={t("Analyze storage")} desc={t("Inspect Lokal's disk usage and remove unused caches, old logs and other recoverable data.")}>
          <button onClick={() => navigate('/cache-analysis')}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white transition-colors">
            <Search size={14} /> {t('Open Cache Analysis')}
          </button>
        </Row>
      </Section>
      )}

      {api.isElectron && inCategory('data') && (
      <Section title={t("Cache")}>
         <Row label={t("Cache Size Limit")} desc={t("Moving covers, converted copies of songs (Apple Lossless, WMA…) and songs converted for casting are kept so they load faster. Past this size, the oldest are removed. Downloaded videos are kept in your Videos folder.")}>
          <select aria-label={t("Cache size limit")} value={String(Math.round((cacheInfo?.limit || 4096 * 1048576) / 1048576))} onChange={e => setCacheLimit(Number(e.target.value))}
            className="bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-accent/50">
            {(cacheInfo?.limits || [512, 1024, 2048, 4096, 8192, 16384]).map(mb => <option key={mb} value={String(mb)}>{mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}</option>)}
          </select>
        </Row>
         <Row label={t("In Use")} desc={cacheInfo ? t('Older video downloads {video} · Moving covers {covers} · Playable copies {playback} · Web cache {web}', { video: fmtBytes(cacheInfo.musicVideo), covers: fmtBytes(cacheInfo.motion), playback: fmtBytes(cacheInfo.playback), web: fmtBytes(cacheInfo.web) }) : t('Measuring…')}>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white font-display">{cacheInfo ? fmtBytes((cacheInfo.motion || 0) + (cacheInfo.playback || 0) + (cacheInfo.musicVideo || 0) + (cacheInfo.cast || 0) + (cacheInfo.web || 0)) : '—'}</span>
            <button onClick={clearCache} disabled={!cacheInfo || cacheInfo.busy}
              className="px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border border-border text-muted hover:text-white disabled:opacity-50 transition-colors">
              {cacheInfo?.busy ? t('Clearing…') : t('Clear Cache')}
            </button>
          </div>
        </Row>
      </Section>
      )}

      {inCategory('data') && (
      <Section title={t("Danger Zone")}>
        <Row label={t("Clear Library")} desc={t("Remove every song, playlist, like and play from Lokal, keeping your accounts and settings. Your music files aren't touched.")}>
          <button onClick={() => setShowClearModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-red-500/15 border border-red-500/30 text-red-400 rounded-lg text-sm hover:bg-red-500/25 transition-colors">
            <Trash2 size={13} /> {t('Clear')}
          </button>
        </Row>
        <Row label={t("Factory Reset Lokal")} desc={t("Start over: erase everything Lokal keeps on this computer, accounts and settings included. Your music files aren't touched.")}>
          <button
            onClick={() => setShowFactoryResetModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-red-500/15 border border-red-500/30 text-red-400 rounded-lg text-sm hover:bg-red-500/25 transition-colors"
          >
            <Trash2 size={13} /> {t('Factory Reset')}
          </button>
        </Row>
      </Section>
      )}

      </SectionSwap>
      </SettingsSearchContext.Provider>

      <Modal open={showClearModal} onClose={() => setShowClearModal(false)} title={t("Clear All Library Data?")} width="max-w-sm">
        <div className="space-y-4">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-white/70 leading-relaxed">{t("Removes all tracks, artists, playlists, and history. Music files are untouched.")}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowClearModal(false)} className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors">{t("Cancel")}</button>
            <button onClick={async () => { await api.clearTracks(); setShowClearModal(false) }}
              className="flex-1 py-2.5 bg-red-500/20 border border-red-500/30 text-red-400 rounded-xl text-sm font-medium hover:bg-red-500/30 transition-colors">
              {t('Clear Everything')}
            </button>
          </div>
        </div>
      </Modal>
      <Modal 
        open={showGenreModal} 
        onClose={() => { setShowGenreModal(false); setStatusMessage(''); setStatusMessageValues(null); setStatusMessageIsError(false) }}
        title={t("Manual Genre Assignment")} 
        width="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-xs text-muted leading-relaxed">
            {t("Overrides take priority over online fetching. Use this if iTunes or MusicBrainz can't find it.")}
          </p>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-display text-muted uppercase tracking-widest block mb-1.5">{t("Artist (Required)")}</label>
                <input 
                  value={manualGenreArtist} 
                  onChange={e => setManualGenreArtist(e.target.value)}
                  placeholder={t("e.g. KENTENSHI")}
                  className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" 
                />
              </div>
              <div>
                <label className="text-[10px] font-display text-muted uppercase tracking-widest block mb-1.5">{t("Genre (Required)")}</label>
                <input 
                  value={manualGenreValue} 
                  onChange={e => setManualGenreValue(e.target.value)}
                  placeholder={t("e.g. Breakcore")}
                  className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" 
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/50">
              <div>
                <label className="text-[10px] font-display text-muted/60 uppercase tracking-widest block mb-1.5">{t("Track (Optional)")}</label>
                <input 
                  value={manualGenreTrack} 
                  onChange={e => setManualGenreTrack(e.target.value)}
                  placeholder={t("Song name")}
                  className="w-full bg-card/40 border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/30" 
                />
              </div>
              <div>
                <label className="text-[10px] font-display text-muted/60 uppercase tracking-widest block mb-1.5">{t("Album (Optional)")}</label>
                <input 
                  value={manualGenreAlbum} 
                  onChange={e => setManualGenreAlbum(e.target.value)}
                  placeholder={t("Album title")}
                  className="w-full bg-card/40 border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/30" 
                />
              </div>
            </div>
          </div>

          {statusMessage && (
            <div className={`p-2.5 rounded-lg border text-center text-xs font-medium ${statusMessageIsError ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-accent/10 border-accent/20 text-accent'}`}>
              {t(statusMessage, statusMessageValues)}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button 
              onClick={() => { setShowGenreModal(false); setStatusMessage(''); setStatusMessageValues(null); setStatusMessageIsError(false) }}
              className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors"
            >
              {t('Cancel')}
            </button>
            <button 
              onClick={async () => {
                if (!manualGenreArtist || !manualGenreValue) {
                  setStatusMessage('Artist and Genre are required')
                  setStatusMessageValues(null)
                  setStatusMessageIsError(true)
                  return;
                }
                const result = await api.setManualGenre({ 
                  artist: manualGenreArtist, 
                  track: manualGenreTrack || null,
                  album: manualGenreAlbum || null,
                  genre: manualGenreValue 
                });
                setStatusMessage(result?.error || '✓ Updated {count} track(s)')
                setStatusMessageValues(result?.error ? null : { count: result?.updated || 0 })
                setStatusMessageIsError(!!result?.error)
                
                if (!result?.error) {
                  setManualGenreArtist('');
                  setManualGenreTrack('');
                  setManualGenreAlbum('');
                  setManualGenreValue('');
                  setTimeout(() => setShowGenreModal(false), 1500);
                }
              }} 
              className="flex-1 py-2.5 bg-accent text-base rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
            >
              {t('Apply Mapping')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showCommaModal} onClose={() => setShowCommaModal(false)} title={t("Keep Comma in Artist Names")} width="max-w-md">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {t("These artists won't have their comma removed. This prevents \"Tyler, The Creator\" from becoming \"Tyler\" and \"The Creator\". Enter one artist per line.")}
          </p>
          <div className="bg-card/50 rounded-lg p-3 mb-2">
            <p className="text-xs text-muted mb-2">{t("Examples (one per line):")}</p>
            <div className="flex flex-wrap gap-2">
              {['Tyler, The Creator', 'Earth, Wind & Fire'].map(ex => (
                <span key={ex} className="text-xs bg-accent/20 text-accent px-2 py-1 rounded">{ex}</span>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1.5">{t("Artists (one per line)")}</label>
            <textarea value={commaInput} onChange={e => setCommaInput(e.target.value)}
              placeholder={t("Tyler, The Creator\nEarth, Wind & Fire")}
              rows={6}
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50 resize-none" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowCommaModal(false)} className="flex-1 py-2 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors">{t("Cancel")}</button>
            <button onClick={saveCommaArtists}
              className="flex-1 py-2 bg-accent text-base rounded-xl text-sm font-medium transition-colors">
              {t('Save')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showDups} onClose={() => { setShowDups(false); setMergeAllResult(null) }} title={t("Duplicate Tracks")} width="max-w-2xl">
        {duplicateMessage && <p role="alert" className="text-sm text-amber-400 mb-3 break-words">{duplicateMessage}</p>}
        {dups?.length === 0 && <p className="text-accent text-sm text-center py-6">{t("✓ No duplicates found!")}</p>}
        
        {dups?.length > 0 && (
          <div className="mb-4">
            <button
              onClick={() => setShowMergeAllConfirm(true)}
              disabled={mergingAll || mergingDuplicate}
              className="flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/50 text-accent rounded-lg text-sm font-medium hover:bg-accent/30 disabled:opacity-40 transition-colors"
            >
              <Zap size={14} />
              {mergingAll ? t('Merging...') : t('Smart Merge All')}
            </button>
            {mergeAllResult && (
              <p className={`text-xs mt-2 ${mergeAllResult.error ? 'text-red-400' : 'text-accent'}`}>
                {mergeAllResult.error ? t('Error: {error}', { error: t(mergeAllResult.error) }) : t('✓ Merged {tracks} tracks across {groups} groups', { tracks: mergeAllResult.merged, groups: mergeAllResult.groups })}
              </p>
            )}
          </div>
        )}
        
        {dups?.length > 0 && (
          <div className="space-y-3 max-h-96 overflow-y-auto">
            <p className="text-xs text-muted mb-2">{t("Merge keeps the selected copy and fills missing metadata from the others. Removed copies’ audio files go to Trash on desktop and are permanently deleted in web mode, even when “Delete files too” is off.")}</p>
            {dups.map((d, i) => {
              return (
                <div key={i} className="p-3 bg-card border border-border rounded-xl flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium">{d.title}</p>
                    <p className="text-xs text-muted">{d.artist} · {d.count} copies</p>
                    <p className="text-xs text-muted/40 mt-0.5 truncate">{d.paths}</p>
                  </div>
                  <button
                    disabled={mergingAll || mergingDuplicate}
                    onClick={() => mergeDup(d)}
                    className="flex-shrink-0 px-3 py-1.5 bg-accent/15 border border-accent/30 text-accent rounded-lg text-xs font-display uppercase tracking-wider hover:bg-accent/25 transition-colors"
                  >
                    {t('Merge → Keep First')}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </Modal>

      <Modal open={showMergeAllConfirm} onClose={() => setShowMergeAllConfirm(false)} title={t("Smart Merge All Duplicates?")} width="max-w-sm">
        <div className="space-y-4">
          <div className="flex gap-3">
            <Zap size={18} className="text-accent flex-shrink-0 mt-0.5" />
            <div className="text-sm text-white/70 leading-relaxed">
              <p>{t("This will automatically merge all duplicate tracks across your entire library using smart scoring:")}</p>
              <ul className="mt-2 text-xs text-muted space-y-1">
                <li>{t("• Bitrate ÷ 100 points (320kbps = 3.2pts)")}</li>
                <li>{t("• +10 points if has artwork")}</li>
                <li>{t("• +5 points if has album")}</li>
                <li>{t("• +3 points if has year")}</li>
                <li>{t("• +2 points if has genre")}</li>
              </ul>
              <p className="mt-2">{t("The highest scoring copy wins. Missing metadata is filled from the other copies, then their audio files are removed from your music folder (Trash on desktop; permanently deleted in web mode).")}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowMergeAllConfirm(false)} className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors">{t("Cancel")}</button>
            <button onClick={mergeAllDuplicates} className="flex-1 py-2.5 bg-accent/20 border border-accent/50 text-accent rounded-xl text-sm font-medium hover:bg-accent/30 transition-colors">
              {t('Merge All')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showPossibleDups} onClose={() => setShowPossibleDups(false)} title={t("Possible Duplicates")} width="max-w-4xl">
        {duplicateMessage && <p role="alert" className="text-sm text-amber-400 mb-3 break-words">{duplicateMessage}</p>}
        {possibleDups?.length === 0 && (
          <div className="space-y-2 py-4">
            <p className="text-accent text-sm text-center">{t("✓ No possible duplicates found.")}</p>
            <p className="text-xs text-muted text-center">{t("Run Exact first, then come back here for what's left.")}</p>
          </div>
        )}

        {possibleDups?.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              This pass is intentionally review-based. Run the exact duplicate checker first, then use this for tracks that look like the same song but do not have identical names. Keep This removes the other copies’ audio files from your music folder (Trash on desktop; permanently deleted in web mode), even when “Delete files too” is off.
            </p>
            <div className="space-y-3 max-h-[34rem] overflow-y-auto pr-1">
              {possibleDups.map((group) => (
                <div key={group.id} className="rounded-2xl border border-border bg-card/40 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm text-white font-medium">{t("Possible match group")}</p>
                      <p className="text-xs text-muted mt-1">{group.summary}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-display uppercase tracking-widest text-accent">{group.confidence}% confidence</p>
                      <p className="text-[10px] text-muted mt-1">{t("Suggested keep is marked below")}</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {group.tracks.map((track) => {
                      const suggested = track.id === group.suggestedKeepId
                      return (
                        <div key={track.id} className={`rounded-xl border px-3 py-3 flex items-center gap-3 ${suggested ? 'border-accent/40 bg-accent/10' : 'border-border bg-elevated/40'}`}>
                          <div className="w-10 h-10 rounded-lg overflow-hidden bg-card border border-border flex items-center justify-center flex-shrink-0">
                            {track.artwork_path ? (
                              <img src={api.isElectron ? `file://${track.artwork_path}` : api.artworkURL(track.id)} className="w-full h-full object-cover" />
                            ) : (
                              <Music2 size={15} className="text-muted" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm text-white truncate">{track.title}</p>
                              {suggested && <span className="text-[10px] text-accent uppercase tracking-widest">{t("Suggested")}</span>}
                            </div>
                            <p className="text-xs text-muted truncate">{track.artist}</p>
                            <p className="text-[10px] text-muted/70 truncate">
                              {track.album || t('No album')} · {track.duration ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}` : '--:--'} · {track.bitrate ? `${track.bitrate}kbps` : t('Unknown bitrate')}
                            </p>
                            <p className="text-[10px] text-muted/50 truncate mt-1">{track.file_path}</p>
                          </div>
                          <button
                            disabled={mergingDuplicate}
                            onClick={() => mergePossibleDup(group, track.id)}
                            className={`flex-shrink-0 px-3 py-2 rounded-lg text-xs font-display uppercase tracking-wider transition-colors ${suggested ? 'bg-accent/20 border border-accent/40 text-accent hover:bg-accent/30' : 'bg-card border border-border text-muted hover:text-white hover:border-accent/30'}`}
                          >
                            {t('Keep This')}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={showPlatformImportGuide} onClose={() => { setShowPlatformImportGuide(false); setPlatformImportStatus('') }} title={t("Import Track Metadata")} width="max-w-5xl">
        <div className="flex max-h-[calc(100vh-8rem)] min-h-0 flex-col gap-5">
          <div className="rounded-xl border border-border bg-card/40 p-4 space-y-2">
            <p className="text-sm text-white">{t("Use CSV, JSON, or M3U exports to enrich songs already in your library.")}</p>
            <p className="text-xs text-muted leading-relaxed">
              {t("Lokal will match each row against your library and apply imported metadata like genres, explicit flags, labels, and audio features. Unmatched rows are saved locally and retried later when those songs enter your library.")}
            </p>
          </div>

          <div className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(320px,0.9fr)_minmax(320px,1.1fr)]">
            <div className="space-y-4">
              <div>
                <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1.5">{t("Source Platform")}</label>
                <select
                  value={platformImportPlatform}
                  onChange={e => setPlatformImportPlatform(e.target.value)}
                  className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
                >
                  <option value="spotify">{t("Spotify / Exportify CSV")}</option>
                  <option value="apple-music">{t("Apple Music Export")}</option>
                  <option value="youtube-music">{t("YouTube Music / Google Takeout")}</option>
                  <option value="lastfm">{t("Last.fm Export")}</option>
                  <option value="generic">{t("Generic CSV / JSON / M3U")}</option>
                </select>
              </div>
              <div className="rounded-xl border border-border bg-card/30 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-white">{t("Choose Export File")}</p>
                    <p className="text-xs text-muted mt-1">{t("CSV works best. You can select multiple files at once and Lokal will merge them into one preview/import pass.")}</p>
                  </div>
                  <button
                    onClick={handlePlatformFileSelect}
                    className="px-4 py-2 bg-card border border-border rounded-lg text-sm text-muted hover:text-white hover:border-accent/30 transition-colors flex items-center gap-2"
                  >
                    <ListMusic size={14} /> {t('Choose Files')}
                  </button>
                </div>
                <div className="rounded-lg border border-border bg-elevated/70 px-3 py-2 text-xs text-muted">
                  {platformImportFileName || t('No files selected')}
                </div>
                {!!platformImportPreview?.files?.length && (
                  <div className="max-h-28 overflow-y-auto rounded-lg border border-border bg-elevated/40">
                    {platformImportPreview.files.map((file, index) => (
                      <div key={`${file.fileName || 'file'}-${index}`} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted last:border-b-0">
                        <span className="truncate">{file.fileName || `File ${index + 1}`}</span>
                        <span className="flex-shrink-0">{file.total} rows</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card/30 p-4 space-y-3">
              <p className="text-sm text-white">{t("What Lokal will do")}</p>
              <div className="space-y-2 text-xs text-muted leading-relaxed">
                <p>{t("Matched songs stay in place and get enriched with imported metadata.")}</p>
                <p>{t("Multi-genre values, explicit flags, labels, and audio features can then feed mixes and queue suggestions.")}</p>
                <p>{t("Unmatched rows are stored locally so future downloads or imports can use that metadata automatically.")}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-2">
                <div className="rounded-lg bg-elevated/70 px-3 py-3 text-center">
                  <p className="text-lg text-white font-medium">{platformImportPreview?.total || 0}</p>
                  <p className="text-[10px] uppercase tracking-[0.22em] text-muted">{t("Rows")}</p>
                </div>
                <div className="rounded-lg bg-elevated/70 px-3 py-3 text-center">
                  <p className="text-lg text-white font-medium">{platformImportPreview?.matched || 0}</p>
                  <p className="text-[10px] uppercase tracking-[0.22em] text-muted">{t("Matched")}</p>
                </div>
                <div className="rounded-lg bg-elevated/70 px-3 py-3 text-center">
                  <p className="text-lg text-white font-medium">{platformImportPreview?.ghostable || 0}</p>
                  <p className="text-[10px] uppercase tracking-[0.22em] text-muted">{t("Saved")}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 rounded-xl border border-border bg-card/30 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-white font-medium">{t("Preview")}</p>
                <p className="text-xs text-muted mt-1">{t("This preview shows which rows Lokal can match now and which rows will be remembered for later.")}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <span className="px-2.5 py-1 rounded-full border border-border text-[10px] uppercase tracking-[0.22em] text-muted">{t("CSV")}</span>
                <span className="px-2.5 py-1 rounded-full border border-border text-[10px] uppercase tracking-[0.22em] text-muted">{t("JSON")}</span>
                <span className="px-2.5 py-1 rounded-full border border-border text-[10px] uppercase tracking-[0.22em] text-muted">M3U</span>
                <span className="px-2.5 py-1 rounded-full border border-border text-[10px] uppercase tracking-[0.22em] text-muted">{t("Text")}</span>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="hidden gap-0 bg-elevated/80 px-4 py-3 text-[10px] uppercase tracking-[0.24em] text-muted md:grid md:grid-cols-[1.3fr_1.1fr_1.1fr_0.9fr_1.2fr]">
                <span>{t("Track")}</span>
                <span>{t("Artist")}</span>
                <span>{t("Album")}</span>
                <span>{t("Status")}</span>
                <span>{t("What Lokal Does")}</span>
              </div>
              <div className="max-h-[34vh] overflow-y-auto divide-y divide-border bg-card/30">
                {(platformImportPreview?.rows || []).map((row) => (
                  <div key={`${row.artist}-${row.title}`} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1.3fr_1.1fr_1.1fr_0.9fr_1.2fr] md:gap-0">
                    <span className="text-white truncate pr-3">{row.title}</span>
                    <span className="text-muted truncate pr-3">{row.artist}</span>
                    <span className="text-muted truncate pr-3">{row.album}</span>
                    <span className="text-accent truncate pr-3">{t(row.status !== 'Matched' ? 'Saved for Later' : row.status)}</span>
                    <span className="text-muted truncate">{t(row.status === 'Matched' ? 'Apply imported metadata' : 'Save for future match')}</span>
                  </div>
                ))}
                {!platformImportPreview?.rows?.length && (
                  <div className="px-4 py-8 text-center text-sm text-muted">
                    {t("Choose an export file to preview the imported songs here.")}
                  </div>
                )}
              </div>
            </div>
          </div>

          {platformImportStatus && (
            <div className="rounded-xl border border-border bg-card/30 px-4 py-3 text-sm text-muted">
              {t(platformImportStatus)}
            </div>
          )}

          <div className="sticky bottom-0 flex gap-2 border-t border-border bg-elevated pt-4">
            <button onClick={() => setShowPlatformImportGuide(false)} className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors">{t("Cancel")}</button>
            <button onClick={handlePlatformImport} disabled={platformImporting || !platformImportPreview?.total} className="flex-1 py-2.5 bg-accent text-base rounded-xl text-sm font-medium transition-colors disabled:opacity-50">
              {platformImporting ? t('Importing...') : t('Apply Metadata')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!userToDelete} onClose={() => setUserToDelete(null)} title={t("Delete Local Account?")} width="max-w-sm">
        <div className="space-y-4">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-white/70 leading-relaxed">
              <p>
                Delete <span className="text-white">{userToDelete?.display_name || userToDelete?.username}</span> from Lokal?
              </p>
              <p className="text-xs text-muted mt-2">
                This removes the local account record, playlists owned by that account, likes, history, saved user settings, and avatar data.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setUserToDelete(null)} className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors">{t("Cancel")}</button>
            <button onClick={handleDeleteUser} className="flex-1 py-2.5 bg-red-500/20 border border-red-500/30 text-red-400 rounded-xl text-sm font-medium hover:bg-red-500/30 transition-colors">
              Delete Account
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showImportModal} onClose={() => { if (!importingAllData) { setShowImportModal(false); setImportPreview(null) } }} title={t("Import Backup?")} width="max-w-lg">
        <div className="space-y-4">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="text-orange-300 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-white/70 leading-relaxed">
              <p>{t("This will replace Lokal's current local database and settings with the selected backup.")}</p>
              <p className="text-xs text-muted mt-2">{t("Current local data will be overwritten. Audio files on disk are not deleted.")}</p>
            </div>
          </div>
          {importPreview && (
            <div className="rounded-xl border border-border bg-card/40 p-4 space-y-3">
              <p className="text-xs text-muted break-all">{importPreview.filePath}</p>
              <div className="grid grid-cols-5 gap-2 text-center">
                <div className="rounded-lg bg-card px-2 py-3">
                  <p className="text-lg text-white font-medium">{importPreview.summary.users}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{t("Users")}</p>
                </div>
                <div className="rounded-lg bg-card px-2 py-3">
                  <p className="text-lg text-white font-medium">{importPreview.summary.artists}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{t("Artists")}</p>
                </div>
                <div className="rounded-lg bg-card px-2 py-3">
                  <p className="text-lg text-white font-medium">{importPreview.summary.tracks}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{t("Tracks")}</p>
                </div>
                <div className="rounded-lg bg-card px-2 py-3">
                  <p className="text-lg text-white font-medium">{importPreview.summary.playlists}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{t("Playlists")}</p>
                </div>
                <div className="rounded-lg bg-card px-2 py-3">
                  <p className="text-lg text-white font-medium">{importPreview.summary.history}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{t("History")}</p>
                </div>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => { setShowImportModal(false); setImportPreview(null) }} disabled={importingAllData} className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors disabled:opacity-50">{t("Cancel")}</button>
            <button onClick={handleImportBackup} disabled={importingAllData || !importPreview} className="flex-1 py-2.5 bg-orange-500/20 border border-orange-500/30 text-orange-200 rounded-xl text-sm font-medium hover:bg-orange-500/30 transition-colors disabled:opacity-50">
              {importingAllData ? t('Importing...') : t('Replace with Backup')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showFactoryResetModal} onClose={() => setShowFactoryResetModal(false)} title={t("Factory Reset Lokal?")} width="max-w-md">
        <div className="space-y-4">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-white/70 leading-relaxed">
              <p>{t("This will erase Lokal's local accounts, settings, themes, playlists, history, artists, tracks, and cached assets on this device.")}</p>
              <p className="text-xs text-muted mt-2">{t("Your music files on disk will not be deleted.")}</p>
            </div>
          </div>
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3">
            <p className="text-xs text-red-200">{t("Strongly recommended: export a full backup before continuing.")}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowFactoryResetModal(false)} className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors">{t("Cancel")}</button>
            <button onClick={() => { setShowFactoryResetModal(false); setShowFactoryResetConfirmModal(true) }} className="flex-1 py-2.5 bg-red-500/20 border border-red-500/30 text-red-400 rounded-xl text-sm font-medium hover:bg-red-500/30 transition-colors">
              {t('Continue')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showFactoryResetConfirmModal} onClose={() => { if (!factoryResetting) { setShowFactoryResetConfirmModal(false); setResetConfirmText(''); setResetConfirmArmed(false) } }} title={t("Final Confirmation")} width="max-w-md">
        <div className="space-y-4">
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 space-y-2">
            <p className="text-sm text-white">Type <span className="text-red-300 font-medium">{t("RESET LOKAL")}</span> {t("to confirm.")}</p>
            <p className="text-xs text-muted">{t("This is intended to make accidental resets much harder.")}</p>
          </div>
          <input
            value={resetConfirmText}
            onChange={(e) => setResetConfirmText(e.target.value)}
            placeholder={t("RESET LOKAL")}
            className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-red-400/50"
          />
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={resetConfirmArmed}
              onChange={(e) => setResetConfirmArmed(e.target.checked)}
              className="accent-red-400"
            />
            {t("I understand this cannot be undone.")}
          </label>
          <div className="flex gap-2">
            <button onClick={() => { setShowFactoryResetConfirmModal(false); setResetConfirmText(''); setResetConfirmArmed(false) }} disabled={factoryResetting} className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors disabled:opacity-50">{t("Cancel")}</button>
            <button
              onClick={handleFactoryReset}
              disabled={factoryResetting || resetConfirmText !== t('RESET LOKAL') || !resetConfirmArmed}
              className="flex-1 py-2.5 bg-red-500/20 border border-red-500/30 text-red-400 rounded-xl text-sm font-medium hover:bg-red-500/30 transition-colors disabled:opacity-50"
            >
              {factoryResetting ? t('Resetting...') : t('Factory Reset')}
            </button>
          </div>
        </div>
      </Modal>

    </div>
  )
}

// Settings → Integrations → Spotify → Sync Likes (electron/ipc/spotifyLikes.js).
function SpotifyLikesRow({ hasCookie, userId }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const unknown = { enabled: false, unknown: true, error: t('Error reading whether sync is enabled. Reopen Settings to try again.') }
    Promise.resolve(api.spotifyLikesStatus()).then(next => setStatus(next || unknown)).catch(() => setStatus(unknown))
  }, [])
  const on = !!status?.enabled
  // Until its state is known, the switch waits: turning "on" an already-on
  // sync would move its starting point past likes not yet brought in.
  const loading = status === null || !!status.unknown
  const toggle = async () => {
    if (loading || busy) return
    setBusy(true)
    try {
      const next = on ? await api.spotifyLikesDisable() : await api.spotifyLikesEnable(userId)
      setStatus(next)
      window.dispatchEvent(new Event('lokal:spotify-likes-changed'))
    } finally { setBusy(false) }
  }
  const since = status?.since ? new Date(status.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  const desc = !hasCookie ? t('Add your Spotify cookie above first.')
    : status?.error ? t(status.error)
      : on ? t('Songs you like here are liked on Spotify, and songs you like on Spotify are liked here, since {since}. Likes from before stay where they are.', { since })
        : t('Songs you like here are liked on Spotify, and songs you like on Spotify from now on are liked here. Your existing Spotify likes aren\'t brought in.')
  return (
    <Row label={t("Sync Likes")} desc={desc}>
      <button disabled={!hasCookie || busy || loading} aria-pressed={on} onClick={toggle}
        className={`px-4 py-1.5 rounded-lg text-xs font-display uppercase tracking-wider border transition-colors disabled:opacity-40 ${on ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white'}`}>
        {busy || loading ? '…' : on ? t('On') : t('Off')}
      </button>
    </Row>
  )
}

