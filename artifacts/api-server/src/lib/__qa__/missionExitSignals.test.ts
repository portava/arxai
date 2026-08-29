// ── DEFECT 4 — the unattended exit manager must not run blind ────────────────
//
// The bug: `missionDriver.manageOpenExits` passed an EMPTY signals object into
// `manageMissionTradeExit`, so invalidation, structure break, order-flow
// reversal, high-impact news and unstable spread were `undefined` on EVERY
// unattended tick. The automated exit manager could only ever see price-based
// triggers, and their silence was indistinguishable from an all-clear.
//
// What is pinned here:
//   1. The pure derivations — each one returns null (NOT false) whenever the
//      inputs cannot support a claim, so an unmeasurable axis is never
//      reported calm.
//   2. `assembleMissionExitSignals` reads the real source seams and populates
//      the bundle; every source that cannot answer records an explicit
//      unavailability instead of a benign default, and the assembler never
//      throws.
//   3. The driver tick actually hands those populated signals — and the
//      unavailability record — to the exit manager.
//   4. The pure exit engine surfaces declared blindness as a warning, so a
//      partially blind decision says so out loud.
//
// Offline: every source is injected; no DB, no network, no market data.
//
// Run: pnpm --filter @workspace/api-server run test:mission-exit-signals
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../data/types.js";

const {
  assembleMissionExitSignals,
  meanTrueRange,
  closedBeyondStop,
  orderFlowAgainst,
  structureBrokeAgainst,
  agentsDisagree,
  unstableSpreadFrom,
  UNSTABLE_SPREAD_MULTIPLE,
  AGENT_STANCE_MAX_AGE_MS,
} = await import("../missionExitSignals.js");
const { manageOpenExits } = await import("../missionDriver.js");
const { decideExit } = await import("@workspace/domain/profit-mission");

const NOW = 1_800_000_000_000;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A rising series: 40 bars, each closing above its open. */
function risingCandles(n = 40, start = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = start + i;
    const close = open + 0.5;
    out.push({ time: new Date(NOW - (n - i) * 60_000).toISOString(), open, high: close + 0.2, low: open - 0.2, close });
  }
  return out;
}

/** A falling series: 40 bars, each closing below its open. */
function fallingCandles(n = 40, start = 200): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = start - i;
    const close = open - 0.5;
    out.push({ time: new Date(NOW - (n - i) * 60_000).toISOString(), open, high: open + 0.2, low: close - 0.2, close });
  }
  return out;
}

const ctx = {
  userId: 11,
  missionId: 22,
  symbol: "EURUSD",
  side: "BUY" as const,
  timeframe: "M5",
  stopLoss: 95,
  nowMs: NOW,
};

function newsPack(over: Record<string, unknown> = {}) {
  return {
    symbol: "EURUSD",
    generatedAt: new Date(NOW).toISOString(),
    riskLevel: "high",
    bias: "unclear",
    timing: "upcoming",
    warningSummary: "",
    recommendation: "wait",
    upcomingEvent: null,
    recentHeadlines: [],
    affectedCurrencies: [],
    dataSources: {
      headlines: { connected: true, provider: "x", count: 0 },
      calendar: { connected: true, provider: "x", providerState: "connected", note: "" },
      social: { connected: false, provider: "none", note: "" },
    },
    safetyNote: "",
    ...over,
  } as never;
}

function quoteOk(bid: number, ask: number) {
  return {
    ok: true,
    symbol: "EURUSD",
    assetClass: "forex",
    quote: { symbol: "EURUSD", bid, ask, timestamp: new Date(NOW).toISOString() },
    primaryProvider: "mt5_broker",
    attempts: [],
    userMessage: "",
    adminDetail: "",
  } as never;
}

function candlesOk(candles: Candle[]) {
  return {
    ok: true,
    verdict: "SERVE",
    reason: null,
    symbol: "EURUSD",
    assetClass: "forex",
    intendedVenue: "mt5",
    candles,
    primaryProvider: "mt5_broker",
    attempts: [],
    userMessage: "",
    adminDetail: "",
  } as never;
}

/** The decision-grade refusal: the EXECUTION broker's own feed could not serve. */
function candlesWait(reason: string) {
  return {
    ok: false,
    verdict: "WAIT",
    reason,
    symbol: "EURUSD",
    assetClass: "forex",
    intendedVenue: "mt5",
    candles: [],
    primaryProvider: null,
    attempts: [],
    userMessage: "",
    adminDetail: "",
  } as never;
}

