// Evidence-diversity discount (#8) — pairwise agreement, correlation
// clustering, and the diversity-adjusted disagreement score.
//
// Locked here:
//   * Pairwise agreement is measured only over SHARED cases from persisted
//     stance records; pairs below the minimum shared-case count never cluster
//     (thin history is not evidence of correlation).
//   * Perfectly-correlated duplicate agents collapse toward ONE vote: their
//     multipliers are 1/clusterSize and the fabricated consensus dissolves —
//     the disagreement score RISES to what one-vote-per-source would say.
//   * Independent agents are unaffected: no cluster, multiplier 1, identical
//     score to the classic engine.
//   * SAFETY: no multiplier ever exceeds 1 (weights never increase), and the
//     adjusted score is floored at the unadjusted score — the discount can
//     only ADD disagreement (caution), never suppress it.
//   * runCouncil wiring: the route passes persisted-history weights in, and
//     the artifact carries the diversity view (source-pinned).
//
// IO-free pure domain + source pins. Offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:evidence-diversity

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  computePairwiseAgreements,
  deriveDiversityWeights,
  disagreementScore,
  diversityAdjustedDisagreementScore,
  type AgentStanceObservation,
  type AgentVerdict,
} from "@workspace/domain/agent-system";
import { stanceObservationsFromVotePayloads } from "../agentStanceHistoryPolicy.js";

function dirVote(agentId: string, direction: "BUY" | "SELL", conviction = 100): AgentVerdict {
  return {
    agentId,
    agentName: agentId,
    category: "DIRECTION",
    direction,
    conviction,
    reasons: ["fixture"],
    observedAt: new Date(0).toISOString(),
  };
}

/** N shared cases where the listed agents always take identical stances. */
function correlatedHistory(agents: string[], cases: number): AgentStanceObservation[] {
  const out: AgentStanceObservation[] = [];
  for (let c = 0; c < cases; c++) {
    const stance = c % 2 === 0 ? "FOR" : "AGAINST";
    for (const a of agents) out.push({ caseId: `case-${c}`, agentId: a, stance });
  }
  return out;
}

/** N shared cases where the agents disagree about half the time. */
function independentHistory(a: string, b: string, cases: number): AgentStanceObservation[] {
  const out: AgentStanceObservation[] = [];
  for (let c = 0; c < cases; c++) {
    out.push({ caseId: `case-${c}`, agentId: a, stance: "FOR" });
    out.push({ caseId: `case-${c}`, agentId: b, stance: c % 2 === 0 ? "FOR" : "AGAINST" });
  }
  return out;
}

// ── Agreement measurement ───────────────────────────────────────────────────

test("pairwise agreement: measured only over shared cases, exact rates", () => {
  const obs = independentHistory("A", "B", 20);
  const pairs = computePairwiseAgreements(obs);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.sharedCases, 20);
  assert.ok(Math.abs(pairs[0]!.agreementRate - 0.5) < 1e-9);
});

test("clustering: perfect duplicates over enough cases cluster at 1/n; thin history never clusters", () => {
  const dup = deriveDiversityWeights(computePairwiseAgreements(correlatedHistory(["A", "B", "C"], 20)));
  assert.deepEqual(dup.clusters, [["A", "B", "C"]]);
  assert.ok(Math.abs(dup.multipliers["A"]! - 1 / 3) < 1e-9);
  assert.ok(Math.abs(dup.multipliers["C"]! - 1 / 3) < 1e-9);
  // Same perfect agreement but below the minimum shared cases → NO cluster.
  const thin = deriveDiversityWeights(computePairwiseAgreements(correlatedHistory(["A", "B"], 5)));
  assert.deepEqual(thin.clusters, []);
  assert.deepEqual(thin.multipliers, {});
  // Independent agents (50% agreement) → NO cluster.
  const ind = deriveDiversityWeights(computePairwiseAgreements(independentHistory("A", "B", 40)));
  assert.deepEqual(ind.clusters, []);
});

test("SAFETY: multipliers never exceed 1", () => {
  const w = deriveDiversityWeights(computePairwiseAgreements(correlatedHistory(["A", "B", "C", "D"], 30)));
  for (const m of Object.values(w.multipliers)) {
    assert.ok(m > 0 && m <= 1, `multiplier ${m} out of (0,1]`);
  }
});

// ── Diversity-adjusted disagreement ─────────────────────────────────────────

