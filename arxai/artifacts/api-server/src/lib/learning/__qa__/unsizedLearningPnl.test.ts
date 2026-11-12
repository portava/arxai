// Truth regression: a debrief of a paper close the venue could not size for
// the instrument (no contract size or currency conversion) hands the learning
// engine pnl null — unknown. processLearningPayload turned it into a measured
// 0 (Number(payload.pnl ?? 0)): the event summary read "pnl=0.00", and every
// strategy edge the trade supported added the 0 to its P&L and divided its
// average by one more sample, pulling it toward 0.
//
// Now the unknown P&L stays unknown: the summary says "P&L not sized", the
// event row flags it (learning_events.pnl is NOT NULL, so it holds 0 with
// pnlKnown false and a note), and an existing edge's netPnl and avgPnl are
// left as they were. The win itself is still learned.
//
// The REAL learningEngine and scopedMemory run; the database is a stub that
// returns rows by table and records writes. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/learning/__qa__/unsizedLearningPnl.test.ts
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

const realDb = await import("@workspace/db");

type Row = Record<string, unknown>;
const state: {
  debrief: Row | null; edges: Row[];
  inserts: Array<{ table: string; values: Row }>; updates: Array<{ table: string; set: Row }>;
} = { debrief: null, edges: [], inserts: [], updates: [] };

function chain(rows: () => unknown[]) {
  const self: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(rows).then(ok, bad);
      if (prop === "catch") return (bad: (e: unknown) => unknown) => Promise.resolve().then(rows).catch(bad);
      return () => self;
    },
  });
  return self;
}
const fakeDb = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
  execute: async () => undefined,
  select: () => ({
    from: (table: Table) => chain(() => {
      const name = getTableName(table);
      if (name === "post_trade_debriefs") return state.debrief ? [state.debrief] : [];
      if (name === "strategy_edges") return state.edges;
      return [];
    }),
  }),
  insert: (table: Table) => ({
    values: (values: Row) => {
      state.inserts.push({ table: getTableName(table), values });
      return chain(() => [{ id: 1, ...values }]);
    },
  }),
  update: (table: Table) => ({
    set: (set: Row) => {
      state.updates.push({ table: getTableName(table), set });
      return chain(() => [{ ...(state.edges[0] ?? {}), ...set }]);
    },
  }),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });

const { processLearningPayload } = await import("../../learningEngine.js");

const EDGE = {
  id: 3, userId: 7, scopeType: "user", scopeOwner: 7, scopeKey: "", symbol: "V75", strategyName: "trend", signalName: "trend",
  action: "BUY", sampleCount: 2, winCount: 1, lossCount: 1, breakEvenCount: 0, netPnl: 30, avgPnl: 15,
  confidenceAdjustment: 0, riskAdjustment: 0, edgeScore: 4, lastResult: "WIN", lastTradeId: 4, contributors: null,
};
function payload(pnl: number | null) {
  return {
    trade_id: 5, decision_id: null, result: "WIN", pnl, symbol: "V75", action: "BUY",
    signals_used: [{ source: "trend", status: "PASS", score: 1 }],
    debrief_id: 9, ready_for_learning: true,
  };
}
const edgeUpdates = () => state.updates.filter((u) => u.table === "strategy_edges").map((u) => u.set);
const eventInsert = () => state.inserts.find((i) => i.table === "learning_events")!.values;
const eventFinal = () => state.updates.find((u) => u.table === "learning_events")!.set;

beforeEach(() => {
  state.debrief = { id: 9, userId: 7, autoMeta: {} };
  state.edges = [{ ...EDGE }];
  state.inserts = []; state.updates = [];
});

test("an unsized WIN (pnl null) is learned as a win, but its P&L is not a measured 0", async () => {
  const r = await processLearningPayload(payload(null), { ownerUserId: 7 });
  assert.equal(r.status, "processed");

  const ev = eventInsert();
  assert.equal(ev.pnl, 0, "learning_events.pnl is NOT NULL");
  assert.equal((ev.adjustments as Row).pnlKnown, false);
  const fin = eventFinal();
  assert.match(String(fin.learningSummary), /^WIN on V75 BUY \(P&L not sized\)/);
  assert.doesNotMatch(String(fin.learningSummary), /pnl=0\.00/, "was 'pnl=0.00'");
  assert.equal((fin.adjustments as Row).pnlKnown, false);
  assert.match(String((fin.adjustments as Row).pnlNote), /could not be sized/);

  const ups = edgeUpdates();
  assert.ok(ups.length > 0, "the supporting signal's edge is updated");
  for (const set of ups) {
    assert.equal(set.sampleCount, 3);
    assert.equal(set.winCount, 2, "the win is still learned");
    assert.equal(set.netPnl, 30, "nothing is added for an unknown P&L");
    assert.equal(set.avgPnl, 15, "was 10: the unknown P&L counted as a 0 sample");
  }
  const vault = state.inserts.find((i) => i.table === "vault_events")!.values;
  assert.equal((vault.payload as Row).pnl, null);
});

test("a sized P&L is still added to the edge and shown in the summary", async () => {
  await processLearningPayload(payload(12), { ownerUserId: 7 });
  assert.equal(eventInsert().pnl, 12);
  assert.match(String(eventFinal().learningSummary), /\(pnl=12\.00\)/);
  assert.equal((eventFinal().adjustments as Row).pnlKnown, true);
  for (const set of edgeUpdates()) {
    assert.equal(set.netPnl, 42);
    assert.equal(set.avgPnl, 14);
  }
});

// Review pass 3: the unsized sample used to be kept out of avgPnl only until
// the next sized close, which divided the new netPnl by every sample, the
// unsized ones included (42 / 4 = 10.5 below, where the sized mean is 14).
test("after an unsized sample, the next sized close averages the sized trades only", async () => {
  // The fixture after the unsized WIN above: 3 samples, 2 of them sized (net 30).
  state.edges = [{ ...EDGE, sampleCount: 3, winCount: 2, netPnl: 30, avgPnl: 15 }];
  await processLearningPayload(payload(12), { ownerUserId: 7 });
  for (const set of edgeUpdates()) {
    assert.equal(set.sampleCount, 4);
    assert.equal(set.netPnl, 42);
    assert.equal(set.avgPnl, 14, "was 10.5: the unsized sample counted as a 0 in the average");
  }
});

test("an edge first seen on an unsized trade averages only the sized trades that follow", async () => {
  // Inserted on an unsized WIN: netPnl and avgPnl start at 0 with 1 sample.
  state.edges = [{ ...EDGE, sampleCount: 1, winCount: 1, lossCount: 0, netPnl: 0, avgPnl: 0 }];
  await processLearningPayload(payload(12), { ownerUserId: 7 });
  for (const set of edgeUpdates()) {
    assert.equal(set.sampleCount, 2);
    assert.equal(set.netPnl, 12);
    assert.equal(set.avgPnl, 12, "was 6: the unsized first sample counted as a 0");
  }
});

test("when the row cannot tell how many samples were sized, the average is never inflated", async () => {
  // A win and a loss with netPnl 0: both unsized, or sized and exactly offsetting.
  state.edges = [{ ...EDGE, sampleCount: 2, winCount: 1, lossCount: 1, netPnl: 0, avgPnl: 0 }];
  await processLearningPayload(payload(12), { ownerUserId: 7 });
  for (const set of edgeUpdates()) {
    assert.equal(set.netPnl, 12);
    assert.equal(set.avgPnl, 4, "divided by every sample: can only pull the average toward 0");
  }
});
