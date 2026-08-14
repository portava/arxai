// Task #573 — every non-admin-reachable route that emits simulator-derived
// SCORED analysis must mask that detail for non-privileged viewers, using the
// SAME role gate as the scanner rows (viewerSeesSimulatorDetail). This drives
// the REAL aiBrain + scanner routers over HTTP and proves, for all seven leak
// routes, that:
//   (a) a non-admin (TESTER) caller gets every simulator score withheld —
//       the payload carries `withheld: true` and the headline scores are 0;
//   (b) an ADMIN/OWNER caller still sees the raw simulator detail (no
//       `withheld` flag, real scores).
//
// Role is selected with the dev-only `x-security-role` header, exactly like the
// sibling RBAC route tests. The seven routes are otherwise unauthenticated
// (role-context only), so no session cookie is required here.
//
// Run: node --import tsx --test src/routes/__qa__/aiHelperSimulatorMask.test.ts

import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Keep the suite hermetic: the only async network path among the seven routes
// is sessionPlan() → scanOnce() (live market-data routing). Stub it to a
// deterministic simulator-shaped plan so the test never reaches a real provider.
// Every other helper (analyzeMarket / opportunityScore / generateTradeCard /
// entrySniperScore / gradeTrade) is a pure synchronous simulator function and
// runs for real, so the route's gate + masker selection is exercised end-to-end.
const realScanner = await import("../../lib/marketScanner.js");
mock.module("../../lib/marketScanner.js", {
  namedExports: {
    ...realScanner,
    scanOnce: async () => [],
    sessionPlan: async () => ({
      bestSymbols: ["EURUSD", "GBPUSD"],
      symbolsToAvoid: ["XAUUSD"],
      preferredStrategy: "Trend Continuation",
      maxTrades: 3,
      maxRiskPerTradeUsd: 20,
      maxRiskPerSessionUsd: 60,
      marketConditions: "Trending across most pairs.",
      rules: ["Reject any setup with confidence < 60."],
      warningZones: ["XAUUSD M15 risk 70"],
      focusAreas: ["Patience"],
      recommendedFirstTest: "Run a paper trade on EURUSD.",
      summary: "Simulator session favors trend continuation.",
      dataSource: "SIMULATOR",
      generatedAt: "2026-06-15T00:00:00.000Z",
    }),
  },
});

