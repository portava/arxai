import { researchAuthority } from "@workspace/domain/investor-research";

export interface SecFact { value:number; start:string; end:string; filed:string; accession:string; concept:string; unit:string; }
const concepts: Record<string,{names:string[];unit:string}> = {
  revenue:{names:["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet"],unit:"USD"},
  grossProfit:{names:["GrossProfit"],unit:"USD"},
  netIncome:{names:["NetIncomeLoss"],unit:"USD"}, operatingIncome:{names:["OperatingIncomeLoss"],unit:"USD"},
  dilutedEps:{names:["EarningsPerShareDiluted"],unit:"USD/shares"},
};
const validDay=(s:unknown):s is string=>typeof s==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export function parseCompanyFacts(payload:unknown,asOf:string) {
  if(!payload || typeof payload!=="object")throw new Error("SEC company facts are malformed");
  const p=payload as Record<string,any>,gaap=p.facts?.["us-gaap"];
  if(!gaap || typeof gaap!=="object")throw new Error("No US GAAP company facts available");
  const series:Record<string,SecFact[]>={};
  for(const [metric,spec] of Object.entries(concepts)){
    const rows:SecFact[]=[];
    for(const name of spec.names){
      const values=gaap[name]?.units?.[spec.unit]; if(!Array.isArray(values))continue;
      for(const f of values){
        if(!f || !["10-Q","10-K","10-Q/A","10-K/A"].includes(f.form)||!validDay(f.start)||!validDay(f.end)||!validDay(f.filed)||f.end>asOf||f.filed>asOf||f.start>f.end||f.filed<f.end||!Number.isFinite(f.val)||!/^\d{10}-\d{2}-\d{6}$/.test(f.accn))continue;
        const duration=(Date.parse(f.end)-Date.parse(f.start))/86400000;
        if(!((duration>=75&&duration<=105)||(duration>=330&&duration<=380)))continue;
        rows.push({value:f.val,start:f.start,end:f.end,filed:f.filed,accession:f.accn,concept:name,unit:spec.unit});
      }
    }
    rows.sort((a,b)=>b.end.localeCompare(a.end)||b.filed.localeCompare(a.filed));series[metric]=rows;
  }
  const anchor=series.revenue[0] ?? Object.values(series).flat().sort((a,b)=>b.end.localeCompare(a.end))[0];
  if(!anchor)return {period:null,metrics:{} as Record<string,number|null>,facts:{} as Record<string,SecFact|null>,note:"No comparable quarterly or annual facts were found; missing metrics remain unknown."};
  const facts:Record<string,SecFact|null>={};
  for(const key of Object.keys(concepts))facts[key]=series[key].find(f=>f.start===anchor.start&&f.end===anchor.end)??null;
  const revenue=facts.revenue?.value;
  const metrics:Record<string,number|null>={};
  for(const key of Object.keys(concepts))metrics[key]=facts[key]?.value??null;
  metrics.grossMarginPct=revenue && revenue>0 && facts.grossProfit ? facts.grossProfit.value/revenue*100:null;
  metrics.netMarginPct=revenue && revenue>0 && facts.netIncome ? facts.netIncome.value/revenue*100:null;
  metrics.operatingMarginPct=revenue && revenue>0 && facts.operatingIncome ? facts.operatingIncome.value/revenue*100:null;
  const duration=(Date.parse(anchor.end)-Date.parse(anchor.start))/86400000;
  const prior=series.revenue.find(f=>{
    const gap=(Date.parse(anchor.end)-Date.parse(f.end))/86400000,days=(Date.parse(f.end)-Date.parse(f.start))/86400000;
    return gap>=350&&gap<=380&&Math.abs(duration-days)<=10;
  });
  metrics.revenueGrowthPct=revenue!==undefined&&prior&&prior.value>0?(revenue/prior.value-1)*100:null;
  return {period:{start:anchor.start,end:anchor.end,kind:duration<110?"QUARTER":"ANNUAL",filed:Object.values(facts).reduce((d,f)=>f&&f.filed>d?f.filed:d,anchor.filed)},metrics,facts,
    growthComparison:prior??null,
    note:"Filed historical facts, not forecasts. Margins and year-over-year growth are derived only from matching periods. Missing concepts remain unknown; no Q4 or trailing EPS is invented. Restatements may change earlier figures."};
}
export function parseSubmissions(payload:unknown,cik:string,asOf:string){
  const p=payload as any,r=p?.filings?.recent;
  if(!r||!Array.isArray(r.accessionNumber)||!Array.isArray(r.form)||!Array.isArray(r.filingDate))throw new Error("SEC submissions are malformed");
  const filings=[];
  for(let i=0;i<r.accessionNumber.length;i++){
    const accession=r.accessionNumber[i],form=r.form[i],filed=r.filingDate[i],doc=r.primaryDocument?.[i];
    if(!["8-K","8-K/A","10-Q","10-K","10-Q/A","10-K/A","13F-HR","13F-HR/A"].includes(form)||!validDay(filed)||filed>asOf||!/^\d{10}-\d{2}-\d{6}$/.test(accession)||typeof doc!=="string"||!/^[a-zA-Z0-9_.-]+$/.test(doc))continue;
    filings.push({id:accession,form,filed,reportDate:validDay(r.reportDate?.[i])?r.reportDate[i]:null,items:typeof r.items?.[i]==="string"?r.items[i]:null,
      url:`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-","")}/${doc}`});
  }
  return filings.sort((a,b)=>b.filed.localeCompare(a.filed)).slice(0,30);
}
export function createSecResearchClient(fetcher:typeof fetch=(...args)=>fetch(...args),clock=Date.now,userAgent=()=>process.env.SEC_USER_AGENT??""){
  const cache=new Map<string,{at:number;value:any}>();let busy=false,nextAt=0;
  const result=(status:string,note:string)=>({status,authority:researchAuthority,source:"SEC EDGAR",fetchedAt:null,note,filings:[],fundamentals:null});
  return async(cik:string)=>{
    if(!/^\d{1,10}$/.test(cik)||Number(cik)===0)return result("INVALID_INPUT","Enter a valid numeric CIK.");
    const key=cik.padStart(10,"0"),now=clock(),cached=cache.get(key);
    if(cached&&now>=cached.at&&now-cached.at<15*60000)return cached.value;
    const ua=userAgent().trim();
    if(!ua || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(ua)||/example\.com|you@/i.test(ua))return result("NOT_CONFIGURED","SEC_USER_AGENT needs the operator's real name and contact email. No SEC request was made.");
    if(busy || now<nextAt)return result("RATE_LIMITED","SEC research is busy or backing off. Try again later.");
    busy=true;
    try{
      async function read(path:string){
        const wait=Math.max(0,nextAt-clock());if(wait)await new Promise(r=>setTimeout(r,wait));nextAt=clock()+1000;
        const response=await fetcher(`https://data.sec.gov/${path}`,{headers:{"User-Agent":ua,Accept:"application/json"},signal:AbortSignal.timeout(12000),redirect:"error"});
        if(!response.ok){nextAt=clock()+(response.status===429?600000:60000);throw new Error(`SEC_HTTP_${response.status}`);}
        if(Number(response.headers.get("content-length"))>20_000_000)throw new Error("SEC_PAYLOAD_TOO_LARGE");
        const reader=response.body?.getReader();if(!reader)throw new Error("SEC_EMPTY_RESPONSE");
        const chunks:Uint8Array[]=[];let size=0;
        try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>20_000_000)throw new Error("SEC_PAYLOAD_TOO_LARGE");chunks.push(value);}}
        finally{await reader.cancel().catch(()=>{});}
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      const asOf=new Date(clock()).toISOString().slice(0,10);
      const submissions=await read(`submissions/CIK${key}.json`);
      if(Number(submissions.cik)!==Number(key))throw new Error("SEC_CIK_MISMATCH");
      const filings=parseSubmissions(submissions,key,asOf);
      // Institutional filers may have submissions but no XBRL facts.
      let fundamentals=null,factsNote:string|null=null;
      if(filings.some(f=>["10-K","10-Q","10-K/A","10-Q/A"].includes(f.form))){
        try{const facts=await read(`api/xbrl/companyfacts/CIK${key}.json`);if(Number(facts.cik)!==Number(key))throw new Error("SEC_CIK_MISMATCH");fundamentals=parseCompanyFacts(facts,asOf);}
        catch{factsNote="Company facts could not be read. Filings are available; fundamentals remain unavailable.";}
      }
      const value={status:factsNote?"PARTIAL":"AVAILABLE",authority:{...researchAuthority,sourceVerified:true},source:"SEC EDGAR",fetchedAt:new Date(clock()).toISOString(),
        cik:key,name:typeof submissions.name==="string"?submissions.name:null,tickers:Array.isArray(submissions.tickers)?submissions.tickers:[],filings,fundamentals,
        note:factsNote??"Historical public filings. Publication is not a trading signal. Only the recent submissions block is covered; older filing archives are not exhausted."};
      cache.set(key,{at:clock(),value});if(cache.size>32)cache.delete(cache.keys().next().value!);return value;
    }catch{nextAt=Math.max(nextAt,clock()+60000);return result("UNAVAILABLE","SEC could not be read. No filings or metrics are fabricated.");}
    finally{busy=false;}
  };
}
export const getSecResearch=createSecResearchClient();
