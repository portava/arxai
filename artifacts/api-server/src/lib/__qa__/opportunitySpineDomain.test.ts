// Opportunity Spine (#17/#18/#19) — pure domain tests. IO-free: only the pure
// state machine / dedup / conflict-resolver / supervisor are imported with
// explicit fake clocks, so this runs in the offline `ci` lane. The DB-backed
// lifecycle manager + sweep worker compose these pure parts and degrade
// fail-open (per-item try/catch); they are observer-only by construction.
//
// Locked here:
//   * #17 owning state machine: terminal EXECUTED/REJECTED/MISSED/EXPIRED/
//     INVALIDATED; MISSED accounting on the SAME object (entry window seen +
//     death without a fill ⇒ MISSED, never a bland EXPIRED); terminal states
//     ABSORB (no revival of expired evidence — typed refusal); the append-only
//     event log fully reconstructs the object (replayOpportunity).
//   * #18 dedup: clustering requires same symbol+side+TIME-HORIZON class+setup
//     AND thesis/evidence similarity ≥ threshold; the declared-but-never-
//     assigned DUPLICATE conflict state is now actually assigned; every merge
//     is journaled with its similarity breakdown as the reason.
//   * #19 TIGHTENING: an opposite-direction conflict NOT resolvable by a
//     validated rule downgrades EVERY candidate on the symbol to WAIT — the
//     higher-ranked agent no longer trades through a direction disagreement.
//     Horizon-aware conflict classes are recorded; the EXPIRED_OPPONENT rule
//     resolves only on hard evidence with an injected clock.
//
// Run: pnpm --filter @workspace/api-server run test:opportunity-spine

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOpportunityEvent,
  initialOpportunitySnapshot,
  replayOpportunity,
  buildOpportunityKey,
  timeframeHorizonClass,
  clusterDuplicates,
  evaluateThesisSimilarity,
  deriveOpportunityObservation,
  resolveOppositeConflict,
  DUPLICATE_SIMILARITY_THRESHOLD,
  type OpportunityEvent,
} from "@workspace/domain/opportunity-spine";
import { resolveSupervisor, type DecisionCandidate, type TradeThesis } from "@workspace/domain/self-trade";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-29T12:00:00.000Z");

function makeThesis(over: Partial<TradeThesis> = {}): TradeThesis {
  return {
    symbol: "EURUSD",
    side: "BUY",
    setup: "BREAKOUT_RETEST",
    whyNow: ["BOS on M5.", "Retest holding above 1.1000.", "HTF bias bullish."],
    entryZone: { from: 1.1, to: 1.101 },
    stopLoss: 1.098,
    invalidation: 1.0975,
    takeProfits: [{ from: 1.104, to: 1.105 }],
    edge: 70,
    confidence: 72,
    newsRisk: "low",
    ...over,
  };
}

function makeCandidate(over: Partial<DecisionCandidate> = {}): DecisionCandidate {
  const thesis = over.thesis === undefined ? makeThesis() : over.thesis;
  return {
    agentId: 1,
    agentKey: "agent-a",
    agentRankWeight: 1,
    symbol: "EURUSD",
    timeframe: "M5",
    side: "BUY",
    setup: "BREAKOUT_RETEST",
    outcome: "APPROVED",
    conflictState: "NONE",
    ownerAgentKey: null,
    plannedAction: "Buy EURUSD",
    reason: "Setup approved.",
    riskState: "HEALTHY",
    setupScore: 70,
    rankScore: 80,
    noTradeScore: 10,
    confidence: 72,
    confidenceDecayed: 70,
    setupExpiresAt: null,
    checks: [],
    scoreBreakdown: {
      direction: 70, entry: 70, execution: 70, risk: 70, newsSafety: 90,
      timing: 70, survivability: 70, regimeFit: 70, mtfAgreement: 70,
      setup: 70, overall: 70, edge: 70, noTrade: 10, rank: 80,
    },
    thesis,
    quotaProgress: {
      dailyMinTrades: 0, effectiveMaxTrades: 5, tradesTakenToday: 0,
      remainingToMax: 5, belowDailyMinimum: false, baseReached: false, hardCapReached: false,
    },
    ...over,
  };
}

