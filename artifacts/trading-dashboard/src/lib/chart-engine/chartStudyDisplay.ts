import {formatSourceChartTime} from './chartClockEvidence';
import {selectVwapAnchor} from './chartVwapAnchor';
import {studyIntervalSuffix,studyLabel,type ChartStudy,type VwapAnchor} from './chartStudies';
import type {ChartEngineAdapter,ChartEngineCandle} from './types';

export function formatSavedVwapAnchor(anchor:VwapAnchor,adapter:Pick<ChartEngineAdapter,'getVwapAnchorEvidence'>|null|undefined):string {
 let qualified=false;
 try {qualified=adapter?.getVwapAnchorEvidence?.(anchor).utcQualified===true;}catch{/* Unknown evidence stays unqualified. */}
 return formatSourceChartTime(anchor.time,qualified,'UTC',{seconds:true});
}
/** Display wording is deliberately separate from the canonical lookup label. */
function baseStudyDisplayLabel(study:ChartStudy,adapter:Pick<ChartEngineAdapter,'getVwapAnchorEvidence'>|null|undefined,detailedProfile=false,studies?:readonly ChartStudy[]):string {
 if(study.kind==='volume_profile'&&study.profileRange){
  if(!detailedProfile)return `Estimated volume profile · ${study.profileRows??32} rows · ${study.profileValueAreaPercent??70}% value-area target · provider trade units`;
  const range=study.profileRange;
  const start=formatSavedVwapAnchor({kind:'observed_bar',time:range.fromTime,seriesIdentity:range.seriesIdentity},adapter);
  const end=formatSavedVwapAnchor({kind:'observed_bar',time:range.toTime,seriesIdentity:range.seriesIdentity},adapter);
  return `Estimated volume profile · uniform OHLC allocation · ${study.profileRows??32} rows · ${study.profileValueAreaPercent??70}% value-area target · frozen ${start} through ${end} · provider trade units`;
 }
 if(study.kind==='vwap'&&study.vwapAnchor)return `VWAP · ${study.source??'hlc3'} · observed-bar anchor ${formatSavedVwapAnchor(study.vwapAnchor,adapter)}`;
 return studyLabel(study,studies);
}
export function studyDisplayLabel(study:ChartStudy,adapter:Pick<ChartEngineAdapter,'getVwapAnchorEvidence'>|null|undefined,detailedProfile=false,studies?:readonly ChartStudy[],timeframe?:string):string {
 return baseStudyDisplayLabel(study,adapter,detailedProfile,studies)+(timeframe?studyIntervalSuffix(study,timeframe):'');
}
export function formatObservedBarChoice(bar:ChartEngineCandle,adapter:Pick<ChartEngineAdapter,'getVwapAnchorEvidence'>|null|undefined):string {
 const selection=selectVwapAnchor([bar],bar.time);
 return selection.anchor ? formatSavedVwapAnchor(selection.anchor,adapter) : formatSourceChartTime(bar.time,false,'UTC',{seconds:true});
}
