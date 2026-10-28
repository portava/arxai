// Truth: getMarketStatus().freshnessState is FRESH after ANY successful
// provider call (news, calendar, overview included), and dataFreshness keeps
// the quality of the last quote payload with no time attached. A consumer
// therefore could not tell "a real-time quote just arrived" from "a news fetch
// just succeeded; the last quote, hours ago, was real-time". dataFreshnessAt
// stamps when that quote quality was observed, so the page can require a recent
// real-time quote before it says FRESH.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  _markMarketFetchSuccessForTests,
  _resetMarketProviderForTests,
  getMarketStatus,
} from "../marketProvider.js";

afterEach(() => _resetMarketProviderForTests());

test("a DELAYED quote payload is reported with the time it was observed", () => {
  _resetMarketProviderForTests();
  const before = Date.now();
  _markMarketFetchSuccessForTests({ freshness: "DELAYED", source: "polygon" });
  const s = getMarketStatus() as ReturnType<typeof getMarketStatus> & { dataFreshnessAt?: string | null };
  assert.equal(s.dataFreshness, "DELAYED");
  assert.ok(s.dataFreshnessAt, "dataFreshnessAt must be set when a payload quality is observed");
  assert.ok(Date.parse(s.dataFreshnessAt!) >= before - 1000);
});

test("a success with no quote payload (news, calendar) does not stamp a quote observation", () => {
  _resetMarketProviderForTests();
  _markMarketFetchSuccessForTests();
  const s = getMarketStatus() as ReturnType<typeof getMarketStatus> & { dataFreshnessAt?: string | null };
  assert.equal(s.dataFreshness, null);
  assert.equal(s.dataFreshnessAt ?? null, null);
});

test("reset clears the last observed quote quality", () => {
  _markMarketFetchSuccessForTests({ freshness: "REALTIME", source: "twelve_data" });
  _resetMarketProviderForTests();
  const s = getMarketStatus() as ReturnType<typeof getMarketStatus> & { dataFreshnessAt?: string | null };
  assert.equal(s.dataFreshness, null);
  assert.equal(s.dataFreshnessAt ?? null, null);
});
