// Online results (YouTube Music, SoundCloud) for web mode. Same as the desktop app's
// online IPC, plus /stream/:provider/:id, which relays the audio through this
// server: YouTube's audio URLs only work from the address that asked for
// them, which is this server, not the browser.

const router = require('express').Router()
const { Readable } = require('stream')
const { getDB } = require('../../electron/ipc/db')
const { cookieArgs } = require('../../electron/ipc/ytCookies')
const { runJsonSearch, mapSearchResult } = require('../../electron/download/search')
const sources = require('../../electron/online/sources')
const genres = require('../../electron/online/genres')
const youtube = require('../../electron/online/youtube')
const { createArtworkResolver } = require('../../electron/discoveryArtwork')
const discoveryArtwork = createArtworkResolver({ getDB, searchArtists: require('../../electron/ipc/artistMetadata').searchArtistMetadataCandidates, searchSongs: youtube.searchSongs })

/** yt-dlp, found the same way the web downloader finds it. */
function ytdlp() {
  return require('./download').findBinary('yt-dlp')
}

/** All settings as { key: value }. */
function settings() {
  try { return Object.fromEntries(getDB().prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])) } catch { return {} }
}

/** yt-dlp and the user's YouTube cookie options, for resolving streams. */
function streamOptions() {
  const all = settings()
  // Only YouTube streams go through yt-dlp with cookies.
  const cookies = cookieArgs(all, { url: 'https://music.youtube.com/' })
  return { db: getDB(), quality: all.online_quality === 'saver' ? 'saver' : 'best', ytdlp: ytdlp(), cookieArgs: cookies.args, cookieBrowser: cookies.usedBrowser }
}

function accountCookies() {
  return settings().yt_cookie_header || ''
}

/** Plain YouTube search through yt-dlp, for when YouTube Music can't be reached. */
async function youtubeFallback(query) {
  const bin = ytdlp()
  if (!bin) throw new Error('YouTube Music could not be reached, and yt-dlp is not installed.')
  const found = await runJsonSearch(bin, String(query || ''), mapSearchResult, 1, 10)
  return (found.results || []).map(r => ({
    videoId: r.id, title: r.title, artist: r.channel, artists: [r.channel], album: null,
    duration: r.duration || null, thumbnail: r.thumbnail, kind: r.topic ? 'song' : 'video', official: !!r.official, url: r.url,
  }))
}

router.get('/global', async (req, res) => {
  try {
    const { preferredGlobalSearch } = require('../../electron/online/globalCatalogue')
    const saved = settings()
    res.json(await preferredGlobalSearch(req.query.q, {
      country: req.query.country, limit: req.query.limit, offset: req.query.offset,
      source: saved.global_catalogue_source === 'spotify' ? 'spotify' : 'apple',
      rawCookie: saved.spotify_sp_dc || '',
    }))
  } catch (error) {
    res.status(502).json({ error: String(error.message || error), tracks: [], albums: [], artists: [] })
  }
})

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 200)
  const provider = sources.providerOf(String(req.query.provider || '')) ? String(req.query.provider) : 'yt'
  try {
    res.json(await sources.search(provider, q, { db: getDB(), ytdlp: ytdlp(), fallbackSearch: youtubeFallback }))
  } catch (e) {
    res.json({ error: e.message, results: [] })
  }
})

// The sources the search page can switch between: built-in ones, then addons.
router.get('/providers', (req, res) => {
  sources.addons.refreshManifests(getDB()).catch(() => {})
  res.json([
    { id: 'yt', label: 'YouTube Music' },
    { id: 'sc', label: 'SoundCloud' },
    { id: 'mono', label: 'Monochrome' },
    ...sources.addons.searchable(getDB()).map(a => ({ id: a.provider, label: a.name, icon: a.icon, addon: true, package: a.kind === 'spotiflac', needsSetup: a.kind === 'spotiflac' && !!a.access && !a.access.ready, filters: a.searchFilters, album: a.resources.includes('album'), artist: a.resources.includes('artist') })),
  ])
})

router.get('/account', async (req, res) => res.json(await youtube.fetchAccountData({ cookies: accountCookies(), force: req.query?.force === '1' }).catch(e => ({ error: e.message }))))
router.post('/artwork', async (req, res) => res.json(await discoveryArtwork(req.body?.items).catch(e => ({ error: e.message }))))
router.post('/catalogue', async (req, res) => {
  const viaYouTube = () => youtube.fetchCatalogue(req.body, accountCookies())
  res.json(await (req.body?.type === 'releases' ? require('../../electron/online/releaseDates').releaseCatalogue(req.body, viaYouTube) : viaYouTube()).catch(e => ({ error: e.message })))
})
router.get('/account-playlist/:id', async (req, res) => res.json(await youtube.fetchAccountPlaylist(req.params.id, accountCookies()).catch(e => ({ error: e.message }))))
router.get('/radio/:videoId', async (req, res) => res.json(await youtube.fetchRadio(req.params.videoId, { cookies: accountCookies() }).catch(() => [])))
router.post('/account-liked', async (req, res) => res.json(await youtube.setAccountLiked(req.body?.videoId, !!req.body?.liked, accountCookies()).catch(e => ({ error: e.message }))))

