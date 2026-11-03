// Truth: the Analytics Command Center describes the paper book accurately.
//
// Offline: the REAL analytics router (and its exported helpers) run over an
// in-memory db fake. No database, no broker, no network.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const mod = await import("../analytics.js");
const router = mod.default;

function setRows(rows: FakeRows) { fake = createFakeDb(rows); }
beforeEach(() => setRows({}));

function order(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", orderType: "MARKET",
    lotSize: 1, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095, status: "CLOSED_TP",
    openedAt: new Date("2026-10-20T08:00:00Z"), closedAt: new Date("2026-10-20T09:00:00Z"),
    exitPrice: 1.095, profitLoss: 1, strategyId: null, tradePlanId: null, decisionId: null,
    clientRequestKey: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

async function getJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}${path}`, init);
    body = await r.json() as Record<string, unknown>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

// ── Session heatmap ─────────────────────────────────────────────────────────
// New York closes at 21:00 UTC. A trade opened at 22:30 UTC (Sydney / Tokyo
// open) was counted in NEWYORK because every hour from 13 to 23 mapped there.
test("session: 21:00–24:00 UTC is the Asia-Pacific session, not New York", () => {
  assert.equal(mod.sessionOf(new Date("2026-10-20T22:30:00Z")), "ASIA");
  assert.equal(mod.sessionOf(new Date("2026-10-20T21:00:00Z")), "ASIA");
  assert.equal(mod.sessionOf(new Date("2026-10-20T03:00:00Z")), "ASIA");
  assert.equal(mod.sessionOf(new Date("2026-10-20T07:00:00Z")), "LONDON");
  assert.equal(mod.sessionOf(new Date("2026-10-20T13:00:00Z")), "NEWYORK");
  assert.equal(mod.sessionOf(new Date("2026-10-20T20:59:00Z")), "NEWYORK");
});

test("session: GET /analytics/session buckets a 22:30Z trade in ASIA and states the hours", async () => {
  setRows({
    paper_orders: [
      order({ id: 1, openedAt: new Date("2026-10-20T22:30:00Z") }),
      order({ id: 2, openedAt: new Date("2026-10-20T14:00:00Z") }),
    ],
    post_trade_debriefs: [],
  });
  const body = await getJson("/analytics/session");
  const session = body["session"] as Record<string, { trades: number }>;
  assert.equal(session["ASIA"]!.trades, 1);
  assert.equal(session["NEWYORK"]!.trades, 1);
  assert.match(String(body["sessionBasis"]), /NEWYORK 13:00–21:00/);
  assert.match(String(body["sessionBasis"]), /ASIA 21:00–07:00/);
});

// ── Snapshot freshness and coverage ─────────────────────────────────────────
// A fake whose select chain honours .limit(n), as Postgres does, so a read
// capped at 1000 rows is observable. Rows come back in fixture order.
function setRowsWithLimits(rows: FakeRows) {
  const base = createFakeDb(rows);
  const chainFor = (all: unknown[]) => {
    let out = [...all];
    const self: Record<string, unknown> = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(out).then(ok, bad);
        if (prop === "catch") return (bad: (e: unknown) => unknown) => Promise.resolve(out).catch(bad);
        if (prop === "limit") return (n: number) => { out = out.slice(0, n); return self; };
        return () => self;
      },
    });
    return self;
  };
  fake = { ...base, db: { ...base.db, select: () => ({ from: (table: Table) => chainFor(rows[getTableName(table)] ?? []) }) } };
}

// 1001 closed EURUSD trades in open-time order; only the NEWEST is a loser.
function thousandAndOne() {
  return Array.from({ length: 1001 }, (_, i) => order({
    id: i + 1,
    openedAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
    ...(i === 1000 ? { exitPrice: 1.08, status: "CLOSED_SL" } : {}),
  }));
}

test("snapshot: the figures cover every closed trade, not the oldest 1000", async () => {
  setRowsWithLimits({
    paper_orders: thousandAndOne(),
    trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [],
  });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.totalTrades, 1001);
  // 1000 winners of +$1,000 and the newest trade a −$500 loser.
  assert.equal(Math.round(s.netProfitLoss as number), 1000 * 1000 - 500);
});

test("strategy, drawdown and session panels read the same 1001 trades", async () => {
  setRowsWithLimits({ paper_orders: thousandAndOne(), post_trade_debriefs: [] });
  const strat = await getJson("/analytics/strategy");
  assert.equal((strat["strategies"] as Array<{ trades: number }>)[0]!.trades, 1001);
  const dd = await getJson("/analytics/drawdown");
  assert.equal((dd["equityCurve"] as unknown[]).length, 1001);
  assert.equal(dd["maxDrawdown"], 500);
  const sess = await getJson("/analytics/session");
  const buckets = Object.values(sess["session"] as Record<string, { trades: number }>);
  assert.equal(buckets.reduce((a, b) => a + b.trades, 0), 1001);
});

test("GET /analytics/snapshot: the saved snapshot keeps its time; current figures are computed now with asOf", async () => {
  const savedAt = new Date("2026-10-20T10:00:00Z");
  setRows({
    analytics_snapshots: [{ id: 3, userId: 7, totalTrades: 3, netProfitLoss: 3000, winRate: 1, createdAt: savedAt }],
    paper_orders: [1, 2, 3, 4, 5].map((id) => order({ id })),
    trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [],
  });
  const before = Date.now();
  const body = await getJson("/analytics/snapshot");
  const saved = body["snapshot"] as Record<string, unknown>;
  assert.equal(saved["totalTrades"], 3);
  assert.equal(saved["createdAt"], savedAt.toISOString());
  const current = body["current"] as Record<string, unknown>;
  assert.ok(current, "live figures are returned");
  assert.equal(current["totalTrades"], 5);
  const asOf = Date.parse(String(current["asOf"]));
  assert.ok(Number.isFinite(asOf) && asOf >= before - 1000, `asOf ${String(current["asOf"])} is the time of this read`);
  assert.equal(body["currentError"], null);
});

// ── Highlights: what "strongest" names ──────────────────────────────────────
function edgeRow(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, edgeName: "symbol=EURUSD", symbol: "EURUSD", strategyId: null, timeframe: null,
    sessionName: null, marketCondition: null, sampleSize: 12, winRate: 0.75, averageRr: 1.5,
    expectancy: 40, profitFactor: 2, disciplineScoreAvg: 0, executionScoreAvg: 0, emotionalScoreAvg: 0,
    confidenceScore: 50, status: "DEVELOPING_EDGE", aiSummary: "", createdAt: new Date("2026-10-20T10:00:00Z"),
    ...over,
  };
}

test("highlights: the 'strategy' cards rank symbols; best is net profitable, worst net losing", async () => {
  setRows({
    paper_orders: [
      order({ id: 1, symbol: "EURUSD", strategyId: "A" }),
      order({ id: 2, symbol: "GBPUSD", strategyId: "B", entryPrice: 1.3, stopLoss: 1.29, takeProfit: 1.32, exitPrice: 1.29, status: "CLOSED_SL" }),
    ],
    trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [],
  });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.strongestSymbol, "EURUSD");
  assert.equal(s.weakestSymbol, "GBPUSD");
  assert.match(s.highlightBasis.symbols, /net P&L/);
  // The stored "strategy" columns have always held a symbol.
  assert.equal(mod.toSnapshotRow(s).strongestStrategy, "EURUSD");
  assert.equal("strongestSymbol" in mod.toSnapshotRow(s), false, "not a snapshot column");
});

test("highlights: one profitable symbol is the best and not also the worst", async () => {
  setRows({ paper_orders: [order({ id: 1 })], trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [] });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.strongestSymbol, "EURUSD");
  assert.equal(s.weakestSymbol, null);
});

test("highlights: edge slices come from the edge board's current, re-derived reports", async () => {
  setRows({
    paper_orders: [], trader_skill_profiles: [], post_trade_debriefs: [],
    edge_discovery_reports: [
      // Legacy no-losses marker row: the board re-derives it to DEVELOPING_EDGE.
      edgeRow({ id: 1, edgeName: "symbol=EURUSD", profitFactor: 999, status: "STRONG_EDGE", confidenceScore: 100 }),
      // GBPUSD: an old STRONG generation, but the current run is NO_EDGE.
      edgeRow({ id: 2, edgeName: "symbol=GBPUSD", status: "STRONG_EDGE", confidenceScore: 90, createdAt: new Date("2026-10-01T10:00:00Z") }),
      edgeRow({ id: 3, edgeName: "symbol=GBPUSD", status: "NO_EDGE", expectancy: -50, confidenceScore: 40, createdAt: new Date("2026-10-21T10:00:00Z") }),
      // Too little data: neither strongest nor weakest.
      edgeRow({ id: 4, edgeName: "emotion=CALM", status: "INSUFFICIENT_DATA", sampleSize: 3, confidenceScore: 95 }),
    ],
  });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.strongestEdgeSlice?.label, "EURUSD (by symbol)");
  assert.equal(s.strongestEdgeSlice?.status, "DEVELOPING_EDGE");
  assert.notEqual(s.strongestEdgeSlice?.confidenceScore, 100);
  assert.equal(s.weakestEdgeSlice?.label, "GBPUSD (by symbol)");
  assert.equal(s.weakestEdgeSlice?.status, "NO_EDGE");
  assert.match(s.highlightBasis.edgeSlices, /not by your results in a market condition/);
});

// ── Nothing measured is null, not 0 ─────────────────────────────────────────
test("unmeasured: a new user's figures are null with a reason, not 0 or failing scores", async () => {
  setRows({ paper_orders: [], trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [] });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.totalTrades, 0);
  for (const k of ["winRate", "netProfitLoss", "expectancy", "profitFactor", "averageRr", "maxDrawdown",
    "disciplineScoreAvg", "executionScoreAvg", "emotionalScoreAvg", "consistencyScoreAvg"] as const) {
    assert.equal(s[k], null, `${k} is not measured`);
    assert.ok(s.unmeasured[k], `${k} says why`);
  }
  assert.match(s.unmeasured["disciplineScoreAvg"]!, /No Trader Skill profile/);
  // The NOT NULL columns still get the column default, as before.
  const row = mod.toSnapshotRow(s);
  assert.equal(row.winRate, 0);
  assert.equal(row.disciplineScoreAvg, 0);
});

test("unmeasured: a skill profile with no debriefs does not score discipline, execution or emotion", async () => {
  setRows({
    paper_orders: [order({ id: 1 })],
    trader_skill_profiles: [{ id: 1, userId: 7, disciplineScore: 0, executionScore: 0, consistencyScore: 0, emotionalControlScore: 0, updatedAt: new Date("2026-10-27T09:00:00Z") }],
    post_trade_debriefs: [], edge_discovery_reports: [],
  });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.disciplineScoreAvg, null);
  assert.equal(s.executionScoreAvg, null);
  assert.equal(s.emotionalScoreAvg, null);
  assert.equal(s.consistencyScoreAvg, null);
  assert.match(s.unmeasured["disciplineScoreAvg"]!, /No post-trade debriefs/);
  assert.equal(s.behaviorAsOf, "2026-10-27T09:00:00.000Z");
  // One winning trade: measured win rate and P&L, but no profit factor.
  assert.equal(s.winRate, 1);
  assert.equal(s.netProfitLoss, 1000);
  assert.equal(s.profitFactor, null);
  assert.equal(s.profitFactorBasis, "NO_LOSING_TRADE");
  assert.match(s.unmeasured["profitFactor"]!, /No losing trade/);
  assert.equal(mod.toSnapshotRow(s).profitFactor, 999, "stored exactly as before");
});

test("unmeasured: a trade with no stop distance has no R and is not counted as 0R", async () => {
  setRows({
    paper_orders: [order({ id: 1 }), order({ id: 2, stopLoss: 1.085 })],
    trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [],
  });
  const s = await mod.computeSnapshot(7);
  assert.equal(Math.round((s.averageRr as number) * 100) / 100, 2);
});

test("unmeasured: GET /analytics/snapshot sends the nulls in current", async () => {
  setRows({ analytics_snapshots: [], paper_orders: [], trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [] });
  const body = await getJson("/analytics/snapshot");
  const current = body["current"] as Record<string, unknown>;
  assert.equal(current["winRate"], null);
  assert.equal(current["disciplineScoreAvg"], null);
  assert.equal(current["emotionalScoreAvg"], null);
});

// ── One paper book, consistent figures across boards ────────────────────────
function debrief(id: number, emotion: string) {
  return { id, userId: 7, paperOrderId: id, followedPlan: 1, traderEmotionAfter: emotion, checklist: [] };
}

test("consistency: Emotional is Trader Skill's emotional control score, not a CALM-only share", async () => {
  setRows({
    paper_orders: [order({ id: 1 })],
    // Trader Skill counts NEUTRAL and RELIEVED as controlled: 100 here.
    trader_skill_profiles: [{ id: 1, userId: 7, disciplineScore: 90, executionScore: 70, consistencyScore: 40,
      emotionalControlScore: 100, updatedAt: new Date("2026-10-27T09:00:00Z") }],
    post_trade_debriefs: [debrief(1, "NEUTRAL"), debrief(2, "RELIEVED")],
    edge_discovery_reports: [],
  });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.emotionalScoreAvg, 100, "the same number Trader Skill shows as Emotional control");
});

test("consistency: a cancelled order with an exit price is not a closed trade", async () => {
  setRows({
    paper_orders: [order({ id: 1 }), order({ id: 2, status: "CANCELLED", exitPrice: 1.08 })],
    trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [],
  });
  const s = await mod.computeSnapshot(7);
  assert.equal(s.totalTrades, 1);
  assert.equal(s.netProfitLoss, 1000);
});

test("consistency: the P&L basis says it differs from Ruby Memory's booked demo P&L", async () => {
  setRows({ paper_orders: [order({ id: 1 })], trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [] });
  const s = await mod.computeSnapshot(7);
  assert.match(s.pnlCoverage.note, /USD at each instrument's contract size/);
  assert.match(s.pnlCoverage.note, /Ruby Memory and your demo account show the P&L the paper venue booked on each close/);
  assert.match(s.pnlCoverage.note, /older closes may have been booked as price move × lots × 100/);
  assert.match(s.pnlCoverage.note, /could not size is booked as a placeholder/);
  assert.match(s.pnlCoverage.note, /can differ from this one/);
});
