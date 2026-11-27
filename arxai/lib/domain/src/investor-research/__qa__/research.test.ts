import { test } from "node:test";
import assert from "node:assert/strict";
import { previewPortfolio, checkResearchBasket, screenCompanies, previewLots, analyzeDisclosures, analyzeHoldingsDisclosure, previewPriceAlerts, cappedAllocation, researchAuthority } from "../index.js";
const now=Date.parse("2026-11-17T12:00:00Z"),asOf=new Date(now).toISOString();
const policy={cashBufferPct:10,maxPositionPct:25,minOrder:5,maxOrder:2000,driftBandPct:5,blocked:[]};
const targets=[{symbol:"AAPL",weight:30},{symbol:"AXP",weight:25},{symbol:"GOOGL",weight:20},{symbol:"KO",weight:15},{symbol:"BAC",weight:10}];
test("budget respects cash, caps, and deterministic cent conservation",()=>{
 const r=previewPortfolio({cash:5000,holdings:[],targets,policy,asOf,currency:"USD",mode:"allocate"},now);
 assert.equal(r.cashAfterHypotheticalFills,500);assert.equal(r.proposals.reduce((s,p)=>s+p.amount,0),4500);
 assert.ok(r.proposals.every(p=>p.amount<=1250));assert.equal(r.authority.executionAllowed,false);
});
test("allocation never exceeds cents capacity across diverse weights and caps",()=>{
 for(let n=1;n<25;n++)for(const cap of [0,1,100,10000]){
  const r=cappedAllocation(Array.from({length:n},(_,i)=>({symbol:String(i),weight:(i+1)*1.17})),12345,cap);
  assert.ok([...r.values()].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=cap));assert.ok([...r.values()].reduce((a,b)=>a+b,0)<=12345);
 }
});
test("single target leaves unallocatable cash rather than violating concentration cap",()=>{
 const r=previewPortfolio({cash:5000,holdings:[],targets:[targets[0]],policy,asOf,currency:"USD",mode:"allocate"},now);
 assert.equal(r.cashAfterHypotheticalFills,3750);assert.equal(r.proposals[0].amount,1250);
});
test("rebalance leaves untracked holdings alone and respects cumulative cash",()=>{
 const r=previewPortfolio({cash:200,holdings:[{symbol:"AAPL",value:4000},{symbol:"OTHER",value:800}],targets,policy,asOf,currency:"USD",mode:"rebalance"},now);
 assert.equal(r.untracked[0].symbol,"OTHER");assert.ok(r.proposals.every(p=>p.symbol!=="OTHER"));
 assert.ok(r.cashAfterHypotheticalFills>=r.cashBuffer);assert.equal(r.proposals[0].side,"sell");
});
test("duplicate, negative, stale and future portfolio input fails closed",()=>{
 const p={cash:5000,holdings:[],targets,policy,asOf,currency:"USD",mode:"allocate"};
 for(const invalid of [{...p,cash:-1},{...p,targets:[targets[0],targets[0]]},{...p,asOf:"2026-11-14T12:00:00Z"},{...p,asOf:"2026-11-18T12:00:00Z"}])assert.throws(()=>previewPortfolio(invalid,now));
});
test("basket checks cumulative exposure, duplicates, cash and no shorts",()=>{
 const r=checkResearchBasket({cash:1000,holdings:[],orders:[{symbol:"AAPL",side:"buy",amount:200},{symbol:"AAPL",side:"buy",amount:200},{symbol:"KO",side:"sell",amount:1},{symbol:"AXP",side:"buy",amount:900}],policy,asOf,currency:"USD"},now);
 assert.deepEqual(r.rows.map(r=>r.status),["WITHIN_SUPPLIED_LIMITS","BLOCKED","BLOCKED","BLOCKED"]);
 assert.equal(r.cashAfterHypotheticalFills,800);
});
test("fundamental missing values do not pass; future filing does not enter screen",()=>{
 const r=screenCompanies({companies:[{symbol:"AAPL",periodEnd:"2026-06-30",filed:"2026-07-30",metrics:{revenueGrowthPct:null},sourceUrl:"https://www.sec.gov/Archives/a"}],rules:[{metric:"revenueGrowthPct",op:">=",value:10}],asOf:"2026-11-17"});
 assert.equal(r.rows[0].status,"INSUFFICIENT_DATA");assert.equal(r.rows[0].checks[0].actual,null);
});
test("cost basis selects actual lots and refuses unknown inventory",()=>{
 const p={lots:[{id:"old",symbol:"AAPL",acquired:"2025-01-01",shares:10,totalBasis:1000},{id:"new",symbol:"AAPL",acquired:"2026-01-01",shares:10,totalBasis:2000}],symbol:"AAPL",shares:5,price:150,method:"FIFO",saleDate:"2026-11-17"};
 assert.equal(previewLots(p).estimatedGain,250);assert.equal(previewLots({...p,method:"HIFO"}).estimatedGain,-250);
 assert.throws(()=>previewLots({...p,shares:21}));assert.equal(previewLots(p).authority.executionAllowed,false);
});
test("13F groups supplied share rows without copying options or unknown tickers",()=>{
 const r=analyzeHoldingsDisclosure({filer:"Fund",periodEnd:"2026-06-30",filed:"2026-08-14",asOf:"2026-11-17",sourceUrl:"https://www.sec.gov/Archives/fund",rows:[{id:"1",symbol:"AAPL",value:100,securityType:"shares"},{id:"2",symbol:"AAPL",value:200,securityType:"shares"},{id:"3",symbol:"KO",value:50,securityType:"call"}]});
 assert.equal(r.holdings[0].weight,100);assert.equal(r.excluded.length,1);assert.equal(r.authority.sourceVerified,false);
});
test("Congress records preserve owner, amount range, options and delay",()=>{
 const r=analyzeDisclosures({asOf:"2026-11-17",rows:[{id:"1",person:"Member",owner:"spouse",symbol:"AAPL",assetType:"options",action:"buy",tradeDate:"2026-10-01",filed:"2026-11-01",amountMin:1001,amountMax:15000,sourceUrl:"https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/1.pdf"}]});
 assert.equal(r.rows[0].disclosureDelayDays,31);assert.equal(r.rows[0].eligibleForStockResearch,false);assert.equal(r.rows[0].amountMax,15000);
});
test("price alerts do not repeat or report stale data as a non-trigger",()=>{
 const base={symbol:"AAPL",direction:"above",threshold:100};
 const r=previewPriceAlerts({now:asOf,observations:[{symbol:"AAPL",price:120,asOf:"2026-11-17T11:00:00Z",source:"supplied",delayed:true}],rules:[{...base,id:"1",alreadyTriggered:false},{...base,id:"2",alreadyTriggered:true}]});
 assert.deepEqual(r.rows.map(x=>x.status),["NOT_CHECKED","ALREADY_TRIGGERED"]);
});
test("research never provides probability, direction or execution authority",()=>{
 assert.equal(researchAuthority.probability,null);assert.equal(researchAuthority.direction,"NOT_ESTABLISHED");assert.equal(researchAuthority.executionAllowed,false);
});
