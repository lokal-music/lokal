// Desktop representation of Lokal Mobile's EqualizerState.
// Keep field names and JSON values compatible with mobile preset exports.
export const EQ_STORAGE_KEY = 'lokal-eq-state-v2'
export const EQ_FREQUENCIES = [32,64,125,250,500,1000,2000,4000,8000,16000]
export const PARAMETRIC_FREQUENCIES = [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000]
export const EQ_TYPES = ['peaking','lowShelf','highShelf','lowPass','highPass','bandPass','notch','allPass']
export const EQ_TYPE_CODES = {peaking:'PK',lowShelf:'LS',highShelf:'HS',lowPass:'LP',highPass:'HP',bandPass:'BP',notch:'NO',allPass:'AP'}
const EQ_CODE_TYPES = Object.fromEntries(Object.entries(EQ_TYPE_CODES).map(([k,v])=>[v,k]))
EQ_CODE_TYPES.LSC = 'lowShelf'
EQ_CODE_TYPES.HSC = 'highShelf'
export const EQ_PRESETS = [
  { id:'builtin_flat', name:'Flat', graphicGainsDb:[0,0,0,0,0,0,0,0,0,0] },
  { id:'builtin_minimal_audio_morph', name:'Minimal Audio Morph EQ', graphicGainsDb:[-0.5,-0.2,0.3,0.8,1.1,0.7,0.2,0.9,1.2,0.8] },
  { id:'builtin_bass_boost', name:'Bass Boost', graphicGainsDb:[6,5,4,2,0,-1,-2,-2,-2,-2] },
  { id:'builtin_vocal', name:'Vocal', graphicGainsDb:[-2,-2,-1,1,3,4,3,1,-1,-2] },
  { id:'builtin_treble_boost', name:'Treble Boost', graphicGainsDb:[-2,-2,-2,-1,0,1,3,4,5,6] },
]
export const defaults = () => ({
  enabled:true, mode:'graphic', preampDb:0,
  graphicGainsDb:Array(10).fill(0),
  parametricBands:PARAMETRIC_FREQUENCIES.slice(0,10).map(frequencyHz=>({enabled:true,frequencyHz,gainDb:0,q:1,type:'peaking'})),
  activePresetName:null, bassDb:0,midDb:0,trebleDb:0,
  compressor:{enabled:false,thresholdDb:-18,ratio:3,attackMs:12,releaseMs:140,makeupGainDb:0},
  limiter:{enabled:false,inputGainDb:0,ceilingDb:-0.8,releaseMs:80},
  fx:{enabled:false,balance:0,tempo:1,damp:.35,filterHz:6800,delayMs:240,size:.55,mix:.25,feedback:.35,width:1},
  convolver:{enabled:false,mix:1,irPath:null,irDisplayName:null},
})
export const clamp = (n,min,max,fallback=0) => {const v=Number(n);return Number.isFinite(v)?Math.max(min,Math.min(max,v)):fallback}
const boolean = (x,defaultValue=false)=>typeof x==='boolean'?x:defaultValue
const range = (obj,key,min,max,fallback)=>clamp(obj?.[key],min,max,fallback)
export function normalizeEqState(input) {
  const d=defaults()
  const s=input && typeof input==='object' ? input : {}
  const bands=Array.isArray(s.parametricBands)?s.parametricBands.slice(0,31):d.parametricBands
  const graphic=Array.isArray(s.graphicGainsDb)?s.graphicGainsDb:d.graphicGainsDb
  const comp=s.compressor||{}, lim=s.limiter||{}, fx=s.fx||{}, conv=s.convolver||{}
  return {
    enabled:boolean(s.enabled,true),
    mode:s.mode==='parametric'?'parametric':'graphic',
    preampDb:range(s,'preampDb',-24,24,0),
    graphicGainsDb:Array.from({length:10},(_,i)=>clamp(graphic[i],-20,20,0)),
    parametricBands:(bands.length?bands:d.parametricBands).map((b,i)=>({
      enabled:boolean(b?.enabled,true),frequencyHz:range(b,'frequencyHz',20,20000,PARAMETRIC_FREQUENCIES[i]||1000),
      gainDb:range(b,'gainDb',-20,20,0),q:range(b,'q',.2,20,1),
      type:EQ_TYPES.includes(b?.type)?b.type:'peaking'
    })),
    activePresetName:typeof s.activePresetName==='string'?s.activePresetName:null,
    bassDb:range(s,'bassDb',-20,20,0),midDb:range(s,'midDb',-20,20,0),trebleDb:range(s,'trebleDb',-20,20,0),
    compressor:{enabled:boolean(comp.enabled),thresholdDb:range(comp,'thresholdDb',-36,0,-18),
      ratio:range(comp,'ratio',1,12,3),attackMs:range(comp,'attackMs',1,100,12),
      releaseMs:range(comp,'releaseMs',20,500,140),makeupGainDb:range(comp,'makeupGainDb',-20,20,0)},
    limiter:{enabled:boolean(lim.enabled),inputGainDb:range(lim,'inputGainDb',0,12,0),
      ceilingDb:range(lim,'ceilingDb',-12,0,-.8),releaseMs:range(lim,'releaseMs',20,300,80)},
    fx:{enabled:boolean(fx.enabled),balance:range(fx,'balance',-1,1,0),tempo:range(fx,'tempo',.5,2,1),
      damp:range(fx,'damp',0,1,.35),filterHz:range(fx,'filterHz',200,18000,6800),
      delayMs:range(fx,'delayMs',10,1600,240),size:range(fx,'size',0,1,.55),
      mix:range(fx,'mix',0,1,.25),feedback:range(fx,'feedback',0,.95,.35),width:range(fx,'width',0,2,1)},
    convolver:{enabled:boolean(conv.enabled),mix:range(conv,'mix',0,1,1),
      irPath:typeof conv.irPath==='string'?conv.irPath:null,
      irDisplayName:typeof conv.irDisplayName==='string'?conv.irDisplayName:null}
  }
}
export function loadEqState(storage=globalThis.localStorage) {
  try {
    const saved=storage.getItem(EQ_STORAGE_KEY)
    if(saved) return normalizeEqState(JSON.parse(saved))
  } catch {}
  let legacy=[]
  try { legacy=JSON.parse(storage.getItem('lokal-eq')||'[]') } catch {}
  if(legacy.length===5) legacy=legacy.flatMap(x=>[x,x])
  return normalizeEqState({graphicGainsDb:legacy})
}
export function saveEqState(state,storage=globalThis.localStorage,dispatch=true) {
  const normalized=normalizeEqState(state)
  try {
    storage.setItem(EQ_STORAGE_KEY,JSON.stringify(normalized))
    // Older desktop builds should still see the last 10-band EQ.
    if(normalized.mode==='graphic') storage.setItem('lokal-eq',JSON.stringify(normalized.graphicGainsDb))
  } catch {}
  if(dispatch && typeof window!=='undefined') {
    window.__lokalInitAudio?.()
    window.__lokaleq?.apply?.(normalized)
    window.dispatchEvent(new CustomEvent('lokal:eq-changed',{detail:normalized}))
  }
  return normalized
}
export function applyPreset(state,preset) {
  const keep=normalizeEqState(state)
  return normalizeEqState({...keep, ...preset,
    // A mobile preset may omit fields; don't inherit old DSP choices silently.
    compressor:preset.compressor||defaults().compressor,
    limiter:preset.limiter||defaults().limiter,fx:preset.fx||defaults().fx,
    activePresetName:preset.name||'Custom',
    enabled:preset.enabled!==false})
}
export function presetFromState(state,name) {
  const s=normalizeEqState(state)
  // Matches the mobile EqPreset JSON schema, retaining DSP configuration.
  return {id:'custom_'+Date.now(),name,...s}
}
export function parseEqPreset(text,fileName='Imported preset') {
  const trimmed=String(text).trim()
  if(trimmed.startsWith('{')) {
    const value=JSON.parse(trimmed)
    if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('Preset must be a JSON object')
    return {...normalizeEqState(value),name:value.name||fileName.replace(/\.(json|txt)$/i,'')}
  }
  let preampDb=0
  const bands=[]
  for(const line of trimmed.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) {
    const p=/^Preamp:\s*([+-]?\d+(?:\.\d+)?)\s*dB$/i.exec(line)
    if(p){preampDb=clamp(p[1],-24,24,0);continue}
    const m=/^Filter\s+\d+:\s+(ON|OFF)\s+([A-Z]+)\s+Fc\s+([+-]?\d+(?:\.\d+)?)\s+Hz(?:\s+Gain\s+([+-]?\d+(?:\.\d+)?)\s+dB)?\s+Q\s+([+-]?\d+(?:\.\d+)?)$/i.exec(line)
    if(!m) throw new Error('Invalid filter line: '+line)
    const type=EQ_CODE_TYPES[m[2].toUpperCase()]
    if(!type) throw new Error('Unsupported filter type: '+m[2])
    if(bands.length>=31) throw new Error('Maximum 31 parametric bands')
    bands.push({enabled:m[1].toUpperCase()==='ON',type,frequencyHz:clamp(m[3],20,20000,1000),
      gainDb:clamp(m[4],-20,20,0),q:clamp(m[5],.2,20,1)})
  }
  if(!bands.length) throw new Error('No EQ filters found')
  return {...defaults(),mode:'parametric',parametricBands:bands,preampDb,name:fileName.replace(/\.(txt|json)$/i,'')}
}
export function exportEqPresetText(state) {
  const s=normalizeEqState(state)
  const bands=s.mode==='parametric'?s.parametricBands:s.graphicGainsDb.map((gainDb,i)=>({
    enabled:true,type:'peaking',frequencyHz:EQ_FREQUENCIES[i],gainDb,q:1
  }))
  const lines=['Preamp: '+s.preampDb.toFixed(1)+' dB']
  bands.forEach((b,i)=>{
    const gain=['peaking','lowShelf','highShelf','notch'].includes(b.type)?' Gain '+b.gainDb.toFixed(1)+' dB':''
    lines.push('Filter '+(i+1)+': '+(b.enabled?'ON':'OFF')+' '+EQ_TYPE_CODES[b.type]+' Fc '+b.frequencyHz+
      ' Hz'+gain+' Q '+b.q.toFixed(3))
  })
  return lines.join('\n')
}
