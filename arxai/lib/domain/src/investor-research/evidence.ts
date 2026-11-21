import { alertPreviewSchema, disclosureSchema, holdingsDisclosureSchema, lotPreviewSchema, researchAuthority, screenSchema } from "./contracts.js";
function sourceUrl(value:string, kind:"sec"|"house") {
  const u=new URL(value);const host=kind==="sec"?"www.sec.gov":"disclosures-clerk.house.gov";
  if(u.protocol!=="https:" || u.hostname!==host || u.username || u.password)throw new Error(`Expected a primary ${kind} source URL`);
  return u.href;
}
export function screenCompanies(raw:unknown){
  const p=screenSchema.parse(raw);
  return {authority:researchAuthority,rows:p.companies.map(c=>{
    const unavailable=c.periodKind==="UNKNOWN" || c.periodEnd>p.asOf || c.filed>p.asOf || c.filed<c.periodEnd;
    const checks=p.rules.map(r=>{
      const value=c.metrics[r.metric];const known=!unavailable && typeof value==="number" && Number.isFinite(value);
      return {...r,actual:known?value:null,status:!known?"UNKNOWN":(r.op===">="?value>=r.value:value<=r.value)?"PASS":"FAIL"};
    });
    return {symbol:c.symbol,periodKind:c.periodKind,periodEnd:c.periodEnd,filed:c.filed,sourceUrl:sourceUrl(c.sourceUrl,"sec"),checks,
      status:checks.some(r=>r.status==="UNKNOWN")?"INSUFFICIENT_DATA":checks.every(r=>r.status==="PASS")?"MATCHES_FILTERS":"DOES_NOT_MATCH"};
  }),note:"A filter match is not a buy signal, probability, or measured edge. Missing data never passes."};
}
export function previewLots(raw:unknown){
  const p=lotPreviewSchema.parse(raw);let remaining=p.shares;
  const lots=p.lots.filter(l=>l.symbol===p.symbol);
  if(lots.some(l=>l.acquired>p.saleDate))throw new Error("A lot cannot be acquired after the sale date");
  lots.sort(p.method==="FIFO"?(a,b)=>a.acquired.localeCompare(b.acquired)||a.id.localeCompare(b.id):(a,b)=>b.totalBasis/b.shares-a.totalBasis/a.shares||a.id.localeCompare(b.id));
  const selected=[];
  for(const l of lots){if(remaining<=1e-10)break;const shares=Math.min(remaining,l.shares),basis=l.totalBasis*shares/l.shares,proceeds=p.price*shares;
    selected.push({id:l.id,acquired:l.acquired,shares,basis,proceeds,gain:proceeds-basis});remaining-=shares;}
  if(remaining>1e-8)throw new Error("Insufficient documented lots; missing basis cannot be invented");
  return {authority:researchAuthority,method:p.method,selected,estimatedGain:selected.reduce((s,l)=>s+l.gain,0),
    note:"Cost-basis arithmetic only, not tax advice or a tax bill. Fees, jurisdiction, holding-period treatment, corporate actions, wash-sale rules and other accounts are not evaluated. Lot selection is not sent to a broker."};
}
export function analyzeDisclosures(raw:unknown){
  const p=disclosureSchema.parse(raw);
  if(new Set(p.rows.map(r=>r.id)).size!==p.rows.length)throw new Error("Each disclosure transaction needs a unique row ID");
  return {authority:researchAuthority,rows:p.rows.map(r=>{
    if(r.filed>p.asOf || r.tradeDate>r.filed || r.amountMax!==null && r.amountMax<r.amountMin)throw new Error("Invalid disclosure dates or amount range");
    return {...r,sourceUrl:sourceUrl(r.sourceUrl,"house"),disclosureDelayDays:(Date.parse(r.filed)-Date.parse(r.tradeDate))/86400000,
      eligibleForStockResearch:r.assetType==="shares"&&r.symbol!==null};
  }),note:"User-supplied transcription of public disclosures, not independently verified PDF extraction. Amounts remain ranges; owner and options are preserved. Filing delay is not proof of a legal violation or a prediction."};
}
export function analyzeHoldingsDisclosure(raw:unknown){
  const p=holdingsDisclosureSchema.parse(raw);
  if(p.periodEnd>p.filed || p.filed>p.asOf)throw new Error("Disclosure dates cannot be future or reversed");
  if(new Set(p.rows.map(r=>r.id)).size!==p.rows.length)throw new Error("Duplicate filing row IDs");
  const grouped=new Map<string,number>(),excluded=p.rows.filter(r=>r.securityType!=="shares" || !r.symbol);
  for(const r of p.rows)if(r.securityType==="shares"&&r.symbol)grouped.set(r.symbol,(grouped.get(r.symbol)??0)+r.value);
  const total=[...grouped.values()].reduce((s,v)=>s+v,0);
  return {authority:researchAuthority,filer:p.filer,periodEnd:p.periodEnd,filed:p.filed,sourceUrl:sourceUrl(p.sourceUrl,"sec"),
    ageDays:(Date.parse(p.asOf)-Date.parse(p.periodEnd))/86400000,
    holdings:[...grouped].map(([symbol,value])=>({symbol,value,weight:total>0?value/total*100:null})).sort((a,b)=>b.value-a.value),excluded,
    note:"Weights describe the supplied reported long-share rows, not current holdings or the whole fund. Cash, shorts, unreported assets and subsequent trades are unknown. Ticker mappings and filing units must be verified before using targets."};
}
export function previewPriceAlerts(raw:unknown){
  const p=alertPreviewSchema.parse(raw),now=Date.parse(p.now);
  if(new Set(p.rules.map(r=>r.id)).size!==p.rules.length || new Set(p.observations.map(r=>r.symbol)).size!==p.observations.length)throw new Error("Duplicate alert IDs or quote symbols");
  return {authority:researchAuthority,rows:p.rules.map(r=>{
    const q=p.observations.find(q=>q.symbol===r.symbol),age=q?now-Date.parse(q.asOf):Infinity;
    const readable=q && age>=-60000 && age<=15*60000;
    return {id:r.id,symbol:r.symbol,status:r.alreadyTriggered?"ALREADY_TRIGGERED":!readable?"NOT_CHECKED":(r.direction==="above"?q.price>=r.threshold:q.price<=r.threshold)?"TRIGGERED":"NOT_TRIGGERED",
      source:q?.source??null,asOf:q?.asOf??null,delayed:q?.delayed??null};
  }),note:"One-shot alert preview from supplied quotes. No background watch was created. A triggered price alert is not an order or prediction; existing Alerts handles persistent monitoring."};
}
