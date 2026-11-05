import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require=createRequire(import.meta.url)
const addons=require('../electron/online/addons.js')
const { extractManifest, parseStaticMpd, stageAddonDash }=require('../electron/online/addonDash.js')
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
  assert.equal(extractManifest({dataUrl:'data:application/dash+xml;base64,'+Buffer.from(sampleMpd).toString('base64')},base).xml,sampleMpd)
  assert.ok(extractManifest({url:'https://cdn.example/manifest.mpd?sig=ok'},base).url)
  const parsed=parseStaticMpd(sampleMpd,base,base)
  assert.equal(parsed.initUrl,'https://cdn.example/init.m4a')
  assert.deepEqual(parsed.segments,['https://cdn.example/frag-1.m4s','https://cdn.example/frag-2.m4s'])
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

test('DASH refuses dynamic manifests, DRM, private hosts and segment explosions', () => {
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('type="static"','type="dynamic"'),base,base),/static/)
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('<Period>','<ContentProtection/><Period>'),base,base),/protected/)
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('https://cdn.example/init.m4a','http://127.0.0.1/init.m4a'),base,base),/HTTPS/)
  assert.throws(()=>parseStaticMpd(sampleMpd.replace('r="1"','r="8000"'),base,base),/timeline/)
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
