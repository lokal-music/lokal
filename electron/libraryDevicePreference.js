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
    'AND ' + leadArtist("COALESCE(NULLIF(TRIM(desktop.album_artist), ''), desktop.artist)") +
      ' = ' + leadArtist("COALESCE(NULLIF(TRIM(tracks.album_artist), ''), tracks.artist)"),
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
