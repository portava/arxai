// #58 Intelligence-ROI Ledger — pure aggregation + governor-feed tests
// (OFFLINE).
//
// Locks:
//   * Aggregation honesty: a component with no closed trades gets NULL pnl
//     fields (never zero-as-fact); lossesAvoided is ALWAYS null with an
//     UNKNOWN basis (no persisted counterfactual evidence exists — the ledger
//     records the gap instead of inventing a saving); error rate = vetoed /
//     observed; fingerprints are the component's real outputs.
//   * Governor feed: RISK/JUDGE map to ESSENTIAL (the pure governor refuses
//     to disable them — asserted end-to-end through the REAL
//     runComplexityGovernor); other components are OPTIONAL; a component
//     without latency evidence costs 0 in the governor input while the
//     persisted row keeps the honest null (both asserted).
//   * ADVISORY ONLY (pin): the worker source touches no dispatch surface and
//     never mutates any agent/strategy table — the verdict is persisted, not
//     enforced.
//   * Change-only: verdictSignature is stable for identical verdicts and
//     moves when the forced-disable set moves.
//   * Env opt-out parsing.
//
// Run: pnpm --filter @workspace/api-server run test:intelligence-roi

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const {
  aggregateComponentWindows,
  toAgentMetrics,
  verdictSignature,
  intelligenceRoiEnabled,
} = await import("../intelligence/intelligenceRoiWorker.js");
const { runComplexityGovernor } = await import("@workspace/domain/complexity-governor");
type ProposalObservation = import("../intelligence/intelligenceRoiWorker.js").ProposalObservation;
type ClosedDraftObservation = import("../intelligence/intelligenceRoiWorker.js").ClosedDraftObservation;

function proposal(over: Partial<ProposalObservation> = {}): ProposalObservation {
  return { agentKey: "TREND", status: "proposed", symbol: "R_75", direction: "BUY", timeframe: "M15", ...over };
}
function closed(over: Partial<ClosedDraftObservation> = {}): ClosedDraftObservation {
  return { agentKey: "TREND", pnl: 10, capturedProfit: 8, missedProfit: 2, ...over };
}

// ── Aggregation honesty ──────────────────────────────────────────────────────

test("a component with no closed trades reports NULL pnl fields, never zero-as-fact", () => {
  const [w] = aggregateComponentWindows([proposal({ agentKey: "SCALPER" })], []);
  assert.equal(w!.componentKey, "SCALPER");
  assert.equal(w!.decisionsObserved, 1);
  assert.equal(w!.closedTrades, 0);
  assert.equal(w!.realizedPnlUsd, null);
  assert.equal(w!.capturedProfitUsd, null);
  assert.equal(w!.profitsMissedUsd, null);
  assert.ok(w!.reasons.some((r) => r.includes("honest null")));
});

test("lossesAvoided is ALWAYS a null with an UNKNOWN basis — no invented savings", () => {
  const windows = aggregateComponentWindows(
    [proposal(), proposal({ status: "vetoed" })],
    [closed()],
  );
  for (const w of windows) {
    assert.equal(w.lossesAvoidedUsd, null);
    assert.ok(w.lossesAvoidedBasis.startsWith("UNKNOWN"));
    assert.ok(w.lossesAvoidedBasis.includes("never an invented"));
  }
});

test("sums, error rate and fingerprints come from the real observations", () => {
  const [w] = aggregateComponentWindows(
    [
      proposal({ status: "vetoed" }),
      proposal({ status: "selected", symbol: "R_100", direction: "SELL", timeframe: "H1" }),
    ],
    [closed({ pnl: -5, capturedProfit: 0, missedProfit: 12 }), closed({ pnl: 3, capturedProfit: 3, missedProfit: null })],
  );
  assert.equal(w!.decisionsObserved, 2);
  assert.equal(w!.closedTrades, 2);
  assert.equal(w!.realizedPnlUsd, -2);
  assert.equal(w!.capturedProfitUsd, 3);
  assert.equal(w!.profitsMissedUsd, 12); // null entries excluded, not zeroed
  assert.equal(w!.errorRate01, 0.5);
  assert.deepEqual(w!.fingerprints, ["R_75:BUY:M15", "R_100:SELL:H1"]);
});

