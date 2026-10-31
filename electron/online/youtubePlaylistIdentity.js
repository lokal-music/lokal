// A signed-in YouTube Music account outlives the individual HTTP cookie
// snapshot. Google refreshes cookies even during our own browse requests.
// Cache/playlists must be tied to the selected sign-in, not the entire jar.
const crypto = require('node:crypto')
const { browserContext, normalizeCookies } = require('./browserAuth')

const fingerprint = value =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Older sessions may not have a persisted sign-in revision. Prefer a stable
// authentication cookie over short-lived request/visitor/consent cookies.
function legacyAccountCredential(rawCookies) {
  const cookies = new Map(normalizeCookies(rawCookies).split(';').map(part => {
    const index = part.indexOf('=')
    return index < 1 ? [] : [part.slice(0, index).trim(), part.slice(index + 1).trim()]
  }).filter(entry => entry.length === 2))
  for (const name of ['SID', '__Secure-3PSID', '__Secure-1PSID',
    'SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID']) {
    if (cookies.get(name)) return [name, cookies.get(name)]
  }
  return ['cookies', normalizeCookies(rawCookies)]
}

/**
 * A privacy-safe ID for the signed-in desktop profile and selected Music
 * channel. A new Lokal login changes yt_account_revision and partition;
 * cookie rotations and YouTube client/visitor metadata do not.
 *
 * Callers must still check youtube.accountHeaders() on each request. This
 * identity is for matching a cache owner, NOT proof of authentication.
 */
function youtubePlaylistAccountId(credentials = {}, settings = {}) {
  const rawCookies = credentials.cookies || ''
  const context = browserContext(rawCookies)
  const selected = [context.SESSION_INDEX || '0', context.DELEGATED_SESSION_ID || '']
  const revision = String(settings.yt_account_revision || '').trim()
  const partition = String(settings.yt_account_partition || '').trim()
  const signedIn = settings.yt_account_session === '1'
  const owner = signedIn && revision && partition
    ? ['desktop-session', revision, partition]
    : ['legacy-cookie', legacyAccountCredential(rawCookies)]
  return fingerprint([owner, selected])
}

module.exports = { youtubePlaylistAccountId }
