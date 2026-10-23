// Profit Mission Phase 5 — pure domain contract tests for the Edge Engine, the
// Opportunity Router + queue, the Trade Draft state machine, and the Mission
// Impact preview. Everything here is PURE + IO-FREE: identical inputs always
// produce identical output, and NOTHING in this layer can relax, override, or
// trigger any execution gate. No DB, no network, no clock (callers pass `nowMs`).
//
// Locks the Phase 5 acceptance behaviours:
//   - Edge: A ranks above B (#18); C/D/F are flagged skip-not-force (#19); the
//     honest caps can only LOWER a score / block a setup, never raise it (#caps).
//   - Router: never takes the first weak trade (#20); "wait" with no A/B tier;
//     opportunity-cost is recorded for the runner-up forgone (#38).
//   - Trade draft: an expired proposal can't become an executable draft (#31); a
//     too-late entry is blocked (#32); the state machine rejects illegal moves.
//   - Mission impact: a TP raises progress / eases pace; an SL lowers progress /
//     hardens pace; deterministic + estimate-labelled.
//
// This imports ONLY @workspace/domain (no `@workspace/db`), so it is an OFFLINE
// unit suite and is wired into the root `ci` lane (not the integration lane).
//
// Run: pnpm --filter @workspace/api-server run test:mission-drafts-domain

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEdgeScore,
  isActionableTier,
  rewardToRiskScore,
  routeOpportunities,
  resolveDraftAction,
  isDraftExpired,
  resolveEffectiveDraftStatus,
  isTerminalDraftStatus,
  computeMissionImpact,
  checkMissionCopyDeep,
  type EdgeInput,
  type EdgeTier,
  type RouterCandidate,
} from "@workspace/domain/profit-mission";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 5);

// A clean, live-feed edge input with all positive components set to `value` and
// no penalties — the baseline we then degrade to exercise tiers + caps.
function edgeInput(value: number, overrides: Partial<EdgeInput> = {}): EdgeInput {
  return {
    direction: "BUY",
    components: {
      directionConviction: value,
      setupQuality: value,
      rewardToRisk: value,
      entryQuality: value,
      timingQuality: value,
      orderFlow: value,
      pattern: value,
      trendline: value,
      pivot: value,
      agentTrust: value,
      session: value,
      symbolQuality: value,
    },
    honesty: { feedStatus: "live", spread: "normal", timing: "fresh" },
    ...overrides,
  };
}

// ── Edge engine — tiers + ranking (#18) ──────────────────────────────────────
test("edge tiers: a strong setup (A) outranks a moderate one (B) (#18)", () => {
  const strong = computeEdgeScore(edgeInput(90)); // → A+/A band
  const moderate = computeEdgeScore(edgeInput(65)); // → B band

  assert.ok(strong.finalEdgeScore > moderate.finalEdgeScore, "A scores above B");
  const order: EdgeTier[] = ["A+", "A", "B", "C", "D", "F"];
  assert.ok(
    order.indexOf(strong.tier) < order.indexOf(moderate.tier),
    `${strong.tier} should rank above ${moderate.tier}`,
  );
  assert.equal(strong.actionable, true);
  assert.equal(moderate.actionable, true);
});

// ── Edge engine — C/D/F are skip-not-force (#19) ──────────────────────────────
test("C/D/F tiers are flagged not-actionable: skip, never force (#19)", () => {
  for (const v of [55, 40, 20]) {
    const e = computeEdgeScore(edgeInput(v));
    assert.ok(["C", "D", "F"].includes(e.tier), `value ${v} → ${e.tier}`);
    assert.equal(e.actionable, false, `tier ${e.tier} must not be actionable`);
    assert.equal(isActionableTier(e.tier), false);
    assert.match(e.reason, /below the actionable A\/B floor/i);
    assert.equal(e.blocked, false, "a weak tier is skipped, not a hard block");
  }
});

// ── Edge engine — caps can only LOWER, never raise (#caps) ─────────────────────
test("honest caps only lower a score / block a setup, never raise it", () => {
  const clean = computeEdgeScore(edgeInput(90));

  // A wide spread caps the score below the clean value (never above).
  const wide = computeEdgeScore(edgeInput(90, { honesty: { feedStatus: "live", spread: "wide", timing: "fresh" } }));
  assert.ok(wide.finalEdgeScore <= clean.finalEdgeScore, "wide spread cannot raise the score");
  assert.ok(wide.finalEdgeScore <= 70, "wide-spread cap holds");

  // A delayed feed caps the score; a stale feed makes it context-only at 0.
  const delayed = computeEdgeScore(edgeInput(90, { honesty: { feedStatus: "delayed", spread: "normal", timing: "fresh" } }));
  assert.ok(delayed.finalEdgeScore <= 55, "delayed feed cap holds");
  assert.ok(delayed.finalEdgeScore <= clean.finalEdgeScore);

  const stale = computeEdgeScore(edgeInput(90, { honesty: { feedStatus: "stale", spread: "normal", timing: "fresh" } }));
  assert.equal(stale.contextOnly, true);
  assert.equal(stale.finalEdgeScore, 0);
  assert.equal(stale.actionable, false);

  // An extreme spread is a hard block regardless of how strong the components are.
  const blocked = computeEdgeScore(edgeInput(99, { honesty: { feedStatus: "live", spread: "extreme", timing: "fresh" } }));
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.actionable, false);
  assert.equal(blocked.finalEdgeScore, 0);

  // A perfect-component setup with NO direction is context-only, never actionable.
  const noDir = computeEdgeScore(edgeInput(99, { direction: "NONE" }));
  assert.equal(noDir.contextOnly, true);
  assert.equal(noDir.actionable, false);
});

