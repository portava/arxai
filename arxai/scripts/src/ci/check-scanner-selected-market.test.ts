// Negative wiring fixtures use the real selected-market source, not a permissive
// hand-built positive fixture. Runtime behavior is covered by its backend suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSelectedMarketCalendar, checkScannerSelectedMarket } from "./check-scanner-selected-market.js";

const root = join(import.meta.dirname, "..", "..", "..");
const source = readFileSync(join(root, "artifacts/api-server/src/lib/scannerSelected/selectedMarket.ts"), "utf8");
assert.deepEqual(scanSelectedMarketCalendar(source), []);
assert.equal(checkScannerSelectedMarket().ok, true, "all pre-existing selected-market invariants still pass");
const mutations: Array<[string, string, string]> = [
  ["wrong authority import", "../news/calendar/newsRiskResolver.js", "../news/calendar/parallelResolver.js"],
  ["unused resolver", "await resolveEvents({ daysAhead: 2 })", "await parallelResolver({ daysAhead: 2 })"],
  ["wrong default dependency", "resolveEvents: typeof resolveNewsRiskEvents = resolveNewsRiskEvents", "resolveEvents: typeof resolveNewsRiskEvents = parallelResolver"],
  ["unavailable falsely certified", "calendarAvailable: false, reason: resolved.reason", "calendarAvailable: true, reason: resolved.reason"],
  ["missing availability accepted", "loaded.calendarAvailable === true", "loaded.calendarAvailable !== false"],
  ["truthy availability accepted", "loaded.calendarAvailable === true", "loaded.calendarAvailable"],
  ["unavailable scored as clear", 'newsRiskUnavailable(symbol, loaded.reason || loaded.calendar?.note || "Economic calendar unavailable — news risk could not be verified.")', "scoreNewsRisk(symbol, [])"],
  ["post-event evidence filtered out", "scorerInput: resolved.events", "scorerInput: sorted"],
  ["availability lost in envelope", "calendarAvailable: news.calendarAvailable", "calendarWasAvailable: news.calendarAvailable"],
  ["waiting envelope loses news", "upcomingEvents: events,\n      newsRisk,", "upcomingEvents: events,"],
  ["normal envelope loses news", "upcomingEvents: events,\n    newsRisk,", "upcomingEvents: events,"],
  ["synthetic applicability lost", "news.calendarAvailable, applicability };", "news.calendarAvailable };"],
];
for (const [name, before, after] of mutations) {
  assert.ok(source.includes(before), `mutation must apply: ${name}`);
  const mutated = source.replace(before, after);
  assert.ok(scanSelectedMarketCalendar(mutated).length > 0, `must reject: ${name}`);
}
assert.ok(scanSelectedMarketCalendar(source + "\nconst bypass = db.select().from(economicEventsTable);").length > 0, "direct DB bypass rejected");
assert.ok(scanSelectedMarketCalendar(`/* ${source} */`).length > 0, "commented code cannot satisfy authority");
assert.deepEqual(scanSelectedMarketCalendar(source + "\n// db.select().from(economicEventsTable)\n/* a former economicEventsTable read */"), [], "historical notes do not count as a bypass");
console.log(JSON.stringify({ guard: "scanner-selected-market-safety", validSource: true, existingInvariants: true, rejectedMutations: mutations.length + 2, commentOnlyBypassIgnored: true }));
