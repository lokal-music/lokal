// LastWave hybrid-v1 CDN byte-range transport. Every fragment is bounded and
// validated; encrypted samples are processed in memory with Node's AES-CTR.
// No remote proxy, native extension, extra dependency or persisted content key.
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { cacheDir } = require('../cache')
const { guardMediaUrl } = require('./addonDash')
const { openInit, openFragment } = require('./addonHybridCenc')

const MAX_CHUNK = 16 * 1024 * 1024
const MAX_TOTAL = 512 * 1024 * 1024
const MAX_RANGES = 4096

function parseRange(value) {
  if (!value || !Number.isSafeInteger(value.start) ||
      !Number.isSafeInteger(value.end) || value.start < 0 ||
      value.end < value.start || value.end - value.start + 1 > MAX_CHUNK) {
    throw new Error('LastWave supplied invalid hybrid byte ranges.')
  }
  return { start: value.start, end: value.end }
}

function parseHybrid(value, addonBase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LastWave supplied an invalid hybrid plan.')
  }
  const url = guardMediaUrl(value.cdnUrl, addonBase)
  const init = parseRange(value.initRange)
  const segments = value.ranges
  if (!Array.isArray(segments) || !segments.length || segments.length > MAX_RANGES ||
      init.start !== 0) throw new Error('LastWave supplied an incomplete hybrid plan.')
  const ranges = segments.map(parseRange)
  let last = init.end
  for(const range of ranges) {
    if (range.start <= last) throw new Error('LastWave hybrid ranges overlap.')
    last = range.end
  }
  const encrypted = value.encrypted === true
  const key = String(value.key || '').replace(/^0x/i, '')
  if (encrypted && !/^[a-f0-9]{32}$/i.test(key)) throw new Error('LastWave supplied an invalid hybrid content key.')
  const ivSize = value.ivSize ?? 16
  if (encrypted && ![0,8,16].includes(ivSize)) throw new Error('LastWave supplied an invalid IV size.')
  let constantIv=Buffer.alloc(0)
  if(value.constantIv){
    constantIv=Buffer.from(value.constantIv,'base64')
    if (![8,16].includes(constantIv.length)) throw new Error('LastWave supplied an invalid constant IV.')
  }
  // When the original CDN ranges are contiguous, include a small SIDX gap
  // so MP4 seeking metadata survives assembly.
  const gap = ranges[0].start - init.end - 1
  const continuous = ranges.every((range,i)=>!i||range.start===ranges[i-1].end+1)
  const first = continuous && gap>0 && gap<=256*1024
    ? { start:0, end:ranges[0].start-1 } : init
  const total=[first,...ranges].reduce((n,r)=>n+r.end-r.start+1,0)
  if(total>MAX_TOTAL)throw new Error('LastWave hybrid recording exceeds the cache limit.')
  return { url, init:first, ranges, encrypted, key, ivSize, constantIv }
}

async function fetchByteRange(url, range, fetchImpl, signal) {
  const expected=range.end-range.start+1
  const response=await fetchImpl(url,{
    headers:{ Range:`bytes=${range.start}-${range.end}`, 'Accept-Encoding':'identity' },
    signal:signal || AbortSignal.timeout(30000),redirect:'error',
  })
  if (response.status!==206 || !response.body) throw new Error('LastWave CDN did not honor the requested byte range.')
  const contentRange=response.headers?.get?.('content-range') || ''
  const match=contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
  if(!match || Number(match[1])!==range.start || Number(match[2])!==range.end)
    throw new Error('LastWave CDN returned a mismatched byte range.')
  const chunks=[]
  let count=0
  for await(const chunk of response.body) {
    count+=chunk.length
    if(count>expected)throw new Error('LastWave CDN returned an oversized fragment.')
    chunks.push(Buffer.from(chunk))
  }
  if(count!==expected)throw new Error('LastWave CDN returned an incomplete fragment.')
  return Buffer.concat(chunks,count)
}

async function stageHybrid(raw, addonBase, { fetchImpl=fetch, signal, key='' }={}) {
  const plan=parseHybrid(raw,addonBase)
  const dir=cacheDir('playback')
  await fs.mkdir(dir,{recursive:true})
  const digest=crypto.createHash('sha256')
    .update(key+'\n'+plan.url+'\n'+JSON.stringify(plan.ranges)+'\n'+plan.key)
    .digest('hex').slice(0,24)
  const dest=path.join(dir,'addon-hybrid-'+digest+'.m4a')
  if((await fs.stat(dest).catch(()=>null))?.size>0)return dest
  const tmp=dest+'.'+process.pid+'.part'
  let handle
  try {
    handle=await fs.open(tmp,'wx')
    const init=await fetchByteRange(plan.url,plan.init,fetchImpl,signal)
    let config={ivSize:plan.ivSize,constantIv:plan.constantIv}
    const keyBytes=plan.encrypted?Buffer.from(plan.key,'hex'):null
    if (keyBytes) config=openInit(init)
    // The transport's constant IV is a fallback when the init omits one.
    if(!config.constantIv?.length) config.constantIv=plan.constantIv
    await handle.writeFile(init)
    for (const range of plan.ranges) {
      const chunk=await fetchByteRange(plan.url,range,fetchImpl,signal)
      if(keyBytes)openFragment(chunk,keyBytes,config,range.start)
      await handle.writeFile(chunk)
    }
    await handle.close();handle=null
    await fs.rename(tmp,dest)
    return dest
  } catch(error) {
    await handle?.close().catch(()=>{})
    await fs.unlink(tmp).catch(()=>{})
    throw error
  }
}
module.exports={parseHybrid,fetchByteRange,stageHybrid}