// Direct audio link of an addon track, for "Save to library".
router.post('/download-url/:provider/:id', async (req, res) => {
  const key = sources.addons.keyOfProvider(req.params.provider)
  if (key && sources.addons.packageService(getDB()).find(key)) return res.json({ package: true, url: `spotiflac://${key}/${encodeURIComponent(req.params.id)}` })
  try { res.json({ url: (await sources.resolveStream(req.params.provider, req.params.id, { ...streamOptions(), force: true })).url }) } catch (e) { res.json({ error: e.message }) }
})

// Addons (Settings → Addons).
// A misspelt search ("micheal jackson"): the library's spelling, else YouTube Music's.
router.get('/spelling', async (req, res) => res.json(await require('../../electron/online/spelling').spelling(getDB(), String(req.query.q || '')).catch(() => ({ corrected: null }))))
router.get('/addons', (req, res) => { sources.addons.refreshManifests(getDB()).catch(() => {}); res.json(sources.addons.list(getDB())) })
// An addon's album and artist pages (when its manifest offers them).
for (const [path, read] of [['addon-album', 'album'], ['addon-artist', 'artist']]) {
  router.get(`/${path}/:provider/:id`, async (req, res) => {
    const key = sources.addons.keyOfProvider(req.params.provider)
    if (!key) return res.status(400).json({ error: 'Not an addon.' })
    try { res.json(await sources.addons[read](getDB(), key, req.params.id)) } catch (e) { res.json({ error: e.message }) }
  })
}
router.post('/addons', async (req, res) => {
  try { res.json(await sources.addons.install(getDB(), req.body?.url, { signingKey: req.body?.signingKey || '' })) } catch (e) { res.status(400).json({ error: e.message }) }
})
const addonRequest = work => async (req, res) => { try { res.json(await work(req)) } catch (e) { res.status(400).json({ error: e.message }) } }
router.post('/addons/packages', addonRequest(req => require('../../electron/spotiflac/api').dispatch(getDB(), req.body)))
router.delete('/addons/:key', addonRequest(req => sources.addons.remove(getDB(), req.params.key)))
router.put('/addons/:key/enabled', addonRequest(req => sources.addons.setEnabled(getDB(), req.params.key, !!req.body?.enabled)))
router.put('/addons/:key/settings', addonRequest(req => sources.addons.setSettings(getDB(), req.params.key, req.body?.values || {}, { signingKey: req.body?.signingKey })))

router.post('/save', (req, res) => {
  try {
    const rows = sources.saveOnlineTracks(getDB(), req.body?.items)
    genres.fillOnlineGenres(getDB(), rows)
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// A streamed song's genre, looked up now if it has none (the details panel).
router.get('/genre/:id', async (req, res) => res.json({ genre: await genres.trackGenre(getDB(), req.params.id).catch(() => null) }))
// Streamed songs' genres (see genres.js): those already played, once the server has settled.
setTimeout(() => { try { genres.backfillOnlineGenres(getDB()) } catch {} }, 20000).unref?.()

router.post('/prepare/:provider/:id', async (req, res) => {
  try {
    const key = sources.addons.keyOfProvider(req.params.provider)
    if (key && sources.addons.packageService(getDB()).find(key)) return res.json(require('../../electron/spotiflac/media').prepare(getDB(), key, req.params.id, { force: req.query.force === '1' }))
    const stream = await sources.resolveStream(req.params.provider, req.params.id, { ...streamOptions(), force: req.query.force === '1' })
    res.json({ ok: true, preview: !!stream.preview })
  } catch (e) { res.json({ error: e.message }) }
})

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges']

router.get('/stream/:provider/:id', async (req, res) => {
  let upstream
  // The player went away (skipped to another song): stop an addon's fetch too.
  const gone = new AbortController()
  req.on('close', () => { if (!res.writableEnded) gone.abort() })
  try {
    const { res: r, mime } = await sources.fetchStream(req.params.provider, req.params.id, { ...streamOptions(), range: req.headers.range, signal: gone.signal })
    upstream = r
    res.status(r.status)
    for (const name of PASS_HEADERS) { const v = r.headers.get(name); if (v) res.setHeader(name, v) }
    const contentType = sources.streamContentType(r.headers.get('content-type'), mime)
    if (contentType) res.setHeader('content-type', contentType)
    res.setHeader('cache-control', 'no-store')
  } catch (e) {
    return res.status(502).type('text/plain').send(String(e.message || e))
  }
  if (!upstream.body) return res.end()
  const body = Readable.fromWeb(upstream.body)
  // Skipping to another song aborts this request: stop fetching from YouTube too.
  res.on('close', () => {
    if (!res.writableFinished) body.destroy()
  })
  body.on('error', () => res.end())
  body.pipe(res)
})

module.exports = router
