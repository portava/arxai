// Regression: a decision receipt is an immutable record of the Ruby read the
// user saw. The read paths (draft-read, read-chart, draw-setup) build their
// state through buildRubyChartContext, which enriches it with the user's own
// bound broker quote; POST /me/chart/decision-receipt and the fire-and-forget
// recorder built a bare buildChartIntelligenceState instead. With the mirror
// unmeasured the stored read was the gated "syncing" one, not the directional
// read the user had in front of them.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const BARE = { tag: "bare", feedUsable: false };
const ENRICHED = { tag: "enriched", feedUsable: true };
const enrichCalls: Array<Record<string, unknown>> = [];
const receipts: Array<{ state: any; draftRead: any }> = [];
let receiptWritten: (() => void) | null = null;

const intelMod = await import("../../lib/data/chart/chartIntelligence.js");
mock.module("../../lib/data/chart/chartIntelligence.js", {
  namedExports: { ...intelMod, buildChartIntelligenceState: async () => BARE },
});
const alignMod = await import("../../lib/data/chart/userBrokerAlignment.js");
mock.module("../../lib/data/chart/userBrokerAlignment.js", {
  namedExports: {
    ...alignMod,
    enrichStateWithUserBrokerQuote: async (_state: unknown, args: Record<string, unknown>) => {
      enrichCalls.push(args);
      return ENRICHED;
    },
  },
});
const draftMod = await import("../../lib/assistant/rubyDraftRead.js");
mock.module("../../lib/assistant/rubyDraftRead.js", {
  namedExports: {
    ...draftMod,
    buildRubyDraftRead: (state: { tag: string; feedUsable: boolean }) => ({
      intent: "analyze",
      headline: state.feedUsable ? "Bullish structure on EURUSD M5." : "Chart data is syncing…",
      confidenceScore: state.feedUsable ? 71 : null,
      confidenceLabel: state.feedUsable ? "Medium" : null,
    }),
  },
});
const receiptMod = await import("../../lib/chart/decisionReceipts.js");
mock.module("../../lib/chart/decisionReceipts.js", {
  namedExports: {
    ...receiptMod,
    createDecisionReceipt: async (args: { state: unknown; draftRead: unknown }) => {
      receipts.push(args as { state: any; draftRead: any });
      receiptWritten?.();
      return { receiptId: `rcpt-${receipts.length}` };
    },
    getUserReceipt: async (_u: number, id: string) => ({ receipt: { receiptId: id } }),
  },
});
const nameMod = await import("../../lib/assistant/assistantName.js");
mock.module("../../lib/assistant/assistantName.js", {
  namedExports: { ...nameMod, getAssistantDisplayName: async () => "Ruby" },
});
const memoryMod = await import("../../lib/chart/chartDecisionMemory.js");
mock.module("../../lib/chart/chartDecisionMemory.js", {
  namedExports: { ...memoryMod, recordChartDecisionEvents: async () => {} },
});

const { meChartBrainRouter: chartBrainRouter } = await import("../meChartBrain.js");
const { recordRubyReadDecision } = await import("../../lib/chart/recordRubyRead.js");
const { withRouter } = await import("./_fakeRouteDb.js");

beforeEach(() => { enrichCalls.length = 0; receipts.length = 0; receiptWritten = null; });

test("POST /me/chart/decision-receipt records the read built from the user's enriched state", async () => {
  await withRouter(chartBrainRouter, { id: 7, role: "TRADER" }, async (base) => {
    const r = await fetch(`${base}/me/chart/decision-receipt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "EURUSD", timeframe: "M5", intent: "analyze", source: "chart_read" }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).created, true);
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.state, ENRICHED, "the receipt state carries the user's broker-quote enrichment");
  assert.equal(receipts[0]!.draftRead.headline, "Bullish structure on EURUSD M5.");
  assert.notEqual(receipts[0]!.draftRead.headline, "Chart data is syncing…");
  assert.deepEqual(enrichCalls[0], { userId: 7, symbol: "EURUSD", timeframe: "M5", limit: 300 });
});

test("the fire-and-forget recorder enriches too when no state is handed to it", async () => {
  const written = new Promise<void>((resolve) => { receiptWritten = resolve; });
  recordRubyReadDecision({ userId: 9, source: "ruby_explain_signal", symbol: "EURUSD", timeframe: "M5" });
  await written;
  assert.equal(receipts[0]!.state, ENRICHED);
  assert.equal(enrichCalls[0]!.userId, 9);
});
