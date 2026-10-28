// Regression: an experiment scenario that getScenario() no longer finds was
// pushed into perScenario AND ranking as {replayRunId:"", trades:0, netPnl:0,
// winRate:0}. The ranking then placed the never-replayed scenario by a net of
// 0 — above a real losing scenario — and BEST_SCENARIO read "Best scenario:
// <missing id> with net 0". A scenario that was not replayed has no result to
// rank.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const updates: Array<Record<string, unknown>> = [];
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{
          experimentId: "exp_1", title: "t", symbol: "EURUSD", timeframe: "M5", playbookEntryId: "",
          scenarioIds: ["a", "b"], settings: {}, resultSummary: {}, status: "PENDING",
        }],
      }),
    }),
  }),
  update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
mock.module("../scenarios.js", {
  namedExports: { getScenario: async (id: string) => (id === "a" ? { scenarioId: "a" } : null) },
});
mock.module("../engine.js", {
  namedExports: {
    runReplay: async () => ({ replayRunId: "r1" }),
    generateReplayReport: async () => ({
      total_trades: 3, wins: 1, net_pnl: -5, win_rate: 33, profit_factor: 0.5,
      replay_report_id: "rr1", should_promote_to_playbook: false, should_mark_for_review: true,
    }),
  },
});

const { runExperiment } = await import("../strategyLab.js");

test("a scenario that was not replayed is not ranked or named best/worst", async () => {
  const summary = await runExperiment("exp_1", 7) as Record<string, unknown>;
  const ranking = summary["ranking"] as Array<{ scenarioId: string }>;
  assert.deepEqual(ranking.map((r) => r.scenarioId), ["a"]);
  assert.deepEqual(summary["notReplayed"], ["b"]);
  const recs = summary["recommendations"] as Array<{ type: string; message: string }>;
  const best = recs.find((r) => r.type === "BEST_SCENARIO")!;
  assert.match(best.message, /Best scenario: a with net -5/);
  for (const r of recs.filter((x) => x.type === "BEST_SCENARIO" || x.type === "WORST_SCENARIO")) {
    assert.doesNotMatch(r.message, /\bb\b with net 0/);
  }
  const nr = recs.find((r) => r.type === "NOT_REPLAYED");
  assert.ok(nr, "the missing scenario is disclosed");
  assert.match(nr!.message, /1 scenario was not found and was not replayed: b/);
  // The per-scenario list still records it, marked as not replayed.
  const per = summary["perScenario"] as Array<{ scenarioId: string; replayRunId: string }>;
  assert.equal(per.find((p) => p.scenarioId === "b")!.replayRunId, "");
  assert.equal(updates.at(-1)!.status, "COMPLETED");
});