// ── #17 state machine ────────────────────────────────────────────────────────

test("#17: happy path to EXECUTED via a real fill", () => {
  let snap = initialOpportunitySnapshot();
  for (const e of [
    { type: "STAGE_OBSERVED", observedStage: "SETUP_FORMING", reason: "forming" },
    { type: "STAGE_OBSERVED", observedStage: "ENTRY_WINDOW_OPEN", reason: "window open" },
    { type: "EXECUTION_DISPATCHED", reason: "dispatched" },
    { type: "EXECUTION_FILLED", reason: "fill ticket 123" },
  ] as OpportunityEvent[]) {
    const r = applyOpportunityEvent(snap, e);
    assert.equal(r.accepted, true);
    snap = r.snapshot;
  }
  assert.equal(snap.state, "EXECUTED");
  assert.equal(snap.terminal, true);
  assert.equal(snap.entryWindowSeen, true);
  assert.equal(snap.executionAttempted, true);
});

test("#17 MISSED accounting: window seen + expiry without a fill = MISSED, not EXPIRED", () => {
  let snap = initialOpportunitySnapshot();
  snap = applyOpportunityEvent(snap, { type: "STAGE_OBSERVED", observedStage: "ENTRY_WINDOW_OPEN", reason: "open" }).snapshot;
  const r = applyOpportunityEvent(snap, { type: "EXPIRED", reason: "aged out" });
  assert.equal(r.snapshot.state, "MISSED");
  assert.equal(r.snapshot.terminal, true);
  assert.match(r.snapshot.terminalReason ?? "", /never executed/);
});

test("#17: expiry with NO window ever open = EXPIRED; invalidation = INVALIDATED", () => {
  let snap = initialOpportunitySnapshot();
  snap = applyOpportunityEvent(snap, { type: "STAGE_OBSERVED", observedStage: "SETUP_FORMING", reason: "forming" }).snapshot;
  assert.equal(applyOpportunityEvent(snap, { type: "EXPIRED", reason: "aged" }).snapshot.state, "EXPIRED");
  assert.equal(applyOpportunityEvent(snap, { type: "INVALIDATED", reason: "level broke" }).snapshot.state, "INVALIDATED");
});

test("#17: invalidation AFTER the window was seen is also MISSED", () => {
  let snap = initialOpportunitySnapshot();
  snap = applyOpportunityEvent(snap, { type: "STAGE_OBSERVED", observedStage: "ENTRY_WINDOW_OPEN", reason: "open" }).snapshot;
  assert.equal(applyOpportunityEvent(snap, { type: "INVALIDATED", reason: "level broke" }).snapshot.state, "MISSED");
});

test("#17: rejected execution terminates REJECTED", () => {
  let snap = initialOpportunitySnapshot();
  snap = applyOpportunityEvent(snap, { type: "STAGE_OBSERVED", observedStage: "ENTRY_WINDOW_OPEN", reason: "open" }).snapshot;
  const r = applyOpportunityEvent(snap, { type: "EXECUTION_BLOCKED", reason: "gate refused" });
  assert.equal(r.snapshot.state, "REJECTED");
});

test("#17 NO REVIVAL: terminal states absorb every event with a typed refusal", () => {
  let snap = initialOpportunitySnapshot();
  snap = applyOpportunityEvent(snap, { type: "EXPIRED", reason: "aged" }).snapshot;
  assert.equal(snap.state, "EXPIRED");
  for (const e of [
    { type: "STAGE_OBSERVED", observedStage: "ENTRY_WINDOW_OPEN", reason: "revive?" },
    { type: "EXECUTION_FILLED", reason: "revive?" },
    { type: "OPENED", reason: "revive?" },
  ] as OpportunityEvent[]) {
    const r = applyOpportunityEvent(snap, e);
    assert.equal(r.accepted, false);
    assert.equal(r.rejectedReason, "TERMINAL_NO_REVIVAL");
    assert.equal(r.snapshot.state, "EXPIRED"); // unchanged
  }
});

