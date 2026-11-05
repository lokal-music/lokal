// AES-CTR Common Encryption support for the private hybrid-v1 add-on
// transport. Parses bounded ISO BMFF structures, decrypts *sample payloads*
// and neutralizes obsolete protection boxes without changing byte lengths.
// The addon-provided content key stays in memory; no key is stored or logged.
'use strict'
const crypto = require('node:crypto')

function fail(reason) { throw new Error('Unsupported encrypted hybrid media: ' + reason) }
function check(b, at, length) {
  if (!Buffer.isBuffer(b) || !Number.isSafeInteger(at) || !Number.isSafeInteger(length) ||
      at < 0 || length < 0 || at + length > b.length) fail('invalid MP4 boundaries')
}
const u16 = (b, n) => (check(b,n,2), b.readUInt16BE(n))
const u32 = (b, n) => (check(b,n,4), b.readUInt32BE(n))
const i32 = (b, n) => (check(b,n,4), b.readInt32BE(n))
const u64 = (b, n) => (check(b,n,8), b.readBigUInt64BE(n))
function* boxes(b, begin = 0, limit = b.length) {
  let at = begin
  while (at + 8 <= limit) {
    let length = u32(b,at), header = 8
    const type = b.toString('ascii', at+4, at+8)
    if (length === 1) {
      const wide = u64(b,at+8)
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) fail('MP4 box too large')
      length = Number(wide); header = 16
    } else if (length === 0) length = limit - at
    if (length < header || at + length > limit) fail('invalid MP4 box size')
    yield { type, at, data: at+header, end: at+length }
    at += length
  }
  if (at !== limit) fail('partial MP4 box')
}
function first(b, begin, end, type) {
  for (const box of boxes(b,begin,end)) if (box.type === type) return box
  return null
}
function descendant(b, root, names) {
  let parent=root, found
  for (const name of names) {
    found=first(b,parent.data,parent.end,name)
    if (!found) return null
    parent=found
  }
  return found
}
const markFree = (b, node) => b.write('free',node.at+4,'ascii')
function neutralize(b, start, end) {
  for (const node of boxes(b,start,end)) if (node.type === 'pssh') markFree(b,node)
}
function openInit(b) {
  const moov=first(b,0,b.length,'moov')
  if (!moov) fail('missing initialization movie')
  const stsd=descendant(b,moov,['trak','mdia','minf','stbl','stsd'])
  if (!stsd) fail('missing sample description')
  let protection=null
  for (const entry of boxes(b,stsd.data+8,stsd.end)) {
    const inside=entry.at+36
    if (inside>=entry.end) continue
    const sinf=first(b,inside,entry.end,'sinf')
    if (!sinf) continue
    const scheme=first(b,sinf.data,sinf.end,'schm')
    if (scheme && b.toString('ascii',scheme.data+4,scheme.data+8)!=='cenc') fail('unsupported CENC scheme')
    const original=first(b,sinf.data,sinf.end,'frma')
    if (!original) fail('missing original sample format')
    b.write(b.toString('ascii',original.data,original.data+4),entry.at+4,'ascii')
    const tenc=descendant(b,sinf,['schi','tenc'])
    if (!tenc) fail('missing encryption sample properties')
    check(b,tenc.data,24)
    const ivSize=b[tenc.data+7]
    if (![0,8,16].includes(ivSize)) fail('invalid encryption IV size')
    const encrypted=b[tenc.data+6]!==0
    let constantIv=Buffer.alloc(0)
    if (encrypted && ivSize===0) {
      const at=tenc.data+24
      check(b,at,1)
      const length=b[at]
      check(b,at+1,length)
      constantIv=b.subarray(at+1,at+1+length)
    }
    protection={ivSize,constantIv}
    markFree(b,sinf)
  }
  if (!protection) fail('missing protected sample description')
  neutralize(b,moov.data,moov.end)
  neutralize(b,0,b.length)
  return protection
}
function sampleRecords(b,senc,ivSize) {
  const flags=u32(b,senc.data) & 0xffffff
  const count=u32(b,senc.data+4)
  if (count>30000) fail('too many encrypted samples')
  const output=[]
  let at=senc.data+8
  for (let n=0;n<count;n++) {
    check(b,at,ivSize)
    const iv=b.subarray(at,at+ivSize);at+=ivSize
    const subs=[]
    if (flags&2) {
      const number=u16(b,at);at+=2
      if (number>5000) fail('too many CENC subsamples')
      for(let j=0;j<number;j++){
        subs.push({clear:u16(b,at),length:u32(b,at+2)})
        at+=6
      }
    }
    output.push({iv,subs})
  }
  if(at>senc.end)fail('truncated CENC auxiliary data')
  return output
}
function decryptSample(buf,at,length,key,iv,subs){
  check(buf,at,length)
  if (!iv.length || ![8,16].includes(iv.length)) fail('missing or invalid sample IV')
  const iv16=Buffer.alloc(16)
  iv.copy(iv16,0,0,Math.min(iv.length,16))
  const ranges=[]
  if (!subs.length) ranges.push([at,length])
  else {
    let cursor=at
    for(const part of subs){
      cursor+=part.clear
      if(part.length)ranges.push([cursor,part.length])
      cursor+=part.length
    }
    if(cursor>at+length)fail('CENC subsamples exceed sample')
  }
  const encrypted=Buffer.concat(ranges.map(([start,length])=>(check(buf,start,length),buf.subarray(start,start+length))))
  if (!encrypted.length) return
  const cipher=crypto.createDecipheriv('aes-128-ctr',key,iv16)
  const plain=Buffer.concat([cipher.update(encrypted),cipher.final()])
  let off=0
  for(const [start,length] of ranges){
    plain.copy(buf,start,off,off+length)
    off+=length
  }
}
function openTraf(buf,traf,moofAbsolute,segmentStart,config,key){
  const tfhd=first(buf,traf.data,traf.end,'tfhd')
  const senc=first(buf,traf.data,traf.end,'senc')
  if(!tfhd || !senc)fail('missing fragment encryption metadata')
  const flags=u32(buf,tfhd.data)&0xffffff
  let at=tfhd.data+8
  let base=moofAbsolute
  let defaultSize=0
  if(flags&1){const val=u64(buf,at);if(val>BigInt(Number.MAX_SAFE_INTEGER))fail('invalid media offset');base=Number(val);at+=8}
  if(flags&2)at+=4
  if(flags&8)at+=4
  if(flags&16){defaultSize=u32(buf,at);at+=4}
  const records=sampleRecords(buf,senc,config.ivSize)
  let index=0,absoluteCursor=null
  for(const node of boxes(buf,traf.data,traf.end)){
    if(node.type!=='trun')continue
    const f=u32(buf,node.data)&0xffffff
    const count=u32(buf,node.data+4)
    let cursor=node.data+8
    if(f&1){absoluteCursor=base+i32(buf,cursor);cursor+=4}
    if(f&4)cursor+=4
    if(absoluteCursor==null)fail('missing fragment sample offsets')
    for(let i=0;i<count;i++){
      if(f&0x100)cursor+=4
      const size=(f&0x200)?u32(buf,cursor):defaultSize
      if(f&0x200)cursor+=4
      if(f&0x400)cursor+=4
      if(f&0x800)cursor+=4
      if(!size)fail('unknown sample size')
      const record=records[index++]
      if(!record)fail('missing CENC sample IV')
      decryptSample(buf,absoluteCursor-segmentStart,size,key,
        record.iv.length?record.iv:config.constantIv,record.subs)
      absoluteCursor+=size
    }
  }
  if(index!==records.length)fail('CENC sample count mismatch')
  for(const node of boxes(buf,traf.data,traf.end)){
    if(['senc','saiz','saio'].includes(node.type))markFree(buf,node)
    if(['sbgp','sgpd'].includes(node.type) &&
        buf.toString('ascii',node.data+4,node.data+8)==='seig')markFree(buf,node)
  }
}
function openFragment(b,key,config,segmentStart){
  let pending=null,count=0
  for(const node of boxes(b)){
    if(node.type==='moof')pending=node
    else if(node.type==='mdat'&&pending){
      const absolute=segmentStart+pending.at
      for(const traf of boxes(b,pending.data,pending.end)){
        if(traf.type==='traf')openTraf(b,traf,absolute,segmentStart,config,key)
      }
      neutralize(b,pending.data,pending.end)
      pending=null;count++
    }
  }
  if(!count)fail('no encrypted MP4 fragments')
  return b
}
module.exports={ openInit,openFragment }
