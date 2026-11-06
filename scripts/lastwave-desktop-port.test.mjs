import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require=createRequire(import.meta.url)
const addons=require('../electron/online/addons.js')
const { guardMediaUrl, extractManifest, parseStaticMpd, stageAddonDash }=require('../electron/online/addonDash.js')
const { parseHybrid, fetchByteRange, stageHybrid }=require('../electron/online/addonHybrid.js')

const base='https://lastwave.example/a/track-addon'
const direct='https://cdn.example/music/recording.flac'
const sampleMpd='<MPD type="static"><Period><AdaptationSet mimeType="audio/mp4">' +
  '<Representation id="audio" bandwidth="800000"><SegmentTemplate ' +
  'initialization="https://cdn.example/init.m4a" media="https://cdn.example/frag-$Number$.m4s" '+
  'startNumber="1"><SegmentTimeline><S d="48000" r="1"/></SegmentTimeline>' +
  '</SegmentTemplate></Representation></AdaptationSet></Period></MPD>'

function fixtureDb() {
  const rows=new Map()
  return {prepare:()=>({
    get:key=>rows.has(key)?{value:rows.get(key)}:undefined,
    run:(key,value)=>rows.set(key,value),
    all:()=>[],
  })}
}
const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})

test('LastWave nested stream accepts progressive FLAC even with default DASH labels', async () => {
  const database=fixtureDb()
  const fetchImpl=async (url,options) => {
    if(url.includes('/manifest.json'))return json({
      id:'lastwave-test-direct',name:'LastWave',version:'1',
      resources:['search','stream'],
    })
    return json({stream:{url:direct,format:'dash',manifest:'dash',codec:'flac'}})
  }
  const addon=await addons.install(database,base+'/manifest.json',{fetchImpl})
  const stream=await addons.resolveStream(database,addon.key,'direct-recording',{fetchImpl})
  assert.equal(stream.url,direct)
  assert.equal(stream.type,undefined)
  assert.notEqual(stream.mime,'application/dash+xml')
})

test('inline/remote DASH detection ignores bare default labels', () => {
  assert.equal(extractManifest({format:'dash',manifest:'dash',url:direct},base),null)
  assert.equal(extractManifest({manifestXml:sampleMpd,format:'dash'},base).xml,sampleMpd)
  assert.equal(extractManifest({streamURL:'https://cdn.example/manifest.mpd?sig=1'},base).url,'https://cdn.example/manifest.mpd?sig=1')
  assert.equal(extractManifest({dataUrl:'data:application/dash+xml;base64,'+Buffer.from(sampleMpd).toString('base64')},base).xml,sampleMpd)
  assert.ok(extractManifest({url:'https://cdn.example/manifest.mpd?sig=ok'},base).url)
  const parsed=parseStaticMpd(sampleMpd,base,base)
  assert.equal(parsed.initUrl,'https://cdn.example/init.m4a')
  assert.deepEqual(parsed.segments,['https://cdn.example/frag-1.m4s','https://cdn.example/frag-2.m4s'])
})

test('DASH signed URLs XML-decode query separators before CDN fetch (403 regression)', async () => {
  // Mobile uses an XML parser, whereas desktop previously sent literal
  // "amp;expires" / "#38;expires" query parameters to the CDN.
  const signed = sampleMpd
    .replace('/init.m4a"', '/init.m4a?sig=alpha%26beta&amp;expires=42"')
    .replace('/frag-$Number$.m4s"', '/frag-$Number$.m4s?sig=alpha%26beta&#38;expires=42"')
  const plan = parseStaticMpd(signed, base, base)
  assert.equal(plan.initUrl, 'https://cdn.example/init.m4a?sig=alpha%26beta&expires=42')
  assert.deepEqual(plan.segments, [
    'https://cdn.example/frag-1.m4s?sig=alpha%26beta&expires=42',
    'https://cdn.example/frag-2.m4s?sig=alpha%26beta&expires=42',
  ])
  const dir = await mkdtemp(join(tmpdir(), 'lokal-lastwave-escaped-'))
  const requests = [], diagnostic = []
  try {
    const file = await stageAddonDash({xml: signed, base}, base, {
      directory: dir, key: 'xml-escaped-cdn-query',
      onDiagnostic: entry => diagnostic.push(entry),
      fetchImpl: async (url, options) => {
        requests.push(url)
        assert.equal(options.headers['Accept-Encoding'], 'identity')
        if (!new URL(url).searchParams.has('expires')) return new Response('Forbidden', {status: 403})
        const part = url.includes('init.m4a') ? 'INIT' : url.includes('frag-1.m4s') ? 'ONE' : 'TWO'
        return new Response(Buffer.from(part), {status: 200})
      },
    })
    assert.equal((await readFile(file)).toString(), 'INITONETWO')
    assert.equal(requests.length, 3)
    assert.equal(diagnostic.find(e => e.event === 'dash-plan')?.encodedQuerySeparators, true)
    assert.equal(diagnostic.find(e => e.event === 'dash-plan')?.initHasQuery, true)
    assert.ok(!JSON.stringify(diagnostic).includes('alpha%26beta'), 'signed URL never logged')
  } finally { await rm(dir, {recursive: true, force: true}) }
})

