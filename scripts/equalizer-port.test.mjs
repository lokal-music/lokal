import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EQ_PRESETS, defaults, loadEqState, normalizeEqState,
  saveEqState, parseEqPreset, exportEqPresetText, applyPreset
} from '../src/audio/equalizerConfig.mjs'
import { createEqualizerRack } from '../src/audio/equalizerGraph.mjs'
import { equalizerResponseDb } from '../src/audio/equalizerResponse.mjs'

function storage(initial={}) {
  const map=new Map(Object.entries(initial))
  return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),read:()=>map}
}
function audioMock() {
  const nodes=[]
  const param=(value=0)=>({value,cancelScheduledValues(){},setTargetAtTime(v){this.value=v}})
  const node=kind=>{
    const out={kind,connect(target){return target},disconnect(){},gain:param(),
      frequency:param(1000),Q:param(1),threshold:param(),ratio:param(1),
      knee:param(),attack:param(),release:param(),pan:param(),delayTime:param(),
      buffer:null}
    nodes.push(out)
    return out
  }
  const ctx={currentTime:0,sampleRate:48000}
  for(const kind of ['BiquadFilter','Gain','DynamicsCompressor','ChannelSplitter','ChannelMerger',
    'StereoPanner','Delay','Convolver'])ctx['create'+kind]=()=>node(kind)
  return {ctx,nodes}
}
test('desktop keeps the mobile EQ state schema and 31-band ceiling',()=>{
  const s=normalizeEqState({...defaults(),mode:'parametric',parametricBands:
    Array.from({length:50},(_,i)=>({type:'peaking',frequencyHz:100+i*200,gainDb:99,q:0}))})
  assert.equal(s.parametricBands.length,31)
  assert.equal(s.parametricBands[0].gainDb,20)
  assert.equal(s.parametricBands[0].q,.2)
  assert.equal(s.mode,'parametric')
  assert.equal(s.fx.tempo,1)
})
test('legacy desktop 5-/10-band gains migrate without changing audible gains',()=>{
  const st=storage({'lokal-eq':JSON.stringify([5,4,3,2,1])})
  const state=loadEqState(st)
  assert.deepEqual(state.graphicGainsDb,[3.6,3.6,2.88,2.88,2.16,2.16,1.44,1.44,.72,.72])
  saveEqState(state,st,false)
  assert.deepEqual(loadEqState(st).graphicGainsDb,state.graphicGainsDb)
})
test('mobile parametric TXT preset round trips types, gains, Q and preamp',()=>{
  const raw='Preamp: -4.2 dB\nFilter 1: ON PK Fc 80 Hz Gain 2.4 dB Q 1.200\nFilter 2: OFF HS Fc 8000 Hz Gain -3 dB Q 0.700'
  const preset=parseEqPreset(raw,'Headphones.txt')
  assert.equal(preset.mode,'parametric')
  assert.equal(preset.preampDb,-4.2)
  assert.equal(preset.parametricBands[1].enabled,false)
  const exported=exportEqPresetText(preset)
  assert.equal(parseEqPreset(exported,'Second.txt').parametricBands[0].gainDb,2.4)
})
test('mobile exported JSON presets preserve compressor, limiter and FX',()=>{
  const state={...defaults(),mode:'parametric',compressor:{...defaults().compressor,enabled:true,ratio:6},
    limiter:{...defaults().limiter,enabled:true,ceilingDb:-1},
    fx:{...defaults().fx,enabled:true,width:1.5}}
  const imported=parseEqPreset(JSON.stringify({...state,name:'Headphones'}),'preset.json')
  const next=applyPreset(defaults(),imported)
  assert.equal(next.activePresetName,'Headphones')
  assert.equal(next.compressor.ratio,6)
  assert.equal(next.limiter.ceilingDb,-1)
  assert.equal(next.fx.width,1.5)
  assert.equal(EQ_PRESETS.length,5)
})
test('two independent DSP racks can apply the same EQ without sharing audio nodes',()=>{
  const {ctx,nodes}=audioMock()
  const a=createEqualizerRack(ctx)
  const b=createEqualizerRack(ctx)
  assert.notEqual(a.input,b.input)
  assert.equal(a.filters.length,44)
  const s={...defaults(),mode:'parametric',parametricBands:[
    {type:'lowShelf',frequencyHz:90,gainDb:5,q:.8,enabled:true}]}
  a.apply(s);b.apply(s)
  assert.equal(a.parametric[0].type,'lowshelf')
  assert.equal(b.parametric[0].gain.value,5)
  assert.equal(a.graphic[0].gain.value,0)
  a.apply({...s,enabled:false})
  assert.equal(a.parametric[0].gain.value,0)
  assert.equal(b.parametric[0].gain.value,5)
  a.setImpulse({sampleRate:48000})
  a.apply({...defaults(),convolver:{...defaults().convolver,enabled:true,mix:.5}})
  assert.ok(nodes.filter(n=>n.kind==='Convolver').some(n=>n.buffer?.sampleRate===48000))
  assert.ok(nodes.some(n=>n.kind==='Gain'&&n.gain.value===.5))
})

test('response curve matches flat bypass and boosted parametric peak',()=>{
  const freqs=[50,1000,10000]
  const flat=equalizerResponseDb(defaults(),freqs)
  assert.ok(flat.every(v=>Math.abs(v)<1e-6))
  const peak=equalizerResponseDb({...defaults(),mode:'parametric',
    parametricBands:[{type:'peaking',enabled:true,frequencyHz:1000,gainDb:6,q:1}]},freqs)
  assert.ok(peak[1]>5.9&&peak[1]<6.1)
  assert.ok(Math.abs(peak[0])<1)
  assert.deepEqual(equalizerResponseDb({...defaults(),enabled:false},freqs),[0,0,0])
})