test("#17 reconstruction: replaying the event log lands on the identical snapshot", () => {
  const events: OpportunityEvent[] = [
    { type: "OPENED", reason: "opened" },
    { type: "STAGE_OBSERVED", observedStage: "SETUP_FORMING", reason: "forming" },
    { type: "STAGE_OBSERVED", observedStage: "ENTRY_WINDOW_OPEN", reason: "open" },
    { type: "DUPLICATE_MERGED", reason: "merged agent-b" },
    { type: "EXECUTION_DISPATCHED", reason: "dispatched" },
    { type: "EXPIRED", reason: "aged out" },
    { type: "EXECUTION_FILLED", reason: "post-terminal noise (must be absorbed)" },
  ];
  const replayed = replayOpportunity(events);
  assert.equal(replayed.state, "MISSED"); // window seen + no fill
  assert.equal(replayed.terminal, true);
  assert.equal(replayed.executionAttempted, true);
});

test("#17 identity: horizon classes + one key per setup identity", () => {
  assert.equal(timeframeHorizonClass("M5"), "SCALP");
  assert.equal(timeframeHorizonClass("H1"), "INTRADAY");
  assert.equal(timeframeHorizonClass("H4"), "SWING");
  assert.equal(timeframeHorizonClass("W1"), "POSITION");
  assert.equal(timeframeHorizonClass("nonsense"), "UNKNOWN"); // honest unknown
  const k = buildOpportunityKey({ symbol: "eur/usd", timeframe: "M5", side: "BUY", setup: "BREAKOUT_RETEST" });
  assert.equal(k, "EURUSD|SCALP|BUY|BREAKOUT_RETEST");
});

test("#17 observation: directionless candidates never fabricate an object", () => {
  assert.equal(deriveOpportunityObservation(makeCandidate({ side: null, thesis: null })), null);
  assert.equal(deriveOpportunityObservation(makeCandidate({ setup: "NONE" })), null);
  const obs = deriveOpportunityObservation(makeCandidate())!;
  assert.equal(obs.observedStage, "ENTRY_WINDOW_OPEN"); // actionable + zone
  const waiting = deriveOpportunityObservation(makeCandidate({ outcome: "WAIT" }))!;
  assert.equal(waiting.observedStage, "ENTRY_APPROACHING"); // zone but not actionable
  const noZone = deriveOpportunityObservation(makeCandidate({ outcome: "WATCH_ONLY", thesis: null }))!;
  assert.equal(noZone.observedStage, "SETUP_FORMING");
});

// ── #18 dedup ────────────────────────────────────────────────────────────────

test("#18: same thesis on the same horizon clusters; the merge is journaled with reasons", () => {
  const a = makeCandidate({ agentId: 1, agentKey: "agent-a", rankScore: 85 });
  const b = makeCandidate({ agentId: 2, agentKey: "agent-b", rankScore: 70 });
  const r = clusterDuplicates([a, b]);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0]!.ownerAgentKey, "agent-a");
  assert.equal(r.journal.length, 1);
  const j = r.journal[0]!;
  assert.equal(j.duplicateAgentKey, "agent-b");
  assert.ok(j.similarity.score >= DUPLICATE_SIMILARITY_THRESHOLD);
  assert.match(j.reason, /similarity \d+\/100/);
  assert.match(j.reason, /SCALP/); // horizon named in the journal
});

test("#18: different time-horizon classes are NEVER duplicates", () => {
  const scalp = makeCandidate({ agentKey: "agent-a", timeframe: "M5" });
  const swing = makeCandidate({ agentId: 2, agentKey: "agent-b", timeframe: "H4" });
  const r = clusterDuplicates([scalp, swing]);
  assert.equal(r.clusters.length, 0);
  assert.equal(r.journal.length, 0);
});

