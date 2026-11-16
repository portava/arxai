import type {ChartSupportResistanceProposal} from "./chartSupportResistance";
import {formatSourceChartTime} from "./chartClockEvidence";
import type {ChartDrawing} from "./chartWorkspace";
export type LevelRequest={action:"preview"|"explain"|"keep"|"dismiss"|"selected"|"hide_selected"|"show_selected"|"remove_selected";side?:"support"|"resistance"}|{error:string};
const family='(?:support\\s*(?:and|&|/)\\s*resistance|s/r)';
export function parseLevelRequest(text:string):LevelRequest|null {
 const input=text.trim().toLowerCase().replace(/[.!?]+$/,'').replace(/^please\s+/,'');
 const selected=input.match(/^(explain|hide|show|remove) (?:the )?selected (support|resistance|s\/r) (?:level|drawing)$/);
 if(selected)return {action:selected[1]==='explain'?'selected':`${selected[1]}_selected` as 'hide_selected'|'show_selected'|'remove_selected',...(selected[2]!=='s/r'?{side:selected[2] as 'support'|'resistance'}:{})};
 if(new RegExp(`^(?:show|add|apply|draw)(?: me)? (?:automatic )?${family}(?: (?:on|to) (?:this|the current) chart)?$`).test(input))return {action:'preview'};
 if(new RegExp(`^(?:explain|what (?:is|are)|what does) ${family}(?: (?:tell|show) me)?(?: about (?:this|the current) chart)?$`).test(input))return {action:'explain'};
 if(new RegExp(`^keep (?:the )?${family}(?: (?:preview|levels))?$`).test(input))return {action:'keep'};
 if(new RegExp(`^(?:hide|dismiss|remove) (?:the )?${family} preview$`).test(input))return {action:'dismiss'};
 if(new RegExp(family).test(input)||/selected (?:support|resistance) (?:level|drawing)/.test(input))return {error:'Chart not changed. Try “show support and resistance”, “keep support and resistance” or “explain selected support level”. Additional assets, periods and actions are not silently applied.'};
 return null;
}
const stamp=(n:number)=>formatSourceChartTime(n,false,'UTC',{seconds:true});
export function explainLevelProposal(p:ChartSupportResistanceProposal,state:'prepared'|'shown'|'hidden'):string {
 return `Support/resistance candidates ${state==='shown'?'are applied':state==='hidden'?'are hidden':'are prepared; visibility is not confirmed yet'} on the selected ${p.symbol} ${p.timeframe} chart. ${p.levels.map(l=>`${l.side}: ${l.price}, pivot at ${stamp(l.pivotTime)}, knowable after ${stamp(l.confirmedAt)}; ${l.laterCloseCrossings} subsequent observed closes beyond the level`).join('. ')}. Reference closed price ${p.referenceClose.price} at ${stamp(p.referenceClose.time)}. Source ${p.source}, identity ${p.sourceIdentity}; ${p.closedBars} closed observations from ${stamp(p.windowFrom)} to ${stamp(p.windowTo)}. ${p.note} Source timestamps are not independently qualified as UTC. Keep levels and edit creates your own adjustable horizontal annotations; candidates are not saved automatically. No trade was sent.`;
}
export function explainKeptLevel(d:ChartDrawing,symbol:string,timeframe:string):string {
 const p=d.pivotLevelOrigin!;
 return `Selected manual ${p.level.side} annotation on ${symbol} ${timeframe}${d.hidden?' (hidden)':''}: current price ${d.start.price}. Your editable anchor is distinct from the archived original ${p.level.price} at ${stamp(p.level.pivotTime)}, confirmed ${stamp(p.level.confirmedAt)}, captured reference close ${p.referenceClose.price} at ${stamp(p.referenceClose.time)}; source ${p.source}, identity ${p.sourceIdentity}. The archived pivot is not revalidated as a current reading. No level was changed and no trade was sent.`;
}
type Handler=(request:LevelRequest)=>string;let current:Handler|null=null;
export function registerChartLevelAssistant(handler:Handler):()=>void {current=handler;return()=>{if(current===handler)current=null;};}
export function requestChartLevels(text:string):string|null {const request=parseLevelRequest(text);if(!request)return null;if('error'in request)return request.error;return current?current(request):'Select a ready Smart Chart with “Use chart with assistant” before showing levels. No other pane was substituted and no trade was sent.';}
