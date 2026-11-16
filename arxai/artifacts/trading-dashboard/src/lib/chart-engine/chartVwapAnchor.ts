import type {ChartEngineCandle} from './types';
import type {ChartStudy,VwapAnchor} from './chartStudies';
import {observedTradeVolume,TRADE_VOLUME_AUTHORITY} from './chartVolume';
/** Both the settings editor and assistant use this exact observed-bar selection.
 * Never skip an ineligible first bar or silently move a saved anchor. */
export function selectVwapAnchor(bars:readonly ChartEngineCandle[],time=bars[0]?.time):{anchor:VwapAnchor;reason?:never}|{reason:string;anchor?:never} {
  const bar=bars.find(row=>row.time===time);
  const volume=observedTradeVolume(bar?.volumeEvidence);
  if(!bar||!Number.isSafeInteger(bar.time)||bar.time<=0||bar.time>=1e11||!volume)return {reason:'VWAP anchor not changed: select an actual visible original bar with qualified positive traded volume. The first visible bar was not skipped; tick counts, missing/zero or partial volume cannot supply this anchor.'};
  return {anchor:{kind:'observed_bar',time:bar.time,seriesIdentity:volume.seriesIdentity}};
}
export function prepareVwapStudy(config:ChartStudy,bars:readonly ChartEngineCandle[]):{study:ChartStudy;reason?:never}|{reason:string;study?:never} {
  if(config.kind!=='vwap'||config.vwapAnchor)return {study:config};
  const result=selectVwapAnchor(bars);
  return result.anchor?{study:{...config,vwapAnchor:result.anchor}}:{reason:result.reason};
}

/** Recheck the exact saved original bar; current feed/zone and stored metadata
 * alone must never upgrade a historical anchor's clock. */
export function vwapAnchorEvidence(anchor:VwapAnchor,bars:readonly ChartEngineCandle[]):{utcQualified:boolean;reason:string|null} {
 const matches=bars.filter(b=>b.time===anchor.time),bar=matches[0],volume=observedTradeVolume(bar?.volumeEvidence);
 const utcQualified=matches.length===1&&volume?.seriesIdentity===anchor.seriesIdentity&&bar?.profileEvidence?.finality==='closed'&&bar.profileEvidence.clockAuthority===TRADE_VOLUME_AUTHORITY;
 return {utcQualified,reason:utcQualified?null:'The saved anchor has no matching current original closed-bar clock evidence; source clock remains unverified.'};
}
