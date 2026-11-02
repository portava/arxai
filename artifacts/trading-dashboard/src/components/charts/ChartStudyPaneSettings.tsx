import {useEffect,useState} from 'react';
import {studyDefinition,type ChartStudy,type StudyReferenceLevel} from '@/lib/chart-engine/chartStudies';
import {validatePreferences} from '@/lib/chart-engine/chartWorkspace';
const field='h-8 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100';
const button='rounded border border-zinc-700 px-2 py-1 text-xs';
interface Props {config:ChartStudy;label:string;onChange:(change:Partial<ChartStudy>)=>void}
/** Draft numeric fields commit together; invalid limits never remove a study. */
export function ChartStudyPaneSettings({config,label,onChange}:Props){
 const [minimum,setMinimum]=useState(''),[maximum,setMaximum]=useState(''),[error,setError]=useState('');
 const scaleKey=JSON.stringify(config.paneScale);
 useEffect(()=>{setMinimum(config.paneScale?.mode==='fixed'?String(config.paneScale.min):'');setMaximum(config.paneScale?.mode==='fixed'?String(config.paneScale.max):'');setError('');},[scaleKey]);
 const levels:StudyReferenceLevel[]=config.referenceLevels??(studyDefinition(config.kind).levels??[]).map(value=>({value}));
 const change=(patch:Partial<ChartStudy>)=>{
  if(validatePreferences({studies:[{...config,...patch}]}).studies.length!==1){setError('Use finite values, with the maximum greater than the minimum. Existing settings are unchanged.');return false;}
  setError('');onChange(patch);return true;
 };
 const edit=(index:number,patch:Partial<StudyReferenceLevel>)=>change({referenceLevels:levels.map((level,i)=>i===index?{...level,...patch}:level)});
 return <details className="mt-3" aria-label={`${label} Pane controls`}>
  <summary className="cursor-pointer text-zinc-300">Pane scale and reference levels</summary>
  <p className="my-2 text-[11px] text-zinc-400">Display only. Guides do not change indicator calculations, AI rules or trade thresholds. Linked overlays share this pane’s scale. Fixed limits can hide values; the data window retains them.</p>
  <div className="flex flex-wrap items-center gap-2">
   <span className="text-xs">{config.paneScale?.mode==='fixed'?`Fixed: ${config.paneScale.min} to ${config.paneScale.max}`:config.paneScale?.mode==='auto'?'Auto scale':'Study default scale'}</span>
   <button type="button" className={button} aria-label={`${label} Auto scale`} onClick={()=>change({paneScale:{mode:'auto'}})}>Auto scale</button>
   <button type="button" className={button} aria-label={`${label} Default scale`} onClick={()=>change({paneScale:undefined})}>Study default</button>
   <label className="flex items-center gap-1">Min<input className={`${field} w-24`} aria-label={`${label} Scale minimum`} type="number" step="any" value={minimum} onChange={e=>setMinimum(e.target.value)}/></label>
   <label className="flex items-center gap-1">Max<input className={`${field} w-24`} aria-label={`${label} Scale maximum`} type="number" step="any" value={maximum} onChange={e=>setMaximum(e.target.value)}/></label>
   <button type="button" className={button} aria-label={`${label} Apply fixed scale`} onClick={()=>{
    if(!minimum.trim()||!maximum.trim()){setError('Enter both limits. Existing settings are unchanged.');return;}
    change({paneScale:{mode:'fixed',min:Number(minimum),max:Number(maximum)}});
   }}>Apply fixed scale</button>
  </div>
  {error&&<p role="alert" className="mt-2 text-xs text-amber-300">{error}</p>}
  <div className="mt-3 space-y-2">
   {levels.map((level,index)=><div key={index} className="flex flex-wrap items-center gap-2">
    <label className="flex items-center gap-1"><input type="checkbox" aria-label={`${label} Level ${index+1} visible`} checked={level.visible!==false} onChange={e=>edit(index,{visible:e.target.checked})}/>Level {index+1}</label>
    <input key={`value-${level.value}`} className={`${field} w-24`} aria-label={`${label} Level ${index+1} value`} type="number" step="any" defaultValue={level.value} onBlur={e=>{if(!e.target.value.trim()||!Number.isFinite(Number(e.target.value))){e.target.value=String(level.value);setError('Enter a finite reference value. Existing settings are unchanged.');return;}edit(index,{value:Number(e.target.value)});}}/>
    <input className={`${field} w-36 max-w-full`} aria-label={`${label} Level ${index+1} description`} placeholder="Description" maxLength={80} value={level.label??''} onChange={e=>edit(index,{label:e.target.value})}/>
    <input type="color" className="h-8 w-9 bg-transparent" aria-label={`${label} Level ${index+1} color`} value={level.color??'#64748b'} onChange={e=>edit(index,{color:e.target.value})}/>
    <select className={field} aria-label={`${label} Level ${index+1} width`} value={level.width??1} onChange={e=>edit(index,{width:Number(e.target.value) as 1|2|3})}>{[1,2,3].map(width=><option key={width} value={width}>{width}px</option>)}</select>
    <select className={field} aria-label={`${label} Level ${index+1} style`} value={level.style??'dashed'} onChange={e=>edit(index,{style:e.target.value as StudyReferenceLevel['style']})}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select>
    <button type="button" className={button} aria-label={`${label} Remove level ${index+1}`} onClick={()=>change({referenceLevels:levels.filter((_,i)=>i!==index)})}>Remove</button>
   </div>)}
   <div className="flex flex-wrap gap-2">
    <button type="button" className={button} disabled={levels.length>=12} aria-label={`${label} Add reference level`} onClick={()=>change({referenceLevels:[...levels,{value:0}]})}>Add level</button>
    <button type="button" className={button} aria-label={`${label} Clear reference levels`} onClick={()=>change({referenceLevels:[]})}>Clear levels</button>
    <button type="button" className={button} aria-label={`${label} Default reference levels`} onClick={()=>change({referenceLevels:undefined})}>Restore default levels</button>
   </div>
  </div>
 </details>;
}
