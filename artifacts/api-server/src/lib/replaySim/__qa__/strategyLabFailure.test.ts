// Regression: runExperiment set an experiment to RUNNING and only ever moved it
// to COMPLETED. A throw mid-run (scenario lookup, replay or report) left the
// row at RUNNING forever, so Strategy Lab kept showing a run in progress that
// had in fact died. A failed run must be recorded as FAILED, with the reason.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const updates: Array<Record<string, unknown>> = [];
function experimentRow() {
  return {
    experimentId: "exp_1", title: "t", symbol: "EURUSD", timeframe: "M5", playbookEntryId: "",
    scenarioIds: ["scn_1"], settings: {}, resultSummary: {}, status: "PENDING",
  };
}
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === database.strategyLabExperimentsTable) return [experimentRow()];
          // getScenario's lookup: simulate the scenario store failing mid-run.
          throw new Error("scenario store unavailable");
        },
      }),
    }),
  }),
  update: () => ({
    set: (v: Record<string, unknown>) => ({
      where: async () => { updates.push(v); },
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { runExperiment } = await import("../strategyLab.js");

test("a run that throws is recorded as FAILED, not left RUNNING", async () => {
  await assert.rejects(() => runExperiment("exp_1"), /scenario store unavailable/);
  assert.equal(updates[0]?.status, "RUNNING");
  const last = updates.at(-1)!;
  assert.equal(last.status, "FAILED");
  const summary = last.resultSummary as { error?: string };
  assert.match(String(summary.error), /scenario store unavailable/);
});
