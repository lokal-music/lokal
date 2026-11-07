import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Regression for a desktop renderer crash: the HTTP add-on form used
// installKey, but its state hook lived in the unrelated RepositoryBrowser.
const source = readFileSync(new URL('../src/components/AddonsSettings.jsx', import.meta.url), 'utf8')
const repositoryStart = source.indexOf('function RepositoryBrowser(')
const addonStart = source.indexOf('export default function AddonsSettings(')
assert.ok(repositoryStart >= 0 && addonStart > repositoryStart, 'Expected add-on settings components')
const repositoryBrowser = source.slice(repositoryStart, addonStart)
const addonsSettings = source.slice(addonStart)

test('HTTP add-on signing key state belongs to the component rendering its form', () => {
  assert.match(addonsSettings, /const \[installKey, setInstallKey\] = useState\(''\)/)
  assert.doesNotMatch(repositoryBrowser, /const \[installKey, setInstallKey\]/)
  assert.match(addonsSettings, /value=\{installKey\} onChange=\{e => setInstallKey\(e\.target\.value\)\}/)
})

test('HTTP add-on install forwards its optional signing key and clears it after success', () => {
  assert.match(addonsSettings, /api\.addonsInstall\(url\.trim\(\), \{ signingKey: installKey \}\)/)
  assert.match(addonsSettings, /setInstallKey\(''\)/)
})
