// Online results from YouTube Music, streamed with the user's own yt-dlp:
// the same source the downloader already uses, played instead of saved.
// Shared by the desktop app (IPC + the lokal-stream:// protocol) and the web
// server (/api/online).
//
//   - search: YouTube Music's own search (the "Songs" tab), so results carry
//     the artist, album, duration and square cover art;
//   - stream: yt-dlp works out the audio URL (Opus when there is one), cached
//     until shortly before it expires, and fetched again once if YouTube
//     refuses it (an expired or IP-bound URL);
//   - keeping online songs as ghost tracks (for playlists, likes, history)
//     is shared with the other sources: see sources.js.

const { spawn } = require('child_process')
const crypto = require('crypto')
const { isCookieError, markUnreadable } = require('../ipc/ytCookies')
const { jsRuntime, jsRuntimeRefused } = require('./jsRuntime')

const SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false'
const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20250901.03.00', hl: 'en' }
// YouTube Music's "Songs" filter, as its own web client sends it.
const SONGS_PARAMS = 'EgWKAQIIAWoOEAkQAxAEEAUQChAVEA4%3D'
const VIDEO_ID = /^[\w-]{11}$/
const DURATION = /^(?:\d+:)?\d{1,2}:\d{2}$/
const SEARCH_TTL_MS = 10 * 60 * 1000
const STREAM_MARGIN_MS = 10 * 60 * 1000
const RESOLVE_TIMEOUT_MS = 30000
// Video extraction precedes a potentially large download; allow slow yt-dlp
// clients and YouTube's challenge responses enough time to finish.
const VIDEO_RESOLVE_TIMEOUT_MS = 180000
const LIKE_URL = 'https://music.youtube.com/youtubei/v1/like'
const ACCOUNT_TTL_MS = 5 * 60 * 1000

const searchCache = new Map() // query -> { at, results }
const streamCache = new Map() // videoId -> { url, headers, mime, expiresAt }
const resolving = new Map()   // videoId -> Promise
const accountCache = new Map() // cookie fingerprint -> { at, data }
const contextCache = new Map()

/** "3:07" or "1:02:03" -> seconds; null when it isn't a duration. */
function parseDuration(text) {
  if (!DURATION.test(String(text || '').trim())) return null
  return String(text).trim().split(':').map(Number).reduce((total, part) => total * 60 + part, 0)
}

/** The runs (text pieces) of one flex column of a list item. */
function columnRuns(renderer, index) {
  return renderer?.flexColumns?.[index]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
}

/** A bigger square cover than the 60px one in search results. */
function largerThumbnail(url) {
  if (!url) return null
  return /=w\d+-h\d+/.test(url) ? url.replace(/=w\d+-h\d+[^&?]*$/, '=w544-h544-l90-rj') : url
}

/** Linked and plain metadata shared by search, history, cards and queue rows. */
function parseSongMetadata(runs) {
  const artists = []
  const artistIds = {} // name -> channel id (UC...)
  let album = null
  let albumId = null
  let duration = null
  const loose = []
  for (const run of runs) {
    const text = String(run.text || '').trim()
    if (!text || text === '•') continue
    const browse = run.navigationEndpoint?.browseEndpoint
    const pageType = browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || ''
    if (pageType.endsWith('_ARTIST') || pageType.endsWith('_USER_CHANNEL')) {
      artists.push(text)
      if (/^UC[\w-]{10,}$/.test(browse?.browseId || '') && !artistIds[text]) artistIds[text] = browse.browseId
    }
    else if (pageType.endsWith('_ALBUM') || /^MPRE/.test(browse?.browseId || '')) { album = text; albumId = browse.browseId || null }
    else if (parseDuration(text) != null) duration = parseDuration(text)
    else if (!/\b(views|plays|listeners|subscribers)$/i.test(text)) loose.push(text)
  }
  // Unfiltered results start with the kind ("Song", "Video"); an artist
  // without a channel link is plain text.
  const kind = /^(song|video|episode)$/i.test(loose[0] || '') ? loose.shift().toLowerCase() : null
  if (!artists.length) {
    const name = loose.shift()
    if (name) artists.push(name)
  }
  if (!album) {
    album = loose.find(text => !artists.includes(text) && parseDuration(text) == null && !/\b(views|plays)$/i.test(text)) || null
  }
  const names = [...new Set(artists)]
  return { artists: names, artist: names.join(', '), artistIds: names.map(name => artistIds[name] || null), album, albumId, duration, kind }
}

/** One song or video row, or null for non-track entries. */
function parseItem(renderer) {
  const titleRuns = columnRuns(renderer, 0)
  const watch = titleRuns[0]?.navigationEndpoint?.watchEndpoint || renderer?.navigationEndpoint?.watchEndpoint
  const videoId = renderer?.playlistItemData?.videoId || watch?.videoId
  if (!videoId || !VIDEO_ID.test(videoId)) return null
  const videoType = watch?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || ''
  // History and playlist rows put the album in its own flex column and time
  // in a fixed column, unlike search's combined artist/album subtitle.
  const metadata = parseSongMetadata([
    ...(renderer.flexColumns || []).slice(1).flatMap((_, index) => columnRuns(renderer, index + 1)),
    ...(renderer.fixedColumns || []).flatMap(column => column.musicResponsiveListItemFixedColumnRenderer?.text?.runs || []),
  ])
  if (metadata.kind === 'episode') return null

  const thumbs = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []
  return {
    videoId,
    title: titleRuns.map(r => r.text).join('').trim(),
    ...metadata,
    thumbnail: largerThumbnail(thumbs[thumbs.length - 1]?.url),
    // ATV = the audio track from the catalogue; OMV = official music video.
    kind: metadata.kind || (videoType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : 'video'),
    official: videoType === 'MUSIC_VIDEO_TYPE_ATV' || videoType === 'MUSIC_VIDEO_TYPE_OMV',
    url: `https://music.youtube.com/watch?v=${videoId}`,
  }
}

/** Every song/video row in a search response, in order, without repeats. */
function parseSearch(json) {
  const found = []
  const seen = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.musicResponsiveListItemRenderer) {
      const item = parseItem(node.musicResponsiveListItemRenderer)
      if (item && !seen.has(item.videoId)) { seen.add(item.videoId); found.push(item) }
      return
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(json)
  return found
}

/**
 * Headers and client context for a request without an account, with the
 * visitor id YouTube Music's own page hands out: without one it answers some
 * networks with thin results or "No results".
 */
async function anonymousRequest(fetchImpl, config = null) {
  const ctx = config || await musicContext('', fetchImpl).catch(() => ({}))
  const visitor = ctx?.VISITOR_DATA || ''
  return {
    headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com', 'User-Agent': 'Mozilla/5.0', ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}) },
    client: { ...CLIENT, clientVersion: ctx?.INNERTUBE_CLIENT_VERSION || CLIENT.clientVersion, ...(visitor ? { visitorData: visitor } : {}) },
  }
}

