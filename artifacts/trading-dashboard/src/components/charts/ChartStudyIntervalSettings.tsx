import {CHART_INTERVALS,parseChartInterval,isChartInterval,chartIntervalSeconds} from '@/lib/chart-engine/chartIntervals';
import {studyVisibleAtInterval,type ChartStudy} from '@/lib/chart-engine/chartStudies';
interface Props {config:ChartStudy;label:string;timeframe?:string;onChange:(patch:Partial<ChartStudy>)=>void}
export function ChartStudyIntervalSettings({config,label,timeframe,onChange}:Props){
 const current=parseChartInterval(timeframe),known=isChartInterval(current);
 const selected=config.visibleIntervals??CHART_INTERVALS;
 const quick=(kind:'only'|'above'|'below')=>{if(!known)return;const seconds=chartIntervalSeconds(current)!;onChange({visibleIntervals:CHART_INTERVALS.filter(interval=>kind==='only'?interval===current:kind==='above'?chartIntervalSeconds(interval)!>=seconds:chartIntervalSeconds(interval)!<=seconds)});};
 return <details className="mt-3" aria-label={`${label} Interval visibility`}>
  <summary className="cursor-pointer text-zinc-300">Visibility on intervals</summary>
  <p className="my-2 text-[11px] text-zinc-400">{timeframe?(studyVisibleAtInterval(config,timeframe)?`Shown on ${current??timeframe}. `:`Hidden on ${current??timeframe}. `):''}Display only: hidden studies retain their calculated values and can feed linked studies. A hidden source still owns a shared pane’s scale. This does not calculate another timeframe.</p>
  <div className="mb-2 flex flex-wrap gap-2">
   {(['All intervals','Hide on all','Only current','Current and above','Current and below'] as const).map((name,index)=><button key={name} type="button" className="rounded border border-zinc-700 px-2 py-1 text-xs disabled:opacity-40" aria-label={`${label} ${name}`} disabled={index>=2&&!known} onClick={()=>index===0?onChange({visibleIntervals:undefined}):index===1?onChange({visibleIntervals:[]}):quick(index===2?'only':index===3?'above':'below')}>{name}</button>)}
  </div>
  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{CHART_INTERVALS.map(interval=><label key={interval} className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`${label} Visible on ${interval}`} checked={selected.includes(interval)} onChange={e=>onChange({visibleIntervals:CHART_INTERVALS.filter(item=>item===interval?e.target.checked:selected.includes(item))})}/>{interval}</label>)}</div>
 </details>;
}
