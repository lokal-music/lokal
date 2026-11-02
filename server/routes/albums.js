const router = require('express').Router()
const { getDB } = require('../../electron/ipc/db')

function classifyAlbumRow(row) {
  const trackCount = Number(row?.track_count || 0)
  if (trackCount <= 1) return 'single'
  if (trackCount <= 6) return 'ep'
  return 'album'
}

function enrichAlbumRows(rows = []) {
  return rows.map(({ cover, ...row }) => {
    // cover = "<track number>\t<artwork path>\t<track id>" (see albumRowsQuery).
    const [, artworkPath = null, artworkTrackId = null] = String(cover || '').split('\t')
    return { ...row, artwork_path: artworkPath, artwork_track_id: artworkTrackId, release_type: classifyAlbumRow(row) }
  })
}

function albumRowsQuery(where = '') {
  return `
    SELECT
      album as title,
      COALESCE(NULLIF(album_artist, ''), artist) as album_artist,
      -- The cover: the first track (by number) that has one. A bare
      -- artwork_path took whichever row SQLite picked (with MAX(added_at),
      -- the newest track), so an album whose newest song had no embedded
      -- cover showed none even when its other songs had one.
      MIN(CASE WHEN NULLIF(artwork_path, '') IS NOT NULL
        THEN printf('%06d', COALESCE(track_num, 999999)) || char(9) || artwork_path || char(9) || id END) as cover,
      MAX(year) as year,
      COUNT(*) as track_count,
      GROUP_CONCAT(DISTINCT artist) as artists
    FROM tracks
    WHERE album IS NOT NULL
      AND file_path NOT LIKE 'ghost://%'
      ${where}
    GROUP BY LOWER(album), LOWER(COALESCE(NULLIF(album_artist, ''), artist))
  `
}

router.get('/', (req, res) => {
  const rows = getDB().prepare(`${albumRowsQuery()} ORDER BY year DESC, album ASC`).all()
  res.json(enrichAlbumRows(rows))
})

router.get('/search', (req, res) => {
  const match = require('../../electron/librarySearch').wordsMatch(String(req.query.q || ''), ['album', 'album_artist', 'artist'])
  if (!match) return res.json([])
  const rows = getDB().prepare(`${albumRowsQuery(`AND COALESCE(download_source, '') <> 'mobile' AND ${match.sql}`)} ORDER BY album ASC LIMIT 40`).all(...match.params)
  res.json(enrichAlbumRows(rows))
})

module.exports = router
