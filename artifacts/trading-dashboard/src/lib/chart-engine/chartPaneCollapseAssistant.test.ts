import {it,expect} from 'vitest';
import {NativeChartStudies} from './nativeChartStudies';
import {executeStudyRequest,parseStudyRequest} from './chartStudyAssistant';
import {studyDisplayLabel} from './chartStudyDisplay';
import type {ChartStudy} from './chartStudies';
const bars=Array.from({length:80},(_,i)=>({time:1700000000+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
function fixture(){
 let studies:ChartStudy[]=[{id:'rsi',kind:'rsi',period:14,color:'#ffffff',paneCollapsed:true,visibleIntervals:[]},{id:'sma',kind:'sma',period:3,color:'#00ff00',studySource:{studyId:'rsi',channel:0}}];
 const model=new NativeChartStudies();model.setTimeframe('M15');model.setStudies(studies,bars);
 const context=()=>({studies,symbol:'TEST',timeframe:'M15',feedLabel:'Offline',adapter:{setStudies:(next:ChartStudy[])=>model.setStudies(next,bars),getVisibleCandles:()=>bars,getStudyValues:(time:number)=>model.getValues(time)},save:(next:ChartStudy[])=>{studies=next;}});
 return {model,context,studies:()=>studies};
}
it.each(['RSI','SMA'])('explicit show %s expands its actual pane owner',name=>{
 const f=fixture();const reply=executeStudyRequest(parseStudyRequest('show '+name)!,f.context());
 expect(reply).toContain('all channels shown');expect(f.model.getPaneCollapsed()).toEqual([false]);expect(f.studies()[0]!.paneCollapsed).toBe(false);
 expect(reply).not.toContain('pane collapsed');if(name==='SMA')expect(f.studies()[0]!.visibleIntervals).toEqual([]);
});
it.each(['RSI','SMA'])('explain %s preserves and discloses collapse',name=>{
 const f=fixture();const reply=executeStudyRequest(parseStudyRequest('explain '+name)!,f.context());
 expect(f.model.getPaneCollapsed()).toEqual([true]);expect(reply).toContain('pane collapsed');expect(reply).not.toContain('all channels shown');
});
it('display/export labels distinguish a collapsed source pane for linked children',()=>{
 const f=fixture();for(const study of f.studies())expect(studyDisplayLabel(study,null,false,f.studies(),'M15')).toContain('pane collapsed');
});
it('explicit linked average comparison expands only its actual owner and discloses that change',()=>{
 const f=fixture(),context=f.context();context.studies=[context.studies[0]!,...([20,50].map(period=>({id:'ema'+period,kind:'ema' as const,period,color:'#ffffff',studySource:{studyId:'rsi',channel:0}})))];
 f.model.setStudies(context.studies,bars);const reply=executeStudyRequest(parseStudyRequest('compare 20 EMA and 50 EMA')!,context);
 expect(f.model.getPaneCollapsed()).toEqual([false]);expect(reply).toContain('source panes expanded');expect(reply).not.toContain('other tools are unchanged');expect(f.studies()[0]!.visibleIntervals).toEqual([]);
});
it.each(['missing','cycle'])('a broken upstream %s does not expand or label an unrelated held pane',reason=>{
 const f=fixture(),context=f.context();context.studies[0]={...context.studies[0]!,studySource:{studyId:reason==='cycle'?'sma':'absent',channel:0}};
 f.model.setStudies(context.studies,bars);expect(f.model.getRenderStudies()[0]!.paneIndex).not.toBe(f.model.getRenderStudies()[1]!.paneIndex);
 expect(studyDisplayLabel(context.studies[1]!,null,false,context.studies,'M15')).not.toContain('pane collapsed');
 executeStudyRequest(parseStudyRequest('show SMA')!,context);expect(f.studies()[0]!.paneCollapsed).toBe(true);
});
