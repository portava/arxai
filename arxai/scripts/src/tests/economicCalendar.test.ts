// Economic-calendar adapter — pure-logic unit tests.
//
// Imports ONLY from tradingEconomicsCore (logger-free) so the test can run
// in the scripts/tsx test runner without pulling in pino or any server dep.
//
// Behavioral contracts asserted:
//   1.  TE Importance 1/2/3 → low/medium/high
//   2.  Impact → DB impactLevel (LOW/MEDIUM/HIGH)
//   3.  currencyToIndexMarkets: USD includes US30/SPX500; EUR includes GER40
//   4.  Date normalisation: bare "YYYY-MM-DDTHH:MM:SS" → "...Z"
//   5.  Date normalisation: already-Z timestamps left unchanged
//   6.  Date normalisation: invalid dates → null
//   7.  teEventToRaw: full mapping round-trip
//   8.  isInFetchWindow: filters ancient past events (>2h ago)
//   9.  isInFetchWindow: accepts events inside window
//   10. computeFreshnessStatus: never fetched → unavailable
//   11. computeFreshnessStatus: success within TTL → fresh
//   12. computeFreshnessStatus: success beyond TTL → stale
//   13. computeFreshnessStatus: error-after-success → unavailable (honesty rule)
//   14. computeFreshnessStatus: success-after-error → fresh (error superseded)
//   15. computeFreshnessStatus: error before any success (null lastFetchAt) → unavailable

import assert from "node:assert/strict";
import {
  teImportanceToImpact,
  impactToLevel,
  currencyToIndexMarkets,
  normalizeTeDate,
  teEventToRaw,
  isInFetchWindow,
  computeFreshnessStatus,
  computeProviderState,
  isValidIsoDateParam,
  validateCalendarDateRange,
  providerStateNote,
  runEconomicEventsSync,
} from "../../../artifacts/api-server/src/lib/news/calendar/tradingEconomicsCore.js";

// ── 1. Impact mapping ─────────────────────────────────────────────────────
assert.equal(teImportanceToImpact(3), "high",   "Importance 3 → high");
assert.equal(teImportanceToImpact(2), "medium", "Importance 2 → medium");
assert.equal(teImportanceToImpact(1), "low",    "Importance 1 → low");
assert.equal(teImportanceToImpact(0), "low",    "Importance 0 → low");
assert.equal(teImportanceToImpact(undefined), "low", "Importance undefined → low");

// ── 2. impactToLevel ──────────────────────────────────────────────────────
assert.equal(impactToLevel("high"),   "HIGH");
assert.equal(impactToLevel("medium"), "MEDIUM");
assert.equal(impactToLevel("low"),    "LOW");

// ── 3. currencyToIndexMarkets ─────────────────────────────────────────────
const usdMarkets = currencyToIndexMarkets("USD");
assert.ok(usdMarkets.includes("US30"),   "USD → US30");
assert.ok(usdMarkets.includes("SPX500"), "USD → SPX500");
assert.ok(usdMarkets.includes("NAS100"), "USD → NAS100");
assert.ok(usdMarkets.includes("DXY"),    "USD → DXY");

const eurMarkets = currencyToIndexMarkets("EUR");
assert.ok(eurMarkets.includes("GER40"), "EUR → GER40");

const gbpMarkets = currencyToIndexMarkets("GBP");
assert.ok(gbpMarkets.includes("UK100"), "GBP → UK100");

const jpyMarkets = currencyToIndexMarkets("JPY");
assert.ok(jpyMarkets.includes("JP225"), "JPY → JP225");

assert.deepEqual(currencyToIndexMarkets("CAD"), [], "CAD → [] (forex-only)");
assert.deepEqual(currencyToIndexMarkets("xyz"), [], "unknown currency → []");

// ── 4. Date normalisation: bare TS without Z gets Z appended ─────────────
const d1 = normalizeTeDate("2024-01-15T13:30:00");
assert.ok(d1 !== null && d1.endsWith("Z"), `bare TS gets Z: got ${d1}`);
const d1t = new Date(d1!).getTime();
assert.ok(!Number.isNaN(d1t), "normalised date is a valid Date");

// ── 5. Date normalisation: already-Z timestamp left unchanged ─────────────
const already = "2024-06-01T08:00:00Z";
const d2 = normalizeTeDate(already);
assert.equal(d2, already, "already-Z timestamp unchanged");

