import React, { useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { readResearchCsv, csvNumber } from "@/lib/researchCsv";

type Row=Record<string,any>;
const tabs=["Company filings","Portfolio plan","Basket check","Reported holdings","Congress disclosures","Cost basis","Price alerts"] as const;
type Tab=typeof tabs[number];
const templates:Partial<Record<Tab,string>>={
  "Portfolio plan":"symbol,weight,value\n",
  "Basket check":"symbol,side,amount\n",
  "Reported holdings":"id,symbol,value,securityType\n",
  "Congress disclosures":"id,person,owner,symbol,assetType,action,tradeDate,filed,amountMin,amountMax,sourceUrl\n",
  "Cost basis":"id,symbol,acquired,shares,totalBasis\n",
  "Price alerts":"id,symbol,direction,threshold,alreadyTriggered,price,asOf,source,delayed\n",
};
function readable(value:unknown):string{
  if(value===null||value===undefined)return "Unknown";
  if(typeof value==="number")return Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:4}):"Unknown";
  if(typeof value==="boolean")return value?"Yes":"No";
  if(Array.isArray(value))return value.map(readable).join("; ")||"None";
  if(typeof value==="object")return Object.entries(value).map(([k,v])=>`${k}: ${readable(v)}`).join(" · ");
  return String(value);
}
function label(key:string){return key.replace(/([A-Z])/g," $1").replace(/^./,s=>s.toUpperCase());}
function SafeLink({url,children}:{url:string;children:React.ReactNode}){
  try{const u=new URL(url);if(u.protocol==="https:"&&!u.username&&!u.password)return <a className="underline text-primary" href={u.href} target="_blank" rel="noopener noreferrer">{children}</a>;}catch{}
  return <>{children}</>;
}
function Table({rows}:{rows:Row[]}){
  if(!rows.length)return <p className="text-sm text-muted-foreground">No rows in this result.</p>;
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{keys.map(k=><th key={k} className="border-b p-2 whitespace-nowrap">{label(k)}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{keys.map(k=><td key={k} className="border-b p-2 align-top">{(k==="url"||k==="sourceUrl")&&typeof r[k]==="string"?<SafeLink url={r[k]}>Source</SafeLink>:readable(r[k])}</td>)}</tr>)}</tbody></table></div>;
}
function Result({data}:{data:Row}){
  return <section aria-label="Research result" className="space-y-4 border-t pt-4">
    <h2 className="text-lg font-semibold">Research result</h2>
    {Object.entries(data).filter(([k])=>!["authority","note","fundamentals","filings"].includes(k)).map(([k,v])=>Array.isArray(v)?<div key={k}><h3 className="font-medium mb-2">{label(k)}</h3><Table rows={v.map(r=>typeof r==="object"?r:{value:r})}/></div>:<p key={k} className="text-sm"><strong>{label(k)}: </strong>{readable(v)}</p>)}
    {data.fundamentals&&<><p className="text-sm">Period: {readable(data.fundamentals.period)}</p><Table rows={Object.entries(data.fundamentals.metrics).map(([metric,value])=>({metric,value,...data.fundamentals.facts?.[metric]}))}/><p className="text-sm text-muted-foreground">{data.fundamentals.note}</p></>}
    {data.filings&&<Table rows={data.filings}/>}
    <p className="text-sm text-amber-500">{data.note}</p>
  </section>;
}
export default function InvestorResearch(){
  const [tab,setTab]=useState<Tab>("Company filings"),[cik,setCik]=useState(""),[result,setResult]=useState<Row|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [csv,setCsv]=useState(""),[cash,setCash]=useState(""),[buffer,setBuffer]=useState("10"),[cap,setCap]=useState("25"),[min,setMin]=useState("5"),[max,setMax]=useState("2000"),[band,setBand]=useState("5");
  const [mode,setMode]=useState("allocate"),[asOf,setAsOf]=useState(""),[symbol,setSymbol]=useState(""),[shares,setShares]=useState(""),[price,setPrice]=useState(""),[method,setMethod]=useState("FIFO");
  const [filer,setFiler]=useState(""),[period,setPeriod]=useState(""),[filed,setFiled]=useState(""),[source,setSource]=useState("");
  const [holdingCsv,setHoldingCsv]=useState(""),[companies,setCompanies]=useState<Row[]>([]),[growth,setGrowth]=useState(""),[margin,setMargin]=useState("");
  const request=useRef(0),fileRequest=useRef(0);
  function clearResult(){request.current++;setBusy(false);setResult(null);}
  function changeTab(next:Tab){request.current++;fileRequest.current++;setBusy(false);setTab(next);setResult(null);setError("");setCsv("");}
  async function run(action:string,payload?:unknown){
    const id=++request.current;setBusy(true);setError("");setResult(null);
    try{
      const response=await fetch(`/api/research/${action}`,{method:payload?"POST":"GET",credentials:"same-origin",headers:payload?{"Content-Type":"application/json"}:undefined,body:payload?JSON.stringify(payload):undefined});
      const data=await response.json();if(!response.ok)throw new Error(data.message||"Research could not be read");
      if(id===request.current)setResult(data);
      return id===request.current?data:null;
    }catch(e){if(id===request.current)setError(e instanceof Error?e.message:"Research failed");return null;}
    finally{if(id===request.current)setBusy(false);}
  }
  const field=(title:string,value:string,set:(s:string)=>void,type="text")=><label className="flex flex-col gap-1 text-sm">{title}<input type={type} value={value} onChange={e=>{set(e.target.value);clearResult();}} className="rounded border bg-background px-3 py-2 min-w-0"/></label>;
  function preview(){try{
    const rows=readResearchCsv(csv),policy={cashBufferPct:csvNumber(buffer),maxPositionPct:csvNumber(cap),minOrder:csvNumber(min),maxOrder:csvNumber(max),driftBandPct:csvNumber(band),blocked:[]};
    const snapshot=asOf?new Date(asOf).toISOString():"";
    if(tab==="Portfolio plan")void run("portfolio",{cash:csvNumber(cash),currency:"USD",asOf:snapshot,mode,policy,
      targets:rows.filter(r=>r.weight && csvNumber(r.weight)>0).map(r=>({symbol:r.symbol,weight:csvNumber(r.weight)})),holdings:rows.filter(r=>r.value&&csvNumber(r.value)>0).map(r=>({symbol:r.symbol,value:csvNumber(r.value)}))});
    if(tab==="Basket check")void run("basket",{cash:csvNumber(cash),currency:"USD",asOf:snapshot,policy,holdings:holdingCsv.trim()?readResearchCsv(holdingCsv).map(r=>({symbol:r.symbol,value:csvNumber(r.value)})):[],orders:rows.map(r=>({symbol:r.symbol,side:r.side,amount:csvNumber(r.amount)}))});
    if(tab==="Reported holdings")void run("holdings",{filer,periodEnd:period,filed,asOf:new Date().toISOString().slice(0,10),sourceUrl:source,rows:rows.map(r=>({id:r.id,symbol:r.symbol||null,value:csvNumber(r.value),securityType:r.securityType}))});
    if(tab==="Congress disclosures")void run("disclosures",{asOf:new Date().toISOString().slice(0,10),rows:rows.map(r=>({...r,symbol:r.symbol||null,amountMin:csvNumber(r.amountMin),amountMax:r.amountMax?csvNumber(r.amountMax):null}))});
    if(tab==="Cost basis")void run("lots",{symbol,shares:csvNumber(shares),price:csvNumber(price),method,saleDate:asOf,lots:rows.map(r=>({...r,shares:csvNumber(r.shares),totalBasis:csvNumber(r.totalBasis)}))});
    if(tab==="Price alerts"){
      if(rows.some(r=>!["true","false"].includes(r.delayed)||!["true","false"].includes(r.alreadyTriggered)))throw new Error("Use true or false for delayed and alreadyTriggered");
      const quoteBySymbol = new Map<string,string>();
      for (const r of rows) {
        const quote=JSON.stringify([r.price,r.asOf,r.source,r.delayed]);
        if(quoteBySymbol.has(r.symbol)&&quoteBySymbol.get(r.symbol)!==quote)throw new Error(`Conflicting price observations for ${r.symbol}`);
        quoteBySymbol.set(r.symbol,quote);
      }
      const observations=[...new Map(rows.map(r=>[r.symbol,{symbol:r.symbol,price:csvNumber(r.price),asOf:r.asOf,source:r.source,delayed:r.delayed==="true"}])).values()];
      void run("alerts",{now:new Date().toISOString(),observations,rules:rows.map(r=>({id:r.id,symbol:r.symbol,direction:r.direction,threshold:csvNumber(r.threshold),alreadyTriggered:r.alreadyTriggered==="true"}))});
    }
  }catch(e){setResult(null);setError(e instanceof Error?e.message:"Check your inputs");}}
  function downloadTemplate(){const blob=new Blob([templates[tab]??""],{type:"text/csv"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="research-template.csv";a.click();URL.revokeObjectURL(url);}
  return <main className="max-w-6xl mx-auto space-y-6 p-4">
    <header><h1 className="text-2xl font-semibold">Investor research</h1><p className="text-muted-foreground mt-2">Company filings, stock portfolio planning and disclosure analysis.</p></header>
    <div className="border-l-2 border-amber-500 pl-3 text-sm" data-testid="research-authority">Research only · Historical filings or supplied inputs · No measured prediction or execution approval. These results do not upgrade Smart Chart, Scanner or Eleanor truth labels.</div>
    <nav aria-label="Research tools" className="flex gap-2 flex-wrap">{tabs.map(t=><Button key={t} aria-pressed={tab===t} variant={tab===t?"default":"outline"} onClick={()=>changeTab(t)}>{t}</Button>)}</nav>
    {tab==="Company filings"?<section className="space-y-4">
      <p className="text-sm">Read a company or institutional filer's recent SEC submissions by CIK. Company figures remain historical; funds may have filings without operating-company fundamentals.</p>
      <div className="flex flex-wrap items-end gap-3">{field("SEC CIK",cik,setCik)}<Button disabled={busy||!/^\d{1,10}$/.test(cik)} onClick={()=>void run(`sec/${encodeURIComponent(cik)}`)}>Read SEC filings</Button><SafeLink url="https://www.sec.gov/edgar/search/">Find a CIK at SEC</SafeLink></div>
      {result?.fundamentals?.period&&result.tickers?.[0]&&<Button variant="outline" onClick={()=>{const period=result.fundamentals.period;setCompanies(c=>[...c.filter(x=>x.symbol!==result.tickers?.[0]),{symbol:result.tickers?.[0]||`CIK${Number(result.cik)}`,periodEnd:period.end,periodKind:period.kind,filed:period.filed,metrics:result.fundamentals.metrics,sourceUrl:result.filings.find((f:Row)=>f.form.startsWith("10-"))?.url||"https://www.sec.gov/edgar/search/"}]);}}>Add reported figures to screen</Button>}
      <h2 className="font-semibold">Screen reported fundamentals ({companies.length} companies)</h2>
      <p className="text-sm text-muted-foreground">Compare the same-period growth and margin figures. A match is a filter result, not a buy signal.</p>
      <div className="flex flex-wrap items-end gap-3">{field("Minimum revenue growth (%)",growth,setGrowth,"number")}{field("Minimum operating margin (%)",margin,setMargin,"number")}<Button disabled={busy||!companies.length} onClick={()=>{try{void run("screen",{companies,rules:[{metric:"revenueGrowthPct",op:">=",value:csvNumber(growth)},{metric:"operatingMarginPct",op:">=",value:csvNumber(margin)}],asOf:new Date().toISOString().slice(0,10)});}catch(e){setError(String(e));}}}>Check filters</Button></div>
    </section>:<section className="space-y-4">
      <p className="text-sm text-muted-foreground">Supply your own verified records. Imports stay in this page's memory and are not saved to your account. Values are USD stock/share amounts; FX lots, CFDs, options and leveraged contracts are not supported.</p>
      {(tab==="Portfolio plan"||tab==="Basket check")&&<div className="grid sm:grid-cols-3 gap-3">
        {field("Cash (USD)",cash,setCash,"number")}{field("Snapshot time (your local time)",asOf,setAsOf,"datetime-local")}{field("Cash buffer (%)",buffer,setBuffer,"number")}{field("Maximum position (%)",cap,setCap,"number")}{field("Minimum proposal (USD)",min,setMin,"number")}{field("Maximum proposal (USD)",max,setMax,"number")}{field("Drift band (percentage points)",band,setBand,"number")}
        {tab==="Portfolio plan"&&<label className="text-sm">Plan type<select className="block border rounded p-2 bg-background" value={mode} onChange={e=>{setMode(e.target.value);clearResult();}}><option value="allocate">Allocate cash (no existing holdings)</option><option value="rebalance">Rebalance supplied holdings</option></select></label>}
      </div>}
      {tab==="Basket check"&&<label className="block text-sm">Existing holdings (CSV: symbol,value)<textarea value={holdingCsv} onChange={e=>{setHoldingCsv(e.target.value);clearResult();}} className="block w-full border rounded bg-background p-2 mt-1" rows={3}/></label>}
      {tab==="Reported holdings"&&<div className="grid sm:grid-cols-2 gap-3">{field("Institution / filer",filer,setFiler)}{field("Holdings date",period,setPeriod,"date")}{field("Filing date",filed,setFiled,"date")}{field("SEC filing URL",source,setSource,"url")}</div>}
      {tab==="Cost basis"&&<><p className="text-sm">Cost-basis arithmetic only, not tax advice. Tax rates, wash sales and jurisdiction-specific treatment are not calculated.</p><div className="grid sm:grid-cols-3 gap-3">{field("Stock symbol",symbol,setSymbol)}{field("Shares to preview",shares,setShares,"number")}{field("Price per share (USD)",price,setPrice,"number")}{field("Proposed sale date",asOf,setAsOf,"date")}<label>Lot method<select className="block border rounded p-2 bg-background" value={method} onChange={e=>{setMethod(e.target.value);clearResult();}}><option>FIFO</option><option>HIFO</option></select></label></div></>}
      {tab==="Congress disclosures"&&<p className="text-sm">Keep each transaction's amount range, owner and instrument type. Use a unique row ID, not just a report ID. <SafeLink url="https://disclosures-clerk.house.gov/FinancialDisclosure">Open House disclosures</SafeLink></p>}
      {tab==="Price alerts"&&<p className="text-sm">Evaluate supplied quotes once. Stale quotes are not checked. Use <Link href="/alerts" className="underline">Alerts</Link> for ARX's existing monitoring.</p>}
      <p className="text-sm text-muted-foreground">{tab==="Portfolio plan" ? "One row per ticker. Weight is the relative target weight; value is the current holding in USD (leave blank when allocating cash)." : tab==="Basket check" ? "Use buy or sell for side, with amount in USD. Rows are evaluated in the supplied order." : tab==="Reported holdings" ? "Use shares, put, call or other for securityType. Convert reported values to USD; leave unmapped symbols blank." : tab==="Congress disclosures" ? "Use shares, options or other for assetType. Keep disclosed dollar bounds; leave amountMax blank for an open-ended range." : tab==="Cost basis" ? "Each lot needs a unique ID, ticker, acquisition date (YYYY-MM-DD), share count and total original basis in USD." : "Use above or below for direction; true or false for delayed and alreadyTriggered. Quote time must include a time zone."}</p>
      <div className="flex flex-wrap items-center gap-3"><Button variant="outline" onClick={downloadTemplate}>Download CSV headers</Button><label className="text-sm">Import CSV <input type="file" accept=".csv,text/csv" onChange={async e=>{const file=e.target.files?.[0],id=++fileRequest.current;if(!file)return;if(file.size>500000){setError("CSV must be smaller than 500 KB");return;}const text=await file.text();if(id===fileRequest.current){setCsv(text);clearResult();}}}/></label></div>
      <label className="block text-sm">Records (CSV)<textarea aria-label="Research records" rows={7} value={csv} onChange={e=>{setCsv(e.target.value);clearResult();}} placeholder={templates[tab]} className="block w-full rounded border bg-background p-3 mt-1 font-mono text-sm"/></label>
      <Button disabled={busy||!csv.trim()} onClick={preview}>Calculate preview</Button>
    </section>}
    {busy&&<p role="status">Reading research…</p>}{error&&<p role="alert" className="text-destructive">{error}</p>}{result&&<Result data={result}/>}
    <footer className="text-sm text-muted-foreground border-t pt-4">No proposals are submitted to a broker. The existing Risk Governor, order review and execution gates remain authoritative.</footer>
  </main>;
}
