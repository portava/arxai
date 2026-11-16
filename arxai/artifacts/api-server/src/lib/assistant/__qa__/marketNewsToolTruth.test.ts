// Truth regression: getMarketNewsIntelligence (the model restates it) must not
// turn "no economic calendar answered" into "no scheduled news / risk none /
// quiet". Unchecked scheduled-event risk reads unknown / not_checked; a failed
// read reads unknown; a connected calendar's verdict passes through unchanged;
// synthetic indices (not moved by scheduled events) keep their "none".
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Pack = Record<string, unknown> & {
  symbol: string;
  dataSources: {
    headlines: { connected: boolean; provider: string; count: number };
    calendar: { connected: boolean; provider: string; providerState: string; note: string };
    social: { connected: boolean; provider: string; note: string };
  };
};

function pack(symbol: string, calendar: Pack["dataSources"]["calendar"], headlinesConnected = false, over: Partial<Pack> = {}): Pack {
  return {
    symbol,
    generatedAt: "2026-10-28T09:00:00.000Z",
    riskLevel: "none",
    bias: "unclear",
    timing: "quiet",
    warningSummary: `No major scheduled news for ${symbol} in the current window.`,
    recommendation: "watch",
    upcomingEvent: null,
    recentHeadlines: [],
    affectedCurrencies: [],
    dataSources: {
      headlines: { connected: headlinesConnected, provider: headlinesConnected ? "finnhub" : "none", count: 0 },
      calendar,
      social: { connected: false, provider: "none", note: "" },
    },
    safetyNote: "Decision support only.",
    ...over,
  };
}

const NOT_CONFIGURED = { connected: false, provider: "none", providerState: "not_configured", note: "" };
const FETCH_ERROR = { connected: false, provider: "trading_economics", providerState: "fetch_error", note: "" };
const CONNECTED = { connected: true, provider: "trading_economics", providerState: "connected", note: "" };

let next: Pack | Error = pack("EURUSD", NOT_CONFIGURED);
mock.module("../../news/newsIntelligenceService.js", {
  namedExports: {
    getNewsIntelligence: async () => {
      if (next instanceof Error) throw next;
      return next;
    },
  },
});

const { dispatchTool } = await import("../tools.js");
const { FAIL_CLOSED_ENVELOPE } = await import("../derivedEnvelope.js");

async function run(): Promise<Record<string, unknown>> {
  return (await dispatchTool("getMarketNewsIntelligence", { symbol: "EURUSD" }, 1, undefined, FAIL_CLOSED_ENVELOPE)) as Record<string, unknown>;
}

test("calendar not configured: scheduled news reads not checked / unknown, never 'no major scheduled news'", async () => {
  next = pack("EURUSD", NOT_CONFIGURED);
  const r = await run();
  assert.equal(r.scheduledEventRisk, "not_checked");
  assert.equal(r.riskLevel, "unknown");
  assert.equal(r.timing, "unknown");
  assert.doesNotMatch(String(r.warningSummary), /No major scheduled news/i);
  assert.match(String(r.warningSummary), /not checked/);
  assert.match(String(r.warningSummary), /no economic-calendar provider is connected/);
  assert.match(String(r.safetyNote), /never say there are no events/);
  assert.equal(r.headlinesChecked, false);
});

test("calendar fetch failed: names the failed check", async () => {
  next = pack("EURUSD", FETCH_ERROR, true);
  const r = await run();
  assert.equal(r.scheduledEventRisk, "not_checked");
  assert.equal(r.riskLevel, "unknown");
  assert.match(String(r.warningSummary), /economic calendar did not answer/);
  assert.equal(r.headlinesChecked, true);
  assert.match(String(r.safetyNote), /never say there are no events/);
});

test("connected calendar: its real verdict passes through unchanged", async () => {
  next = pack("EURUSD", CONNECTED, true, { riskLevel: "none", timing: "quiet" });
  const r = await run();
  assert.equal(r.scheduledEventRisk, "checked");
  assert.equal(r.riskLevel, "none");
  assert.equal(r.timing, "quiet");
  assert.equal(r.warningSummary, "No major scheduled news for EURUSD in the current window.");
  assert.equal(r.safetyNote, "Decision support only.");
});

test("synthetic index: scheduled events do not apply, 'none' stays", async () => {
  next = pack("R_75", NOT_CONFIGURED);
  const r = await run();
  assert.equal(r.scheduledEventRisk, "not_applicable");
  assert.equal(r.riskLevel, "none");
});

test("service throws: nothing was checked — risk/timing unknown, never none/quiet", async () => {
  next = new Error("boom");
  const r = await run();
  assert.equal(r.riskLevel, "unknown");
  assert.equal(r.timing, "unknown");
  assert.equal(r.scheduledEventRisk, "not_checked");
  assert.equal(r.headlinesChecked, false);
  assert.match(String(r.warningSummary), /not checked/);
});