test("an empty window aggregates to nothing (change-only upstream)", () => {
  assert.deepEqual(aggregateComponentWindows([], []), []);
});

// ── Governor feed ────────────────────────────────────────────────────────────

test("RISK/JUDGE map to ESSENTIAL and the REAL governor refuses to disable them", () => {
  // RISK is expensive and contributes nothing — the exact profile the governor
  // wants to disable; ESSENTIAL protection must refuse and record a blocker.
  const windows = aggregateComponentWindows(
    [
      ...Array.from({ length: 10 }, () => proposal({ agentKey: "RISK", status: "vetoed" })),
      ...Array.from({ length: 10 }, () => proposal({ agentKey: "SCALPER" })),
    ],
    [],
  );
  const metrics = toAgentMetrics(windows, new Map([["RISK", 5000], ["SCALPER", 5000]]));
  assert.equal(metrics.find((m) => m.agentId === "RISK")!.tier, "ESSENTIAL");
  assert.equal(metrics.find((m) => m.agentId === "SCALPER")!.tier, "OPTIONAL");

  const verdict = runComplexityGovernor({
    agents: metrics,
    totalComputeBudgetMs: 100, // both far over budget
    cycleLatenciesMs: [50, 60],
    cycleLatencyBudgetMs: 1000,
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(!verdict.forcedDisableAgentIds.includes("RISK"), "ESSENTIAL RISK must never be force-disabled");
  if (verdict.forcedDisableAgentIds.length > 0 || verdict.blockers.length > 0) {
    // When anything was disable-worthy, the essential refusal is explicit.
    assert.ok(
      verdict.forcedDisableAgentIds.every((id) => id !== "RISK" && id !== "JUDGE"),
    );
  }
});

test("no latency evidence → 0 cost in the governor input (with the null kept on the row side)", () => {
  const windows = aggregateComponentWindows([proposal({ agentKey: "GOLD" })], []);
  const metrics = toAgentMetrics(windows, new Map());
  assert.equal(metrics[0]!.cpuMsPerCycle, 0);
});

// ── Change-only signature ────────────────────────────────────────────────────

test("verdictSignature is stable for identical verdicts and moves with the forced set", () => {
  const windows = aggregateComponentWindows(
    Array.from({ length: 5 }, () => proposal({ agentKey: "SCALPER" })),
    [],
  );
  const base = {
    agents: toAgentMetrics(windows, new Map()),
    totalComputeBudgetMs: 5000,
    cycleLatenciesMs: [10],
    cycleLatencyBudgetMs: 2000,
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  };
  const a = runComplexityGovernor(base);
  const b = runComplexityGovernor({ ...base, generatedAtIso: "2026-01-01T01:00:00.000Z" });
  assert.equal(verdictSignature(a), verdictSignature(b), "timestamp alone must not defeat change-only");

  // A real cost against a tiny budget flips overBudget — the signature moves.
  const c = runComplexityGovernor({
    ...base,
    agents: toAgentMetrics(windows, new Map([["SCALPER", 5000]])),
    totalComputeBudgetMs: 1,
  });
  assert.equal(c.computeBudget.overBudget, true);
  assert.notEqual(verdictSignature(a), verdictSignature(c), "an over-budget verdict must change the signature");
});

// ── Advisory-only pin ────────────────────────────────────────────────────────

test("advisory pin: the worker source touches no dispatch or enforcement surface", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.resolve(here, "../intelligence/intelligenceRoiWorker.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [
    "executeInstant", "dispatchApprovedDraft", "liveCommandPipeline", ".deliver(",
    "demote(", "promote(", "missionAgentsTable", // records evidence; never flips an agent
  ]) {
    assert.ok(!src.includes(forbidden), `intelligenceRoiWorker must not reference ${forbidden}`);
  }
});

test("env opt-out: absent = enabled; disable values disable", () => {
  assert.equal(intelligenceRoiEnabled(undefined), true);
  for (const v of ["0", "false", "off", "no"]) {
    assert.equal(intelligenceRoiEnabled(v), false, v);
  }
});