test("correlated duplicates collapse toward one vote: fabricated consensus RAISES disagreement", () => {
  // Three perfectly-correlated BUY agents vs one independent SELL dissenter.
  const verdicts = [dirVote("A", "BUY"), dirVote("B", "BUY"), dirVote("C", "BUY"), dirVote("D", "SELL")];
  const weights = deriveDiversityWeights(computePairwiseAgreements(correlatedHistory(["A", "B", "C"], 20)));
  const adjusted = diversityAdjustedDisagreementScore(verdicts, weights);
  const unadjusted = disagreementScore(verdicts);
  // Unweighted: 300 BUY-conv vs 100 SELL-conv → 0.5 directional. Discounted:
  // the cluster's combined 100 vs 100 → an even split (1.0 directional).
  assert.ok(adjusted.score01 > unadjusted.score01, `${adjusted.score01} !> ${unadjusted.score01}`);
  assert.equal(adjusted.adjustmentApplied, true);
  assert.equal(adjusted.unadjustedScore01, unadjusted.score01);
  assert.ok(Math.abs(adjusted.directional01 - 1) < 1e-9, "cluster collapses to one vote vs one vote");
});

test("independent agents are unaffected: no discount, identical score", () => {
  const verdicts = [dirVote("A", "BUY"), dirVote("B", "BUY"), dirVote("C", "SELL")];
  const unadjusted = disagreementScore(verdicts);
  // No weights at all.
  const noWeights = diversityAdjustedDisagreementScore(verdicts, null);
  assert.equal(noWeights.score01, unadjusted.score01);
  assert.equal(noWeights.adjustmentApplied, false);
  // Weights derived from genuinely independent history are empty → same.
  const weights = deriveDiversityWeights(computePairwiseAgreements(independentHistory("A", "C", 40)));
  const withEmpty = diversityAdjustedDisagreementScore(verdicts, weights);
  assert.equal(withEmpty.score01, unadjusted.score01);
  assert.equal(withEmpty.adjustmentApplied, false);
});

test("SAFETY: the adjusted score is floored at the unadjusted score (discount can only ADD caution)", () => {
  // The cluster sits on the MINORITY side: discounting it would mathematically
  // LOWER the raw disagreement (2*100/400=0.5 → 2*50/350≈0.29 directional) —
  // the floor must keep the published score at the unadjusted level.
  const verdicts = [
    dirVote("X", "BUY"), dirVote("Y", "BUY"), dirVote("Z", "BUY"),
    dirVote("A", "SELL"), dirVote("B", "SELL"),
  ];
  const weights = deriveDiversityWeights(computePairwiseAgreements(correlatedHistory(["A", "B"], 20)));
  const unadjusted = disagreementScore(verdicts);
  const adjusted = diversityAdjustedDisagreementScore(verdicts, weights);
  assert.ok(adjusted.score01 >= unadjusted.score01, "diversity view must never suppress disagreement");
  assert.equal(adjusted.score01, unadjusted.score01);
});

// ── Persisted-payload adapter + wiring pins ─────────────────────────────────

test("adapter: persisted AGENT_VOTE payloads map onto stance observations; garbage is dropped", () => {
  const obs = stanceObservationsFromVotePayloads([
    { decisionId: "d1", agentId: "RISK", vote: "FOR" },
    { decisionId: "d1", agentId: "MOMO", vote: "AGAINST" },
    { decisionId: "d2", agentId: "RISK" }, // no vote → dropped
    { agentId: "RISK", vote: "FOR" }, // no case id → dropped
    null,
    { decisionId: 5 as unknown as string, agentId: "RISK", vote: "FOR" }, // wrong type → dropped
  ]);
  assert.equal(obs.length, 2);
  assert.deepEqual(obs[0], { caseId: "d1", agentId: "RISK", stance: "FOR" });
});

test("wiring pin: the council route derives weights from persisted history and passes them to runCouncil", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(path.resolve(here, "../../routes/agents.ts"), "utf8");
  assert.match(route, /loadCouncilDiversityWeights\(\)/);
  assert.match(route, /runCouncil\(snap, decisionId, \{ diversityWeights \}\)/);
  const council = readFileSync(
    path.resolve(here, "../../../../../lib/domain/src/agent-system/runCouncil.ts"),
    "utf8",
  );
  assert.match(council, /diversityAdjustedDisagreementScore\(verdicts, opts\.diversityWeights\)/);
});
