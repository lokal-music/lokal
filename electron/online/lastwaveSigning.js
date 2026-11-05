'use strict'

// LastWave-compatible HTTP addons embed a listener token in /a/<token>.
// The published protocol signs GET requests with a common client key. This
// is not an application secret and does not replace the listener's private URL.
const crypto = require('node:crypto')

const DEFAULT_SIGNING_KEY = '36d96a751b12ee481c281a8a8e64c482d0c1634a22061ab72f40175017818b85'

function headersForLastWave(address, { intent = null, nowMs = Date.now(), secret = process.env.LASTWAVE_ADDON_SIGNING_SECRET || DEFAULT_SIGNING_KEY } = {}) {
  let url, token, path
  try {
    url = new URL(address)
    const match = url.pathname.match(/(?:^|\/)a\/([^/]+)/)
    if (!match) return {}
    token = decodeURIComponent(match[1])
    // LastWave signs the decoded path, not query parameters or the origin.
    path = decodeURIComponent(url.pathname)
  } catch {
    return {}
  }
  if (!token || !secret) return {}
  const seconds = Math.floor(nowMs / 1000)
  const payload = [seconds, 'GET', path, token].join('\n')
  const signature = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
  return {
    'X-LW-TS': String(seconds),
    'X-LW-Sign': signature,
    ...(intent === 'stream' || intent === 'download' ? { 'X-LW-Intent': intent } : {}),
  }
}

module.exports = { headersForLastWave }
