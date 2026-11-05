import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { activeSupportingVocalIndex } from '../src/lyrics/supportingVocals.mjs'

const require = createRequire(import.meta.url)
const { fromVorbisCommentBlock, readFlacLyrics, selectWithBacking, attachBackgroundRows } =
  require('../electron/lyrics/flacVorbis.js')
const { parseEnhancedLRC } = require('../electron/lyrics/lrc.js')
const { fetch: localLyrics, mergePrivateBackground } = require('../electron/lyrics/providers/local.js')

const lead = [
  '[00:15.433]<00:15.433>Lead <00:16.353>voice <00:22.852>',
  '[00:23.055]<00:23.055>Next <00:24.039>line <00:24.474>',
].join('\n')
const bg = '[bg:<00:17.254><00:17.254>Backing <00:17.726><00:17.726>voice <00:26.736><00:26.736>]'

function commentBlock(values) {
  const vendor=Buffer.from('Lokal test')
  const parts=[Buffer.alloc(4),vendor,Buffer.alloc(4)]
  parts[0].writeUInt32LE(vendor.length)
  parts[2].writeUInt32LE(values.length)
  for(const [key,value] of values) {
    const entry=Buffer.from(key+'='+value)
    const size=Buffer.alloc(4)
    size.writeUInt32LE(entry.length)
    parts.push(size,entry)
  }
  return Buffer.concat(parts)
}
function flac(block) {
  const header=Buffer.alloc(4)
  header[0]=0x84
  header.writeUIntBE(block.length,1,3)
  return Buffer.concat([Buffer.from('fLaC'),header,block])
}

test('mobile-style FLAC Vorbis parser retains separately stored backing vocals', () => {
  const bytes=commentBlock([['LYRICS',lead],['UNSYNCEDLYRICS',bg]])
  const selected=fromVorbisCommentBlock(bytes)
  assert.ok(selected.includes('<00:15.433>Lead '))
  assert.ok(selected.includes(bg))
  const parsed=parseEnhancedLRC(selected)
  assert.equal(parsed.length,2)
  assert.equal(parsed[0].bgText,'Backing voice')
  assert.deepEqual(parsed[0].bgWords.map(w=>w.time),[17.254,17.726])
  assert.equal(parsed[0].bgWords.at(-1).end,26.736)
})

test('desktop local provider loads actual FLAC comments, not only flattened metadata', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lokal-vorbis-test-'))
  const file=join(dir,'test.flac')
  try {
    await writeFile(file,flac(commentBlock([['LYRICS',lead],['LYRICS',bg]])))
    assert.ok((await readFlacLyrics(file)).includes(bg))
    // The bare Vorbis reader is used even if music-metadata refuses an audio-
    // frame-free FLAC test fixture (or a native decoder is unavailable).
    const selected=await localLyrics({filePath:file})
    assert.ok(selected?.raw?.includes(bg))
    const parsed=parseEnhancedLRC(selected.raw)
    assert.equal(parsed[0].bgText,'Backing voice')
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('sidecars keep authority over lead but borrow distinct embedded bg rows', () => {
  const combined=attachBackgroundRows(lead,bg,bg)
  assert.equal(combined.split('[bg:').length-1,1)
  assert.ok(combined.startsWith(lead))
  assert.equal(selectWithBacking([lead,bg]).split('[bg:').length-1,1)
})

test('an online lead keeps its precise word timings while FLAC adds backing vocals', () => {
  const primary=parseEnhancedLRC(lead)
  const originalWords=JSON.stringify(primary[0].words)
  const enriched=mergePrivateBackground({source:'online',lines:primary},bg)
  assert.equal(enriched.source,'online')
  assert.equal(enriched.lines.length,primary.length)
  assert.equal(JSON.stringify(enriched.lines[0].words),originalWords)
  assert.equal(enriched.lines[0].bgText,'Backing voice')
  assert.equal(enriched.lines[0].bgWords.at(-1).end,26.736)
  // Retrying the same FLAC merge should not duplicate a singer.
  const again=mergePrivateBackground(enriched,bg)
  assert.equal(again.lines[0].bgText,'Backing voice')
})

test('backing singer survives subsequent lead focus and stops at own word end', () => {
  const parsed=parseEnhancedLRC(lead+'\n'+bg)
  assert.equal(activeSupportingVocalIndex(parsed,16),-1)
  assert.equal(activeSupportingVocalIndex(parsed,20),0)
  assert.equal(activeSupportingVocalIndex(parsed,23.6),0,
    'Independently timed singer remains beneath next active lead')
  assert.equal(activeSupportingVocalIndex(parsed,26.9),-1)
})
