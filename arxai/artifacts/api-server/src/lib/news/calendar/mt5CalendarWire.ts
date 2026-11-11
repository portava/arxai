import type { CalendarEvent } from "./calendarTypes.js";

// No broker execution imports. This is a read-only, bounded telemetry contract.
export const MT5_CALENDAR_PROVIDER = "mt5_calendar";
const LONG_MIN = "-9223372036854775808";
export interface Mt5CalendarRow {
  id: string; eventId: string; timeServer: number; timeMode: string;
  title: string; country: string; currency: string; importance: number;
  actual: string | null; forecast: string | null; previous: string | null; revised: string | null;
  unit: string; multiplier: string;
}
export interface Mt5CalendarSnapshot {
  version: 1; account: string; server: string; terminalConnected: boolean; tester: boolean;
  collectedAtUtc: number; serverNow: number; lastQuoteServer: number;
  windowFromServer: number; windowToServer: number;
  status: "ok" | "error"; errorCode: number; omitted: number; events: Mt5CalendarRow[];
}
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && !Array.isArray(v); }
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v); }
function bounded(v: unknown, max: number): v is string { return typeof v === "string" && v.length <= max; }
export function parseMt5CalendarSnapshot(v: unknown): Mt5CalendarSnapshot {
  if (!object(v) || v.version !== 1 || !bounded(v.account, 32) || !/^\d+$/.test(v.account)
    || !bounded(v.server, 128) || !v.server || typeof v.terminalConnected !== "boolean" || typeof v.tester !== "boolean"
    || ![v.collectedAtUtc,v.serverNow,v.lastQuoteServer,v.windowFromServer,v.windowToServer,v.errorCode,v.omitted].every(integer)
    || (v.status !== "ok" && v.status !== "error") || !Array.isArray(v.events) || v.events.length > 2000
    || Number(v.omitted) < 0 || Number(v.errorCode) < 0 || Number(v.windowToServer) <= Number(v.windowFromServer)
    || Number(v.windowToServer)-Number(v.windowFromServer) > 15*86400) throw new Error("Invalid MT5 calendar snapshot");
  for (const row of v.events) {
    if (!object(row) || !bounded(row.id,32) || !/^\d+$/.test(row.id) || !bounded(row.eventId,32) || !/^\d+$/.test(row.eventId)
      || !integer(row.timeServer) || !bounded(row.timeMode,48) || !bounded(row.title,500) || !row.title.trim()
      || !bounded(row.country,100) || !bounded(row.currency,3) || !/^[A-Z]{3}$/.test(row.currency)
      || !integer(row.importance) || row.importance < 0 || row.importance > 3
      || !bounded(row.unit,48) || !bounded(row.multiplier,48)
      || ![row.actual,row.forecast,row.previous,row.revised].every(x => x === null || (bounded(x,20) && /^-?\d+$/.test(x) && BigInt(x) >= -9223372036854775808n && BigInt(x) <= 9223372036854775807n)))
      throw new Error("Invalid MT5 calendar event");
  }
  return v as unknown as Mt5CalendarSnapshot;
}
/** Integer-string conversion preserves long precision and genuine zero values. */
export function mt5Millionths(raw: string | null): string | null {
  if (raw === null || raw === LONG_MIN) return null;
  const value = BigInt(raw), abs = value < 0 ? -value : value;
  const fraction = (abs % 1000000n).toString().padStart(6,"0").replace(/0+$/, "");
  return `${value < 0 ? "-" : ""}${abs/1000000n}${fraction ? `.${fraction}` : ""}`;
}
function wallAt(utcSeconds: number, zone: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year:"numeric", month:"2-digit", day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23" }).formatToParts(new Date(utcSeconds*1000));
  const n = (key: string) => Number(p.find(x => x.type === key)?.value);
  return Date.UTC(n("year"),n("month")-1,n("day"),n("hour"),n("minute"),n("second"))/1000;
}
/** A configured broker zone, not the Mac zone/current offset, determines future DST. */
export function mt5ServerTimeToUtc(wallSeconds: number, zone: string): number | null {
  const offsets = new Set([-172800,-86400,0,86400,172800].map(d => wallAt(wallSeconds+d,zone)-(wallSeconds+d)));
  const candidates = [...offsets].map(offset => wallSeconds-offset).filter(utc => wallAt(utc,zone) === wallSeconds);
  return candidates.length === 1 ? candidates[0]! * 1000 : null; // gap/overlap => unknown, never guess
}
const UNITS: Record<string,string> = { CALENDAR_UNIT_PERCENT:"%", CALENDAR_UNIT_CURRENCY:"currency", CALENDAR_UNIT_HOUR:"hours", CALENDAR_UNIT_JOB:"jobs", CALENDAR_UNIT_RIG:"rigs", CALENDAR_UNIT_USD:"USD", CALENDAR_UNIT_PEOPLE:"people", CALENDAR_UNIT_MORTGAGE:"mortgages", CALENDAR_UNIT_VOTE:"votes", CALENDAR_UNIT_BARREL:"barrels", CALENDAR_UNIT_CUBICFEET:"cubic feet", CALENDAR_UNIT_POSITION:"positions", CALENDAR_UNIT_BUILDING:"buildings" };
const MULTIPLIERS: Record<string,string> = { CALENDAR_MULTIPLIER_THOUSANDS:"thousands", CALENDAR_MULTIPLIER_MILLIONS:"millions", CALENDAR_MULTIPLIER_BILLIONS:"billions", CALENDAR_MULTIPLIER_TRILLIONS:"trillions" };
export function normalizeMt5Calendar(snapshot: Mt5CalendarSnapshot, zone: string, nowMs: number): {events: CalendarEvent[]; omitted: number} {
  if (!zone) throw new Error("MT5 calendar broker timezone is not verified/configured");
  if (snapshot.tester || !snapshot.terminalConnected) throw new Error("MT5 calendar terminal is disconnected or in tester mode");
  if (snapshot.status !== "ok" || snapshot.errorCode !== 0) throw new Error(`MT5 calendar query failed (code ${snapshot.errorCode})`);
  if (Math.abs(nowMs-snapshot.collectedAtUtc*1000) > 120000) throw new Error("MT5 calendar UTC clock evidence is stale or skewed");
  if (Math.abs(wallAt(snapshot.collectedAtUtc,zone)-snapshot.serverNow) > 5
    || Math.abs(snapshot.serverNow-snapshot.lastQuoteServer) > 120) throw new Error("MT5 calendar broker clock evidence does not verify configured timezone");
  const events: CalendarEvent[] = []; let omitted = snapshot.omitted;
  const ids = new Set<string>();
  for (const row of snapshot.events) {
    if (ids.has(row.id)) throw new Error("Duplicate MT5 calendar value ID"); ids.add(row.id);
    if (row.timeServer < snapshot.windowFromServer || row.timeServer > snapshot.windowToServer) throw new Error("MT5 calendar event outside reported window");
    // The canonical UI requires exact timestamps and known severity. Unknown/all-day
    // events cannot be converted into precise countdowns or a fabricated low impact.
    if (row.timeMode !== "CALENDAR_TIMEMODE_DATETIME" || row.importance === 0) { omitted++; continue; }
    const utc = mt5ServerTimeToUtc(row.timeServer,zone);
    if (utc === null) { omitted++; continue; }
    const impact = (["", "low", "medium", "high"] as const)[row.importance] as CalendarEvent["impact"];
    const unit = [MULTIPLIERS[row.multiplier],UNITS[row.unit]].filter(Boolean).join(" ") || null;
    events.push({id:`mt5:${row.id}`,provider:MT5_CALENDAR_PROVIDER,source:"MetaTrader 5 economic calendar",country:row.country,currency:row.currency,category:null,title:row.title,impact,
      eventTimeUtc:new Date(utc).toISOString(),eventTimeLocal:null,actual:mt5Millionths(row.actual),forecast:mt5Millionths(row.forecast),previous:mt5Millionths(row.previous),revised:mt5Millionths(row.revised),unit,importance:row.importance,
      lastUpdatedAt:new Date(snapshot.collectedAtUtc*1000).toISOString(),freshness:"LIVE",affectedSymbols:[],riskNote:null});
  }
  events.sort((a,b) => a.eventTimeUtc.localeCompare(b.eventTimeUtc));
  return {events,omitted};
}