const aiBrainRouter = (await import("../aiBrain.js")).default;
const scannerRouter = (await import("../scanner.js")).default;

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", aiBrainRouter);
  app.use("/api", scannerRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

async function post(path: string, role: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-security-role": role },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `${path} (${role}) must be 200`);
  return res.json() as Promise<Record<string, unknown>>;
}

const SYMBOL = { symbol: "EURUSD", timeframe: "M15" };
const TRADE = { symbol: "EURUSD", direction: "BUY", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.13 };

// ── (1) /ai/market-analysis ─────────────────────────────────────────────────
test("/ai/market-analysis masks for TESTER, raw for OWNER", async () => {
  const masked = await post("/api/ai/market-analysis", "TESTER", SYMBOL);
  assert.equal(masked.withheld, true, "non-admin analysis must be withheld");
  assert.equal(masked.confidenceScore, 0, "withheld analysis must zero confidence");
  assert.equal(masked.recommendedAction, "WAIT", "withheld analysis must not recommend a trade");

  const raw = await post("/api/ai/market-analysis", "OWNER", SYMBOL);
  assert.equal(raw.withheld, undefined, "operator sees raw simulator analysis");
  assert.equal(raw.dataSource, "SIMULATOR");
});

// ── (2) /ai/generate-trade-card ─────────────────────────────────────────────
test("/ai/generate-trade-card masks for TESTER, raw for OWNER", async () => {
  const masked = await post("/api/ai/generate-trade-card", "TESTER", SYMBOL);
  assert.equal(masked.withheld, true, "non-admin trade card must be withheld");
  assert.equal(masked.confidenceScore, 0);
  const sizing = masked.positionSizingHint as { suggestedLot: number };
  assert.equal(sizing.suggestedLot, 0, "withheld card must not leak a suggested lot");

  const raw = await post("/api/ai/generate-trade-card", "OWNER", SYMBOL);
  assert.equal(raw.withheld, undefined, "operator sees raw trade card");
});

// ── (3) /ai/entry-sniper-score ──────────────────────────────────────────────
test("/ai/entry-sniper-score masks for TESTER, raw for OWNER", async () => {
  const masked = await post("/api/ai/entry-sniper-score", "TESTER", TRADE);
  assert.equal(masked.withheld, true, "non-admin sniper score must be withheld");
  assert.equal(masked.score, 0);
  assert.equal(masked.label, "DO_NOT_ENTER");
  for (const [k, v] of Object.entries(masked.factors as Record<string, number>)) {
    assert.equal(v, 0, `withheld sniper factor ${k} must be zeroed`);
  }

  const raw = await post("/api/ai/entry-sniper-score", "OWNER", TRADE);
  assert.equal(raw.withheld, undefined, "operator sees raw sniper score");
  assert.equal(raw.dataSource, "SIMULATOR");
});

// ── (4) /ai/grade-trade ─────────────────────────────────────────────────────
test("/ai/grade-trade masks for TESTER, raw for OWNER", async () => {
  const masked = await post("/api/ai/grade-trade", "TESTER", TRADE);
  assert.equal(masked.withheld, true, "non-admin trade grade must be withheld");
  assert.equal(masked.overallScore, 0);
  assert.equal(masked.tradeGrade, "—", "withheld grade shows a neutral placeholder");

  const raw = await post("/api/ai/grade-trade", "OWNER", TRADE);
  assert.equal(raw.withheld, undefined, "operator sees raw trade grade");
});

// ── (5) /ai/opportunity-score (scanner) ─────────────────────────────────────
test("/ai/opportunity-score masks for TESTER, raw for OWNER", async () => {
  const masked = await post("/api/ai/opportunity-score", "TESTER", SYMBOL);
  assert.equal(masked.withheld, true, "non-admin opportunity score must be withheld");
  assert.equal(masked.score, 0);
  assert.equal(masked.label, "REJECT");
  assert.equal(masked.symbol, "EURUSD", "envelope keeps the requested symbol");

  const raw = await post("/api/ai/opportunity-score", "OWNER", SYMBOL);
  assert.equal(raw.withheld, undefined, "operator sees raw opportunity score");
});

// ── (6) /ai/setup-analysis (scanner) ────────────────────────────────────────
test("/ai/setup-analysis masks every nested score for TESTER, raw for OWNER", async () => {
  const masked = await post("/api/ai/setup-analysis", "TESTER", SYMBOL);
  assert.equal(masked.withheld, true, "non-admin setup analysis must be withheld");
  assert.equal((masked.analysis as { withheld?: boolean }).withheld, true);
  assert.equal((masked.opportunity as { score: number }).score, 0);
  assert.equal((masked.card as { withheld?: boolean }).withheld, true);

  const raw = await post("/api/ai/setup-analysis", "OWNER", SYMBOL);
  assert.equal(raw.withheld, undefined, "operator sees raw setup analysis");
  assert.equal((raw.analysis as { withheld?: boolean }).withheld, undefined);
});

// ── (7) /ai/session-plan (scanner; POST + GET) ──────────────────────────────
test("/ai/session-plan masks for TESTER, raw for OWNER (POST + GET)", async () => {
  const masked = await post("/api/ai/session-plan", "TESTER", {});
  assert.equal(masked.withheld, true, "non-admin session plan must be withheld");
  assert.deepEqual(masked.bestSymbols, [], "withheld plan reveals no best symbols");
  assert.equal(masked.maxTrades, 0);

  const rawRes = await fetch(`${base}/api/ai/session-plan`, {
    headers: { "x-security-role": "OWNER" },
  });
  assert.equal(rawRes.status, 200);
  const raw = (await rawRes.json()) as Record<string, unknown>;
  assert.equal(raw.withheld, undefined, "operator sees the raw session plan");
  assert.equal(raw.dataSource, "SIMULATOR");

  // The GET variant must mask identically to POST for a non-admin.
  const getMaskedRes = await fetch(`${base}/api/ai/session-plan`, {
    headers: { "x-security-role": "TESTER" },
  });
  const getMasked = (await getMaskedRes.json()) as Record<string, unknown>;
  assert.equal(getMasked.withheld, true, "GET session-plan must mask for non-admin too");
});