// ── 6. Date normalisation: invalid date → null ────────────────────────────
assert.equal(normalizeTeDate("not-a-date"), null, "invalid date → null");
assert.equal(normalizeTeDate(undefined), null,     "undefined → null");
assert.equal(normalizeTeDate(""), null,             "empty string → null");

// ── 7. teEventToRaw: full mapping round-trip ──────────────────────────────
const teEvent = {
  CalendarId: "evt-001",
  Date: "2099-01-15T13:30:00",
  Category: "Consumer Price Index",
  Event: "US CPI YoY",
  Country: "United States",
  Currency: "USD",
  Importance: 3,
  Actual: null, Previous: "3.1%", Forecast: "3.2%",
};
const raw = teEventToRaw(teEvent);
assert.ok(raw !== null, "teEventToRaw must not return null for valid event");
assert.equal(raw!.id, "evt-001");
assert.equal(raw!.title, "US CPI YoY");
assert.equal(raw!.currency, "USD");
assert.equal(raw!.impact, "high");
assert.ok(raw!.eventTimeIso.endsWith("Z"), "eventTimeIso ends with Z");
assert.ok(raw!.affectedMarkets.includes("US30"), "USD affectedMarkets includes US30");

// Null for event with invalid date
const badDate = teEventToRaw({ CalendarId: "x", Date: "bad", Currency: "EUR", Importance: 2 });
assert.equal(badDate, null, "invalid date → null from teEventToRaw");

// Null for event with no Date
const noDate = teEventToRaw({ CalendarId: "x", Currency: "EUR", Importance: 2 });
assert.equal(noDate, null, "no date → null from teEventToRaw");

// ── 8. isInFetchWindow: ancient past events (>2h ago) excluded ────────────
const ancientTime = new Date("2000-01-01T00:00:00Z").toISOString();
const nowMs = Date.now();
assert.equal(
  isInFetchWindow(ancientTime, nowMs, 72 * 3600 * 1000),
  false,
  "ancient past event must be excluded",
);

// ── 9. isInFetchWindow: events inside window accepted ─────────────────────
const futureTime = new Date(nowMs + 24 * 3600 * 1000).toISOString();
assert.equal(
  isInFetchWindow(futureTime, nowMs, 72 * 3600 * 1000),
  true,
  "future event within window must be accepted",
);

// Just past (< 2h ago) — accepted
const justPast = new Date(nowMs - 30 * 60 * 1000).toISOString(); // 30 min ago
assert.equal(
  isInFetchWindow(justPast, nowMs, 72 * 3600 * 1000),
  true,
  "event 30min ago must be accepted (within 2h grace)",
);

// Exactly >2h ago — excluded
const twoHalfHoursAgo = new Date(nowMs - 2.5 * 3600 * 1000).toISOString();
assert.equal(
  isInFetchWindow(twoHalfHoursAgo, nowMs, 72 * 3600 * 1000),
  false,
  "event 2.5h ago must be excluded",
);

// ── 10–15. computeFreshnessStatus: liveness honesty rules ─────────────────
const FIVE_MIN_MS = 5 * 60 * 1000;
const nowFixed = new Date("2099-01-01T12:00:00Z").getTime();

// 10. Never fetched → unavailable
assert.equal(
  computeFreshnessStatus({ lastFetchAt: null, lastErrorAt: null }, FIVE_MIN_MS, nowFixed),
  "unavailable",
  "never fetched → unavailable",
);

// 11. Success within TTL → fresh
const recentFetch = new Date(nowFixed - 60_000).toISOString(); // 1 min ago
assert.equal(
  computeFreshnessStatus({ lastFetchAt: recentFetch, lastErrorAt: null }, FIVE_MIN_MS, nowFixed),
  "fresh",
  "success within TTL → fresh",
);

// 12. Success beyond TTL → stale
const oldFetch = new Date(nowFixed - 10 * 60_000).toISOString(); // 10 min ago
assert.equal(
  computeFreshnessStatus({ lastFetchAt: oldFetch, lastErrorAt: null }, FIVE_MIN_MS, nowFixed),
  "stale",
  "success beyond TTL → stale",
);

// 13. Error-after-success → unavailable (honesty rule: error overrides prior success age).
//     This is the critical fix: previously getCalendarLiveness() would return
//     "fresh"/"stale" based on the old lastFetchAt even after a subsequent error.
const priorSuccess = new Date(nowFixed - 60_000).toISOString();  // 1 min ago (would be "fresh")
const laterError   = new Date(nowFixed - 30_000).toISOString();  // 30s ago (AFTER the success)
assert.equal(
  computeFreshnessStatus({ lastFetchAt: priorSuccess, lastErrorAt: laterError }, FIVE_MIN_MS, nowFixed),
  "unavailable",
  "error-after-success → unavailable (honesty rule)",
);