/** Every source answering with real, readable data. */
function allSourcesOk(over: Record<string, unknown> = {}) {
  return {
    news: async () => newsPack(),
    quote: async () => quoteOk(1.1000, 1.1002),
    candles: async () => candlesOk(fallingCandles()),
    brokerSpec: async () => ({ point: 0.0001, spreadPoints: 10 }),
    agentStances: async () => [{ direction: "SELL", createdAtMs: NOW - 1_000 }],
    ...over,
  } as never;
}

// ── 1. The pure derivations refuse to invent an all-clear ───────────────────

test("meanTrueRange returns null (never 0) on insufficient history", () => {
  assert.equal(meanTrueRange([], 14), null);
  assert.equal(meanTrueRange(risingCandles(10), 14), null);
  const atr = meanTrueRange(risingCandles(40), 14);
  assert.ok(atr != null && atr > 0);
});

test("closedBeyondStop is null with no stop reference — never false", () => {
  assert.equal(closedBeyondStop({ side: "BUY", stopLoss: null, lastClose: 90 }), null);
  assert.equal(closedBeyondStop({ side: "BUY", stopLoss: 95, lastClose: null }), null);
  assert.equal(closedBeyondStop({ side: "BUY", stopLoss: 95, lastClose: 90 }), true);
  assert.equal(closedBeyondStop({ side: "BUY", stopLoss: 95, lastClose: 99 }), false);
  assert.equal(closedBeyondStop({ side: "SELL", stopLoss: 95, lastClose: 99 }), true);
});

test("orderFlowAgainst needs enough bars; a mixed window is not a reversal", () => {
  assert.equal(orderFlowAgainst({ side: "BUY", candles: risingCandles(2) }), null);
  assert.equal(orderFlowAgainst({ side: "BUY", candles: fallingCandles() }), true);
  assert.equal(orderFlowAgainst({ side: "BUY", candles: risingCandles() }), false);
  assert.equal(orderFlowAgainst({ side: "SELL", candles: risingCandles() }), true);
});

test("structureBreak is a BREAK EVENT, not a directional lean", () => {
  // Review fix: `structureBreak` maps in decideExit to an UNCONDITIONAL full
  // CLOSE of a live position, so it must mean what its reason string says. It
  // used to be "the chart bias points the other way" — the condition
  // chartStructure itself reports as a counter-trend CAUTION — which closed a
  // deliberately counter-trend position on the first unattended tick.
  // A break is now a CLOSED bar beyond the level the position depended on.

  // Persistent decline: each bar closes below the whole prior window → broken.
  assert.equal(structureBrokeAgainst({ side: "BUY", candles: fallingCandles() }), true);
  assert.equal(structureBrokeAgainst({ side: "SELL", candles: risingCandles() }), true);
  // The same series does NOT break the position that agrees with it.
  assert.equal(structureBrokeAgainst({ side: "SELL", candles: fallingCandles() }), false);
  assert.equal(structureBrokeAgainst({ side: "BUY", candles: risingCandles() }), false);

  // A BUY holding inside its recent range is NOT a break, however the chart
  // "leans" — this is the exact case that used to trigger a full close.
  const chop: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const open = 100 + (i % 2 === 0 ? 0.4 : -0.4);
    const close = 100 + (i % 2 === 0 ? -0.4 : 0.4);
    chop.push({
      time: new Date(NOW - (40 - i) * 60_000).toISOString(),
      open, high: 100.6, low: 99.4, close,
    });
  }
  assert.equal(structureBrokeAgainst({ side: "BUY", candles: chop }), false);

  // …and one decisive close below that range IS a break.
  const broken = [...chop];
  broken.push({ time: new Date(NOW).toISOString(), open: 99.5, high: 99.6, low: 98.0, close: 98.2 });
  assert.equal(structureBrokeAgainst({ side: "BUY", candles: broken }), true);

  // Not enough history is null — never a fabricated "structure intact".
  assert.equal(structureBrokeAgainst({ side: "BUY", candles: risingCandles(5) }), null);
});

test("agentsDisagree: abstentions are not disagreement; a split is", () => {
  assert.equal(agentsDisagree({ side: "BUY", directions: ["NONE", "NONE"] }), false);
  assert.equal(agentsDisagree({ side: "BUY", directions: ["BUY"] }), false);
  assert.equal(agentsDisagree({ side: "BUY", directions: ["SELL"] }), true);
  assert.equal(agentsDisagree({ side: "BUY", directions: ["BUY", "SELL"] }), true);
});

