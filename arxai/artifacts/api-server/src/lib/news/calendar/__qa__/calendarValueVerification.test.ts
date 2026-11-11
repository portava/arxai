import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyCalendarValues} from '../calendarValueVerification.js';
import type {EconomicCalendarResult} from '../calendarTypes.js';
const result=(actual='4.25',previous='4',time='2026-11-05T12:00:00.000Z')=>({message:'MT5 calendar',events:[{provider:'mt5_calendar',currency:'GBP',title:'BoE Interest Rate Decision',eventTimeUtc:time,actual,previous,revised:null,forecast:null}]} as EconomicCalendarResult);
test('conflicting released values are withheld with primary-source explanation, never silently replaced',()=>{const r=verifyCalendarValues(result());assert.equal(r.events[0]!.actual,null);assert.equal(r.events[0]!.previous,null);assert.match(r.events[0]!.riskNote!,/bankofengland.co.uk/);assert.match(r.message,/conflicting/);});
test('matching values and different meetings are preserved',()=>{assert.equal(verifyCalendarValues(result('4','3.75')).events[0]!.actual,'4');assert.equal(verifyCalendarValues(result('4.25','4','2026-12-17T12:00:00.000Z')).events[0]!.actual,'4.25');});