// 14. Success-after-error → fresh (new success supersedes old error)
const priorError  = new Date(nowFixed - 10 * 60_000).toISOString(); // 10 min ago
const laterFetch  = new Date(nowFixed - 60_000).toISOString();      // 1 min ago (AFTER the error)
assert.equal(
  computeFreshnessStatus({ lastFetchAt: laterFetch, lastErrorAt: priorError }, FIVE_MIN_MS, nowFixed),
  "fresh",
  "success-after-error → fresh (error superseded)",
);

// 15. Error before any success (null lastFetchAt) → unavailable
assert.equal(
  computeFreshnessStatus({ lastFetchAt: null, lastErrorAt: new Date(nowFixed - 5000).toISOString() }, FIVE_MIN_MS, nowFixed),
  "unavailable",
  "error before any success (null lastFetchAt) → unavailable",
);

// ── 16–18. computeProviderState — cross-surface state discrimination ─────────
//
// These lock the explicit provider-state discriminant contract that downstream
// radar, newsIntelligenceService, and Ruby consumers rely on to render distinct
// UX copy for "not configured" vs "fetch error" vs "live connected". Without
// this discriminant both non-connected states would collapse to `connected:false`
// and consumers could not distinguish them (reviewer-identified gap).

// 16. Not enabled → "not_configured" (no key set / wrong provider env var)
assert.equal(
  computeProviderState(false, false),
  "not_configured",
  "not enabled → not_configured",
);
assert.equal(
  computeProviderState(false, true),
  "not_configured",
  "not enabled even if fetch flag is true → not_configured (isEnabled wins)",
);

// 17. Enabled + fetch failed → "fetch_error"
assert.equal(
  computeProviderState(true, false),
  "fetch_error",
  "enabled but fetch failed → fetch_error",
);

// 18. Enabled + fetch succeeded → "connected"
assert.equal(
  computeProviderState(true, true),
  "connected",
  "enabled and fetch succeeded → connected",
);

// ── 19. isValidIsoDateParam — strict ISO date/datetime acceptance ────────────
assert.equal(isValidIsoDateParam("2025-06-19"), true, "YYYY-MM-DD accepted");
assert.equal(isValidIsoDateParam("2025-06-19T13:30:00Z"), true, "ISO datetime accepted");
assert.equal(isValidIsoDateParam("2025-06-19T13:30"), true, "ISO datetime without seconds accepted");
assert.equal(isValidIsoDateParam("2025-13-45"), false, "out-of-range month/day rejected");
assert.equal(isValidIsoDateParam("2025-99-99"), false, "nonsense month/day rejected");
assert.equal(isValidIsoDateParam("not-a-date"), false, "non-date rejected");
assert.equal(isValidIsoDateParam("2025-1-5"), false, "non-zero-padded date rejected (no silent coercion)");
assert.equal(isValidIsoDateParam(""), false, "empty string rejected");
assert.equal(isValidIsoDateParam("2025-02-30"), false, "Feb 30 rollover rejected");

// ── 20. validateCalendarDateRange — 400-or-pass contract ─────────────────────
// Both omitted → ok with null bounds (provider may use its own default window).
const r0 = validateCalendarDateRange(undefined, undefined);
assert.equal(r0.ok, true, "no params → ok");
assert.ok(r0.ok && r0.fromMs === null && r0.toMs === null, "no params → null bounds");

// Empty strings treated as omitted (Zod may pass through "")
const rEmpty = validateCalendarDateRange("", "");
assert.equal(rEmpty.ok, true, "empty params → ok");

// Valid date-only and datetime ranges.
const rValid = validateCalendarDateRange("2025-06-01", "2025-06-30");
assert.equal(rValid.ok, true, "valid date range → ok");
assert.ok(rValid.ok && rValid.fromMs! < rValid.toMs!, "fromMs < toMs for valid range");

const rDateTime = validateCalendarDateRange("2025-06-01T00:00:00Z", "2025-06-30T23:59:59Z");
assert.equal(rDateTime.ok, true, "valid datetime range → ok");