test("unstableSpreadFrom is null whenever any component is missing", () => {
  assert.equal(unstableSpreadFrom({ bid: null, ask: 1.1, point: 0.0001, referenceSpreadPoints: 10 }), null);
  assert.equal(unstableSpreadFrom({ bid: 1.1, ask: 1.1002, point: null, referenceSpreadPoints: 10 }), null);
  assert.equal(unstableSpreadFrom({ bid: 1.1, ask: 1.1002, point: 0.0001, referenceSpreadPoints: null }), null);
  // 2 points live vs a 10-point broker reference → stable.
  assert.equal(unstableSpreadFrom({ bid: 1.1, ask: 1.1002, point: 0.0001, referenceSpreadPoints: 10 }), false);
  // 40 points live vs 10 → at/above the documented multiple → unstable.
  assert.ok(UNSTABLE_SPREAD_MULTIPLE >= 2);
  assert.equal(unstableSpreadFrom({ bid: 1.1, ask: 1.1040, point: 0.0001, referenceSpreadPoints: 10 }), true);
});

// ── 2. The assembler populates real signals, or says it could not ───────────

test("an unattended assembly with live sources populates every signal", async () => {
  const r = await assembleMissionExitSignals(ctx, allSourcesOk());
  assert.deepEqual(r.unavailable, [], "nothing should be unavailable when every source answers");
  assert.equal(r.signals.highImpactNewsImminent, true);
  assert.equal(r.signals.unstableSpread, false);
  assert.equal(r.signals.structureBreak, true, "a persistent decline breaks a BUY's structure");
  assert.equal(r.signals.orderFlowReversal, true);
  assert.equal(r.signals.invalidation, false, "price is still above the stop");
  assert.equal(r.signals.agentDisagreement, true);
  assert.ok(typeof r.signals.atr === "number" && r.signals.atr > 0);
});

test("a DISCONNECTED calendar records unavailability — it never reads as 'no news'", async () => {
  const r = await assembleMissionExitSignals(
    ctx,
    allSourcesOk({
      news: async () =>
        newsPack({
          dataSources: {
            headlines: { connected: false, provider: "none", count: 0 },
            calendar: { connected: false, provider: "none", providerState: "not_configured", note: "" },
            social: { connected: false, provider: "none", note: "" },
          },
        }),
    }),
  );
  assert.equal("highImpactNewsImminent" in r.signals, false, "must be ABSENT, not false");
  assert.deepEqual(
    r.unavailable.filter((u) => u.signal === "highImpactNewsImminent"),
    [{ signal: "highImpactNewsImminent", source: "news_intelligence:economic_calendar", reason: "CALENDAR_NOT_CONNECTED" }],
  );
});

test("an unavailable quote records unavailability instead of a calm spread", async () => {
  const r = await assembleMissionExitSignals(
    ctx,
    allSourcesOk({ quote: async () => ({ ok: false, quote: null, attempts: [] }) }),
  );
  assert.equal("unstableSpread" in r.signals, false);
  assert.ok(r.unavailable.some((u) => u.signal === "unstableSpread" && u.reason === "QUOTE_UNAVAILABLE"));
});

test("no broker spread reference → unavailable, never 'spread looks fine'", async () => {
  const r = await assembleMissionExitSignals(
    ctx,
    allSourcesOk({ brokerSpec: async () => ({ point: 0.0001, spreadPoints: null }) }),
  );
  assert.equal("unstableSpread" in r.signals, false);
  assert.ok(r.unavailable.some((u) => u.reason === "NO_BROKER_SPREAD_REFERENCE"));
});

test("a failed candle read blinds FOUR signals honestly and none of them defaults to calm", async () => {
  const r = await assembleMissionExitSignals(
    ctx,
    allSourcesOk({ candles: async () => { throw new Error("feed down"); } }),
  );
  for (const key of ["structureBreak", "invalidation", "orderFlowReversal", "atr"]) {
    assert.equal(key in r.signals, false, `${key} must be absent`);
    assert.ok(
      r.unavailable.some((u) => u.signal === key && u.reason === "CANDLES_UNAVAILABLE"),
      `${key} must record unavailability`,
    );
  }
});