test("rewardToRiskScore maps R onto a 0..100 scale (advisory helper)", () => {
  assert.equal(rewardToRiskScore(null), null);
  assert.equal(rewardToRiskScore(0), null);
  const r1 = rewardToRiskScore(1);
  const r3 = rewardToRiskScore(3);
  assert.ok(r1 != null && r3 != null && r3 > r1, "higher R → higher score");
});

// ── Opportunity router — never take the first weak trade (#20) ─────────────────
function candidate(id: string, edgeValue: number, opts: Partial<RouterCandidate> = {}): RouterCandidate {
  const edge = computeEdgeScore(edgeInput(edgeValue));
  return {
    proposalId: id,
    agentKey: `agent_${id}`,
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    edge,
    expectedR: 2,
    estimatedProfitContribution: 50,
    riskAmount: 25,
    ...opts,
  };
}

test("router ranks the strongest actionable best — never the first weak one (#20)", () => {
  // Order is intentionally weak-first; the router must still surface the A setup.
  const weak = candidate("weak", 40); // D — not actionable
  const moderate = candidate("mod", 65); // B — actionable
  const strong = candidate("strong", 90); // A — actionable
  const queue = routeOpportunities([weak, moderate, strong], {
    remainingProfit: 300,
    requiredDailyProfit: 43,
  });

  assert.equal(queue.decision, "act");
  assert.ok(queue.best);
  assert.equal(queue.best!.candidate.proposalId, "strong", "best is the strongest, not the first/weakest");
  assert.equal(queue.best!.rank, 1);
  // The non-actionable weak candidate is ordered last and never actionable.
  const last = queue.queue[queue.queue.length - 1]!;
  assert.equal(last.candidate.proposalId, "weak");
  assert.equal(last.actionable, false);
});

test("router returns 'wait' when no candidate is A/B tier", () => {
  const weakOnly = routeOpportunities([candidate("c1", 40), candidate("c2", 30)], {
    remainingProfit: 300,
    requiredDailyProfit: 43,
  });
  assert.equal(weakOnly.decision, "wait");
  assert.equal(weakOnly.best, null);
  assert.ok(weakOnly.waitReason, "an honest wait reason is given");

  const empty = routeOpportunities([], { remainingProfit: 300, requiredDailyProfit: 43 });
  assert.equal(empty.decision, "wait");
  assert.equal(empty.waitReason, "NO_CANDIDATES");
});

// ── Opportunity cost foundation (#38) ─────────────────────────────────────────
test("router records opportunity cost: best is 0, runner-up is the score gap (#38)", () => {
  const strong = candidate("strong", 90);
  const moderate = candidate("mod", 65);
  const queue = routeOpportunities([strong, moderate], {
    remainingProfit: 300,
    requiredDailyProfit: 43,
  });
  assert.equal(queue.best!.opportunityCost, 0, "the best opportunity forgoes nothing");
  const runnerUp = queue.queue.find((q) => q.candidate.proposalId === "mod")!;
  assert.ok(runnerUp.opportunityCost > 0, "a runner-up carries a positive opportunity cost");
  // Acting on the best forgoes the runner-up's actionable standing.
  assert.ok(queue.bestAlternativeForgone > 0, "best-alternative-forgone is surfaced");
});

// ── Trade draft state machine ─────────────────────────────────────────────────
test("draft state machine: legal moves resolve, illegal moves are refused", () => {
  // proposed → waiting_confirmation (submit), → approved (approve).
  assert.deepEqual(resolveDraftAction("proposed", "submit"), { ok: true, to: "waiting_confirmation" });
  assert.deepEqual(resolveDraftAction("waiting_confirmation", "approve"), { ok: true, to: "approved" });
  assert.deepEqual(resolveDraftAction("waiting_confirmation", "reject"), { ok: true, to: "rejected" });

  // Illegal: you cannot approve from a terminal state, nor re-approve.
  const fromRejected = resolveDraftAction("rejected", "approve");
  assert.equal(fromRejected.ok, false);
  const fromExpired = resolveDraftAction("expired", "approve");
  assert.equal(fromExpired.ok, false);

  assert.equal(isTerminalDraftStatus("approved"), false, "approved still allows cancel/expire");
  assert.equal(isTerminalDraftStatus("rejected"), true);
  assert.equal(isTerminalDraftStatus("expired"), true);
  assert.equal(isTerminalDraftStatus("cancelled"), true);
});

