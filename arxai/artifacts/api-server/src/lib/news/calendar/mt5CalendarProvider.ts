import type { CalendarEvent, EconomicCalendarResult } from "./calendarTypes.js";
import { affectedSymbolsFor, riskNoteFor } from "./calendarSymbolMap.js";
import { MT5_CALENDAR_PROVIDER, parseMt5CalendarSnapshot, normalizeMt5Calendar, mt5ServerTimeToUtc } from "./mt5CalendarWire.js";
export { MT5_CALENDAR_PROVIDER } from "./mt5CalendarWire.js";

type Env = Record<string, string | undefined>;
type Observation = { connectionId: string; timezone: string; observedAt: number; receivedAt: number; from: number; to: number; events: CalendarEvent[]; omitted: number; error: string | null };
let observation: Observation | null = null;
let clockEvidence: { collectedAtUtc: number; serverNow: number; lastQuoteServer: number; status: string; errorCode: number; eventCount: number; samples: {title: string; currency: string; timeServer: number; timeMode: string}[] } | null = null;
/** Operator diagnostics only; contains no account identifiers or credentials. */
export function getMt5CalendarClockEvidence() { return clockEvidence; }
export function mt5CalendarConfigured(env: Env = process.env): boolean {
  return Boolean(env.MT5_CALENDAR_CONNECTION_ID?.trim() && env.MT5_CALENDAR_SERVER_TIMEZONE?.trim());
}
/** Called ONLY after existing per-user bridge auth. The selected connection is
 * operator configuration, never an account/user field supplied by the payload. */
export function ingestMt5Calendar(connectionId: string, payload: unknown, nowMs = Date.now(), env: Env = process.env): { accepted: boolean; eventCount: number; omitted: number; error: string | null } {
  if (!env.MT5_CALENDAR_CONNECTION_ID?.trim() || String(connectionId) !== env.MT5_CALENDAR_CONNECTION_ID?.trim()) throw new Error("MT5 calendar source connection is not selected");
  const timezone = env.MT5_CALENDAR_SERVER_TIMEZONE?.trim() ?? "";
  const snapshot = parseMt5CalendarSnapshot(payload);
  if (observation?.connectionId === connectionId && !observation.error && snapshot.collectedAtUtc*1000 <= observation.observedAt) throw new Error("MT5 calendar snapshot is duplicate or out of order");
  clockEvidence = {collectedAtUtc:snapshot.collectedAtUtc,serverNow:snapshot.serverNow,lastQuoteServer:snapshot.lastQuoteServer,status:snapshot.status,errorCode:snapshot.errorCode,eventCount:snapshot.events.length,samples:snapshot.events.slice(0,8).map(e => ({title:e.title,currency:e.currency,timeServer:e.timeServer,timeMode:e.timeMode}))};
  let events: CalendarEvent[] = [], omitted = snapshot.omitted, error: string | null = null;
  let from = 0, to = 0;
  try {
    const normalized = normalizeMt5Calendar(snapshot,timezone,nowMs); events = normalized.events; omitted = normalized.omitted;
    from = mt5ServerTimeToUtc(snapshot.windowFromServer,timezone) ?? 0;
    to = mt5ServerTimeToUtc(snapshot.windowToServer,timezone) ?? 0;
    if (!from || !to) throw new Error("MT5 calendar coverage boundary is ambiguous");
    events = events.map(e => ({...e,affectedSymbols:affectedSymbolsFor(e.currency,e.country),riskNote:riskNoteFor(e.impact,e.currency)}));
    if (!events.length && omitted) throw new Error("MT5 calendar returned only events without exact time or known impact");
  } catch (e) { error = e instanceof Error ? e.message : "MT5 calendar observation failed"; events = []; }
  observation = {connectionId,timezone,observedAt:snapshot.collectedAtUtc*1000,receivedAt:nowMs,from,to,events,omitted,error};
  return {accepted:error === null,eventCount:events.length,omitted,error};
}
export function getMt5CalendarResult(options: {nowMs?: number; daysAhead?: number; env?: Env} = {}): EconomicCalendarResult {
  const now = options.nowMs ?? Date.now(), env = options.env ?? process.env;
  const configured = mt5CalendarConfigured(env);
  const row = observation?.connectionId === env.MT5_CALENDAR_CONNECTION_ID?.trim() && observation?.timezone === env.MT5_CALENDAR_SERVER_TIMEZONE?.trim() ? observation : null;
  const age = row ? Math.max(0,now-row.observedAt) : null;
  const horizon = options.daysAhead ?? 7;
  let error = !configured ? "MT5 calendar source connection and verified broker timezone are not configured" : !row ? "MT5 calendar is waiting for its first authenticated terminal observation" : row.error;
  if (!error && (!Number.isFinite(horizon) || horizon < 1 || horizon > 14)) error = "MT5 calendar terminal snapshot does not cover the requested horizon";
  if (!error && row && (age! > 120000 || now < row.observedAt-5000)) error = "MT5 calendar observation is stale or clock-skewed";
  if (!error && row && (row.from > now || row.to < now+horizon*86400000)) error = "MT5 calendar terminal snapshot does not cover the requested horizon";
  const events = error || !row ? [] : row.events.filter(e => Date.parse(e.eventTimeUtc) >= Math.floor(now/86400000)*86400000 && Date.parse(e.eventTimeUtc) <= now+horizon*86400000);
  const status = !configured ? "missing" : error ? "error" : events.length ? "ok" : "empty";
  const freshness = error ? (row ? "STALE" : "UNAVAILABLE") : "LIVE";
  return {status,connected:!error,configured,provider:MT5_CALENDAR_PROVIDER,events,diagnostics:{provider:MT5_CALENDAR_PROVIDER,configured,apiKeyPresent:false,status,lastFetchAt:row ? new Date(row.receivedAt).toISOString() : null,lastSuccessAt:row && !row.error ? new Date(row.observedAt).toISOString() : null,lastError:error,eventCount:events.length,freshness,cacheAgeMs:age},
    message:error ?? `MT5 economic calendar; authenticated terminal observation. ${row?.omitted ?? 0} events omitted because exact time, impact, or metadata was unavailable.`};
}
export function __resetMt5CalendarForTests(): void { observation = null; clockEvidence = null; }
