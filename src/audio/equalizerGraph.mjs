import { EQ_FREQUENCIES, normalizeEqState } from './equalizerConfig.mjs'

// Web Audio equivalent of the mobile equalizer processing chain. The rack is
// instantiated per playback deck, so crossfades keep identical processing.
// All controls update in-place: never disconnect a live source to change mode.
const dbGain = db => Math.pow(10, db/20)
const glide = (param,value,ctx) => {
  const now=ctx.currentTime
  try { param.cancelScheduledValues(now);param.setTargetAtTime(value,now,.012) }
  catch { param.value=value }
}
const biquad = (ctx,type,frequency,q=1) => {
  const node=ctx.createBiquadFilter()
  node.type=type;node.frequency.value=frequency;node.Q.value=q
  return node
}
export function createEqualizerRack(ctx) {
  const graphic=EQ_FREQUENCIES.map((f,i)=>biquad(ctx,i===0?'lowshelf':i===9?'highshelf':'peaking',f,i===0||i===9?.7:1))
  const parametric=Array.from({length:31},()=>biquad(ctx,'peaking',1000))
  const tone=[biquad(ctx,'lowshelf',120),biquad(ctx,'peaking',1000,.8),biquad(ctx,'highshelf',6500)]
  const preamp=ctx.createGain()
  const compressor=ctx.createDynamicsCompressor()
  const makeup=ctx.createGain()
  const limiterInput=ctx.createGain()
  const limiter=ctx.createDynamicsCompressor()
  const limiterOutput=ctx.createGain()
  // Width is implemented as the mobile-style Mid/Side stereo transform:
  // output L = ((1+w)*L + (1-w)*R)/2, output R = mirror.
  const splitter=ctx.createChannelSplitter(2)
  const merger=ctx.createChannelMerger(2)
  const widthNodes=Array.from({length:4},()=>ctx.createGain())
  const balance=ctx.createStereoPanner()
  const dryDelay=ctx.createGain()
  const wetDelay=ctx.createGain()
  const delay=ctx.createDelay(2)
  const damp=biquad(ctx,'lowpass',6800)
  const feedback=ctx.createGain()
  const fxMix=ctx.createGain()
  const dryConvolver=ctx.createGain()
  const wetConvolver=ctx.createGain()
  const convolution=ctx.createConvolver()
  const output=ctx.createGain()
  const first=graphic[0]
  let previous=first
  for(const node of [...graphic.slice(1),...parametric,...tone,preamp,compressor,makeup,limiterInput,limiter,limiterOutput,splitter]){
    previous.connect(node);previous=node
  }
  splitter.connect(widthNodes[0],0);widthNodes[0].connect(merger,0,0)
  splitter.connect(widthNodes[1],1);widthNodes[1].connect(merger,0,0)
  splitter.connect(widthNodes[2],0);widthNodes[2].connect(merger,0,1)
  splitter.connect(widthNodes[3],1);widthNodes[3].connect(merger,0,1)
  merger.connect(balance)
  balance.connect(dryDelay);dryDelay.connect(fxMix)
  balance.connect(delay);delay.connect(damp);damp.connect(feedback);feedback.connect(delay)
  delay.connect(wetDelay);wetDelay.connect(fxMix)
  fxMix.connect(dryConvolver);dryConvolver.connect(output)
  fxMix.connect(convolution);convolution.connect(wetConvolver);wetConvolver.connect(output)
  let hasImpulse=false
  function apply(raw) {
    const s=normalizeEqState(raw)
    graphic.forEach((node,i)=>glide(node.gain,s.enabled&&s.mode==='graphic'?s.graphicGainsDb[i]:0,ctx))
    parametric.forEach((node,i)=>{
      const band=s.parametricBands[i]
      const active=s.enabled&&s.mode==='parametric'&&band?.enabled
      node.type=active?({
        lowShelf:'lowshelf', highShelf:'highshelf',lowPass:'lowpass',
        highPass:'highpass',bandPass:'bandpass',notch:'notch',allPass:'allpass'
      }[band.type]||'peaking'):'peaking'
      glide(node.frequency,active?Math.min(band.frequencyHz,ctx.sampleRate*.45):1000,ctx)
      glide(node.Q,active?band.q:1,ctx)
      glide(node.gain,active?band.gainDb:0,ctx)
    })
    tone.forEach((node,i)=>glide(node.gain,s.enabled?[s.bassDb,s.midDb,s.trebleDb][i]:0,ctx))
    glide(preamp.gain,dbGain(s.enabled?s.preampDb:0),ctx)
    const c=s.compressor
    glide(compressor.threshold,s.enabled&&c.enabled?c.thresholdDb:0,ctx)
    glide(compressor.ratio,s.enabled&&c.enabled?c.ratio:1,ctx)
    glide(compressor.knee,0,ctx)
    glide(compressor.attack,c.attackMs/1000,ctx)
    glide(compressor.release,c.releaseMs/1000,ctx)
    glide(makeup.gain,dbGain(s.enabled&&c.enabled?c.makeupGainDb:0),ctx)
    const lim=s.limiter
    glide(limiterInput.gain,dbGain(s.enabled&&lim.enabled?lim.inputGainDb:0),ctx)
    glide(limiter.threshold,s.enabled&&lim.enabled?lim.ceilingDb:0,ctx)
    glide(limiter.ratio,s.enabled&&lim.enabled?20:1,ctx)
    glide(limiter.knee,0,ctx)
    glide(limiter.attack,.002,ctx)
    glide(limiter.release,lim.releaseMs/1000,ctx)
    glide(limiterOutput.gain,1,ctx)
    const fx=s.fx,active=s.enabled&&fx.enabled
    const w=active?fx.width:1
    for(let i=0;i<4;i++) glide(widthNodes[i].gain,i===0||i===3?(1+w)/2:(1-w)/2,ctx)
    glide(balance.pan,active?fx.balance:0,ctx)
    glide(delay.delayTime,Math.min(1.6,(fx.delayMs/1000)*(.7+fx.size*.6)),ctx)
    glide(damp.frequency,fx.filterHz*(1-fx.damp*.8),ctx)
    glide(feedback.gain,active?fx.feedback:0,ctx)
    glide(wetDelay.gain,active?fx.mix:0,ctx)
    glide(dryDelay.gain,1,ctx)
    const wet=s.enabled&&s.convolver.enabled&&hasImpulse?s.convolver.mix:0
    glide(wetConvolver.gain,wet,ctx)
    glide(dryConvolver.gain,1-wet,ctx)
    return s
  }
  function setImpulse(decoded) {
    convolution.buffer=decoded||null
    hasImpulse=!!decoded
  }
  return {input:first,output,graphic,parametric,tone,filters:[...graphic,...parametric,...tone],apply,setImpulse}
}

const IR_DB='lokal-eq-impulses'
function withIrStore(mode,perform) {
  return new Promise((resolve,reject)=>{
    if(typeof indexedDB==='undefined') return reject(new Error('Impulse storage unavailable'))
    const request=indexedDB.open(IR_DB,1)
    request.onupgradeneeded=()=>request.result.createObjectStore('files')
    request.onerror=()=>reject(request.error)
    request.onsuccess=()=>{
      const db=request.result
      const tx=db.transaction('files',mode)
      const op=perform(tx.objectStore('files'))
      op.onerror=()=>reject(op.error)
      tx.oncomplete=()=>{resolve(op.result);db.close()}
      tx.onerror=()=>{reject(tx.error);db.close()}
    }
  })
}
export async function storeImpulseFile(file) {
  if(!file || file.size>16*1024*1024) throw new Error('Impulse response must be smaller than 16 MB')
  const bytes=await file.arrayBuffer()
  await withIrStore('readwrite',store=>store.put(bytes,'active'))
  return bytes
}
export async function loadImpulseFile() { return withIrStore('readonly',store=>store.get('active')) }
export async function clearImpulseFile() {return withIrStore('readwrite',store=>store.delete('active'))}