// Invalid 'from' → not ok with an explicit error (route maps to 400).
const rBadFrom = validateCalendarDateRange("2025-13-45", "2025-06-30");
assert.equal(rBadFrom.ok, false, "invalid from → not ok");
assert.ok(!rBadFrom.ok && /from/i.test(rBadFrom.error), "invalid from → error names 'from'");

// Invalid 'to' → not ok.
const rBadTo = validateCalendarDateRange("2025-06-01", "garbage");
assert.equal(rBadTo.ok, false, "invalid to → not ok");
assert.ok(!rBadTo.ok && /to/i.test(rBadTo.error), "invalid to → error names 'to'");

// from > to → not ok (inverted range rejected, no silent swap).
const rInverted = validateCalendarDateRange("2025-06-30", "2025-06-01");
assert.equal(rInverted.ok, false, "from > to → not ok");
assert.ok(!rInverted.ok && /after/i.test(rInverted.error), "inverted range → 'after' error");

// Feb-30 rollover rejected at the range level too.
const rFeb30 = validateCalendarDateRange("2025-02-30", undefined);
assert.equal(rFeb30.ok, false, "Feb 30 from → not ok");

// ── 21. providerStateNote — three distinct canonical strings ────────────────
const noteConnected = providerStateNote("connected");
const noteFetchErr = providerStateNote("fetch_error");
const noteNotConf = providerStateNote("not_configured");
assert.ok(noteConnected.length > 0 && noteFetchErr.length > 0 && noteNotConf.length > 0, "all notes non-empty");
assert.notEqual(noteConnected, noteFetchErr, "connected ≠ fetch_error copy");
assert.notEqual(noteConnected, noteNotConf, "connected ≠ not_configured copy");
assert.notEqual(noteFetchErr, noteNotConf, "fetch_error ≠ not_configured copy");

// ── 22. runEconomicEventsSync — not_configured short-circuits, no fetch ──────
let fetchCalled = false;
const notConfigured = await runEconomicEventsSync({
  enabled: false,
  daysAhead: 7,
  syncFromProvider: async () => {
    fetchCalled = true;
    return { provider: "trading_economics", upserted: 5 };
  },
});
assert.equal(fetchCalled, false, "provider:none MUST NOT call syncFromProvider (no fetch)");
assert.equal(notConfigured.status, 200, "not_configured → 200 (honest, not an error)");
assert.equal(notConfigured.body.providerState, "not_configured", "providerState not_configured");
assert.equal(notConfigured.body.configured, false, "configured false");
assert.equal(notConfigured.body.connected, false, "connected false");
assert.equal(notConfigured.body.eventsSynced, 0, "eventsSynced 0");
assert.equal(notConfigured.body.upserted, 0, "upserted 0 (no fake success)");
assert.equal(notConfigured.body.provider, "none", "provider none");
assert.equal(
  notConfigured.body.message,
  "Economic calendar provider is not configured",
  "exact not_configured message",
);

// ── 23. runEconomicEventsSync — connected path reports real counts ──────────
const connected = await runEconomicEventsSync({
  enabled: true,
  daysAhead: 14,
  syncFromProvider: async () => ({ provider: "trading_economics", upserted: 12 }),
});
assert.equal(connected.status, 200, "connected → 200");
assert.equal(connected.body.providerState, "connected", "providerState connected");
assert.equal(connected.body.configured, true, "configured true");
assert.equal(connected.body.connected, true, "connected true");
assert.equal(connected.body.eventsSynced, 12, "eventsSynced reflects real upsert count");
assert.equal(connected.body.upserted, 12, "upserted alias matches eventsSynced");
assert.equal(connected.body.daysAhead, 14, "daysAhead echoed");

// ── 24. runEconomicEventsSync — fetch throw → fetch_error 500, onError fired ─
let errorSeen: unknown = null;
const fetchError = await runEconomicEventsSync({
  enabled: true,
  daysAhead: 7,
  onError: (e) => { errorSeen = e; },
  syncFromProvider: async () => { throw new Error("provider 503"); },
});
assert.equal(fetchError.status, 500, "fetch throw → 500");
assert.equal(fetchError.body.providerState, "fetch_error", "providerState fetch_error");
assert.equal(fetchError.body.configured, true, "configured true on fetch_error (provider IS set)");
assert.equal(fetchError.body.connected, false, "connected false on fetch_error");
assert.equal(fetchError.body.eventsSynced, 0, "eventsSynced 0 on fetch_error");
assert.ok(errorSeen instanceof Error, "onError received the thrown error");

console.log("All 24 economic-calendar core tests passed.");
