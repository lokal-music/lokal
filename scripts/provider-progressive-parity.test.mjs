import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { playbackAvailability } from '../src/recommendations.js'

const require = createRequire(import.meta.url)
const { progressiveMedia } = require('../electron/mornye/progressiveMedia')
const { shouldRetryEnrichment } = require('../electron/mornye/providerFastPath')
const media = require('../electron/mornye/media')

const flacHeader = () => {
  const h = Buffer.alloc(42)
  h.write('fLaC')
  h[7] = 34 // STREAMINFO metadata block length
  const rate = 44100, bits = 16
  h[18] = rate >> 12
  h[19] = (rate >> 4) & 255
  h[20] = ((rate & 15) << 4) | (((bits - 1) >> 4) & 1)
  h[21] = ((bits - 1) & 15) << 4
  return h
}
const box = (kind, bytes = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(bytes.length + 8)
  head.write(kind, 4)
  return Buffer.concat([head, bytes])
}
const validM4aMoov = () => {
  // A real sample-table hierarchy: moov/trak/mdia/hdlr + minf/stbl/stsd
  // with a complete audio sample entry and valid channel/sample widths.
  const entry = Buffer.alloc(36)
  entry.writeUInt32BE(entry.length)
  entry.write('mp4a', 4)
  entry.writeUInt16BE(1, 14)  // data reference index
  entry.writeUInt16BE(2, 24)  // channels
  entry.writeUInt16BE(16, 26) // bit depth
  const count = Buffer.alloc(4)
  count.writeUInt32BE(1)
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(4), count, entry]))
  const stbl = box('stbl', stsd)
  const minf = box('minf', stbl)
  const handler = Buffer.alloc(12)
  handler.write('soun', 8)
  const mdia = box('mdia', Buffer.concat([box('hdlr', handler), minf]))
  return box('moov', box('trak', mdia))
}

test('complete FLAC headers are recognizable; only caller-selected Qobuz exposes live playback', () => {
  const head = Buffer.concat([flacHeader(), Buffer.alloc(65536 - 42)])
  for (const provider of ['qobuz','deezer','tidal','amazon']) {
    assert.deepEqual(progressiveMedia(head, 'audio.flac'), {
      format: 'flac', mime: 'audio/flac',
    }, provider)
  }
  assert.equal(progressiveMedia(Buffer.alloc(65536), 'audio.flac'), null)
  assert.equal(progressiveMedia(head, 'audio.flac.encrypted'), null)
})

test('M4A must have complete fast-start init; encrypted/segmented media waits for validation', () => {
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0'))
  const moov = validM4aMoov()
  const start = Buffer.concat([ftyp, moov, Buffer.alloc(65536 - ftyp.length - moov.length)])
  assert.deepEqual(progressiveMedia(start, 'audio.m4a'), {
    format: 'm4a', mime: 'audio/mp4',
  })
  // A "mp4a" byte sequence without a complete sample description is never
  // sufficient. No playback source should be handed to Chromium in this case.
  assert.equal(progressiveMedia(Buffer.concat([
    ftyp, box('moov', Buffer.from('mp4a and alac are just arbitrary text')),
  ]),'audio.m4a'), null)
  assert.equal(progressiveMedia(Buffer.concat([
    ftyp, box('moov', box('mvex')),
  ]),'audio.m4a'), null)
  assert.equal(progressiveMedia(Buffer.concat([ftyp,box('moov',Buffer.from('mp4asinf'))]),'audio.m4a'), null)
  assert.equal(progressiveMedia(Buffer.concat([ftyp,box('mdat',Buffer.from('mp4a'))]),'audio.m4a'), null)
  const incomplete = Buffer.concat([ftyp, Buffer.from([0,1,0,0]), Buffer.from('moov')])
  assert.equal(progressiveMedia(incomplete, 'audio.m4a'), null)
})

test('ready Qobuz transfer survives metadata availability and remains readable', async () => {
  let preparationSignal
  const result = await playbackAvailability(
    { id:'12345' }, 'a-0123456789',
    { onlinePrepare: async (_source,_id,_force,{signal}) => {
      preparationSignal = signal
      return { ok:true, live:true, status:'running' }
    } },
    200,
  )
  assert.equal(result, null)
  assert.equal(preparationSignal.aborted, false,
    'preparation must not cancel the active background download')

  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'lokal-qobuz-live-'))
  const part = path.join(dir, 'audio.flac.part')
  const finished = path.join(dir, 'audio.flac')
  const first = Buffer.concat([flacHeader(),Buffer.alloc(65536 - 42)])
  let signalled = false
  const job = { status:'running', markLive:()=>{signalled=true}, promise:Promise.resolve(),
    message:'' }
  try {
    // First callback can race a Windows file rename/open. Don't disable
    // early streaming permanently just because the initial probe could not
    // open its in-progress file.
    media.liveUpdate(job,{part,file:finished,total:100000,written:first.length})
    assert.equal(job.live.checked,false)
    await fs.writeFile(part, first)
    media.liveUpdate(job,{part,file:finished,total:100000,written:first.length})
    assert.equal(job.live.ready, true)
    assert.equal(signalled, true)
    assert.equal(job.live.mime, 'audio/flac')
    const response = await media.liveResponse(job, { range:'bytes=0-99999' })
    assert.equal(response.status,206)
    assert.equal(response.headers.get('content-range'),'bytes 0-99999/100000')
    const reader = response.body.getReader()
    const {value} = await reader.read()
    assert.ok(value.length > 0, 'first bytes play before the 100KB file is complete')
    await reader.cancel()
  } finally {
    await fs.rm(dir, { recursive:true, force:true })
  }
})

test('a persistent add-on file cannot be moved out of the add-on root', () => {
  const staging=path.join(os.tmpdir(),'lokal-work','operation')
  assert.equal(media.isStagedAudioFile(path.join(staging,'audio.flac'),staging),true)
  assert.equal(media.isStagedAudioFile(path.join(staging,'subdir','audio.flac'),staging),true)
  assert.equal(media.isStagedAudioFile(path.join(os.tmpdir(),'lokal-data','audio.flac'),staging),false)
  assert.equal(media.isStagedAudioFile(path.join(staging,'..','cached.flac'),staging),false)
  assert.equal(media.isStagedAudioFile(staging,staging),false)
})

test('failed availability permits the same bounded enrichment retry on every provider', () => {
  for (const provider of ['tidal','tidal-web','qobuz','deezer','amazon']) {
    assert.equal(shouldRetryEnrichment({
      available: {available:false,reason:'Track not resolved'},
      hasEnrichment:true,
    }),true,provider)
  }
  assert.equal(shouldRetryEnrichment({
    available:{available:true,track_id:'123'},
    hasEnrichment:true,
  }),false)
  assert.equal(shouldRetryEnrichment({
    available:{available:false},hasEnrichment:false,
  }),false)
})