async function innertubeSearch(query, params, fetchImpl) {
  const anonymous = await anonymousRequest(fetchImpl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetchImpl(SEARCH_URL, {
      method: 'POST',
      headers: anonymous.headers,
      body: JSON.stringify({ context: { client: anonymous.client }, query, ...(params ? { params } : {}) }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`YouTube Music answered ${res.status}`)
    return parseSearch(await res.json())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Songs on YouTube Music for `query`: the Songs tab, or, where YouTube Music
 * has no catalogue for the region, the songs and official videos of the
 * general search. Cached for ten minutes.
 */
async function searchSongs(query, { limit = 10, fetchImpl = fetch } = {}) {
  const q = String(query || '').trim()
  if (q.length < 2) return []
  const key = q.toLowerCase()
  const cached = searchCache.get(key)
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.results.slice(0, limit)
  let results = await innertubeSearch(q, SONGS_PARAMS, fetchImpl)
  if (!results.length) {
    const all = await innertubeSearch(q, null, fetchImpl)
    results = all.filter(r => r.kind === 'song' || r.official)
  }
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value)
  searchCache.set(key, { at: Date.now(), results })
  return results.slice(0, limit)
}

const spellCache = new Map() // query -> { at, corrected }

/**
 * YouTube Music's spelling correction for `query` ("micheal jackson" ->
 * "michael jackson"), from its "Showing results for" / "Did you mean", or
 * null. Cached for ten minutes.
 */
async function spellCheck(query, { fetchImpl = fetch } = {}) {
  const q = String(query || '').trim()
  if (q.length < 3) return null
  const key = q.toLowerCase()
  const cached = spellCache.get(key)
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.corrected
  const anonymous = await anonymousRequest(fetchImpl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  let corrected = null
  try {
    const res = await fetchImpl(SEARCH_URL, { method: 'POST', headers: anonymous.headers, signal: controller.signal, body: JSON.stringify({ context: { client: anonymous.client }, query: q, params: SONGS_PARAMS }) })
    if (res.ok) {
      walkObjects(await res.json(), node => {
        const renderer = node.showingResultsForRenderer || node.didYouMeanRenderer
        const runs = renderer?.correctedQuery?.runs
        if (!corrected && Array.isArray(runs)) corrected = runs.map(run => run.text || '').join('').trim() || null
      })
    }
  } catch {} finally { clearTimeout(timer) }
  if (corrected && corrected.toLowerCase() === key) corrected = null
  if (spellCache.size > 200) spellCache.delete(spellCache.keys().next().value)
  spellCache.set(key, { at: Date.now(), corrected })
  return corrected
}

// -------------------------------------------------------------- account data

function cookieValue(header, names) {
  const values = new Map()
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    values.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return names.map(name => values.get(name)).find(Boolean) || ''
}

const { normalizeCookies: normalizeAccountCookies, browserContext } = require('./browserAuth')

function accountHeaders(cookieHeader, config = {}) {
  config = { ...config, ...browserContext(cookieHeader) }
  cookieHeader = normalizeAccountCookies(cookieHeader)
  const sapisid = cookieValue(cookieHeader, ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'])
  if (!sapisid) return null
  const timestamp = Math.floor(Date.now() / 1000)
  const signed = (scheme, value) => `${scheme} ${timestamp}_${crypto.createHash('sha1').update(`${timestamp} ${value} https://music.youtube.com`).digest('hex')}`
  const authorization = [signed('SAPISIDHASH', sapisid)]
  for (const [scheme, name] of [['SAPISID1PHASH', '__Secure-1PAPISID'], ['SAPISID3PHASH', '__Secure-3PAPISID']]) {
    const value = cookieValue(cookieHeader, [name])
    if (value) authorization.push(signed(scheme, value))
  }
  // Some exported sessions contain only the secure counterpart. The account
  // API still expects its SAPISID cookie alongside the authorization hash.
  if (!cookieValue(cookieHeader, ['SAPISID'])) cookieHeader += `; SAPISID=${sapisid}`
  return {
    'Content-Type': 'application/json',
    Origin: 'https://music.youtube.com',
    Referer: 'https://music.youtube.com/',
    'User-Agent': config.USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    Cookie: cookieHeader,
    Authorization: authorization.join(' '),
    'X-Origin': 'https://music.youtube.com',
    'X-YouTube-Client-Name': '67',
    'X-YouTube-Client-Version': config.INNERTUBE_CLIENT_VERSION || CLIENT.clientVersion,
    'X-Goog-AuthUser': String(config.SESSION_INDEX || '0'),
    ...(config.VISITOR_DATA ? { 'X-Goog-Visitor-Id': config.VISITOR_DATA } : {}),
    ...(config.DELEGATED_SESSION_ID ? { 'X-Goog-PageId': config.DELEGATED_SESSION_ID } : {}),
  }
}

function parseMusicConfig(html) {
  const marker = /ytcfg\.set\(\s*\{/g
  let match
  while ((match = marker.exec(String(html || '')))) {
    const start = marker.lastIndex - 1
    let quoted = false, escaped = false, depth = 0
    for (let at = start; at < html.length; at++) {
      const char = html[at]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try { const config = JSON.parse(html.slice(start, at + 1)); if (config.INNERTUBE_CLIENT_VERSION) return config } catch {}
        break
      }
    }
  }
  return {}
}

async function musicContext(cookieHeader, fetchImpl, force = false) {
  const id = accountKey(cookieHeader)
  const cached = contextCache.get(id)
  if (!force && cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.config
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetchImpl('https://music.youtube.com/', { headers: { Cookie: normalizeAccountCookies(cookieHeader), 'User-Agent': browserContext(cookieHeader).USER_AGENT || 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }, signal: controller.signal })
    const config = { ...(res.ok ? parseMusicConfig(await res.text()) : {}), ...browserContext(cookieHeader) }
    contextCache.set(id, { config, at: Date.now() })
    if (contextCache.size > 4) contextCache.delete(contextCache.keys().next().value)
    return config
  } catch { return {} }
  finally { clearTimeout(timer) }
}

function textOf(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value.simpleText) return String(value.simpleText)
  if (Array.isArray(value.runs)) return value.runs.map(run => String(run.text || '')).join('')
  return ''
}

function thumbnailsOf(value) {
  const choices = [
    value?.thumbnails,
    value?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    value?.croppedThumbnailRenderer?.thumbnail?.thumbnails,
    value?.thumbnail?.thumbnails,
    value?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    value?.thumbnail?.croppedThumbnailRenderer?.thumbnail?.thumbnails,
    value?.thumbnail?.thumbnail?.thumbnails,
  ]
  const thumbnails = choices.find(Array.isArray) || []
  return thumbnails.length ? largerThumbnail(thumbnails[thumbnails.length - 1]?.url) : null
}

function walkObjects(root, visitor) {
  if (!root || typeof root !== 'object') return
  if (Array.isArray(root)) {
    root.forEach(item => walkObjects(item, visitor))
    return
  }
  visitor(root)
  Object.values(root).forEach(value => walkObjects(value, visitor))
}

function parseTrackCard(renderer) {
  const play = (renderer?.thumbnailOverlay || renderer?.overlay)?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
  const endpoints = [renderer?.navigationEndpoint, renderer?.onTap, ...(renderer?.title?.runs || []).map(run => run.navigationEndpoint), play]
  if (renderer?.isPlaylist || endpoints.some(endpoint => /^(VL|MPRE|UC)/.test(endpoint?.browseEndpoint?.browseId || '') || endpoint?.watchPlaylistEndpoint || /^RDTMAK/.test(endpoint?.watchEndpoint?.playlistId || ''))) return null
  const videoId = endpoints.map(endpoint => endpoint?.watchEndpoint?.videoId).find(id => VIDEO_ID.test(id || '')) || ''
  const title = textOf(renderer?.title)
  if (!VIDEO_ID.test(videoId) || !title) return null
  const runs = renderer.subtitle?.runs
  const metadata = parseSongMetadata(runs?.some(run => run.navigationEndpoint) ? runs : textOf(renderer.subtitle).split('•').map(text => ({ text })))
  if (metadata.kind === 'episode') return null
  return {
    videoId,
    title,
    ...metadata,
    artist: metadata.artist || 'Unknown Artist',
    thumbnail: thumbnailsOf(renderer?.thumbnailRenderer || renderer?.thumbnail),
    kind: 'song',
    official: true,
    url: `https://music.youtube.com/watch?v=${videoId}`,
  }
}

function parseAccountTracks(root, limit = 200) {
  const tracks = []
  const seen = new Set()
  walkObjects(root, node => {
    if (tracks.length >= limit) return
    const panel = node.playlistPanelVideoRenderer
    const item = node.musicResponsiveListItemRenderer ? parseItem(node.musicResponsiveListItemRenderer) : panel ? {
      videoId: panel.videoId, title: textOf(panel.title), ...parseSongMetadata((panel.longBylineText || panel.shortBylineText)?.runs || textOf(panel.longBylineText || panel.shortBylineText).split('•').map(text => ({ text }))),
      thumbnail: thumbnailsOf(panel.thumbnail), duration: parseDuration(textOf(panel.lengthText)),
      url: `https://music.youtube.com/watch?v=${panel.videoId}`,
    } : parseTrackCard(node.musicTwoRowItemRenderer)
    if (item && (!VIDEO_ID.test(item.videoId || '') || !item.title)) return
    if (!item || seen.has(item.videoId)) return
    seen.add(item.videoId)
    tracks.push({ ...item, provider: 'yt', id: item.videoId, source_url: item.url })
  })
  return tracks
}

function parseAccountPlaylists(root, limit = 100) {
  const playlists = []
  const seen = new Set()
  walkObjects(root, node => {
    const renderer = node.gridPlaylistRenderer || node.musicTwoRowItemRenderer || node.musicResponsiveListItemRenderer
    if (!renderer || playlists.length >= limit) return
    const titleNavigation = renderer.title?.runs?.find(run => run.navigationEndpoint)?.navigationEndpoint || columnRuns(renderer, 0).find(run => run.navigationEndpoint)?.navigationEndpoint
    const play = (renderer.thumbnailOverlay || renderer.overlay)?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
    const navigations = [titleNavigation, renderer.navigationEndpoint, renderer.onTap, play].filter(Boolean)
    const browse = navigations.find(navigation => navigation.browseEndpoint?.browseId)?.browseEndpoint
    const pageType = browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || ''
    if (pageType && !pageType.endsWith('_PLAYLIST')) return
    // A song's radio link isn't a playlist card. Personalized mix cards may
    // have a seed video on their play button but a playlist link on the title.
    if (!browse && !renderer.isPlaylist && !navigations.some(navigation => navigation.watchPlaylistEndpoint || /^RDTMAK/.test(navigation.watchEndpoint?.playlistId || '')) && navigations.some(navigation => VIDEO_ID.test(navigation.watchEndpoint?.videoId || ''))) return
    const rawId = renderer.playlistId || browse?.browseId || navigations.map(navigation => navigation.watchPlaylistEndpoint?.playlistId || navigation.watchEndpoint?.playlistId).find(Boolean) || ''
    const id = String(rawId).replace(/^VL/, '')
    if (!id || /^(UC|MPRE|FE)/.test(id) || seen.has(id)) return
    const title = textOf(renderer.title) || columnRuns(renderer, 0).map(run => run.text || '').join('')
    if (!title) return
    seen.add(id)
    playlists.push({
      id,
      title,
      author: textOf(renderer.shortBylineText || renderer.subtitle) || columnRuns(renderer, 1).map(run => run.text || '').join(''),
      trackCount: textOf(renderer.videoCountText || renderer.secondLine),
      thumbnail: thumbnailsOf(renderer.thumbnailRenderer || renderer.thumbnail),
      url: `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`,
    })
  })
  return playlists
}

const isMixTitle = title => /^(mixed for you|mixes for you|your mixes)$/i.test(String(title || '').trim())
const isPersonalMix = playlist => /^RDTMAK/.test(playlist.id)
const shelfTitle = shelf => textOf(shelf?.header?.musicCarouselShelfBasicHeaderRenderer?.title || shelf?.header?.musicShelfHeaderRenderer?.title || shelf?.title)

// The same five provider-owned Home shelves Mobile recognizes. Do not
// synthesize results from search or mix playlists under these names.
function youtubeHomeCategory(title) {
  const value = String(title || '').trim().toLowerCase()
  if (value.includes('community')) return 'community'
  if (value.includes('new release') || value.includes('new album') || value.includes('recently released')) return 'newReleases'
  if (value.includes('trending')) return 'trending'
  if (value.includes('featured playlist')) return 'featuredPlaylists'
  if (value.includes('daily discover') || value.includes('discover mix')) return 'dailyDiscover'
  return null
}

function parseAccountHomeCategories(root) {
  const result = new Map()
  walkObjects(root, node => {
    const shelf = node.musicCarouselShelfRenderer || node.musicShelfRenderer
    if (!shelf) return
    const id = youtubeHomeCategory(shelfTitle(shelf))
    if (!id) return
    const tracks = parseAccountTracks(shelf.contents || [], 100)
    const playlists = parseAccountPlaylists(shelf.contents || [], 100)
    const albums = parseAccountEntities(shelf.contents || [], 'album')
    if (!tracks.length && !playlists.length && !albums.length) return
    if (!result.has(id)) result.set(id, { id, tracks: [], mixes: [], albums: [] })
    const group = result.get(id)
    group.tracks.push(...tracks)
    group.mixes.push(...playlists)
    group.albums.push(...albums)
  })
  return [...result.values()].map(group => ({
    ...group,
    tracks: [...new Map(group.tracks.map(item => [item.videoId, item])).values()],
    mixes: [...new Map(group.mixes.map(item => [item.id, item])).values()],
    albums: [...new Map(group.albums.map(item => [item.albumId || `${item.artist}\0${item.title}`, item])).values()],
  }))
}

function mixedForYouShelves(root) {
  const shelves = []
  walkObjects(root, node => {
    const shelf = node.musicCarouselShelfRenderer || node.musicShelfRenderer
    if (shelf && (isMixTitle(shelfTitle(shelf)) || parseAccountPlaylists(shelf.contents).some(isPersonalMix))) shelves.push(shelf)
  })
  return shelves
}

function parseAccountMixes(root) {
  const mixes = mixedForYouShelves(root).flatMap(shelf => {
    const playlists = parseAccountPlaylists(shelf.contents, Infinity)
    return isMixTitle(shelfTitle(shelf)) ? playlists : playlists.filter(isPersonalMix)
  })
  return [...new Map(mixes.map(mix => [mix.id, mix])).values()]
}

function continuationTokens(root, types) {
  const tokens = new Set()
  const collect = container => {
    for (const entry of container?.continuations || []) {
      const token = entry.nextContinuationData?.continuation
      if (token) tokens.add(token)
    }
    for (const item of container?.contents || container?.items || container?.continuationItems || []) {
      const endpoint = item.continuationItemRenderer?.continuationEndpoint
      const commands = [endpoint, ...(endpoint?.commandExecutorCommand?.commands || [])]
      for (const command of commands) if (command?.continuationCommand?.token) tokens.add(command.continuationCommand.token)
    }
  }
  walkObjects(root, node => {
    for (const type of types) if (node[type]) collect(node[type])
  })
  return [...tokens]
}

async function browsePages(browseId, first, cookies, fetchImpl, config, { params, types, stop = () => false, timeoutMs = 10000, maxPages = 20 } = {}) {
  const pages = [first]
  const seen = new Set()
  const pending = continuationTokens(first, types)
  const deadline = Date.now() + timeoutMs
  while (pending.length && !stop(pages)) {
    const continuation = pending.shift()
    if (seen.has(continuation)) continue
    if (seen.size >= maxPages || Date.now() >= deadline) return { pages, error: 'YouTube Music mix loading did not finish. Refresh to retry.' }
    seen.add(continuation)
    try {
      const page = await accountBrowse(browseId, cookies, fetchImpl, config, { params, continuation, timeoutMs: Math.min(5000, deadline - Date.now()) })
      pages.push(page)
      pending.push(...continuationTokens(page, types))
    } catch (error) { return { pages, error: error.message } }
  }
  return { pages, error: '' }
}

function parseAccountEntities(root, type) {
  const items = new Map()
  walkObjects(root, node => {
    const row = node.musicTwoRowItemRenderer || node.musicResponsiveListItemRenderer
    const titleRuns = columnRuns(row, 0)
    const endpoint = row?.navigationEndpoint?.browseEndpoint || titleRuns[0]?.navigationEndpoint?.browseEndpoint
    const pageType = endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || ''
    const title = textOf(row?.title) || titleRuns.map(run => run.text).join('')
    if (!title || !pageType.endsWith(type === 'artist' ? '_ARTIST' : '_ALBUM')) return
    // Cards (musicTwoRowItemRenderer: an artist page's albums and singles)
    // keep their picture in thumbnailRenderer; list rows in thumbnail.
    const image = thumbnailsOf(row.thumbnailRenderer || row.thumbnail)
    const parts = (textOf(row.subtitle) || columnRuns(row, 1).map(run => run.text).join('')).split('•').map(value => value.trim())
    const artist = parts.find(value => value && !/^(album|single|ep|\d{4})$/i.test(value)) || ''
    const year = Number(parts.find(value => /^\d{4}$/.test(value))) || null
    const kind = parts.find(value => /^(album|single|ep)$/i.test(value))?.toLowerCase() || null
    items.set(endpoint.browseId, type === 'artist' ? { name: title, image, browseId: endpoint.browseId } : { title, artist, artwork_url: image, albumId: endpoint.browseId, year, release_type: kind })
  })
  return [...items.values()].slice(0, 30)
}

async function accountRequest(endpoint, body, cookieHeader, fetchImpl = fetch, config = {}, { anonymous = false, timeoutMs = 12000, continuation } = {}) {
  const headers = accountHeaders(cookieHeader, config) || (anonymous ? { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com', ...(config.VISITOR_DATA ? { 'X-Goog-Visitor-Id': config.VISITOR_DATA } : {}) } : null)
  if (!headers) throw new Error('Sign in to YouTube Music in Integrations.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = `https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false${continuation ? `&${new URLSearchParams({ continuation, ctoken: continuation })}` : ''}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ context: { client: { ...CLIENT, ...config.INNERTUBE_CONTEXT?.client, hl: CLIENT.hl, clientVersion: config.INNERTUBE_CLIENT_VERSION || CLIENT.clientVersion, ...(config.VISITOR_DATA ? { visitorData: config.VISITOR_DATA } : {}) }, user: { ...(config.DELEGATED_SESSION_ID ? { onBehalfOfUser: config.DELEGATED_SESSION_ID } : {}) } }, ...body }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`YouTube Music account request failed (${res.status}).`)
    const json = await res.json()
    if (!anonymous && isLoggedOutResponse(json)) {
      throw new Error('YouTube Music rejected the saved session. Sign in again in Integrations.')
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

function accountBrowse(browseId, cookieHeader, fetchImpl = fetch, config = {}, options = {}) {
  return accountRequest('browse', { browseId, ...(options.params ? { params: options.params } : {}), ...(options.continuation ? { continuation: options.continuation } : {}) }, cookieHeader, fetchImpl, config, options)
}

function accountKey(cookieHeader) {
  return crypto.createHash('sha256').update(String(cookieHeader || '')).digest('hex').slice(0, 24)
}

function isLoggedOutResponse(json) {
  const login = (json?.responseContext?.serviceTrackingParams || []).flatMap(service => Array.isArray(service?.params) ? service.params : []).filter(param => param?.key === 'logged_in')
  if (json?.responseContext?.mainAppWebResponseContext?.loggedOut === true) return true
  // Tracking services can disagree; any authenticated service is evidence of
  // login, rather than rejecting an otherwise valid account response.
  return login.length > 0 && !login.some(param => String(param.value) === '1') && login.some(param => String(param.value) === '0')
}

/** Authenticated YouTube Music account surfaces backed by the internal login. */
async function fetchAccountData({ cookies, fetchImpl = fetch, limit = 100, force = false } = {}) {
  const cookieHeader = String(cookies || '')
  if (!accountHeaders(cookieHeader)) return { error: 'Sign in to YouTube Music in Integrations.', authenticated: false }
  const key = accountKey(cookieHeader)
  const cached = accountCache.get(key)
  if (!force && cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.data

  const config = await musicContext(cookieHeader, fetchImpl, force)
  const [likedResult, playlistsResult, homeResult, historyResult] = await Promise.allSettled([
    accountBrowse('VLLM', cookieHeader, fetchImpl, config),
    accountBrowse('FEmusic_liked_playlists', cookieHeader, fetchImpl, config),
    accountBrowse('FEmusic_home', cookieHeader, fetchImpl, config),
    accountBrowse('FEmusic_history', cookieHeader, fetchImpl, config),
  ])
  const liked = likedResult.status === 'fulfilled' ? parseAccountTracks(likedResult.value, limit) : []
  const playlists = playlistsResult.status === 'fulfilled' ? parseAccountPlaylists(playlistsResult.value, limit) : []
  const home = homeResult.status === 'fulfilled' ? parseAccountTracks(homeResult.value, limit) : []
  const results = [likedResult, playlistsResult, homeResult, historyResult]
  const errors = results.filter(result => result.status === 'rejected')
  const authenticated = results.some(result => result.status === 'fulfilled' && (result.value?.responseContext?.mainAppWebResponseContext?.loggedOut === false || (result.value?.responseContext?.serviceTrackingParams || []).some(service => (service.params || []).some(param => param.key === 'logged_in' && String(param.value) === '1'))))
  if (!authenticated) {
    return { error: errors[0]?.reason?.message || 'YouTube Music did not confirm an authenticated account. Sign in again in Integrations.', authenticated: false }
  }
  const homePages = homeResult.status === 'fulfilled' ? await browsePages('FEmusic_home', homeResult.value, cookieHeader, fetchImpl, config, {
    types: ['sectionListRenderer', 'sectionListContinuation', 'appendContinuationItemsAction', 'reloadContinuationItemsCommand'],
    // Explore several Home continuations rather than stopping at the first
    // mixes shelf. Bound requests: a provider can offer many unrelated pages.
    stop: pages => pages.length >= 5,
  }) : { pages: [], error: homeResult.reason?.message || '' }
  const homeRoot = homePages.pages
  const homePlaylists = parseAccountPlaylists(homeRoot)
  const mixEndpoints = new Map()
  const mixTypes = ['musicCarouselShelfRenderer', 'musicCarouselShelfContinuation', 'musicShelfRenderer', 'musicShelfContinuation', 'gridRenderer', 'gridContinuation', 'sectionListRenderer', 'sectionListContinuation', 'appendContinuationItemsAction', 'reloadContinuationItemsCommand']
  const shelfPages = await Promise.all(mixedForYouShelves(homeRoot).map(async shelf => ({
    ...await browsePages('FEmusic_home', { musicCarouselShelfRenderer: shelf }, cookieHeader, fetchImpl, config, { types: mixTypes }),
    namedMixShelf: isMixTitle(shelfTitle(shelf)),
  })))
  for (const shelf of mixedForYouShelves(homeRoot)) if (isMixTitle(shelfTitle(shelf))) walkObjects(shelf.header, node => {
    const endpoint = node.browseEndpoint
    if (endpoint?.browseId) mixEndpoints.set(`${endpoint.browseId}\0${endpoint.params || ''}`, endpoint)
  })
  const expandedMixes = await Promise.allSettled([...mixEndpoints.values()].map(async endpoint => {
    const first = await accountBrowse(endpoint.browseId, cookieHeader, fetchImpl, config, { params: endpoint.params })
    return browsePages(endpoint.browseId, first, cookieHeader, fetchImpl, config, { params: endpoint.params, types: mixTypes })
  }))
  const extraMixes = [...shelfPages.flatMap(result => parseAccountPlaylists(result.pages.slice(1), Infinity).filter(mix => result.namedMixShelf || isPersonalMix(mix))), ...expandedMixes.flatMap(result => result.status === 'fulfilled' ? parseAccountPlaylists(result.value.pages, Infinity) : [])]
  const mixes = [...new Map([...parseAccountMixes(homeRoot), ...extraMixes].map(mix => [mix.id, mix])).values()]
  const mixError = homePages.error || shelfPages.find(result => result.error)?.error || expandedMixes.find(result => result.status === 'rejected')?.reason?.message || expandedMixes.find(result => result.status === 'fulfilled' && result.value.error)?.value.error || ''
  const knownAlbums = new Map([...liked, ...home].filter(track => track.album).map(track => [track.videoId, track]))
  const history = (historyResult.status === 'fulfilled' ? parseAccountTracks(historyResult.value, limit) : []).map(track => track.album || !knownAlbums.has(track.videoId) ? track : { ...track, album: knownAlbums.get(track.videoId).album, albumId: knownAlbums.get(track.videoId).albumId })
  const data = { liked, playlists, home, homePlaylists, mixes, history, categories: parseAccountHomeCategories(homeRoot), artists: parseAccountEntities(homeRoot, 'artist'), albums: parseAccountEntities(homeRoot, 'album'), authenticated: true, homeError: homeResult.status === 'rejected' ? homeResult.reason?.message : '', mixError }
  if (!errors.length && !mixError) {
    accountCache.set(key, { at: Date.now(), data })
    if (accountCache.size > 4) accountCache.delete(accountCache.keys().next().value)
  }
  return data
}

/** The signed-in listener's saved playlists, not the Discovery Home mixes. */
async function fetchLibraryPlaylists({ cookies, fetchImpl = fetch, limit = 2000 } = {}) {
  const header = String(cookies || '')
  if (!accountHeaders(header)) throw new Error('Sign in to YouTube Music in Integrations.')
  const config = await musicContext(header, fetchImpl)
  const root = await accountBrowse('FEmusic_liked_playlists', header, fetchImpl, config)
  const pages = await browsePages('FEmusic_liked_playlists', root, header, fetchImpl, config, {
    types: ['gridRenderer', 'gridContinuation', 'musicShelfRenderer',
      'musicShelfContinuation', 'sectionListRenderer', 'sectionListContinuation',
      'appendContinuationItemsAction', 'reloadContinuationItemsCommand'],
    timeoutMs: 60000, maxPages: 100,
  })
  if (pages.error) throw new Error(pages.error.replace('mix loading', 'playlist loading'))
  const playlists = new Map()
  for (const page of pages.pages) for (const item of parseAccountPlaylists(page, limit)) {
    // Continuations can repeat a previously saved playlist with less reliable
    // title/artwork metadata. Keep the first complete card and source order.
    if (!/^RD/.test(item.id) && !playlists.has(item.id)) playlists.set(item.id, item)
  }
  return [...playlists.values()].slice(0, limit)
}

/** YouTube Music's own song radio, rather than searching for the word "radio". */
async function fetchRadio(videoId, { cookies = '', fetchImpl = fetch, limit = 50 } = {}) {
  if (!VIDEO_ID.test(String(videoId || ''))) return []
  const config = await musicContext(cookies, fetchImpl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetchImpl('https://music.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST', signal: controller.signal,
      headers: accountHeaders(cookies, config) || { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com' },
      body: JSON.stringify({ context: { client: { ...CLIENT, clientVersion: config.INNERTUBE_CLIENT_VERSION || CLIENT.clientVersion }, user: config.DELEGATED_SESSION_ID ? { onBehalfOfUser: config.DELEGATED_SESSION_ID } : {} }, videoId, playlistId: `RDAMVM${videoId}`, isAudioOnly: true, enablePersistentPlaylistPanel: true }),
    })
    if (!response.ok) throw new Error(`YouTube Music radio failed (${response.status}).`)
    const json = await response.json()
    return parseAccountTracks(json, limit)
  } finally { clearTimeout(timer) }
}

function clearAccountCache() {
  accountCache.clear()
  contextCache.clear()
  streamCache.clear()
}

const PLAYLIST_CONTINUATION_TYPES = [
  'musicPlaylistShelfRenderer', 'musicPlaylistShelfContinuation',
  'musicShelfRenderer', 'musicShelfContinuation',
  'gridRenderer', 'gridContinuation',
  'sectionListRenderer', 'sectionListContinuation',
  'appendContinuationItemsAction', 'reloadContinuationItemsCommand',
]

function parseMusicPlaylistMetadata(root, playlistId = '') {
  const result = { id: String(playlistId || '').replace(/^VL/, ''), title: null, author: null, thumbnail: null, count: null }
  walkObjects(root, node => {
    const header = node.musicDetailHeaderRenderer
      || node.musicEditablePlaylistDetailHeaderRenderer
      || node.musicImmersiveHeaderRenderer
      || node.musicResponsiveHeaderRenderer
      || node.musicVisualHeaderRenderer
    if (!header) return

    const title = textOf(header.title || header.header?.title)
    if (!result.title && title) result.title = title
    const thumbnail = thumbnailsOf(header.thumbnail || header.thumbnailRenderer || header.image)
    if (!result.thumbnail && thumbnail) result.thumbnail = thumbnail

    const authorFields = [
      header.subtitle, header.secondLine, header.strapline,
      header.straplineTextOne, header.straplineTextTwo, header.straplineTextThree,
      header.secondSubtitle, header.ownerText,
    ]
    const runs = authorFields.flatMap(field => field?.runs || [])
    const ownerRun = runs.find(run => {
      const browse = run.navigationEndpoint?.browseEndpoint
      const pageType = browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || ''
      return /^UC[\w-]{10,}$/.test(browse?.browseId || '') || /_(?:ARTIST|USER_CHANNEL)$/.test(pageType)
    })
    if (!result.author && ownerRun?.text) result.author = String(ownerRun.text).trim() || null

    const authorLines = authorFields.map(textOf).filter(Boolean)
    if (!result.author) {
      for (const line of authorLines) {
        const candidate = line.split(/[•·|]/)[0].replace(/^by\s+/i, '').trim()
        if (candidate && !/^(?:public|private|unlisted|playlist|mix|radio)\b/i.test(candidate) && !/^\d/.test(candidate)) {
          result.author = candidate
          break
        }
      }
    }
    const countLines = [...authorLines, textOf(header.description)].filter(Boolean)
    if (!result.count) {
      for (const line of countLines) {
        const match = line.match(/([\d,.]+)\s*([KMB]?)\s*(?:songs?|tracks?|videos?)\b/i)
        if (!match) continue
        const amount = Number(match[1].replace(/,/g, ''))
        if (Number.isFinite(amount)) result.count = Math.round(amount * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase()] || 1))
        break
      }
    }
  })
  return result
}

function youtubeMusicPlaylistId(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'music.youtube.com' || url.pathname !== '/playlist') return null
    const id = String(url.searchParams.get('list') || '').trim()
    return id && /^[\w.-]{1,120}$/.test(id) && !id.startsWith('RD') ? id : null
  } catch { return null }
}

async function openMusicPlaylist(playlistId, cookies = '', fetchImpl = fetch, timeoutMs = 15000) {
  const id = String(playlistId || '').trim().replace(/^VL/, '')
  if (!/^[\w.-]{1,120}$/.test(id) || id.startsWith('RD')) throw new Error('A finite YouTube Music playlist id is required.')
  const config = await musicContext(cookies, fetchImpl)
  const authenticated = !!accountHeaders(cookies, config)
  const root = await accountBrowse(`VL${id}`, cookies, fetchImpl, config, {
    anonymous: !authenticated,
    timeoutMs,
  })
  return { id, cookies, fetchImpl, config, anonymous: !authenticated, root, metadata: parseMusicPlaylistMetadata(root, id) }
}

/** The playlist's own name, owner and artwork; no full track-list request is needed for a pasted-link card. */
async function fetchMusicPlaylistInfo(playlistId, cookies = '', fetchImpl = fetch) {
  try {
    const opened = await openMusicPlaylist(playlistId, cookies, fetchImpl)
    const [firstTrack] = parseAccountTracks(opened.root, 1)
    if (!opened.metadata.title && !firstTrack) return { error: 'YouTube Music returned no playlist details.' }
    return {
      id: opened.id,
      title: opened.metadata.title || `YouTube Music Playlist ${opened.id.slice(0, 8)}`,
      author: opened.metadata.author || null,
      // Prefer the playlist's own cover; the first track is only a fallback
      // for playlist renderers that do not expose a separate thumbnail.
      thumbnail: opened.metadata.thumbnail || firstTrack?.thumbnail || null,
      count: opened.metadata.count || null,
    }
  } catch (error) {
    return { error: error?.message || 'Could not read that YouTube Music playlist.' }
  }
}

/** All available tracks in a YouTube Music playlist, preserving its order. */
async function fetchMusicPlaylist(playlistId, cookies = '', fetchImpl = fetch, { limit = 10000, timeoutMs = 600000 } = {}) {
  try {
    const opened = await openMusicPlaylist(playlistId, cookies, fetchImpl)
    const safeLimit = Math.max(1, Math.min(10000, Number.parseInt(limit, 10) || 10000))
    const tracks = []
    const seenTracks = new Set()
    const addTracks = root => {
      for (const track of parseAccountTracks(root, safeLimit)) {
        const videoId = String(track.videoId || track.id || '')
        if (!/^[\w-]{11}$/.test(videoId) || seenTracks.has(videoId)) continue
        seenTracks.add(videoId)
        tracks.push({
          ...track,
          videoId,
          id: videoId,
          url: `https://music.youtube.com/watch?v=${videoId}`,
          source_url: `https://music.youtube.com/watch?v=${videoId}`,
        })
        if (tracks.length >= safeLimit) break
      }
    }
    addTracks(opened.root)
    const startedAt = Date.now()
    const deadline = startedAt + Math.max(1000, Math.min(600000, Number(timeoutMs) || 600000))
    const seenTokens = new Set()
    const pending = continuationTokens(opened.root, PLAYLIST_CONTINUATION_TYPES)
    let pages = 1
    while (pending.length && tracks.length < safeLimit && pages < 300 && Date.now() < deadline) {
      const continuation = pending.shift()
      if (!continuation || seenTokens.has(continuation)) continue
      seenTokens.add(continuation)
      const page = await accountBrowse(`VL${opened.id}`, opened.cookies, opened.fetchImpl, opened.config, {
        anonymous: opened.anonymous,
        continuation,
        timeoutMs: Math.max(1000, Math.min(15000, deadline - Date.now())),
      })
      pages++
      addTracks(page)
      for (const token of continuationTokens(page, PLAYLIST_CONTINUATION_TYPES)) {
        if (!seenTokens.has(token) && !pending.includes(token)) pending.push(token)
      }
    }
    if (!tracks.length) return { error: 'That YouTube Music playlist has no accessible tracks. It may be private or unavailable.' }
    const [firstTrack] = tracks
    return {
      id: opened.id,
      title: opened.metadata.title || `YouTube Music Playlist ${opened.id.slice(0, 8)}`,
      author: opened.metadata.author || null,
      thumbnail: opened.metadata.thumbnail || firstTrack?.thumbnail || null,
      count: opened.metadata.count || tracks.length,
      tracks,
      truncated: pending.length > 0 || (opened.metadata.count ? opened.metadata.count > tracks.length : tracks.length >= safeLimit),
    }
  } catch (error) {
    return { error: error?.message || 'Could not read that YouTube Music playlist.' }
  }
}

async function fetchAccountPlaylist(playlistId, cookies, fetchImpl = fetch) {
  const id = String(playlistId || '').replace(/^VL/, '')
  if (!id) return { error: 'A YouTube Music playlist id is required.' }
  try {
    const config = await musicContext(cookies, fetchImpl)
    const root = /^RD/.test(id)
      ? await accountRequest('next', { playlistId: id, enablePersistentPlaylistPanel: true, isAudioOnly: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' }, cookies, fetchImpl, config)
      : await accountBrowse(`VL${id}`, cookies, fetchImpl, config)
    return { id, tracks: parseAccountTracks(root, 500) }
  } catch (error) {
    return { error: error.message }
  }
}

// YouTube Music's search filters, as its web client sends them.
const ALBUMS_PARAMS = 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D'
const ARTISTS_PARAMS = 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D'

/** A filtered YouTube Music search: the response, or { error }. */
async function musicSearch(query, params, cookies, fetchImpl, config) {
  const signedIn = accountHeaders(cookies, config)
  const anonymous = signedIn ? null : await anonymousRequest(fetchImpl, config)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetchImpl(SEARCH_URL, {
      method: 'POST', signal: controller.signal,
      headers: signedIn || anonymous.headers,
      body: JSON.stringify({ context: { client: anonymous ? anonymous.client : { ...CLIENT, clientVersion: config.INNERTUBE_CLIENT_VERSION || CLIENT.clientVersion, ...(config.VISITOR_DATA ? { visitorData: config.VISITOR_DATA } : {}) } }, query, params }),
    })
    if (!response.ok) return { error: `YouTube Music search failed (${response.status}).` }
    return await response.json()
  } finally { clearTimeout(timer) }
}

/** YouTube Music's album search: { albums: [{ title, artist, artwork_url, albumId, year, release_type }] } or { error }. */
async function searchAlbums(query, cookies, fetchImpl, config) {
  const result = await musicSearch(query, ALBUMS_PARAMS, cookies, fetchImpl, config)
  return result.error ? result : { albums: parseAccountEntities(result, 'album') }
}

const plainName = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** An artist channel's page: its name, picture, songs and releases (albums, singles, EPs). */
function parseArtistPage(root, fallbackName = '') {
  const header = root?.header?.musicImmersiveHeaderRenderer || root?.header?.musicVisualHeaderRenderer || root?.header?.musicResponsiveHeaderRenderer || {}
  const name = textOf(header.title) || fallbackName
  const tracks = []
  const albums = []
  // The top songs shelf shows five; its "See all" leads to the rest.
  let songsListId = null
  walkObjects(root, node => {
    // Songs: the list shelf ("Top songs"), not the videos carousel.
    if (node.musicShelfRenderer) {
      for (const track of parseAccountTracks(node.musicShelfRenderer, 50)) if (!tracks.some(item => item.videoId === track.videoId)) tracks.push(track)
      const shelf = node.musicShelfRenderer
      const more = shelf.bottomEndpoint?.browseEndpoint?.browseId || (shelf.title?.runs || []).map(run => run?.navigationEndpoint?.browseEndpoint?.browseId).find(Boolean)
      if (!songsListId && /^VL/.test(String(more || ''))) songsListId = more
    }
    const shelf = node.musicCarouselShelfRenderer
    const title = plainName(textOf(shelf?.header?.musicCarouselShelfBasicHeaderRenderer?.title))
    if (shelf && /^(albums|singles|eps|singles and eps|singles eps)$/.test(title)) {
      const kind = title === 'albums' ? 'album' : title === 'eps' ? 'ep' : 'single'
      for (const album of parseAccountEntities(shelf.contents, 'album')) {
        if (!albums.some(item => item.albumId === album.albumId)) albums.push({ ...album, artist: album.artist || name, release_type: album.release_type || kind })
      }
    }
  })
  return { name, image: thumbnailsOf(header.thumbnail), tracks, albums, ...(songsListId ? { songsListId } : {}) }
}

/**
 * One artist's page, not everyone with the name: the channel of `anchor`
 * (a song of theirs, e.g. the one playing), else of the artists named
 * `artist` the one whose songs and releases share the most with `hints`
 * (the library's titles), else YouTube's first.
 * { channelId, name, image, tracks, albums } or { error }
 */
async function fetchArtistPage({ artist, channelId, anchor, hints = [], releasesOnly = false } = {}, cookies, fetchImpl = fetch) {
  const config = await musicContext(cookies, fetchImpl)
  const want = plainName(artist)
  let id = /^UC[\w-]{10,}$/.test(String(channelId || '')) ? channelId : null
  if (!id && anchor?.title) {
    const title = plainName(anchor.title)
    const songs = await searchSongs(`${artist} ${anchor.title}`, { limit: 10, fetchImpl }).catch(() => [])
    for (const song of songs) {
      const at = (song.artists || []).findIndex(name => plainName(name) === want)
      const same = plainName(song.title) === title || plainName(song.title).startsWith(`${title} `) || title.startsWith(`${plainName(song.title)} `)
      if (same && at >= 0 && song.artistIds?.[at]) { id = song.artistIds[at]; break }
    }
  }
  let candidates = id ? [{ browseId: id }] : []
  if (!id) {
    const found = await musicSearch(artist, ARTISTS_PARAMS, cookies, fetchImpl, config)
    if (found.error) return found
    candidates = parseAccountEntities(found, 'artist').filter(item => plainName(item.name) === want && /^UC/.test(item.browseId)).slice(0, hints.length ? 3 : 1)
  }
  if (!candidates.length) return { error: `YouTube Music has no artist named ${artist}.` }
  const anonymous = !accountHeaders(cookies)
  const pages = await Promise.all(candidates.map(async candidate => {
    try { return { channelId: candidate.browseId, ...parseArtistPage(await accountBrowse(candidate.browseId, cookies, fetchImpl, config, { anonymous }), artist) } } catch { return null }
  }))
  const hinted = new Set(hints.map(plainName).filter(Boolean))
  const score = page => [...page.tracks.map(track => track.title), ...page.tracks.map(track => track.album), ...page.albums.map(album => album.title)].filter(value => hinted.has(plainName(value))).length
  const best = pages.filter(Boolean).sort((a, b) => score(b) - score(a))[0]
  if (!best) return { error: `Could not load ${artist} from YouTube Music.` }
  // Their page shows five top songs: the rest of the list (the page offers
  // ten with "Show more"), when it can be read.
  const { songsListId, ...page } = best
  if (!releasesOnly && songsListId && page.tracks.length < 10) {
    try {
      const more = parseAccountTracks(await accountBrowse(songsListId, cookies, fetchImpl, config, { anonymous }), 20)
      const seen = new Set(page.tracks.map(track => track.videoId))
      page.tracks = [...page.tracks, ...more.filter(track => !seen.has(track.videoId))].slice(0, 20)
    } catch {}
  }
  return page
}

async function fetchCatalogue(options = {}, cookies, fetchImpl = fetch) {
  const { type, artist, album, albumId } = options
  const plain = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!artist || (type === 'album' && !album)) return { error: 'An artist and album name are required.' }
  if (type === 'artistPage') return fetchArtistPage(options, cookies, fetchImpl)
  if (type === 'releases') {
    const page = await fetchArtistPage({ ...options, releasesOnly: true }, cookies, fetchImpl)
    return page.error ? page : { albums: page.albums }
  }
  if (type !== 'album' && type !== 'albums') {
    const tracks = (await searchSongs(String(artist), { limit: 60, fetchImpl })).filter(track => track.artists.some(name => plain(name) === plain(artist)))
    return { tracks }
  }
  const config = await musicContext(cookies, fetchImpl)
  // An artist's albums (their online page): albums whose artist is them.
  if (type === 'albums') {
    const found = await searchAlbums(String(artist), cookies, fetchImpl, config)
    if (found.error) return found
    return { albums: found.albums.filter(item => plain(item.artist) === plain(artist) || plain(item.artist).startsWith(`${plain(artist)} `)) }
  }
  let id = /^MPRE[\w-]+$/.test(String(albumId || '')) ? albumId : null
  if (!id) {
    const found = await searchAlbums(`${artist} ${album}`, cookies, fetchImpl, config)
    if (found.error) return found
    // Exact first; then the same release under an edition label ("I Am" /
    // "I Am (Expanded Edition)"), by an artist credit that starts with theirs.
    const bare = value => plain(String(value || '').replace(/\s*[([][^)\]]*[)\]]/g, '')) || plain(value)
    const sameArtist = item => plain(item.artist) === plain(artist) || plain(item.artist).startsWith(`${plain(artist)} `)
    id = (found.albums.find(item => plain(item.title) === plain(album) && plain(item.artist) === plain(artist))
      || found.albums.find(item => bare(item.title) === bare(album) && sameArtist(item)))?.albumId
  }
  if (!id) return { error: `YouTube Music did not find the album ${album} by ${artist}.` }
  const root = await accountBrowse(id, cookies, fetchImpl, config, { anonymous: !accountHeaders(cookies) })
  return { tracks: parseAccountTracks(root, 100).map(track => {
    const artists = track.artists?.length ? track.artists : [track.artist || String(artist)]
    return { ...track, artists, artist: track.artist || artists.join(', '), album }
  }) }
}

async function setAccountLiked(videoId, liked, cookies, fetchImpl = fetch) {
  if (!VIDEO_ID.test(String(videoId || ''))) return { error: 'Invalid YouTube track id.' }
  const headers = accountHeaders(cookies)
  if (!headers) return { skipped: true }
  const endpoint = liked ? 'like' : 'removelike'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetchImpl(`${LIKE_URL}/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ context: { client: CLIENT }, target: { videoId } }),
      signal: controller.signal,
    })
    if (!res.ok) return { error: `YouTube Music like request failed (${res.status}).` }
    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') return { error: 'YouTube Music returned an invalid like response.' }
    if (isLoggedOutResponse(body)) return { error: 'YouTube Music returned a signed-out response.' }
    accountCache.clear()
    return { ok: true, liked: !!liked }
  } catch (error) {
    return { error: error.message || 'YouTube Music like request failed.' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- streams

function expiryOf(url) {
  try {
    const expire = Number(new URL(url).searchParams.get('expire'))
    if (expire > 0) return expire * 1000 - STREAM_MARGIN_MS
  } catch {}
  return Date.now() + 60 * 60 * 1000
}

// yt-dlp found the video but no format it could use: the stream links are
// behind JavaScript challenges it couldn't solve, or need a token it lacks.
const FORMATS_MISSING = /Requested format is not available|Only images are available|No video formats found|n challenge solving failed|nsig extraction failed|Signature extraction failed/i

/** A readable reason from yt-dlp's error output. */
function streamError(text) {
  if (/confirm you.re not a bot/i.test(text)) return 'YouTube asked to confirm you are not a bot. Sign in to YouTube Music in Settings → Integrations.'
  if (/Sign in to confirm your age/i.test(text)) return 'This song is age-restricted. Sign in to YouTube Music in Settings → Integrations to play it.'
  // Not the song: yt-dlp got no audio link it could use ("Requested format is not available").
  if (FORMATS_MISSING.test(text)) return 'YouTube gave yt-dlp no playable audio for this song. Update yt-dlp in Settings → External Tools, then try again.'
  if (/not available|unavailable|Private video|removed/i.test(text)) return 'This song is not available on YouTube.'
  if (/HTTP Error 429|Too Many Requests/i.test(text)) return 'YouTube is rate-limiting. Try again in a while.'
  const line = String(text).split('\n').reverse().find(l => /ERROR:/.test(l))
  return line ? line.replace(/^.*?ERROR:\s*/, '').slice(0, 200) : 'Could not get the audio from YouTube.'
}

// Streaming quality (Settings → Library → Streaming Quality):
//   best   the highest bitrate: Opus ~160 kbps, or Premium's 256 kbps AAC
//          when the cookies are a YouTube Premium account's (-S abr, since
//          yt-dlp would otherwise prefer Opus over AAC whatever the bitrate)
//   saver  the smallest Opus stream (~50-70 kbps)
const QUALITY_ARGS = {
  // Direct HTTP(S) formats only, fallbacks included: the player can't use HLS
  // or DASH manifests, so none of them may pick one. The last resort is a
  // direct file with audio in it (a small muxed video) rather than a manifest.
  best: ['-f', 'bestaudio[protocol=https]/bestaudio[protocol=http]/best[acodec!=none][protocol=https]', '-S', 'abr'],
  saver: ['-f', 'worstaudio[acodec=opus][protocol=https]/worstaudio[protocol=https]/worstaudio[protocol=http]/worst[acodec!=none][protocol=https]'],
  // Music video check (musicVideo.js): AAC lines up better than low-rate Opus.
  analysis: ['-f', 'bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]/best[acodec!=none][protocol=https]'],
  // Music videos (musicVideo.js): the picture alone, capped by Settings ->
  // Playback -> Music Video Quality -- it plays muted under the song's own
  // audio. H.264 first (hardware decoding), then VP9; muxed files and finally
  // anything direct as fallbacks, so a video still plays when the capped
  // video-only formats aren't offered.
  video: videoFormatArgs(1080),
}

/** yt-dlp format args for a music video's picture, capped at `height`. */
function videoFormatArgs(height) {
  const h = [1080, 720, 480].includes(Number(height)) ? Number(height) : 1080
  return ['-f', [
    `bestvideo[height<=${h}][vcodec^=avc1][protocol=https]`,
    `bestvideo[height<=${h}][vcodec^=vp09][protocol=https]`,
    `bestvideo[height<=${h}][protocol=https]`,
    `best[height<=${h}][protocol=https]`,
    'bestvideo[protocol=https]',
    'best[protocol=https]',
  ].join('/')]
}

function runResolve(videoId, { ytdlp, cookieArgs = [], quality = 'best', videoHeight = null }) {
  return new Promise((resolve, reject) => {
    const runtime = jsRuntime()
    const args = [
      ...(quality === 'video' ? videoFormatArgs(videoHeight || 1080) : QUALITY_ARGS[quality] || QUALITY_ARGS.best),
      '-j', '--no-playlist', '--no-warnings', '--skip-download',
      ...runtime.args,
      ...cookieArgs,
      // YouTube Music is the right page for audio/account formats. Its watch
      // endpoint can expose an audio-oriented format list, though, so ask the
      // regular YouTube endpoint when the caller needs a picture.
      `${quality === 'video' ? 'https://www.youtube.com' : 'https://music.youtube.com'}/watch?v=${videoId}`,
    ]
    let proc
    try { proc = spawn(ytdlp, args, { windowsHide: true, ...runtime.options }) } catch (e) { reject(new Error(`Could not run yt-dlp (${e.message})`)); return }
    let out = ''
    let err = ''
    let timedOut = false
    // Music videos are far bigger files than songs, and their format lists
    // longer: give the lookup more time than the audio one.
    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill() } catch {}
      reject(new Error(quality === 'video' ? 'The music video lookup timed out. Try again.' : 'YouTube audio resolution timed out. Try again.'))
    }, quality === 'video' ? VIDEO_RESOLVE_TIMEOUT_MS : RESOLVE_TIMEOUT_MS)
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('error', e => { clearTimeout(timer); reject(new Error(`Could not run yt-dlp (${e.message})`)) })
    proc.on('close', () => {
      clearTimeout(timer)
      if (timedOut) return
      let info = null
      try { info = JSON.parse(out.trim().split('\n').pop()) } catch {}
      const output = err || out
      if (!info?.url) {
        if (runtime.args.length && jsRuntimeRefused(output)) {
          resolve(runResolve(videoId, { ytdlp, cookieArgs, quality, videoHeight }))
          return
        }
        if (isCookieError(output)) {
          const error = new Error('YouTube cookies could not be read')
          error.cookieError = true
          reject(error)
          return
        }
        const error = new Error(streamError(output))
        error.formatsMissing = FORMATS_MISSING.test(output)
        reject(error)
        return
      }
      const ext = info.ext || ''
      if (quality === 'video') {
        resolve({ format: [info.vcodec, info.height ? `${info.height}p` : null].filter(Boolean).join(' ') || null, url: info.url, headers: info.http_headers || {}, mime: ext === 'webm' ? 'video/webm' : 'video/mp4', expiresAt: expiryOf(info.url) })
        return
      }
      resolve({
        format: [info.acodec, info.abr ? `${Math.round(info.abr)} kbps` : null].filter(Boolean).join(' ') || null,
        url: info.url,
        headers: info.http_headers || {},
        mime: ext === 'webm' ? 'audio/webm' : ext === 'm4a' || ext === 'mp4' ? 'audio/mp4' : 'audio/*',
        expiresAt: expiryOf(info.url),
      })
    })
  })
}

// The fast engine (youtubeFast.js) for audio and music videos' pictures,
// yt-dlp as the fallback. A song or video whose fast link was refused, or
// that the fast engine couldn't do, goes to yt-dlp for a while instead of
// failing the same way (a song and its video separately).
const FAST_QUALITIES = new Set(['best', 'saver', 'analysis', 'video'])
const FAST_RETRY_MS = 10 * 60 * 1000
const fastFailed = new Map() // videoId -> until
const fastReasons = new Map() // videoId -> why the fast engine last failed it
/** Why the fast engine last couldn't do `videoId` (for `quality`), or null. */
function fastFailure(videoId, quality) { return fastReasons.get(fastKey(videoId, quality)) || null }
const fastKey = (videoId, quality) => quality === 'video' ? `${videoId}:video` : videoId
function fastBlocked(videoId, quality) {
  const key = fastKey(videoId, quality)
  const until = fastFailed.get(key)
  if (until && until > Date.now()) return true
  fastFailed.delete(key)
  return false
}
function blockFast(videoId, quality, error) {
  if (fastFailed.size > 500) fastFailed.delete(fastFailed.keys().next().value)
  fastFailed.set(fastKey(videoId, quality), Date.now() + FAST_RETRY_MS)
  if (fastReasons.size > 500) fastReasons.delete(fastReasons.keys().next().value)
  fastReasons.set(fastKey(videoId, quality), String(error?.message || error).slice(0, 300))
  const what = quality === 'video' ? 'YouTube fast engine (video)' : 'YouTube fast engine'
  try { require('electron-log').info(`${what}: ${videoId} goes through yt-dlp for now (${String(error?.message || error).slice(0, 200)})`) } catch {}
}

/**
 * The audio URL for a video, from cache, the fast engine (`fast`, when on) or
 * yt-dlp (one lookup at a time per video).
 */
async function resolveStream(videoId, { ytdlp, cookieArgs, cookieBrowser = null, force = false, quality = 'best', videoHeight = null, fast = null, keepFast = false } = {}) {
  if (!VIDEO_ID.test(String(videoId || ''))) throw new Error('Not a YouTube video id')
  const q = QUALITY_ARGS[quality] ? quality : 'best'
  const useFast = !!fast && FAST_QUALITIES.has(q)
  if (!ytdlp && !useFast) throw new Error('yt-dlp is not installed. Install it from the Download page.')
  const key = `${videoId}\n${q}${q === 'video' && videoHeight ? `\n${videoHeight}` : ''}` // a quality change looks the stream up again
  const cached = streamCache.get(key)
  // A caller with the fast engine off (or a fast link refused before) doesn't take a fast link.
  const usable = cached && (useFast || cached.engine !== 'youtubei')
  if (!force && usable && cached.expiresAt > Date.now()) return cached
  // Looked up again because its link was refused: a fast link goes to yt-dlp
  // now (unless the caller wants a fresh fast link: `keepFast`, the same file).
  if (force && !keepFast && cached?.engine === 'youtubei') blockFast(videoId, q, new Error('its stream link was refused'))
  if (!force && resolving.has(key)) return resolving.get(key)
  const job = (async () => {
    if (useFast && !fastBlocked(videoId, q) && (q !== 'video' || fast.resolveVideo)) {
      try {
        return q === 'video' ? await fast.resolveVideo(videoId, { height: videoHeight || 1080 }) : await fast.resolveAudio(videoId, { quality: q })
      } catch (error) { blockFast(videoId, q, error) }
    }
    if (!ytdlp) throw new Error('yt-dlp is not installed. Install it from the Download page.')
    try {
      return await runResolve(videoId, { ytdlp, cookieArgs, quality: q, videoHeight })
    } catch (e) {
      if (e.cookieError && cookieBrowser) markUnreadable(cookieBrowser)
      // Signed in, yt-dlp only uses player clients that need a JavaScript
      // runtime; signed out, it has one that doesn't. Public songs play the same.
      else if (!(e.formatsMissing && cookieArgs?.length)) throw e
      return runResolve(videoId, { ytdlp, cookieArgs: [], quality: q, videoHeight })
    }
  })().then(stream => {
    if (streamCache.size > 200) streamCache.delete(streamCache.keys().next().value)
    streamCache.set(key, stream)
    return stream
  })
    .finally(() => resolving.delete(key))
  resolving.set(key, job)
  return job
}

/**
 * Fetch (a range of) a YouTube media stream. A refused URL (expired, or tied
 * to another address) is looked up again once.
 */
async function fetchStream(videoId, { range, ytdlp, cookieArgs, cookieBrowser, quality, videoHeight, fast = null, force = false, signal, fetchImpl = fetch } = {}) {
  const attempt = async (force) => {
    const stream = await resolveStream(videoId, { ytdlp, cookieArgs, cookieBrowser, force, quality, videoHeight, fast })
    const headers = { ...stream.headers }
    if (range) headers.Range = range
    return { stream, res: await fetchImpl(stream.url, { headers, signal }) }
  }
  let { stream, res } = await attempt(force)
  if (res.status === 403 || res.status === 410) {
    try { await res.body?.cancel?.() } catch {}
    ;({ stream, res } = await attempt(true))
  }
  return { res, mime: stream.mime, engine: stream.engine || 'yt-dlp' }
}

/** A YouTube video id from a youtube.com / music.youtube.com / youtu.be link, or null. */
function videoIdFromUrl(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/)
  return m ? m[1] : null
}

module.exports = {
  searchSongs, innertubeSearch, spellCheck, parseSearch, parseItem, parseDuration,
  fetchAccountData, fetchLibraryPlaylists, fetchAccountPlaylist, fetchMusicPlaylistInfo, fetchMusicPlaylist, parseMusicPlaylistMetadata, youtubeMusicPlaylistId, setAccountLiked, fetchCatalogue, parseArtistPage,
  fetchRadio, parseAccountTracks, parseAccountMixes, parseAccountHomeCategories, youtubeHomeCategory, clearAccountCache, accountHeaders, normalizeAccountCookies, parseMusicConfig, isLoggedOutResponse,
  resolveStream, fetchStream, streamError, videoIdFromUrl, fastFailure,
}
