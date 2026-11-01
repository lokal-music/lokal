import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronDown, ChevronUp, Download, FolderOpen, Headphones, Plus, RotateCcw, Save, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react'
import Modal from './Modal'
import { EQ_FREQUENCIES, EQ_PRESETS, EQ_TYPES, clamp, defaults, loadEqState, saveEqState, applyPreset, parseEqPreset, presetFromState, exportEqPresetText } from '../audio/equalizerConfig.mjs'
import { storeImpulseFile, clearImpulseFile } from '../audio/equalizerGraph.mjs'

const CUSTOM_PRESETS='lokal-eq-custom-presets'
const BAND_LABELS=['32','64','125','250','500','1k','2k','4k','8k','16k']
const css={
  panel:'rounded-xl border border-border/70 bg-card/60 p-4 sm:p-5',
  input:'w-full min-w-0 rounded-lg border border-border bg-elevated px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60',
  button:'rounded-lg border border-border bg-card px-3 py-2 text-xs text-white hover:bg-white/10 transition-colors',
  muted:'text-xs text-muted',
}
function loadCustom(){
  try{const saved=JSON.parse(localStorage.getItem(CUSTOM_PRESETS)||'[]');return Array.isArray(saved)?saved:[]}catch{return []}
}
const numberLabel=(x,unit='dB')=>(x>0?'+':'')+Number(x).toFixed(1)+' '+unit
function EqSlider({label,value,min,max,step=.1,onChange,unit='dB',disabled=false}){
  return <label className="flex min-w-0 flex-col gap-2">
    <span className="flex items-center justify-between gap-2 text-xs"><span className="text-muted">{label}</span><strong className="tabular-nums font-normal text-white">{numberLabel(value,unit)}</strong></span>
    <input aria-label={label} type="range" className="w-full accent-accent" disabled={disabled} min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} />
  </label>
}
function EqToggle({label,checked,onChange}){
  return <label className="inline-flex items-center gap-2 text-xs text-white cursor-pointer">
    <input type="checkbox" className="accent-accent" checked={checked} onChange={e=>onChange(e.target.checked)} /> {label}
  </label>
}
function SectionTitle({children,side}){
  return <div className="mb-4 flex items-center justify-between gap-2"><h3 className="font-display text-sm font-semibold text-white">{children}</h3>{side}</div>
}
function downloadText(name,body,mime){
  const url=URL.createObjectURL(new Blob([body],{type:mime}))
  const a=document.createElement('a');a.href=url;a.download=name;a.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
function ResponsePreview({state}){
  const path=useMemo(()=>{
    const bands=state.mode==='graphic'
      ?state.graphicGainsDb.map((gain,i)=>({frequencyHz:EQ_FREQUENCIES[i],gainDb:gain,enabled:true,q:1}))
      :state.parametricBands
    const width=720,height=132
    const xhz=x=>20*Math.pow(1000,x/width)
    const rows=[]
    for(let x=0;x<=width;x+=4){
      const f=xhz(x), lf=Math.log2(f)
      let y=state.enabled?state.preampDb:0
      if(state.enabled){
        for(const b of bands){
          if(!b.enabled)continue
          // Smooth preview of each band's contribution. Filter processing is
          // performed by the Web Audio biquads, not by this visual estimation.
          const spread=b.q?Math.max(.16,1/b.q):1
          const distance=(lf-Math.log2(b.frequencyHz))/spread
          const weight=b.type==='lowShelf' ? 1/(1+Math.exp(distance*3))
            :b.type==='highShelf'?1/(1+Math.exp(-distance*3))
            :Math.exp(-.5*distance*distance)
          y+=(b.gainDb||0)*weight*(state.mode==='graphic'?.72:1)
        }
        y+=state.bassDb/(1+Math.exp((lf-Math.log2(120))*3))
        y+=state.midDb*Math.exp(-.5*Math.pow((lf-Math.log2(1000))/1.6,2))
        y+=state.trebleDb/(1+Math.exp(-(lf-Math.log2(6500))*3))
      }
      rows.push((x===0?'M':'L')+x+' '+Math.max(2,Math.min(height-2,height/2-y*2.4)).toFixed(2))
    }
    return rows.join(' ')
  },[state])
  return <div className="relative rounded-xl border border-border/70 bg-black/20 p-3">
    <div className="flex justify-between text-[10px] text-muted mb-2"><span>+24 dB</span><span>Frequency response preview</span><span>−24 dB</span></div>
    <svg viewBox="0 0 720 132" preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Approximate equalizer response curve">
      {[33,66,99].map(y=><line key={y} x1="0" x2="720" y1={y} y2={y} stroke="currentColor" strokeOpacity=".14" strokeDasharray={y===66?'':'3 5'} />)}
      {[70,180,290,400,510,620].map(x=><line key={x} x1={x} x2={x} y1="0" y2="132" stroke="currentColor" strokeOpacity=".08" />)}
      <path d={path} fill="none" stroke="#e8ff57" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
    </svg>
    <div className="mt-1 flex justify-between text-[10px] text-muted"><span>20 Hz</span><span>100 Hz</span><span>1 kHz</span><span>10 kHz</span><span>20 kHz</span></div>
  </div>
}
export default function EqualizerModal({open,onClose,onChange}){
  const [state,setState]=useState(()=>loadEqState())
  const [advanced,setAdvanced]=useState(false)
  const [presetsOpen,setPresetsOpen]=useState(false)
  const [custom,setCustom]=useState(loadCustom)
  const [query,setQuery]=useState('')
  const [catalog,setCatalog]=useState(null)
  const [autoeqOpen,setAutoeqOpen]=useState(false)
  const [loadingCatalog,setLoadingCatalog]=useState(false)
  const [message,setMessage]=useState('')
  const fileRef=useRef(null)
  const irRef=useRef(null)
  useEffect(()=>{if(open){const latest=loadEqState();setState(latest);setMessage('')}},[open])
  const change=(next)=>{
    setState(previous=>{
      const updated=typeof next==='function'?next(previous):{...previous,...next}
      const saved=saveEqState(updated)
      onChange?.(saved)
      return saved
    })
  }
  const nested=(section,key,value)=>change(previous=>({...previous,[section]:{...previous[section],[key]:value}}))
  const saveCustom=()=>{
    const name=window.prompt('Preset name',state.activePresetName||'My preset')
    if(!name?.trim())return
    const preset=presetFromState(state,name.trim())
    const next=[...custom.filter(p=>p.name!==preset.name),preset]
    setCustom(next);localStorage.setItem(CUSTOM_PRESETS,JSON.stringify(next))
    setMessage('Preset saved');change({...state,activePresetName:preset.name})
  }
  const importFile=async(file)=>{
    if(!file)return
    try{
      const preset=parseEqPreset(await file.text(),file.name)
      change(applyPreset(state,preset));setMessage('Imported '+preset.name)
    }catch(err){setMessage(err.message||'Could not import preset')}
  }
  const exportFile=format=>{
    const name=(state.activePresetName||'equalizer_preset').replace(/[^a-z0-9_-]+/gi,'_')
    if(format==='json')downloadText(name+'.json',JSON.stringify(presetFromState(state,name),null,2),'application/json')
    else downloadText(name+'.txt',exportEqPresetText(state),'text/plain')
  }
  const loadAutoeq=async()=>{
    setAutoeqOpen(true)
    if(catalog||loadingCatalog)return
    setLoadingCatalog(true)
    try{
      const data=(await import('../audio/autoeqCatalog.json')).default
      if(!Array.isArray(data))throw new Error('Invalid AutoEQ catalog')
      setCatalog(data)
    }catch(e){setMessage('AutoEQ catalog: '+e.message)}finally{setLoadingCatalog(false)}
  }
  const autoeqMatches=useMemo(()=>{
    if(!catalog)return []
    const tokens=query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return catalog.filter(e=>tokens.every(t=>(e.b+' '+e.m).toLowerCase().includes(t))).slice(0,60)
  },[catalog,query])
  const pickAutoeq=entry=>{
    change(applyPreset(state,{name:entry.b+' '+entry.m,enabled:true,mode:'parametric',preampDb:entry.pa,
      parametricBands:entry.g.map(b=>({frequencyHz:b[0],gainDb:b[1],q:b[2],
        type:({PK:'peaking',LS:'lowShelf',HS:'highShelf',LP:'lowPass',HP:'highPass',BP:'bandPass',NO:'notch',AP:'allPass'})[b[3]]||'peaking',enabled:true}))}))
    setAutoeqOpen(false);setMessage('AutoEQ applied: '+entry.b+' '+entry.m)
  }
  const loadImpulse=async(file)=>{
    if(!file)return
    try{
      const bytes=await file.arrayBuffer()
      const ctx=new (window.AudioContext||window.webkitAudioContext)()
      try {await ctx.decodeAudioData(bytes.slice(0))} finally {await ctx.close()}
      await storeImpulseFile(file)
      // Save the impulse details together so reloading remains atomic.
      change(previous=>({...previous,convolver:{...previous.convolver,irPath:'indexeddb:active',
        irDisplayName:file.name,enabled:true}}))
      window.dispatchEvent(new Event('lokal:eq-ir-changed'))
      setMessage('Impulse response loaded: '+file.name)
    }catch(e){setMessage('Could not load impulse response: '+e.message)}
  }
  const removeImpulse=async()=>{
    await clearImpulseFile();change(previous=>({...previous,convolver:{...previous.convolver,
      irPath:null,irDisplayName:null,enabled:false}}))
    window.dispatchEvent(new Event('lokal:eq-ir-changed'))
  }
  const updateBand=(i,key,value)=>change(previous=>({...previous,activePresetName:null,
    parametricBands:previous.parametricBands.map((b,j)=>j===i?{...b,[key]:value}:b)}))
  const addBand=()=>change(previous=>({...previous,activePresetName:null,
    parametricBands:[...previous.parametricBands,{enabled:true,frequencyHz:1000,gainDb:0,q:1,type:'peaking'}]}))
  return <Modal open={open} onClose={onClose} title="Equalizer" width="max-w-5xl">
    <div className="flex flex-col gap-4 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-display text-white">Shape your sound</h2><p className={css.muted}>{state.activePresetName||'Custom'} · Graphic and parametric EQ with advanced audio processing</p></div>
        <EqToggle label="Enable equalizer" checked={state.enabled} onChange={value=>change({enabled:value})}/>
      </div>
      {message&&<p role="status" className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-white">{message}</p>}
      <div className={css.panel}><EqSlider label="Preamp" value={state.preampDb} min={-24} max={24} step={.5}
        onChange={v=>change({preampDb:v,activePresetName:null})}/></div>
      <div className={css.panel}>
        <SectionTitle side={<button className={css.button} onClick={()=>setPresetsOpen(p=>!p)}><FolderOpen size={14} className="inline mr-1"/> Browse presets {presetsOpen?<ChevronUp size={13} className="inline"/>:<ChevronDown size={13} className="inline"/>}</button>}>Presets and AutoEQ</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <button className={css.button} onClick={loadAutoeq}><Headphones size={14} className="inline mr-1"/> AutoEQ headphones</button>
          <button className={css.button} onClick={saveCustom}><Save size={14} className="inline mr-1"/> Save preset</button>
          <button className={css.button} onClick={()=>fileRef.current?.click()}><Upload size={14} className="inline mr-1"/> Import JSON / TXT</button>
          <button className={css.button} onClick={()=>exportFile('json')}><Download size={14} className="inline mr-1"/> Export JSON</button>
          <button className={css.button} onClick={()=>exportFile('txt')}>Export TXT</button>
          <input ref={fileRef} hidden type="file" accept=".json,.txt" onChange={e=>{importFile(e.target.files?.[0]);e.target.value=''}}/>
        </div>
        {presetsOpen&&<div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{EQ_PRESETS.map(p=><button key={p.id} className={css.button} onClick={()=>change(applyPreset(state,{...defaults(),...p,mode:'graphic'}))}>{p.name}</button>)}</div>
          {custom.length>0&&<div><p className="mb-2 text-xs text-muted">Saved presets</p>
            <div className="flex flex-wrap gap-2">{custom.map(p=><div key={p.id} className="flex items-center rounded-lg border border-border overflow-hidden"><button className="p-2 text-xs text-white hover:bg-white/10" onClick={()=>change(applyPreset(state,p))}>{p.name}</button><button aria-label={'Delete '+p.name} className="p-2 text-muted hover:text-red-400" onClick={()=>{const next=custom.filter(x=>x.id!==p.id);setCustom(next);localStorage.setItem(CUSTOM_PRESETS,JSON.stringify(next))}}><X size={13}/></button></div>)}</div>
          </div>}
        </div>}
        {autoeqOpen&&<div className="mt-4 space-y-2 rounded-xl border border-border bg-elevated/50 p-3">
          <div className="flex items-center justify-between"><strong className="text-xs text-white">AutoEQ headphone profiles</strong><button onClick={()=>setAutoeqOpen(false)} aria-label="Close AutoEQ"><X size={14}/></button></div>
          <input className={css.input} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search brand or model" aria-label="Search AutoEQ profiles"/>
          {loadingCatalog&&<p className={css.muted}>Loading headphone profiles…</p>}
          <div className="max-h-44 overflow-y-auto space-y-1">{autoeqMatches.map(e=><button key={e.id} className="flex w-full justify-between gap-2 rounded-lg p-2 text-left text-xs text-white hover:bg-white/10" onClick={()=>pickAutoeq(e)}><span>{e.b} {e.m}</span><span className="text-muted">{e.t}</span></button>)}</div>
          {!loadingCatalog&&catalog&&autoeqMatches.length===0&&<p className={css.muted}>No matching profiles.</p>}
        </div>}
      </div>
      <ResponsePreview state={state}/>
      {state.mode==='graphic'
        ?<div className={css.panel}>
          <SectionTitle side={<button className={css.button} onClick={()=>change({graphicGainsDb:Array(10).fill(0),preampDb:0,activePresetName:null})}><RotateCcw size={13} className="inline mr-1"/> Reset bands</button>}>10-band graphic EQ</SectionTitle>
          <div className="flex items-end justify-between gap-1 overflow-x-auto pb-1">{BAND_LABELS.map((name,i)=><div key={name} className="flex min-w-[41px] flex-1 flex-col items-center gap-2">
            <span className="text-[10px] tabular-nums text-white">{state.graphicGainsDb[i]>0?'+':''}{state.graphicGainsDb[i].toFixed(1)}</span>
            <input aria-label={name+' gain'} className="accent-accent" type="range" min="-20" max="20" step=".5" value={state.graphicGainsDb[i]}
              onChange={e=>change(previous=>({...previous,activePresetName:null,graphicGainsDb:previous.graphicGainsDb.map((v,j)=>j===i?Number(e.target.value):v)}))}
              style={{writingMode:'vertical-lr',direction:'rtl',height:160,width:24}}/>
            <span className="text-[10px] text-muted">{name}</span>
          </div>)}</div>
        </div>
        :<div className={css.panel}>
          <SectionTitle side={<button className={css.button} disabled={state.parametricBands.length>=31} onClick={addBand}><Plus size={14} className="inline"/> Add band ({state.parametricBands.length}/31)</button>}>Parametric EQ</SectionTitle>
          <div className="space-y-2 max-h-96 overflow-y-auto">{state.parametricBands.map((band,i)=><div key={i} className="grid grid-cols-[auto_minmax(110px,1.2fr)_minmax(65px,1fr)_minmax(60px,1fr)_minmax(60px,1fr)_auto] items-center gap-2 rounded-lg border border-border/50 bg-elevated/30 p-2">
            <input aria-label={'Band '+(i+1)+' enabled'} type="checkbox" checked={band.enabled} className="accent-accent" onChange={e=>updateBand(i,'enabled',e.target.checked)}/>
            <select aria-label={'Band '+(i+1)+' type'} className={css.input} value={band.type} onChange={e=>updateBand(i,'type',e.target.value)}>{EQ_TYPES.map(type=><option key={type} value={type}>{type}</option>)}</select>
            <label className="text-[10px] text-muted">Hz<input aria-label={'Band '+(i+1)+' frequency'} type="number" min="20" max="20000" className={css.input} value={band.frequencyHz} onChange={e=>updateBand(i,'frequencyHz',clamp(e.target.value,20,20000,1000))}/></label>
            <label className="text-[10px] text-muted">dB<input aria-label={'Band '+(i+1)+' gain'} disabled={!['peaking','lowShelf','highShelf','notch'].includes(band.type)} type="number" step=".5" min="-20" max="20" className={css.input} value={band.gainDb} onChange={e=>updateBand(i,'gainDb',clamp(e.target.value,-20,20))}/></label>
            <label className="text-[10px] text-muted">Q<input aria-label={'Band '+(i+1)+' Q'} type="number" step=".1" min=".2" max="20" className={css.input} value={band.q} onChange={e=>updateBand(i,'q',clamp(e.target.value,.2,20,1))}/></label>
            <button aria-label={'Remove band '+(i+1)} disabled={state.parametricBands.length<=1} onClick={()=>change(previous=>({...previous,parametricBands:previous.parametricBands.filter((_,j)=>i!==j)}))} className="text-muted hover:text-red-400"><Trash2 size={15}/></button>
          </div>)}</div>
        </div>}
      <button className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left text-sm text-white hover:bg-white/10" onClick={()=>setAdvanced(a=>!a)}>
        <span className="flex items-center gap-2"><SlidersHorizontal size={16}/> Advanced <span className="text-xs text-muted">Parametric EQ, tone, dynamics, FX, convolver</span></span>{advanced?<ChevronUp size={16}/>:<ChevronDown size={16}/>}
      </button>
      {advanced&&<>
        <div className={css.panel}><SectionTitle>EQ type</SectionTitle>
          <div className="flex gap-2">{['graphic','parametric'].map(mode=><button key={mode} aria-pressed={state.mode===mode} className={css.button+' '+(state.mode===mode?'border-accent/60 text-accent':'')} onClick={()=>change({mode})}>{mode==='graphic'?'Graphic (10-band)':'Parametric (up to 31 bands)'}</button>)}</div>
        </div>
        <div className={css.panel}><SectionTitle>Tone</SectionTitle><div className="grid gap-5 sm:grid-cols-3">
          {['bassDb','midDb','trebleDb'].map(key=><EqSlider key={key} label={key.replace('Db','')} value={state[key]} min={-20} max={20} step={.5} onChange={v=>change({[key]:v})}/>)}
        </div></div>
        <div className={css.panel}><SectionTitle side={<EqToggle label="Enable compressor" checked={state.compressor.enabled} onChange={v=>nested('compressor','enabled',v)}/>}>Compressor</SectionTitle>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[['thresholdDb','Threshold',-36,0,.5,'dB'],['ratio','Ratio',1,12,.1,':1'],['attackMs','Attack',1,100,1,'ms'],['releaseMs','Release',20,500,5,'ms'],['makeupGainDb','Makeup gain',-20,20,.5,'dB']].map(([key,label,min,max,step,unit])=><EqSlider key={key} label={label} value={state.compressor[key]} min={min} max={max} step={step} unit={unit} onChange={v=>nested('compressor',key,v)}/>)}
          </div>
        </div>
        <div className={css.panel}><SectionTitle side={<EqToggle label="Enable limiter" checked={state.limiter.enabled} onChange={v=>nested('limiter','enabled',v)}/>}>Limiter</SectionTitle>
          <div className="grid gap-5 sm:grid-cols-3">
            {[['inputGainDb','Input gain',0,12,.5,'dB'],['ceilingDb','Ceiling',-12,0,.1,'dB'],['releaseMs','Release',20,300,5,'ms']].map(([key,label,min,max,step,unit])=><EqSlider key={key} label={label} value={state.limiter[key]} min={min} max={max} step={step} unit={unit} onChange={v=>nested('limiter',key,v)}/>)}
          </div>
        </div>
        <div className={css.panel}><SectionTitle side={<EqToggle label="Enable FX" checked={state.fx.enabled} onChange={v=>nested('fx','enabled',v)}/>}>Creative FX and balance</SectionTitle>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[['balance','Balance',-1,1,.05,''],['tempo','Tempo',.5,2,.01,'×'],['width','Stereo width',0,2,.05,'×'],['damp','Damping',0,1,.05,''],['filterHz','Filter',200,18000,100,'Hz'],['delayMs','Delay',10,1600,10,'ms'],['size','Size',0,1,.05,''],['mix','Wet mix',0,1,.05,''],['feedback','Feedback',0,.95,.05,'']].map(([key,label,min,max,step,unit])=><EqSlider key={key} label={label} value={state.fx[key]} min={min} max={max} step={step} unit={unit} onChange={v=>nested('fx',key,v)}/>)}
          </div>
          <p className="mt-4 text-xs text-muted">Tempo multiplies the normal playback-speed setting while preserving pitch. Desktop delay and stereo effects use Web Audio, so their algorithms differ from mobile's Rust FX.</p>
        </div>
        <div className={css.panel}><SectionTitle side={<EqToggle label="Enable convolver" checked={state.convolver.enabled} onChange={v=>nested('convolver','enabled',v)}/>}>Convolver</SectionTitle>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button className={css.button} onClick={()=>irRef.current?.click()}><Upload size={14} className="inline mr-1"/> Load impulse response</button>
            <input type="file" ref={irRef} hidden accept="audio/*,.wav,.flac" onChange={e=>{loadImpulse(e.target.files?.[0]);e.target.value=''}}/>
            {state.convolver.irDisplayName&&<><span className="text-xs text-white">{state.convolver.irDisplayName}</span><button className={css.button} onClick={removeImpulse}>Remove</button></>}
          </div>
          <EqSlider label="Convolver wet mix" value={state.convolver.mix} min={0} max={1} step={.05} unit="" onChange={v=>nested('convolver','mix',v)}/>
        </div>
      </>}
      <p className="text-xs text-muted">Changes are applied live to both playback decks and saved automatically. Audio processing is bypassed on native Dolby/bit-perfect paths that do not pass through the Web Audio graph.</p>
    </div>
  </Modal>
}