test("#18: different setup kinds / dissimilar theses do not merge", () => {
  const a = makeCandidate({ agentKey: "agent-a" });
  const b = makeCandidate({
    agentId: 2,
    agentKey: "agent-b",
    setup: "REVERSAL",
    thesis: makeThesis({ setup: "REVERSAL" }),
  });
  assert.equal(clusterDuplicates([a, b]).clusters.length, 0);

  // Same setup kind, but disjoint geometry + disjoint evidence: below threshold.
  const far = makeCandidate({
    agentId: 3,
    agentKey: "agent-c",
    thesis: makeThesis({
      entryZone: { from: 1.2, to: 1.201 },
      stopLoss: 1.25,
      whyNow: ["Totally different narrative.", "Nothing shared."],
    }),
  });
  const r2 = clusterDuplicates([a, far]);
  assert.equal(r2.clusters.length, 0);
});

test("#18 honesty: missing geometry contributes ZERO similarity, never closeness", () => {
  const a = makeCandidate({ thesis: makeThesis({ entryZone: null }) });
  const b = makeCandidate({ agentId: 2, agentKey: "agent-b", thesis: makeThesis({ entryZone: null }) });
  const sim = evaluateThesisSimilarity(a, b);
  assert.equal(sim.components.entryZoneOverlap, 0);
  assert.ok(sim.reasons.some((s) => /unknown/.test(s)));
});

test("#18: the supervisor finally ASSIGNS the DUPLICATE conflict state", () => {
  const a = makeCandidate({ agentId: 1, agentKey: "agent-a", rankScore: 85 });
  const b = makeCandidate({ agentId: 2, agentKey: "agent-b", rankScore: 70 });
  const r = resolveSupervisor([a, b], { nowMs: NOW });
  const loser = r.candidates.find((c) => c.agentKey === "agent-b")!;
  assert.equal(loser.conflictState, "DUPLICATE");
  assert.equal(loser.outcome, "ASSIGNED_TO_ANOTHER");
  assert.equal(loser.ownerAgentKey, "agent-a");
  assert.match(loser.reason, /Duplicate/i);
  const winner = r.candidates.find((c) => c.agentKey === "agent-a")!;
  assert.equal(winner.outcome, "APPROVED"); // owner keeps its own decision
  assert.equal(r.dedupJournal.length, 1);
});

// ── #19 opposite-direction conflicts (tightened) ─────────────────────────────

test("#19 TIGHTENING: unresolvable opposite conflict downgrades BOTH sides to WAIT", () => {
  const buy = makeCandidate({ agentId: 1, agentKey: "agent-buy", rankScore: 90 });
  const sell = makeCandidate({
    agentId: 2,
    agentKey: "agent-sell",
    side: "SELL",
    setup: "REVERSAL",
    rankScore: 60,
    thesis: makeThesis({ side: "SELL", setup: "REVERSAL" }),
  });
  const r = resolveSupervisor([buy, sell], { nowMs: NOW });
  for (const key of ["agent-buy", "agent-sell"]) {
    const c = r.candidates.find((x) => x.agentKey === key)!;
    assert.equal(c.outcome, "WAIT", `${key} must WAIT — rank is not authority over direction`);
    assert.equal(c.conflictState, "SAME_SYMBOL_OPPOSITE");
    assert.equal(c.ownerAgentKey, null); // nobody owns a withheld trade
    assert.match(c.reason, /no validated rule/i);
  }
  assert.equal(r.conflictJournal.length, 1);
  assert.equal(r.conflictJournal[0]!.resolution, "ALL_WAIT");
  assert.equal(r.conflictJournal[0]!.conflictClass, "SAME_HORIZON_OPPOSITE");
  assert.ok(r.conflictJournal[0]!.rulesConsulted.length > 0); // rules were consulted + journaled
});

