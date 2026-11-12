import type { EconomicCalendarResult } from './calendarTypes.js';
// Dated, independently checked primary-source evidence. Never extrapolate this
// value to other meetings or silently rewrite an upstream provider's print.
export const BOE_NOVEMBER_2026_REFERENCE = {
  url:'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/november-2026',
  eventTimeUtc:'2026-11-05T12:00:00.000Z', actual:4, previous:3.75,
  checkedOn:'2026-11-05',
} as const;
export function verifyCalendarValues(result:EconomicCalendarResult):EconomicCalendarResult {
  let conflicts=0;
  const events=result.events.map(event=>{
    if(event.provider!=='mt5_calendar' || event.currency!=='GBP' || event.eventTimeUtc!==BOE_NOVEMBER_2026_REFERENCE.eventTimeUtc || !/^BoE Interest Rate Decision$/i.test(event.title)) return event;
    const conflict=(event.actual!==null && Number(event.actual)!==BOE_NOVEMBER_2026_REFERENCE.actual) || (event.previous!==null && Number(event.previous)!==BOE_NOVEMBER_2026_REFERENCE.previous);
    if(!conflict)return event;
    conflicts++;
    return {...event,actual:null,previous:null,revised:null,riskNote:`Released values withheld: MT5 conflicts with the Bank of England's 5 November 2026 release. Verify at ${BOE_NOVEMBER_2026_REFERENCE.url}`};
  });
  return conflicts ? {...result,events,message:`${result.message} ${conflicts} event has conflicting released values withheld after a primary-source check; see the event note.`} : result;
}
