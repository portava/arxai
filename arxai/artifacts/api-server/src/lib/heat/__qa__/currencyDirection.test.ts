import { test } from "node:test";
import assert from "node:assert/strict";
import { currencyPriceSignal } from "../marketHeatService.js";
import { computeHeatVerdict, type PriceSignal } from "@workspace/domain/market-heat";
const p:PriceSignal={available:true,momentum:0.5,volatility:0.1,freshness:"LIVE",updatedAt:"2026-11-05T13:00:00Z",source:"Deriv",candleCount:120};
for(const pair of ["EURUSD","GBPUSD","USDJPY","EURGBP"]) test(`${pair} contributes opposite signed momentum to its two currencies`,()=>{
 assert.equal(currencyPriceSignal(pair,pair.slice(0,3),p).momentum,0.5);
 assert.equal(currencyPriceSignal(pair,pair.slice(3),p).momentum,-0.5);
 assert.equal(currencyPriceSignal(pair,pair.slice(3),p).volatility,p.volatility);
});
test("asset performance is not silently substituted for currency strength",()=>{
 for(const pair of ["XAUUSD","BTCUSD","SPX500"]) assert.equal(currencyPriceSignal(pair,"USD",p).available,false);
 assert.equal(currencyPriceSignal("EURUSD","JPY",p).available,false);
});

test("country FX direction follows its own currency, and calendar rows stay currency-scoped",async()=>{
 const {countryPriceSignal,scopedCalendarSignal}=await import('../marketHeatService.js');
 const price={available:true,momentum:0.5,volatility:0.2,freshness:'LIVE' as const,updatedAt:null,source:'test',candleCount:20};
 assert.equal(countryPriceSignal('EURUSD','US',price).momentum,-0.5);assert.equal(countryPriceSignal('EURUSD','Eurozone',price).momentum,0.5);
 const now=Date.parse('2026-11-05T14:00:00Z');
 const read={configured:true,connected:true,eventCount:2,highImpactActive:true,updatedAt:null,provider:'test',source:{note:null},events:[{currency:'GBP',impact:'high',timeUtc:'2026-11-05T14:30:00Z'},{currency:'USD',impact:'low',timeUtc:'2026-11-05T15:00:00Z'}]} as never;
 assert.equal(scopedCalendarSignal(read,'EUR',now).eventCount,0);assert.equal(scopedCalendarSignal(read,'USD',now).highImpactActive,false);assert.equal(scopedCalendarSignal(read,'GBP',now).highImpactActive,true);
});