// ── Expired proposal/draft can't become executable (#31) ──────────────────────
test("an expired draft reads as expired and can't be approved (#31)", () => {
  const expiresAt = NOW + 10 * 60 * 1000;
  assert.equal(isDraftExpired(expiresAt, NOW), false, "before the window it is live");
  assert.equal(isDraftExpired(expiresAt, expiresAt + 1), true, "past the window it is expired");
  assert.equal(isDraftExpired(null, NOW), false, "a null expiry never auto-expires");

  // Expiry-on-read: a waiting draft past its window reads as `expired`.
  const effective = resolveEffectiveDraftStatus("waiting_confirmation", expiresAt, expiresAt + 1);
  assert.equal(effective, "expired");
  // ...and approving from `expired` is illegal — never an executable plan.
  assert.equal(resolveDraftAction(effective, "approve").ok, false);

  // A terminal status is never silently re-opened by expiry logic.
  assert.equal(resolveEffectiveDraftStatus("approved", expiresAt, NOW), "approved");
});

// ── Too-late entry is blocked at the edge layer (#32) ─────────────────────────
test("a too-late entry is blocked, so no actionable edge / draft is possible (#32)", () => {
  const tooLate = computeEdgeScore(edgeInput(90, { honesty: { feedStatus: "live", spread: "normal", timing: "too_late" } }));
  assert.equal(tooLate.blocked, true);
  assert.equal(tooLate.actionable, false);
  assert.equal(tooLate.capReason, "ENTRY_TOO_LATE");
  // A blocked edge can never be routed as actionable.
  const queue = routeOpportunities(
    [candidate("late", 90, { edge: tooLate })],
    { remainingProfit: 300, requiredDailyProfit: 43 },
  );
  assert.equal(queue.decision, "wait");
});

// ── Mission impact preview — directional deltas ───────────────────────────────
test("mission impact: TP raises progress / eases pace; SL lowers it / hardens pace", () => {
  const impact = computeMissionImpact({
    math: {
      startingAmount: 1000,
      targetAmount: 1300,
      timeframeStartMs: NOW,
      timeframeEndMs: NOW + 7 * DAY,
      currentValue: 1000,
      nowMs: NOW,
    },
    riskAmount: 50,
    expectedR: 2,
    winProbability: 0.5,
  });

  // Win (TP) moves progress UP and eases the required pace.
  assert.ok(impact.win.profitDelta > 0);
  assert.ok(impact.win.progressPctDelta > 0, "TP raises progress");
  assert.ok(impact.win.requiredDailyPaceDelta < 0, "TP eases the required pace");

  // Loss (SL) moves progress DOWN and hardens the required pace.
  assert.ok(impact.loss.profitDelta < 0);
  assert.ok(impact.loss.progressPctDelta < 0, "SL lowers progress");
  assert.ok(impact.loss.requiredDailyPaceDelta > 0, "SL hardens the required pace");

  // The win gain is expectedR × the risk amount.
  assert.equal(impact.takeProfitGain, 100);
  assert.equal(impact.riskAmount, 50);
  assert.equal(impact.isEstimate, true);
});

test("mission impact is deterministic (identical inputs → identical output)", () => {
  const input = {
    math: {
      startingAmount: 1000,
      targetAmount: 1300,
      timeframeStartMs: NOW,
      timeframeEndMs: NOW + 7 * DAY,
      currentValue: 1100,
      nowMs: NOW,
    },
    riskAmount: 40,
    expectedR: 2.5,
    winProbability: 0.55,
  };
  assert.deepEqual(computeMissionImpact(input), computeMissionImpact(input));
});

// ── Banned-vocabulary guard over generated preview copy ───────────────────────
test("no Phase 5 generated copy uses banned guaranteed-profit vocabulary", () => {
  const edge = computeEdgeScore(edgeInput(90));
  const impact = computeMissionImpact({
    math: {
      startingAmount: 1000,
      targetAmount: 1300,
      timeframeStartMs: NOW,
      timeframeEndMs: NOW + 7 * DAY,
      currentValue: 1000,
      nowMs: NOW,
    },
    riskAmount: 50,
    expectedR: 2,
  });
  const queue = routeOpportunities([candidate("c", 90)], {
    remainingProfit: 300,
    requiredDailyProfit: 43,
  });

  const copy = [
    edge.reason,
    ...edge.warnings,
    queue.waitReason,
    ...queue.queue.flatMap((q) => q.reasons),
    impact.win.label,
    impact.loss.label,
    impact.expected.label,
  ];
  const verdict = checkMissionCopyDeep(copy);
  assert.equal(verdict.ok, true, `generated copy used banned vocabulary: ${verdict.violations.join(", ")}`);
});
