import type {ChartEngineAdapter} from './types';
import {formatStudyNumber,studyId,type ChartStudy} from './chartStudies';
import type {VolumeProfileResult} from './chartVolumeProfile';
import {formatSourceChartTime} from './chartClockEvidence';

/** Read the installed owner, not a second calculator or a stale same-name study. */
export function readMatchingVolumeProfile(adapter:Pick<ChartEngineAdapter,'getVolumeProfiles'>|null|undefined,study:ChartStudy):VolumeProfileResult|null {
  try {
    const rows=adapter?.getVolumeProfiles?.().filter(row=>row.id===studyId(study))??[];
    if(rows.length!==1)return null;
    if(rows[0]!.visible!==(study.lineStyles?.[0]?.visible!==false))return null;
    const result=rows[0]!.result;
    if(result.status==='held')return result;
    const wanted=study.profileRange;
    if(!wanted || result.range.fromTime!==wanted.fromTime || result.range.toTime!==wanted.toTime || result.range.seriesIdentity!==wanted.seriesIdentity || result.range.clockAuthority!==wanted.clockAuthority || result.requestedRowCount!==(study.profileRows??32) || result.valueArea.targetPercent!==(study.profileValueAreaPercent??70))return null;
    return result;
  } catch {return null;}
}
export function describeVolumeProfile(result:VolumeProfileResult|null,study:ChartStudy):string {
  const method='Estimated uniform original OHLC high–low allocation: each selected bar’s qualified provider-reported trade units are spread uniformly through its price range. This is not measured transactions-at-price, bid/ask volume, order flow, proven shares or consolidated-market volume.';
  if(!result)return `No matching renderer aggregate is available yet. Settings were requested, but profile values and geometry are not verified. ${method}`;
  if(result.status==='held')return `Profile withheld: ${result.reason} No zero-filled or tick-volume substitute was used. ${method}`;
  const poc=result.rows[result.pocIndex];
  if(!poc||![result.totalTradeUnits,result.valueArea.low,result.valueArea.high,result.valueArea.achievedPercent,poc.low,poc.high,poc.estimatedTradeUnits].every(Number.isFinite))return `Profile aggregate is unavailable: the renderer did not return finite summary values. ${method}`;
  const price=(v:number)=>formatStudyNumber(v,'Price');
  return `Renderer aggregate for ${result.barCount} loaded selected closed observations, ${result.rowCount} price rows (${result.requestedRowCount} requested${result.rowCount!==result.requestedRowCount ? "; flat prices collapse to one row" : ""}), ${String(result.totalTradeUnits)} provider-reported trade units. Frozen range: ${formatSourceChartTime(result.range.fromTime,true,'UTC',{seconds:true})} through ${formatSourceChartTime(result.range.toTime,true,'UTC',{seconds:true})} (bar-open endpoints, inclusive). ${study.lineStyles?.[0]?.visible===false?'The profile is hidden; these are calculated values, not displayed bars.':'The installed profile is enabled; this receipt does not independently prove a painted frame.'}\nEstimated POC row: ${price(poc.low)}–${price(poc.high)}, ${formatStudyNumber(poc.estimatedTradeUnits,'Estimated allocation')} allocated trade units (rounded display). Value-area target ${result.valueArea.targetPercent}%; achieved ${formatStudyNumber(result.valueArea.achievedPercent,'Percent')}%, from ${price(result.valueArea.low)} to ${price(result.valueArea.high)}. Whole-row selection can differ from the target; the POC row is always included. ${method}\n${result.omittedFormingTail ? "One loaded forming tail is outside this closed-observation range. " : ""}${result.limitations.join(' ')}`;
}
