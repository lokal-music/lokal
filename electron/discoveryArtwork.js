const { key, leadArtist, titleKey, artistMatches, artworkMatchConfidence, isArtworkMatch } = require('./discoveryArtworkMatch')
const imageUrl = value => {
  const url = String(value || '').replace(/^http:/, 'https:')
  return /^https:\/\//.test(url) && !/2a96cbd8|default_album|noimage|\/artist\/\//i.test(url) ? url : ''
}

async function json(url, fetchImpl, timeoutMs = 6000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    return response.ok ? await response.json() : null
  } catch { return null }
  finally { clearTimeout(timer) }
}

/** Resolve only artwork for provider metadata; never change recommendation identity. */
function createArtworkResolver({ getDB = () => null, isElectron = false, fetchImpl = fetch, searchArtists, searchSongs } = {}) {
  const cache = new Map()
  const pending = new Map()
  const local = item => {
    try {
      const db = getDB()
      if (!db) return ''
      if (item.type === 'artist') {
        const row = db.prepare('SELECT id, image_path FROM artists WHERE lower(trim(name)) = lower(trim(?)) AND image_path IS NOT NULL LIMIT 1').get(item.artist)
        if (row?.image_path) return isElectron ? `file://${row.image_path}` : `/api/artist-image/${encodeURIComponent(row.id)}`
      } else {
        const field = item.type === 'album' ? 'album' : 'title'
        const row = db.prepare(`SELECT id, artwork_path, artwork_url FROM tracks WHERE lower(trim(${field})) = lower(trim(?)) AND lower(trim(COALESCE(album_artist, artist))) = lower(trim(?)) AND (artwork_path IS NOT NULL OR artwork_url IS NOT NULL) LIMIT 1`).get(item.title, item.artist)
        if (row?.artwork_path) return isElectron ? `file://${row.artwork_path}` : `/api/artwork/${encodeURIComponent(row.id)}`
        if (imageUrl(row?.artwork_url)) return imageUrl(row.artwork_url)
      }
    } catch { /* Missing local art should still try provider metadata. */ }
    return ''
  }
  const remote = async item => {
    const disallowed = new Set([item.exclude, ...(item.excludes || [])].map(imageUrl).filter(Boolean))
    const allowed = value => {
      const image = imageUrl(value)
      return image && !disallowed.has(image) ? image : ''
    }
    const firstImage = (...values) => values.map(allowed).find(Boolean) || ''
    // Keep the same bounded Deezer -> US/GB Apple/iTunes -> YouTube Music
    // search used on Mobile. Do not accept a fuzzy title from another artist,
    // or let a live/remix/edit recording borrow the original's cover.
    const end = Date.now() + 14000
    const lookup = url => Date.now() < end
      ? json(url, fetchImpl, Math.max(100, Math.min(6000, end - Date.now()))) : Promise.resolve(null)
    const wantedArtist = leadArtist(item.artist) || item.artist
    const wantedTitle = titleKey(item.title) || item.title

    if (item.type === 'artist') {
      const deezer = await lookup('https://api.deezer.com/search/artist?q=' + encodeURIComponent(item.artist) + '&limit=10')
      const match = (deezer?.data || []).find(row => artistMatches(item.artist, row.name) && firstImage(row.picture_xl, row.picture_big))
      if (match) return firstImage(match.picture_xl, match.picture_big)
      if (searchArtists) {
        const candidates = await searchArtists(item.artist, { source: 'wikidata' }).catch(() => [])
        const artist = candidates.find(row => artistMatches(item.artist, row.title) && allowed(row.imageUrl))
        if (artist) return allowed(artist.imageUrl)
      }
      const songs = await lookup('https://api.deezer.com/search?q=' + encodeURIComponent('artist:"' + item.artist + '"') + '&limit=10')
      const songImage = row => firstImage(row?.artist?.picture_xl, row?.artist?.picture_big, row?.album?.cover_xl, row?.album?.cover_big)
      const song = (songs?.data || []).find(row => artistMatches(item.artist, row.artist?.name) && songImage(row))
      return song ? songImage(song) : ''
    }

    const album = item.type === 'album'
    const matches = (title, artist) => album
      ? titleKey(title) === titleKey(item.title) && artistMatches(item.artist, artist)
      : isArtworkMatch(item.title, item.artist, title, artist)
    const coverOf = row => album
      ? firstImage(row?.cover_xl, row?.cover_big)
      : firstImage(row?.album?.cover_xl, row?.album?.cover_big)
    const deezerQuery = album
      ? 'artist:"' + wantedArtist + '" album:"' + wantedTitle + '"'
      : 'artist:"' + wantedArtist + '" track:"' + wantedTitle + '"'
    const deezer = await lookup('https://api.deezer.com/search' + (album ? '/album' : '') + '?q=' + encodeURIComponent(deezerQuery) + '&limit=15')
    const match = (deezer?.data || []).find(row => matches(row.title, row.artist?.name) && coverOf(row))
    if (match) return coverOf(match)

    const countries = album ? ['us', 'gb', 'in'] : ['us', 'gb']
    const appleArt = row => allowed(row?.artworkUrl100?.replace(/100x100bb/, album ? '1500x1500bb' : '600x600bb'))
    const searchTerm = wantedArtist + ' ' + wantedTitle
    for (const country of countries) {
      const itunes = await lookup('https://itunes.apple.com/search?term=' + encodeURIComponent(searchTerm) + '&country=' + country + '&entity=' + (album ? 'album' : 'song') + '&limit=15')
      const apple = (itunes?.results || []).find(row =>
        matches(album ? row.collectionName : row.trackName, row.artistName) && appleArt(row))
      if (apple) return appleArt(apple)
    }

    if (!album && searchSongs) {
      const songs = await searchSongs(searchTerm).catch(() => [])
      const match = songs.find(row =>
        [row.artist, ...(Array.isArray(row.artists) ? row.artists : [])].some(artist =>
          isArtworkMatch(item.title, item.artist, row.title, artist)) &&
        firstImage(row.thumbnail, row.artwork))
      if (match) return firstImage(match.thumbnail, match.artwork)
    }

    // A slightly different local tag or an omitted remaster/guest suffix can
    // miss constrained provider search entirely. Mobile retries a broader
    // phrase, but only accepts >= .84 confidence with the same credited artist.
    // Never use arbitrary first results from a broad query.
    if (album || Date.now() >= end) return ''
    const words = wantedTitle.split(' ').filter(word => word.length >= 3 && !new Set(['the', 'and', 'with', 'for', 'from', 'feat']).has(word))
    if (words.length < 2) return ''
    const broad = words.join(' ')
    const candidates = []
    const consider = (title, artist, image) => {
      const url = allowed(image)
      const score = artworkMatchConfidence(item.title, item.artist, title, artist)
      if (url && score >= .84) candidates.push({ url, score, title: titleKey(title) })
    }
    const expanded = await lookup('https://api.deezer.com/search?q=' + encodeURIComponent('artist:"' + wantedArtist + '" ' + broad) + '&limit=30')
    for (const row of expanded?.data || []) consider(row.title, row.artist?.name, firstImage(row.album?.cover_xl, row.album?.cover_big))
    for (const country of ['us', 'gb']) {
      const expandedApple = await lookup('https://itunes.apple.com/search?term=' + encodeURIComponent(wantedArtist + ' ' + broad) + '&country=' + country + '&entity=song&limit=30')
      for (const row of expandedApple?.results || []) consider(row.trackName, row.artistName, appleArt(row))
    }
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]
    if (!best || candidates.some(candidate => candidate.title !== best.title && best.score - candidate.score < .025)) return ''
    return best.url
  }
  const resolve = async raw => {
    const excludes = [...new Set([
      raw?.exclude,
      ...(Array.isArray(raw?.excludes) ? raw.excludes.slice(0, 6) : []),
    ].map(imageUrl).filter(Boolean))]
    const item = {
      type: ['artist', 'album', 'track'].includes(raw?.type) ? raw.type : 'track',
      title: String(raw?.title || '').slice(0, 300),
      artist: String(raw?.artist || '').slice(0, 300),
      image: raw?.image,
      exclude: excludes[0] || '',
      excludes,
      remoteOnly: raw?.remoteOnly === true,
    }
    if (!item.artist || (item.type !== 'artist' && !item.title)) return { image: '' }
    const supplied = imageUrl(item.image)
    if (supplied && !excludes.includes(supplied)) return { image: supplied }
    // Search stays local-first; player high-resolution lookups can bypass
    // stale local/ghost thumbnails, as before.
    const localImage = item.remoteOnly ? '' : local(item)
    if (localImage && !excludes.includes(imageUrl(localImage) || localImage)) return { image: localImage }
    const id = JSON.stringify([item.remoteOnly, item.type, key(item.artist), titleKey(item.title), excludes])
    const cached = cache.get(id)
    if (cached && Date.now() - cached.at < (cached.image ? 86400000 : 300000)) return { image: cached.image }
    if (!pending.has(id)) {
      pending.set(id, remote(item).then(image => {
        cache.set(id, { image, at: Date.now() })
        if (cache.size > 1000) cache.delete(cache.keys().next().value)
        return { image }
      }).finally(() => pending.delete(id)))
    }
    return pending.get(id)
  }
  return async items => {
    const batch = Array.isArray(items) ? items.slice(0, 100) : []
    const results = new Array(batch.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
      while (next < batch.length) { const at = next++; results[at] = await resolve(batch[at]).catch(() => ({ image: '' })) }
    }))
    return results
  }
}

module.exports = { createArtworkResolver }