test("#19: horizon-aware classes — cross-horizon disagreement is classified (and still WAITs)", () => {
  const buy = makeCandidate({ agentId: 1, agentKey: "agent-buy", timeframe: "M5" });
  const sell = makeCandidate({
    agentId: 2,
    agentKey: "agent-sell",
    side: "SELL",
    timeframe: "H4",
    thesis: makeThesis({ side: "SELL" }),
  });
  const r = resolveSupervisor([buy, sell], { nowMs: NOW });
  assert.equal(r.conflictJournal[0]!.conflictClass, "CROSS_HORIZON_OPPOSITE");
  assert.equal(r.conflictJournal[0]!.resolution, "ALL_WAIT"); // classification only — never a licence
  for (const c of r.candidates) assert.equal(c.outcome, "WAIT");
});

test("#19 validated rule EXPIRED_OPPONENT: the still-live thesis proceeds, journaled", () => {
  const expiredIso = new Date(NOW - 60_000).toISOString();
  const buy = makeCandidate({ agentId: 1, agentKey: "agent-buy", rankScore: 40, setupExpiresAt: null });
  const sell = makeCandidate({
    agentId: 2,
    agentKey: "agent-sell",
    side: "SELL",
    rankScore: 95, // HIGHER rank — but its evidence is dead, so rank cannot save it
    setupExpiresAt: expiredIso,
    thesis: makeThesis({ side: "SELL" }),
  });
  const r = resolveSupervisor([buy, sell], { nowMs: NOW });
  const winner = r.candidates.find((c) => c.agentKey === "agent-buy")!;
  const loser = r.candidates.find((c) => c.agentKey === "agent-sell")!;
  assert.equal(winner.outcome, "APPROVED");
  assert.equal(winner.ownerAgentKey, "agent-buy");
  assert.equal(loser.outcome, "WAIT");
  assert.equal(loser.conflictState, "SAME_SYMBOL_OPPOSITE");
  assert.equal(r.conflictJournal[0]!.resolution, "RULE_RESOLVED");
  assert.equal(r.conflictJournal[0]!.winnerAgentKey, "agent-buy");
  assert.ok(r.conflictJournal[0]!.rulesConsulted.some((x) => x.ruleId === "EXPIRED_OPPONENT" && x.applied));
});

test("#19: without an injected clock the EXPIRED_OPPONENT rule honestly never applies", () => {
  const buy = makeCandidate({ agentKey: "agent-buy" });
  const sell = makeCandidate({
    agentId: 2, agentKey: "agent-sell", side: "SELL",
    setupExpiresAt: new Date(NOW - 60_000).toISOString(),
    thesis: makeThesis({ side: "SELL" }),
  });
  const v = resolveOppositeConflict(buy, sell, {});
  assert.equal(v.resolved, false);
  assert.match(v.rulesConsulted[0]!.detail, /No evaluation clock/);
});

test("#19: same-side contention is unchanged (one-owner-per-trade preserved)", () => {
  // Distinct theses (below dedup threshold) so this reaches the contention stage.
  const a = makeCandidate({ agentId: 1, agentKey: "agent-a", rankScore: 90 });
  const b = makeCandidate({
    agentId: 2,
    agentKey: "agent-b",
    rankScore: 60,
    setup: "TREND_CONTINUATION",
    thesis: makeThesis({
      setup: "TREND_CONTINUATION",
      entryZone: { from: 1.09, to: 1.0905 },
      stopLoss: 1.085,
      whyNow: ["Pullback into the moving average.", "Trend intact."],
    }),
  });
  const r = resolveSupervisor([a, b], { nowMs: NOW });
  const winner = r.candidates.find((c) => c.agentKey === "agent-a")!;
  const loser = r.candidates.find((c) => c.agentKey === "agent-b")!;
  assert.equal(winner.outcome, "APPROVED");
  assert.equal(loser.outcome, "ASSIGNED_TO_ANOTHER");
  assert.equal(loser.conflictState, "SAME_SYMBOL_SAME_SIDE");
  assert.equal(loser.ownerAgentKey, "agent-a");
});
