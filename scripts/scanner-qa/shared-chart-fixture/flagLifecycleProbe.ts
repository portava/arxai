import { analyzeSmartChart } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/smartChartAnalysis";
import { findingAnnotation } from "../../../artifacts/trading-dashboard/src/components/charts/SmartChartReader";

/** Visual QA only: actual analysis, reader annotation mapping and chart adapter.
 * No app account, API, provider, model or broker is used by this entry. */
export function installFlagLifecycleProbe(Adapter:new()=>any){
 const root=document.createElement("main");root.style.cssText="padding:16px;background:#090d14;color:#e2e8f0;min-height:100vh;font:15px system-ui";
 const title=document.createElement("h1");title.textContent="Offline flag evidence — generated candles only";
 const disclaimer=document.createElement("p");disclaimer.textContent="Isolated actual chart adapter and analysis; this is not the Market Scanner page or live market data.";
 const select=document.createElement("select");select.setAttribute("aria-label","Flag scenario");select.style.cssText="background:#1e293b;color:white;padding:8px;margin:10px 0";
 for(const side of ["bull","bear"])for(const state of ["developing","confirmed","target reached","invalidated"]){const option=document.createElement("option");option.value=`${side}:${state}`;option.textContent=`${side} — ${state}`;select.append(option);}
 const chart=document.createElement("div");chart.style.cssText="width:100%;height:520px";
 const status=document.createElement("h2"),explanation=document.createElement("p"),evidence=document.createElement("p");
 root.append(title,disclaimer,select,chart,status,explanation,evidence);document.body.append(root);
 const adapter=new Adapter();adapter.init({container:chart,height:520});adapter.setFeedState({source:"offline_generated",livePriceAffordance:false});adapter.setSymbol?.("OFFLINE_FLAG");adapter.setTimeframe?.("M5");
 const render=()=>{
  const [side,state]=select.value.split(":"),extra=state==="developing"?[105.6]:state==="confirmed"?[106.2,106.3]:state==="target reached"?[106.2,113,107]:[106.2,113,105,107];
  const values=[...Array(6).fill(100),...Array.from({length:8},(_,i)=>100+i),...Array.from({length:6},(_,i)=>106.8-i*.2),...extra];
  const bars=values.map((v,i)=>{const close=(side==="bear"?220-v:v)+946000;return{time:1700000000+i*300,closeTime:1700000000+(i+1)*300,open:close,high:close+.2,low:close-.2,close,isComplete:true,isFinal:true,isForming:false};});
  const result=analyzeSmartChart({symbol:"OFFLINE_FLAG",timeframe:"M5",source:"mt5_broker",sourceIdentity:"a".repeat(64),bars,asOfMs:bars.at(-1)!.closeTime*1000,dataState:"historical"});
  const finding=result.allFindings.find(f=>f.id.startsWith(`${side}_flag`));
  adapter.setCandles(bars);adapter.setSmartAnnotation(findingAnnotation(finding??null));adapter.fitHistory();
  status.textContent=finding?`${finding.title}: ${finding.status}`:"No verified flag finding";
  explanation.textContent=finding?.explanation??result.reason??"Finding withheld.";
  evidence.textContent=finding?`Source bars: ${bars.length}; separate lines: ${finding.segments?.length??0}; first confirmation: ${finding.confirmedAt?new Date(finding.confirmedAt*1000).toISOString():"none"}.`:"";
 };
 select.addEventListener("change",render);render();
}