test("a decision-grade WAIT blinds the candle signals and carries the venue's OWN reason", async () => {
  // Review fix: these signals end in a real broker CLOSE, so they read the
  // EXECUTION broker's feed (`routeCandlesForDecision`), never the display
  // fallback chain. A stale execution feed is declared blindness — it is NOT
  // silently replaced with a fresh-looking series from another venue.
  const r = await assembleMissionExitSignals(
    ctx,
    allSourcesOk({ candles: async () => candlesWait("MT5_BROKER_HISTORY_STALE") }),
  );
  for (const key of ["structureBreak", "invalidation", "orderFlowReversal", "atr"]) {
    assert.equal(key in r.signals, false, `${key} must be absent, not calm`);
    assert.ok(
      r.unavailable.some(
        (u) =>
          u.signal === key
          && u.reason === "MT5_BROKER_HISTORY_STALE"
          && u.source === "market_data_router:candles_for_decision",
      ),
      `${key} must name the execution feed's own refusal`,
    );
  }
});

test("SOURCE PIN: the exit-signal candle read is decision-grade, never the display chain", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = (await import("node:path")).default;
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../missionExitSignals.ts"),
    "utf8",
  );
  assert.match(src, /routeCandlesForDecision/);
  // Code only — the header comment names the display router to explain why it
  // is NOT used here, and that sentence must stay readable.
  const code = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  assert.equal(
    /\brouteCandles\b(?!ForDecision)/.test(code),
    false,
    "the display-grade router must not feed an execution decision",
  );
});

test("a position with no stop has no invalidation reference — recorded, not assumed safe", async () => {
  const r = await assembleMissionExitSignals({ ...ctx, stopLoss: null }, allSourcesOk());
  assert.equal("invalidation" in r.signals, false);
  assert.ok(r.unavailable.some((u) => u.signal === "invalidation" && u.reason === "NO_STOP_LOSS_REFERENCE"));
});

test("stale agent stances are reported stale, not treated as agreement", async () => {
  const r = await assembleMissionExitSignals(
    ctx,
    allSourcesOk({
      agentStances: async () => [{ direction: "SELL", createdAtMs: NOW - AGENT_STANCE_MAX_AGE_MS - 1 }],
    }),
  );
  assert.equal("agentDisagreement" in r.signals, false);
  assert.ok(r.unavailable.some((u) => u.reason === "AGENT_STANCES_STALE"));
});

test("no agent stances at all is recorded, not read as consensus", async () => {
  const r = await assembleMissionExitSignals(ctx, allSourcesOk({ agentStances: async () => [] }));
  assert.equal("agentDisagreement" in r.signals, false);
  assert.ok(r.unavailable.some((u) => u.reason === "NO_AGENT_STANCES"));
});

test("every source throwing yields a fully blind, fully declared bundle — and never throws", async () => {
  const boom = async () => { throw new Error("down"); };
  const r = await assembleMissionExitSignals(ctx, {
    news: boom as never,
    quote: boom as never,
    candles: boom as never,
    brokerSpec: boom as never,
    agentStances: boom as never,
  });
  assert.deepEqual(r.signals, {}, "no signal may be invented when nothing could be read");
  const blinded = new Set(r.unavailable.map((u) => u.signal));
  for (const key of [
    "highImpactNewsImminent", "unstableSpread", "structureBreak",
    "invalidation", "orderFlowReversal", "atr", "agentDisagreement",
  ]) {
    assert.ok(blinded.has(key as never), `${key} must be declared unavailable`);
  }
});

// ── 3. The driver tick hands the real bundle to the exit manager ────────────

test("an unattended driver tick passes POPULATED signals to the exit manager", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const managed = await manageOpenExits(
    { id: 22, userId: 11, executionMode: "live" } as never,
    {
      nowMs: NOW,
      loadOpenExitDrafts: async () => [
        { draftId: "d1", symbol: "EURUSD", timeframe: "M5", direction: "BUY", stopLoss: 95 },
      ],
      exitSignals: async (c) => {
        assert.equal(c.symbol, "EURUSD");
        assert.equal(c.side, "BUY");
        assert.equal(c.stopLoss, 95);
        return assembleMissionExitSignals(c, allSourcesOk());
      },
      exitManager: async (args) => {
        seen.push(args.signals as Record<string, unknown>);
        return { ok: true, dispatched: false } as never;
      },
    },
  );
  assert.equal(managed, 0);
  assert.equal(seen.length, 1);
  const s = seen[0]!;
  // The exact regression: this used to be `{}` on every unattended tick.
  assert.notDeepEqual(s, {});
  assert.equal(s["structureBreak"], true);
  assert.equal(s["orderFlowReversal"], true);
  assert.equal(s["highImpactNewsImminent"], true);
  assert.equal(s["agentDisagreement"], true);
  assert.equal(s["unstableSpread"], false);
  assert.equal(s["invalidation"], false);
});