test('DASH BaseURL also unescapes signed CDN query parameters', () => {
  const xml = '<MPD type="static"><BaseURL>https://cdn.example/media/?token=abc&amp;expires=42</BaseURL>' +
    '<Period><AdaptationSet mimeType="audio/mp4"><Representation id="audio" bandwidth="800000">' +
    '<SegmentTemplate initialization="init.m4a" media="fragment-$Number$.m4s">' +
    '<SegmentTimeline><S d="48000"/></SegmentTimeline></SegmentTemplate>' +
    '</Representation></AdaptationSet></Period></MPD>'
  const plan = parseStaticMpd(xml, base, base)
  assert.equal(plan.initUrl, 'https://cdn.example/media/init.m4a')
  assert.equal(plan.segments[0], 'https://cdn.example/media/fragment-1.m4s')
  // Relative paths resolved against BaseURL do not inherit its query string.
  // An escaped query must nevertheless be decoded before URL resolution.
})

test('review: public fc/fd hosts are allowed without admitting private IPv6 hosts', () => {
  for (const hostname of ['fcdn.net', 'fdcdn.example.com']) {
    const url='https://'+hostname+'/audio.m4a'
    assert.equal(guardMediaUrl(url,base),url)
  }
  for (const url of ['https://[fc00::1]/audio.m4a','https://[fd12::1]/audio.m4a','https://[::1]/audio.m4a']) {
    assert.throws(()=>guardMediaUrl(url,base),/private network hosts/)
  }
})

test('actual static DASH stream is staged as a seekable local file', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lokal-lastwave-dash-'))
  const calls=[]
  const fetchImpl=async url=>{
    calls.push(url)
    const body=url.endsWith('/init.m4a')?'INIT':url.endsWith('/frag-1.m4s')?'ONE':'TWO'
    return new Response(Buffer.from(body),{status:200})
  }
  try {
    const file=await stageAddonDash({xml:sampleMpd,base},base,{directory:dir,fetchImpl,key:'test'})
    assert.equal((await readFile(file)).toString(),'INITONETWO')
    assert.deepEqual(calls,[
      'https://cdn.example/init.m4a',
      'https://cdn.example/frag-1.m4s',
      'https://cdn.example/frag-2.m4s',
    ])
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('review: failed DASH staging rejects without exposing partially assembled media', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lokal-lastwave-write-error-'))
  let count=0
  try {
    await assert.rejects(
      stageAddonDash({xml:sampleMpd,base},base,{
        directory:dir,key:'fail-after-first-write',
        fetchImpl:async()=>{
          count++
          if (count === 2) throw new Error('Simulated upstream I/O failure')
          return new Response(Buffer.from('INIT'),{status:200})
        },
      }), /I\/O failure/,
    )
    assert.deepEqual(await readdir(dir),[], 'temporary recording must be removed on failure')
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('DASH refuses oversized network responses before allocating segment bodies', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lokal-lastwave-bounds-'))
  try {
    await assert.rejects(
      stageAddonDash({xml:sampleMpd,base},base,{
        directory:dir,key:'oversized',
        fetchImpl:async()=>new Response(Buffer.from('small'),{
          status:200,headers:{'content-length':String(32*1024*1024)},
        }),
      }),
      /limits/,
    )
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('DASH refuses dynamic manifests, DRM, private hosts and segment explosions', () => {
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('type="static"','type="dynamic"'),base,base),/static/)
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('<Period>','<ContentProtection/><Period>'),base,base),/protected/)
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('https://cdn.example/init.m4a','http://127.0.0.1/init.m4a'),base,base),/HTTPS/)
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('<S d="48000" r="1"','<S d="48000" r="8000"'),base,base),/timeline/)
})

test('hybrid validates byte ranges and forbids invalid key material', () => {
  const item={cdnUrl:'https://cdn.example/hybrid',initRange:{start:0,end:7},
    ranges:[{start:8,end:15}],encrypted:false}
  assert.equal(parseHybrid(item,base).ranges.length,1)
  assert.throws(()=>parseHybrid({...item,ranges:[{start:7,end:15}]},base),/overlap/)
  assert.throws(()=>parseHybrid({...item,encrypted:true,key:'not-a-key'},base),/key/)
})

