// Shared HTTP plumbing for the lyrics providers.
//
// Every provider is raced against the others (see repository.js), so one that
// hangs holds up the whole lookup. The timeout here is deliberately short: a
// lyric that turns up after the second chorus is no use to anyone, and the
// fallbacks behind it are the better answer.

const USER_AGENT = 'Lokal (https://github.com/lokal-music/Desktop)'
const DEFAULT_TIMEOUT_MS = 7000

async function request(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...headers },
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
}

/** Body of a successful GET, or null for any failure at all. */
function getText(url, options) {
  return request(url, options)
}

/** Parsed JSON of a successful GET, or null. */
async function getJson(url, options) {
  const text = await request(url, options)
  if (text == null) return null
  try { return JSON.parse(text) } catch { return null }
}

function withQuery(base, params) {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

module.exports = { request, getText, getJson, withQuery, USER_AGENT }
