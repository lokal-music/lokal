// Default library visibility: when the desktop owns the same recording,
// prefer it over an imported mobile copy, including desktop-owned downloads. Both underlying rows survive.
// A Mobile-only filter can still explicitly show uploaded phone tracks.
function leadArtist(expression) {
  const comma = 'INSTR(' + expression + ", ',')";
  const semi = 'INSTR(' + expression + ", ';')";
  const first = 'CASE WHEN ' + comma + ' > 0 AND (' + semi + ' = 0 OR ' +
    comma + ' < ' + semi + ') THEN SUBSTR(' + expression + ',1,' + comma +
    '-1) WHEN ' + semi + ' > 0 THEN SUBSTR(' + expression + ',1,' + semi +
    '-1) ELSE ' + expression + ' END';
  return 'LOWER(TRIM(' + first + '))';
}

// Album ownership alone is not a recording identity: compilation albums
// may contain unrelated songs with the same title and approximate duration.
// Only use the album-artist override when it is itself credited as a
// performer on both copies. Match whole comma/semicolon-separated names.
function creditsArtist(credit, owner) {
  const cleaned = `REPLACE(REPLACE(REPLACE(LOWER(TRIM(COALESCE(${credit}, ''))), ', ', ','), '; ', ','), ';', ',')`
  return `INSTR(',' || ${cleaned} || ',', ',' || ${leadArtist(owner)} || ',') > 0`
}

function desktopPreferredLibraryClause() {
  return [
    "NOT (COALESCE(tracks.download_source, '') = 'mobile'",
    "AND COALESCE(tracks.duration, 0) > 0",
    "AND EXISTS (SELECT 1 FROM tracks AS desktop",
    "WHERE COALESCE(desktop.download_source, '') <> 'mobile'",
    "AND desktop.file_path NOT LIKE 'ghost://%'",
    "AND desktop.title = tracks.title COLLATE NOCASE",
    "AND COALESCE(desktop.duration, 0) > 0",
    "AND ABS(desktop.duration - tracks.duration) <= 2",
    // Album-artist identifies the owner when a track credits multiple guests.
    // Preserve the full track artist in storage; choose the owner only for
    // matching equivalent phone/desktop rows.
    // A FLAC can have ARTIST=SZA and ARTIST=Kendrick Lamar as separate
    // Vorbis values. Android may expose only the featured credit while
    // desktop uses SZA (the album owner). Accept this special case only when
    // the *title explicitly names the phone artist* as a collaborator,
    // both albums are specified and equal, and the duration is within 1s.
    // Do not infer identity from album ownership alone.
    "AND ((" +
    leadArtist("COALESCE(NULLIF(TRIM(desktop.album_artist), ''), desktop.artist)") +
      ' = ' + leadArtist("COALESCE(NULLIF(TRIM(tracks.album_artist), ''), tracks.artist)") +
    ' AND (' + leadArtist('desktop.artist') + ' = ' + leadArtist('tracks.artist') +
      ' OR (' + creditsArtist('desktop.artist', 'desktop.album_artist') +
      ' AND ' + creditsArtist('tracks.artist', 'tracks.album_artist') + ')))' +
    ' OR (' +
      "LOWER(TRIM(COALESCE(desktop.album_artist, ''))) = LOWER(TRIM(desktop.artist))" +
      " AND TRIM(COALESCE(desktop.album_artist, '')) <> ''" +
      " AND TRIM(COALESCE(desktop.album, '')) <> ''" +
      " AND LOWER(TRIM(desktop.album)) = LOWER(TRIM(tracks.album))" +
      " AND ABS(desktop.duration - tracks.duration) <= 1" +
      " AND TRIM(COALESCE(tracks.artist, '')) <> ''" +
      " AND TRIM(tracks.artist) NOT LIKE '%,%'" +
      " AND TRIM(tracks.artist) NOT LIKE '%;%' " +
      "AND (INSTR(LOWER(desktop.title), '(with ' || LOWER(TRIM(tracks.artist)) || ')') > 0 " +
      " OR INSTR(LOWER(desktop.title), '(feat. ' || LOWER(TRIM(tracks.artist)) || ')') > 0 " +
      " OR INSTR(LOWER(desktop.title), '(ft. ' || LOWER(TRIM(tracks.artist)) || ')') > 0 " +
      " OR INSTR(LOWER(desktop.title), '(featuring ' || LOWER(TRIM(tracks.artist)) || ')') > 0)" +
    '))',
    "AND (TRIM(COALESCE(desktop.album, '')) = ''",
    "OR TRIM(COALESCE(tracks.album, '')) = ''",
    "OR LOWER(TRIM(desktop.album)) = LOWER(TRIM(tracks.album)))",
    '))',
  ].join(' ');
}

function shouldPreferDesktop(opts = {}) {
  const source = opts.source;
  const problemMode = opts.problems === true || opts.problems === 'true' ||
    opts.problems === 1 || opts.problems === '1';
  const showGhosts = opts.includeGhosts === true ||
    opts.includeGhosts === 'true' || opts.includeGhosts === '1';
  return (!source || source === 'all') &&
    !opts.id && !(Array.isArray(opts.ids) && opts.ids.length) &&
    !problemMode && !showGhosts;
}

module.exports = { desktopPreferredLibraryClause, shouldPreferDesktop };
