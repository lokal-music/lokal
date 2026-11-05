import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url)
const { openInit,openFragment }=require('../electron/online/addonHybridCenc.js')
const { stageHybrid }=require('../electron/online/addonHybrid.js')

const box=(kind,...parts)=>{
  const body=Buffer.concat(parts)
  const result=Buffer.alloc(body.length+8)
  result.writeUInt32BE(result.length)
  result.write(kind,4,4,'ascii')
  body.copy(result,8)
  return result
}
const u32=(value)=>{const b=Buffer.alloc(4);b.writeUInt32BE(value);return b}

function sample() {
  const key=Buffer.from('00112233445566778899aabbccddeeff','hex')
  const iv=Buffer.from('f00102030405060708090a0b0c0d0e0f','hex')
  const clear=Buffer.from('LastWave encrypted audio test payload')
  const cipher=crypto.createCipheriv('aes-128-ctr',key,iv)
  const encrypted=Buffer.concat([cipher.update(clear),cipher.final()])
  const tenc=box('tenc',Buffer.alloc(4),Buffer.from([0,0,1,16]),Buffer.alloc(16))
  const sinf=box('sinf',box('frma',Buffer.from('mp4a')),
    box('schm',Buffer.alloc(4),Buffer.from('cenc'),Buffer.alloc(4)),
    box('schi',tenc))
  const sampleEntry=box('enca',Buffer.alloc(28),sinf)
  const stsd=box('stsd',Buffer.alloc(4),u32(1),sampleEntry)
  const init=box('moov',box('trak',box('mdia',box('minf',box('stbl',stsd)))))
  const tfhd=box('tfhd',Buffer.from([0,0,0,16]),u32(1),u32(clear.length))
  const senc=box('senc',Buffer.alloc(4),u32(1),iv)
  const trun=box('trun',Buffer.from([0,0,0,1]),u32(1),u32(0))
  let moof=box('moof',box('traf',tfhd,senc,trun))
  const dataOffset=moof.length+8
  moof=box('moof',box('traf',tfhd,senc,
    box('trun',Buffer.from([0,0,0,1]),u32(1),u32(dataOffset))))
  const fragment=Buffer.concat([moof,box('mdat',encrypted)])
  return {key,iv,clear,init,fragment}
}
function range(data,from,to) {
  return {start:from,end:to}
}

test('lastwave AES-CTR CENC test fixture decrypts the real MP4 sample bytes',()=>{
  const item=sample()
  const config=openInit(item.init)
  assert.equal(config.ivSize,16)
  assert.equal(item.init.includes(Buffer.from('enca')),false)
  assert.equal(item.init.includes(Buffer.from('sinf')),false)
  openFragment(item.fragment,item.key,config,0)
  assert.ok(item.fragment.includes(item.clear))
  assert.equal(item.fragment.includes(Buffer.from('senc')),false)
  assert.throws(()=>openFragment(Buffer.alloc(4),item.key,config,0),/invalid|fragments|boundaries/)
})

test('encrypted lastwave hybrid-v1 decrypts and stages a complete seekable file',async()=>{
  const {key,init,fragment,clear}=sample()
  const full=Buffer.concat([init,fragment])
  const url='https://cdn.example/encrypted'
  const plan={
    cdnUrl:url,encrypted:true,key:key.toString('hex'),ivSize:16,
    initRange:range(full,0,init.length-1),
    ranges:[range(full,init.length,full.length-1)],
  }
  const fetchImpl=async(target,options)=>{
    assert.equal(target,url)
    const m=options.headers.Range.match(/^bytes=(\d+)-(\d+)$/)
    const from=Number(m[1]),to=Number(m[2])
    return new Response(full.subarray(from,to+1),{
      status:206,headers:{'content-range':`bytes ${from}-${to}/${full.length}`},
    })
  }
  const dir=await mkdtemp(join(tmpdir(),'lokal-cenc-'))
  try{
    const file=await stageHybrid(plan,'https://addon.example/a/provider',{directory:dir,fetchImpl,key:'encrypted-test'})
    const staged=await readFile(file)
    assert.ok(staged.includes(clear))
    assert.equal(staged.includes(Buffer.from('senc')),false)
  }finally{await rm(dir,{recursive:true,force:true})}
})
