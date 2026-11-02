// RBJ biquad response formulas for the desktop EQ curve. These match Web
// Audio's BiquadFilterNode for the supported filter types at 44.1/48 kHz.
// This module has no browser globals and can be covered by Node tests.
import { EQ_FREQUENCIES, normalizeEqState } from './equalizerConfig.mjs'

const TAU=Math.PI*2
const EPSILON=1e-12
function coefficients(type,frequencyHz,gainDb,q,sampleRate) {
  const freq=Math.max(20,Math.min(frequencyHz,sampleRate*.45))
  const omega=TAU*freq/sampleRate
  const cos=Math.cos(omega),sin=Math.sin(omega),A=Math.pow(10,gainDb/40)
  const alpha=sin/(2*Math.max(.2,q))
  let b0,b1,b2,a0,a1,a2
  switch(type) {
    case 'lowShelf':
    case 'highShelf': {
      // Web Audio shelves use fixed slope (the Q input has no effect).
      const a=sin*Math.SQRT1_2 // sin(w)/sqrt(2)
      const p=2*Math.sqrt(A)*a
      if(type==='lowShelf') {
        b0=A*((A+1)-(A-1)*cos+p)
        b1=2*A*((A-1)-(A+1)*cos)
        b2=A*((A+1)-(A-1)*cos-p)
        a0=(A+1)+(A-1)*cos+p
        a1=-2*((A-1)+(A+1)*cos)
        a2=(A+1)+(A-1)*cos-p
      } else {
        b0=A*((A+1)+(A-1)*cos+p)
        b1=-2*A*((A-1)+(A+1)*cos)
        b2=A*((A+1)+(A-1)*cos-p)
        a0=(A+1)-(A-1)*cos+p
        a1=2*((A-1)-(A+1)*cos)
        a2=(A+1)-(A-1)*cos-p
      }
      break
    }
    case 'lowPass':
      b0=(1-cos)/2;b1=1-cos;b2=b0
      a0=1+alpha;a1=-2*cos;a2=1-alpha
      break
    case 'highPass':
      b0=(1+cos)/2;b1=-(1+cos);b2=b0
      a0=1+alpha;a1=-2*cos;a2=1-alpha
      break
    case 'bandPass':
      b0=alpha;b1=0;b2=-alpha
      a0=1+alpha;a1=-2*cos;a2=1-alpha
      break
    case 'notch':
      b0=1;b1=-2*cos;b2=1
      a0=1+alpha;a1=-2*cos;a2=1-alpha
      break
    case 'allPass':
      b0=1-alpha;b1=-2*cos;b2=1+alpha
      a0=1+alpha;a1=-2*cos;a2=1-alpha
      break
    default:
      b0=1+alpha*A;b1=-2*cos;b2=1-alpha*A
      a0=1+alpha/A;a1=-2*cos;a2=1-alpha/A
  }
  return [b0,b1,b2,a0,a1,a2]
}
function responseDb(coefs,frequencyHz,sampleRate) {
  const [b0,b1,b2,a0,a1,a2]=coefs
  const w=TAU*frequencyHz/sampleRate
  const c1=Math.cos(w),s1=Math.sin(w),c2=Math.cos(2*w),s2=Math.sin(2*w)
  const num=Math.hypot(b0+b1*c1+b2*c2,b1*s1+b2*s2)
  const den=Math.hypot(a0+a1*c1+a2*c2,a1*s1+a2*s2)
  return 20*Math.log10(Math.max(num,EPSILON)/Math.max(den,EPSILON))
}
export function equalizerResponseDb(stateInput,frequenciesHz,sampleRate=48000) {
  const s=normalizeEqState(stateInput)
  if(!s.enabled)return frequenciesHz.map(()=>0)
  const bands=s.mode==='graphic'?s.graphicGainsDb.map((gainDb,i)=>({
    type:i===0?'lowShelf':i===9?'highShelf':'peaking',
    frequencyHz:EQ_FREQUENCIES[i],q:i===0||i===9?.7:1,gainDb,enabled:true
  })):s.parametricBands
  const all=[...bands,{type:'lowShelf',frequencyHz:120,q:1,gainDb:s.bassDb,enabled:true},
    {type:'peaking',frequencyHz:1000,q:.8,gainDb:s.midDb,enabled:true},
    {type:'highShelf',frequencyHz:6500,q:1,gainDb:s.trebleDb,enabled:true}]
  const stages=all.filter(b=>b.enabled).map(b=>coefficients(b.type,b.frequencyHz,b.gainDb,b.q,sampleRate))
  return frequenciesHz.map(hz=>s.preampDb+stages.reduce((total,c)=>total+responseDb(c,hz,sampleRate),0))
}

// Estimate the summed response (rather than the maximum individual boost).
// Calculated when the EQ changes, never on the audio rendering callback.
const HEADROOM_FREQUENCIES=Array.from({length:192},(_,i)=>20*Math.pow(1000,i/191))
export function estimateEqHeadroomDb(stateInput,sampleRate=48000) {
  const state=normalizeEqState(stateInput)
  if(!state.enabled || !state.autoHeadroom) return 0
  const peak=Math.max(0,...equalizerResponseDb(state,HEADROOM_FREQUENCIES,sampleRate))
  return peak>0 ? peak+0.8 : 0
}