test("an unattended tick with a dead source hands the exit manager the UNAVAILABILITY record", async () => {
  const seen: Array<Record<string, unknown>> = [];
  await manageOpenExits(
    { id: 22, userId: 11, executionMode: "live" } as never,
    {
      nowMs: NOW,
      loadOpenExitDrafts: async () => [
        { draftId: "d1", symbol: "EURUSD", timeframe: "M5", direction: "BUY", stopLoss: 95 },
      ],
      exitSignals: async (c) =>
        assembleMissionExitSignals(c, allSourcesOk({ candles: async () => { throw new Error("down"); } })),
      exitManager: async (args) => {
        seen.push(args.signals as Record<string, unknown>);
        return { ok: true, dispatched: false } as never;
      },
    },
  );
  const unavailable = seen[0]?.["unavailable"] as Array<{ signal: string; reason: string }> | undefined;
  assert.ok(Array.isArray(unavailable) && unavailable.length > 0);
  assert.ok(unavailable.some((u) => u.signal === "structureBreak" && u.reason === "CANDLES_UNAVAILABLE"));
  // …and the blinded keys are absent rather than false.
  assert.equal("structureBreak" in (seen[0] as object), false);
});

test("a signal-assembly failure still manages exits, with TOTAL blindness declared", async () => {
  const seen: Array<Record<string, unknown>> = [];
  await manageOpenExits(
    { id: 22, userId: 11, executionMode: "live" } as never,
    {
      nowMs: NOW,
      loadOpenExitDrafts: async () => [
        { draftId: "d1", symbol: "EURUSD", timeframe: "M5", direction: "BUY", stopLoss: 95 },
      ],
      exitSignals: async () => { throw new Error("assembler exploded"); },
      exitManager: async (args) => {
        seen.push(args.signals as Record<string, unknown>);
        return { ok: true, dispatched: false } as never;
      },
    },
  );
  assert.equal(seen.length, 1, "exit management must still run");
  const unavailable = seen[0]?.["unavailable"] as Array<{ reason: string }> | undefined;
  assert.equal(unavailable?.length, 7);
  assert.ok(unavailable?.every((u) => u.reason === "SIGNAL_ASSEMBLY_FAILED"));
});

test("a paper/demo mission still manages no exits (no positions exist)", async () => {
  let called = 0;
  const managed = await manageOpenExits(
    { id: 22, userId: 11, executionMode: "paper" } as never,
    { nowMs: NOW, loadOpenExitDrafts: async () => { called += 1; return []; } },
  );
  assert.equal(managed, 0);
  assert.equal(called, 0);
});

// ── 4. Declared blindness reaches the decision ─────────────────────────────

test("decideExit surfaces declared blindness as a warning — silence is not an all-clear", () => {
  const blind = decideExit({
    side: "BUY",
    entryPrice: 100,
    currentPrice: 101,
    stopLoss: 99,
    takeProfit: 110,
    unobservedSignals: ["highImpactNewsImminent (CALENDAR_NOT_CONNECTED)"],
  });
  assert.ok(
    blind.warnings.some((w) => w.includes("CALENDAR_NOT_CONNECTED")),
    "the decision must carry what it could not see",
  );
  assert.ok(blind.warnings.some((w) => /not an all-clear/i.test(w)));

  // No declaration = no invented warning (and no behaviour change).
  const quiet = decideExit({
    side: "BUY", entryPrice: 100, currentPrice: 101, stopLoss: 99, takeProfit: 110,
  });
  assert.equal(quiet.warnings.some((w) => /not an all-clear/i.test(w)), false);
});

test("declared blindness rides the price-unknown refusal too", () => {
  const d = decideExit({
    side: "BUY",
    entryPrice: null,
    currentPrice: null,
    unobservedSignals: ["atr (CANDLES_UNAVAILABLE)"],
  });
  assert.equal(d.action, "NONE");
  assert.ok(d.warnings.some((w) => w.includes("CANDLES_UNAVAILABLE")));
});
