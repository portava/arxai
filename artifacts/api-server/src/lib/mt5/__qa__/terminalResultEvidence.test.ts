import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { normalizeTerminalResultEvidence as normalize, terminalResultKind, TERMINAL_ENTRY_COMMAND_TYPES } from "../terminalResultEvidence.js";
const full = {resultEvidenceVersion:1,resultKind:"ENTRY",tradeCallSucceeded:true,mt5Retcode:10009,resultDeal:"43",resultOrder:"42",requestedVolume:.02,resultVolume:.02,resultPrice:1.234567891};
const read=(raw:Record<string,unknown>,type="PLACE_LIVE_MARKET_ORDER",volume:number|null=.02,ticket?:string)=>normalize(raw,type,volume,ticket)!;
test("legacy reports remain explicit compatibility, no evidence certification",()=>assert.equal(normalize({status:"FILLED"},"OPEN_MARKET",.02),null));
test("actual execution evidence preserves decimal precision, not requested-volume or caller status",()=>{
 const r=read({...full,status:"LIVE_REJECTED",executedVolume:99,fillPrice:99});
 assert.equal(r.outcome,"LIVE_FILLED");assert.equal(r.executedVolume,.02);assert.equal(r.fillPrice,1.234567891);
 const short=read({...full,resultVolume:.00789123});assert.equal(short.outcome,"LIVE_PARTIALLY_FILLED");assert.equal(short.executedVolume,.00789123);
 assert.equal(read({...full,mt5Retcode:10010}).outcome,"LIVE_PARTIALLY_FILLED");
});
for(const patch of [
 {resultEvidenceVersion:2},{resultEvidenceVersion:"1"},{resultKind:"CLOSE"},{tradeCallSucceeded:false},
 {resultDeal:"0"},{resultDeal:43},{resultDeal:"18446744073709551616"},{resultOrder:"0"},
 {resultVolume:0},{resultVolume:NaN},{resultVolume:Infinity},{resultVolume:-.02},{resultVolume:.03},
 {resultPrice:0},{resultPrice:NaN},{resultPrice:Infinity},{requestedVolume:.03},{requestedVolume:undefined},
 {mt5Retcode:10012},{mt5Retcode:10031},{mt5Retcode:10025},{mt5Retcode:10009.1},
])test(`unproven or contradictory execution stays unknown: ${Object.keys(patch)[0]} ${String(Object.values(patch)[0])}`,()=>{
 const result=read({...full,...patch,status:"LIVE_FILLED",executedVolume:.02,fillPrice:1.2});
 assert.equal(result.outcome,"LIVE_UNKNOWN");assert.equal(result.executedVolume,null);assert.equal(result.fillPrice,null);
});
test("placed is acceptance only even with an order ticket and proposed volume",()=>{
 const r=read({...full,mt5Retcode:10008,resultDeal:"0"});assert.equal(r.outcome,"LIVE_ACKNOWLEDGED");assert.equal(r.executedVolume,null);
});
test("definite refusal with contradictory execution evidence remains unresolved",()=>{
 assert.equal(read({...full,mt5Retcode:10006,resultDeal:"0",resultVolume:0}).outcome,"LIVE_REJECTED");
 assert.equal(read({...full,mt5Retcode:10006}).outcome,"LIVE_UNKNOWN");
});
test("completed protection has no financial fill and must match exact position ticket",()=>{
 const body={...full,resultKind:"MODIFY",resultDeal:"0",resultVolume:0,requestedVolume:0,positionTicket:"123"};
 const r=read(body,"MODIFY_LIVE_SLTP",.02,"123");assert.equal(r.outcome,"LIVE_FILLED");assert.equal(r.executedVolume,null);assert.equal(r.fillPrice,null);
 assert.equal(read({...body,mt5PositionTicket:"456"},"MODIFY_LIVE_SLTP",.02,"123").outcome,"LIVE_UNKNOWN");
 assert.equal(read(body,"MODIFY_LIVE_SLTP",.02,"456").outcome,"LIVE_UNKNOWN");
});
test("close requires exact target and cannot infer cumulative execution from a residual request",()=>{
 const body={...full,resultKind:"CLOSE",positionTicket:"123"};
 assert.equal(read(body,"CLOSE_LIVE_POSITION",.02,"123").outcome,"LIVE_FILLED");
 assert.equal(read({...body,requestedVolume:.01,resultVolume:.01},"CLOSE_LIVE_POSITION",.02,"123").outcome,"LIVE_UNKNOWN");
 assert.equal(read({...body,positionTicket:"124"},"CLOSE_LIVE_POSITION",.02,"123").outcome,"LIVE_UNKNOWN");
});
test("evidence is fixed, bounded primitives and never an arbitrary payload",()=>{
 const r=read({...full,resultKind:"x".repeat(1000),password:"not-persisted",nested:{secret:true}});
 assert.equal(String(r.evidence.resultKind).length,80);assert.ok(!Object.hasOwn(r.evidence,"password"));assert.ok(!Object.hasOwn(r.evidence,"nested"));
});
test("actual extracted v131/v154 handlers agree with server for all synchronous result fixtures",()=>{
 const runner=fileURLToPath(new URL("../../../../../../mt5-bridge/tests/run_management_target.py",import.meta.url));
 const result=spawnSync("python3",[runner,"--result-evidence","--emit"],{encoding:"utf8",timeout:20000,env:{...process.env,TMPDIR:process.env.TMPDIR ?? tmpdir()}});
 assert.equal(result.status,0,`${result.error??""} ${result.stderr}`);
 const rows=result.stdout.trim().split("\n").map(line=>JSON.parse(line));assert.equal(rows.length,96);
 for(const {kind,body,path,scenario}of rows){
  const types=kind==="ENTRY"?TERMINAL_ENTRY_COMMAND_TYPES:[kind==="CLOSE"?"CLOSE_LIVE_POSITION":"MODIFY_LIVE_SLTP"];
  for(const type of types){
   const r=read(body,type,.02,kind==="ENTRY"?undefined:"42");
   assert.equal(r.outcome,body.status,`${path} ${kind} ${type} ${scenario}`);assert.equal(r.executedVolume,body.executedVolume);assert.equal(r.fillPrice,body.fillPrice);
  }
 }
});
test("every v154 market-entry dispatch alias maps to ENTRY; pending, bulk and unknown actions do not",()=>{
 for(const type of ["PLACE_LIVE_MARKET_ORDER","OPEN_MARKET","PLACE_MARKET_ORDER","DEMO_MARKET_ORDER"]){
  assert.equal(terminalResultKind(type),"ENTRY",type);
  const r=read(full,type);assert.equal(r.outcome,"LIVE_FILLED",type);assert.equal(r.executedVolume,.02);assert.equal(r.brokerTicket,"42");
 }
 for(const type of ["PLACE_PENDING","PLACE_PENDING_ORDER","PLACE_LIVE_PENDING_ORDER","REVERSE_POSITION","CLOSE_ALL","PARTIAL_CLOSE","open_market","OPEN_MARKET ",""]){
  assert.equal(terminalResultKind(type),null,type);assert.equal(read(full,type).outcome,"LIVE_UNKNOWN",type);
 }
});
test("actual v154 dispatcher routes exactly the declared entry aliases to the evidence-emitting handler",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(fileURLToPath(new URL("../../../../../../mt5-bridge/ARX_AI_Universal_Agent_v154.mq5",import.meta.url)),"utf8");
 const routed=[...source.matchAll(/(?:if|else if)\(([^)]*?)\)\s*HandleOpenMarket\(/g)].flatMap(m=>[...m[1]!.matchAll(/action == "([A-Z_]+)"/g)].map(a=>a[1]));
 assert.deepEqual([...routed].sort(),TERMINAL_ENTRY_COMMAND_TYPES.filter(t=>t!=="PLACE_LIVE_MARKET_ORDER").sort());
});
