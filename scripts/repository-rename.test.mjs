import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_RADIO_CATALOG_URL, resolveRadioCatalogUrl } from '../src/radio/stations.js'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('Electron updater and release publishing target the renamed Desktop repository', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.deepEqual(manifest.build.publish, {
    provider: 'github', owner: 'lokal-music', repo: 'Desktop',
  })
  assert.match(read('src/App.jsx'), /api\.github\.com\/repos\/lokal-music\/Desktop\/releases\/latest/)
  assert.match(read('src/pages/Settings.jsx'), /github\.com\/lokal-music\/Desktop\/releases/)
})

test('existing default radio catalogue URLs migrate without touching personal lists', () => {
  assert.equal(DEFAULT_RADIO_CATALOG_URL,
    'https://raw.githubusercontent.com/lokal-music/Desktop/refs/heads/main/radios.json')
  for (const origin of ['sipbuu/lokal', 'lokal-music/lokal']) {
    for (const branch of ['main', 'refs/heads/main']) {
      assert.equal(resolveRadioCatalogUrl(
        'https://raw.githubusercontent.com/' + origin + '/' + branch + '/radios.json'),
      DEFAULT_RADIO_CATALOG_URL)
    }
  }
  const custom = 'https://example.org/my-custom-radios.json'
  assert.equal(resolveRadioCatalogUrl(custom), custom)
})

test('Google Cast project Pages path and operator documentation match new repo', () => {
  const workflow = read('.github/workflows/cast-receiver.yml')
  const docs = read('docs/CASTING.md')
  assert.match(workflow, /https:\/\/lokal-music\.github\.io\/Desktop\/receiver\//)
  assert.match(docs, /https:\/\/lokal-music\.github\.io\/Desktop\/receiver\//)
  assert.match(docs, /Google Cast SDK Developer Console/)
  assert.doesNotMatch(docs, /github\.io\/lokal\/receiver\//)
})

test('project navigation links use canonical repo and neither old project URL', () => {
  const files = [
    'README.md', 'CONTRIBUTING.md', 'electron/discord/activity.js',
    'electron/quality/stores.js', 'electron/lyrics/http.js',
    'electron/ipc/artistMetadata.js', 'electron/theAudioDb.js',
    'src/components/OnlineLyricsSearch.jsx',
  ]
  for (const path of files) {
    const data = read(path)
    assert.doesNotMatch(data, /github\.com\/lokal-music\/lokal(?![-A-Za-z0-9])/,
      path + ' must use the current repository link')
  }
})
