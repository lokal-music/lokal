// Web mode: the same online radio catalogue and now-playing lookups as the
// desktop app (electron/ipc/radio.js).
const router = require('express').Router()
const { getCatalog, loadAndSave } = require('../../electron/ipc/radio')
const { nowPlaying } = require('../../electron/radio/nowPlaying')
const { browseStations } = require('../../electron/radio/browser')

router.get('/catalog', (req, res) => res.json(getCatalog()))

router.get('/browse', async (req, res) => {
  try { res.json(await browseStations(req.query)) }
  catch (error) { res.status(503).json({ error: String(error?.message || error) }) }
})

router.post('/catalog', async (req, res) => {
  res.json(await loadAndSave(req.body?.url, { publicOnly: true }).catch(error => ({ ok: false, errors: [{ path: '', code: 'network', detail: String(error?.message || error) }] })))
})

router.post('/now-playing', async (req, res) => {
  res.json((await nowPlaying(req.body?.api, { publicOnly: true }).catch(() => null)) || null)
})

module.exports = router
