import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {getEconomicCalendar} from '../../news/economicCalendarProvider.js';
import {__setEconomicCalendarFetcherForTests,__resetEconomicCalendarStateForTests} from '../../news/calendar/economicCalendarService.js';
import {readCalendarProvider} from '../marketHeatProviderStatus.js';
import {computeHeatVerdict} from '@workspace/domain/market-heat';
const saved=process.env.ECONOMIC_CALENDAR_PROVIDER;
afterEach(()=>{if(saved===undefined)delete process.env.ECONOMIC_CALENDAR_PROVIDER;else process.env.ECONOMIC_CALENDAR_PROVIDER=saved;__resetEconomicCalendarStateForTests();});
test('GLOBAL calendar retains cross-currency events and heat preserves delayed source evidence',async()=>{
 process.env.ECONOMIC_CALENDAR_PROVIDER='forex_factory';__resetEconomicCalendarStateForTests();
 const now=Date.parse('2026-11-05T13:00:00Z');
 const rows=[{title:'Past rate decision',country:'GBP',date:'2026-11-05T07:00:00-05:00',impact:'High'},{title:'Jobs report',country:'USD',date:'2026-11-06T08:30:00-05:00',impact:'High'}];
 __setEconomicCalendarFetcherForTests(async()=>({ok:true,status:200,text:async()=>JSON.stringify(rows)}));
 const global=await getEconomicCalendar('GLOBAL',now);assert.equal(global.events.length,2);
 const heat=await readCalendarProvider('GLOBAL',now+3*60000);assert.equal(heat.eventCount,1);assert.equal(heat.events[0]?.title,'Jobs report');assert.equal(heat.highImpactActive,false);assert.equal(heat.freshness,'DELAYED');assert.equal(heat.apiKeyPresent,false);assert.equal(heat.updatedAt,new Date(now).toISOString());assert.match(heat.source.note!,/Current-week/);
 const v=computeHeatVerdict({id:'global',scope:'global',key:'global',displayName:'Global',affectedSymbols:[],price:{available:true,candleCount:120,momentum:0.3,volatility:0.2,updatedAt:new Date(now).toISOString(),source:'test',freshness:'LIVE'},news:{configured:true,connected:true,riskScore:0.2,itemCount:2,updatedAt:new Date(now).toISOString(),source:'news',freshness:'LIVE'},calendar:{configured:true,connected:true,impactScore:0.2,eventCount:heat.eventCount,highImpactActive:false,updatedAt:heat.updatedAt,source:heat.provider,freshness:heat.freshness,note:heat.source.note}});
 assert.equal(v.calendarSource.status,'delayed');assert.equal(v.sourceStatus,'delayed');assert.match(v.calendarSource.note!,/Current-week/);
});

// Exact ingress exemption delegates to route bridge auth; siblings remain session-protected.
test('calendar global gate permits only the exact bridge ingress path',async()=>{
 const {requireAuthOrPublic}=await import('../../auth/globalGate.js');
 for(const [path,allowed] of [['/mt5/calendar/ingest',true],['/mt5/calendar/ingest/other',false],['/mt5/calendar/private',false]] as const){
  let next=false,status=0;const response={status:(code:number)=>{status=code;return response;},json:()=>{}};
  requireAuthOrPublic({path,method:'POST'} as never,response as never,()=>{next=true;});
  assert.equal(next,allowed);if(!allowed)assert.equal(status,401);
 }
});