test('hybrid range fetch verifies the exact response range and size', async () => {
  const expected={start:10,end:13}
  const valid=async (_url,opt)=>{
    assert.equal(opt.headers.Range,'bytes=10-13')
    return new Response(Buffer.from('ABCD'),{
      status:206,headers:{'content-range':'bytes 10-13/100'},
    })
  }
  assert.equal((await fetchByteRange('https://cdn.example/file',expected,valid)).toString(),'ABCD')
  await assert.rejects(
    fetchByteRange('https://cdn.example/file',expected,async()=>new Response('ABCD',{status:200})),
    /byte range/,
  )
})

test('clear hybrid ranges are staged in byte order', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lokal-lastwave-hybrid-'))
  const value={
    cdnUrl:'https://cdn.example/hybrid',encrypted:false,
    initRange:{start:0,end:3},ranges:[{start:4,end:7},{start:8,end:11}],
  }
  const all=Buffer.from('INITONETWO!!')
  const fetchImpl=async (_url,options)=>{
    const match=options.headers.Range.match(/bytes=(\d+)-(\d+)/)
    const from=Number(match[1]),to=Number(match[2])
    return new Response(all.subarray(from,to+1),{
      status:206,headers:{'content-range':`bytes ${from}-${to}/12`},
    })
  }
  try {
    const file=await stageHybrid(value,base,{directory:dir,fetchImpl,key:'clear-test'})
    assert.equal((await readFile(file)).toString(),'INITONETWO!!')
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('LastWave search artwork alias and inline streamURL match mobile playback', async () => {
  const database=fixtureDb()
  let resolved=0
  const artwork='https://img.example/cover.jpg'
  const fetchImpl=async url=>{
    if(url.includes('/manifest.json'))return json({
      id:'lastwave-inline-url',name:'LastWave',version:'1',
      resources:['search','stream'],
    })
    if(url.includes('/search'))return json({tracks:[{
      id:'inline-track',title:'Inline song',artist:'The Artist',
      albumArtworkURL:artwork,streamURL:direct,format:'dash',manifest:'dash',
      duration:193,
    }]})
    resolved++
    throw new Error('A valid search-inline recording should not call /stream')
  }
  const addon=await addons.install(database,base+'/manifest.json',{fetchImpl})
  const tracks=await addons.search(database,addon.key,'Inline song',{fetchImpl})
  assert.equal(tracks[0].thumbnail,artwork)
  const stream=await addons.resolveStream(database,addon.key,'inline-track',{fetchImpl})
  assert.equal(stream.url,direct)
  assert.equal(stream.mime,'audio/flac')
  assert.equal(resolved,0)
})

test('LastWave uppercase streamURL in nested /stream payload resolves for playback', async () => {
  const database=fixtureDb()
  const fetchImpl=async url=>url.includes('/manifest.json')
    ? json({id:'lastwave-streamurl-alias',name:'LastWave',version:'1',resources:['search','stream']})
    : json({data:{streamURL:direct,format:'dash',manifest:'dash'}})
  const addon=await addons.install(database,base+'/manifest.json',{fetchImpl})
  const stream=await addons.resolveStream(database,addon.key,'uppercase-link',{fetchImpl})
  assert.equal(stream.url,direct)
  assert.equal(stream.mime,'audio/flac')
})

test('Explicit add-on playback quality bypasses a search-inline recording', async () => {
  const database=fixtureDb()
  let resolved=0
  const fetchImpl=async url=>{
    if(url.includes('/manifest.json'))return json({
      id:'lastwave-quality-selection',name:'LastWave',version:'1',
      resources:['search','stream'],
      settings:[{key:'quality',type:'select',default:'LOSSLESS'}],
    })
    if(url.includes('/search'))return json({tracks:[{
      id:'quality-track',title:'Quality song',artist:'Singer',
      streamURL:'https://cdn.example/audio/default.mp3',
    }]})
    resolved++
    return json({url:direct,format:'flac'})
  }
  const addon=await addons.install(database,base+'/manifest.json',{fetchImpl})
  addons.setSettings(database,addon.key,{quality:'LOSSLESS'})
  await addons.search(database,addon.key,'Quality song',{fetchImpl})
  const stream=await addons.resolveStream(database,addon.key,'quality-track',{fetchImpl})
  assert.equal(resolved,1)
  assert.equal(stream.url,direct)
})
