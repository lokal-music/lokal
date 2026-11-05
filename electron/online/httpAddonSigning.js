'use strict'

// Some HTTP add-ons embed a private token in /a/<token> and require HMAC
// signatures. A signing key must be supplied explicitly; none is bundled.
const crypto = require('node:crypto')

const DEFAULT_SIGNING_KEY = ''

function headersForSignedAddon(address, { intent = null, nowMs = Date.now(), signingKey = process.env.HTTP_ADDON_SIGNING_KEY || DEFAULT_SIGNING_KEY } = {}) {
  let url, token, path
  try {
    url = new URL(address)
    if (url.protocol !== 'https:') return {}
    const match = url.pathname.match(/(?:^|\/)a\/([^/]+)/)
    if (!match) return {}
    token = decodeURIComponent(match[1])
    // Sign the decoded path, excluding query parameters and origin.
    path = decodeURIComponent(url.pathname)
  } catch {
    return {}
  }
  if (!token || !signingKey) return {}
  const seconds = Math.floor(nowMs / 1000)
  const payload = [seconds, 'GET', path, token].join('\n')
  const signature = crypto.createHmac('sha256', signingKey).update(payload, 'utf8').digest('hex')
  return {
    'X-LW-TS': String(seconds),
    'X-LW-Sign': signature,
    ...(intent === 'stream' || intent === 'download' ? { 'X-LW-Intent': intent } : {}),
  }
}

module.exports = { headersForSignedAddon }
