import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGatedTrustLine } from "../eleanorChartContext.js";
test("missing feed is unavailable, not a promise that candles are syncing",()=>{
 for(const available of [true,false]){
  const line=buildGatedTrustLine("M5",{available,stale:false,aiUsable:false,basis:"INSUFFICIENT",quality:"unavailable"});
  assert.match(line,/unavailable/);assert.doesNotMatch(line,/syncing|live feed|verified/i);
 }
});
