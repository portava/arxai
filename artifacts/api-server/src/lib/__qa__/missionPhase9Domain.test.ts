// Profit Mission Phase 9 — pure domain contract tests.
//
// Locks the deterministic, IO-free engines that make a mission strategy *earn*
// automation: the user-type guardrail ceilings, the honestly-labelled testing
// lab (historical/simulated vs forward) with small-sample warnings, the
// fail-safe strategy-drift detector, the HARD fail-closed promotion gate, the
// Mission Risk Certificate phrase/validation, and the briefing/eod/report +
// learning-loop builders. Everything here is PURE — identical inputs always
// produce identical output, which is the "honest estimate, never a promise"
// guarantee. No DB, no network, no clock (callers pass `nowMs`).
//
// These also assert the banned guaranteed-profit vocabulary is absent from every
// piece of user-facing copy the engines generate. This is the OFFLINE companion
// to the DB-backed route suite (missionPhase9Route.test.ts).
//
// Run: pnpm --filter @workspace/api-server run test:mission-phase9-domain

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  // automation + guardrails
  AUTOMATION_LEVEL_META,
  DEFAULT_MISSION_AUTOMATION_LEVEL,
  FIRST_LIVE_AUTO_LEVEL,
  metaForLevel,
  resolveGuardrailCeiling,
  isMissionAutomationLevel,
  // testing lab
  summarizeMissionTest,
  sampleWarning,
  hasSufficientSample,
  MISSION_TEST_LABEL,
  type MissionTestMetrics,
  // drift
  detectMissionDrift,
  driftBlocksPromotion,
  // promotion gate
  evaluateMissionPromotion,
  type PromotionEvidence,
  // certificate
  MISSION_CERTIFICATE_PHRASE,
  buildCertificateContent,
  validateCertificateAcceptance,
  // briefing / report / learning
  buildDailyBriefing,
  buildEndOfDayReview,
  buildMissionReport,
  runMissionLearningLoop,
  type MissionBriefingState,
  type ClosedTradeAggregate,
  type ClosedTradeRecord,
  // banned vocab guard
  checkMissionCopyDeep,
} from "@workspace/domain/profit-mission";

const NOW = Date.UTC(2026, 5, 21);

function metrics(p: Partial<MissionTestMetrics>): MissionTestMetrics {
  return {
    totalTrades: 40,
    winningTrades: 24,
    losingTrades: 16,
    winRate: 0.6,
    netProfitLoss: 500,
    maxDrawdownPct: 8,
    averageRr: 1.5,
    expectancyR: 0.4,
    profitFactor: 1.8,
    ...p,
  };
}

// ── Automation ladder + guardrails ───────────────────────────────────────────

test("automation default is Level 2 (approval), and live auto starts at Level 4", () => {
  assert.equal(DEFAULT_MISSION_AUTOMATION_LEVEL, 2);
  assert.equal(FIRST_LIVE_AUTO_LEVEL, 4);
  // Only levels 4–6 AUTO-execute against the live broker. Demo auto (3) is
  // demo-only; approval (2) can reach live but only after a manual approval.
  for (const lvl of [0, 1, 3] as const) assert.equal(metaForLevel(lvl).reachesLive, false);
  for (const lvl of [4, 5, 6] as const) assert.equal(metaForLevel(lvl).reachesLive, true);
  // Demo auto auto-executes but never touches the live broker.
  assert.equal(metaForLevel(3).isAuto, true);
  assert.equal(metaForLevel(3).reachesLive, false);
  // Live-auto levels require certificate + explicit enablement.
  for (const lvl of [4, 5, 6] as const) {
    assert.equal(metaForLevel(lvl).isAuto, true);
    assert.equal(metaForLevel(lvl).requiresCertificate, true);
    assert.equal(metaForLevel(lvl).requiresExplicitLiveEnable, true);
  }
  // Levels 0–2 are not auto.
  for (const lvl of [0, 1, 2] as const) assert.equal(metaForLevel(lvl).isAuto, false);
  assert.equal(isMissionAutomationLevel(2), true);
  assert.equal(isMissionAutomationLevel(7), false);
  assert.equal(isMissionAutomationLevel("2"), false);
});

test("guardrail: new users capped at approval; investor/pool approval+audit; viewer advisory", () => {
  // New trader, even live account, capped at approval (must earn history).
  const newTrader = resolveGuardrailCeiling({ role: "TRADER", accountType: "live", isNewUser: true });
  assert.equal(newTrader.maxLevel, DEFAULT_MISSION_AUTOMATION_LEVEL);

  // Established trader on a live account gets the full ladder.
  const vetTrader = resolveGuardrailCeiling({ role: "TRADER", accountType: "live", isNewUser: false });
  assert.equal(vetTrader.maxLevel, 6);

  // Investor / pool: approval ceiling + audit required.
  const investor = resolveGuardrailCeiling({ role: "INVESTOR", accountType: "live", isNewUser: false });
  assert.equal(investor.maxLevel, 2);
  assert.equal(investor.auditRequired, true);

  // Viewer: advisory only.
  const viewer = resolveGuardrailCeiling({ role: "VIEWER", accountType: "live", isNewUser: false });
  assert.equal(viewer.maxLevel, 1);

  // Unrecognized role fails closed to approval.
  const unknown = resolveGuardrailCeiling({ role: "WHATEVER", accountType: "live", isNewUser: false });
  assert.equal(unknown.maxLevel, 2);
});

test("guardrail: paper/demo account can never reach a live-auto level", () => {
  const demo = resolveGuardrailCeiling({ role: "OWNER", accountType: "demo", isNewUser: false });
  assert.ok(demo.maxLevel <= 3, "demo clamps below live auto");
  const paper = resolveGuardrailCeiling({ role: "ADMIN", accountType: "paper", isNewUser: false });
  assert.ok(paper.maxLevel <= 3, "paper clamps below live auto");
});

// ── Testing lab labels + sample warnings ─────────────────────────────────────

test("testing lab labels backtest as historical/simulated and forward distinctly", () => {
  assert.match(MISSION_TEST_LABEL.BACKTEST, /historical|simulated/i);
  assert.notEqual(MISSION_TEST_LABEL.FORWARD, MISSION_TEST_LABEL.BACKTEST);

  const bt = summarizeMissionTest({
    kind: "BACKTEST", strategyKey: "flame_scalp", symbol: "EURUSD", timeframe: "M15",
    metrics: metrics({ totalTrades: 40 }),
  });
  assert.match(bt.headline, /historical|simulated/i);
  assert.equal(bt.label, MISSION_TEST_LABEL.BACKTEST);
});

test("testing lab flags small samples and withholds promotion eligibility", () => {
  // Below FORWARD min (20) → sample warning + not promotion-eligible.
  assert.equal(hasSufficientSample("FORWARD", 5), false);
  assert.ok(sampleWarning("FORWARD", 5));
  const small = summarizeMissionTest({
    kind: "FORWARD", strategyKey: "flame_scalp", symbol: "EURUSD", timeframe: "M15",
    metrics: metrics({ totalTrades: 5 }),
  });
  assert.equal(small.sampleSufficient, false);
  assert.ok(small.sampleWarning);
  assert.equal(small.promotionEligible, false);

  // Sufficient sample + positive edge → eligible, no warning.
  assert.equal(hasSufficientSample("BACKTEST", 40), true);
  assert.equal(sampleWarning("BACKTEST", 40), null);
  const big = summarizeMissionTest({
    kind: "BACKTEST", strategyKey: "flame_scalp", symbol: "EURUSD", timeframe: "M15",
    metrics: metrics({ totalTrades: 40, expectancyR: 0.4, profitFactor: 1.8 }),
  });
  assert.equal(big.promotionEligible, true);
  assert.equal(big.sampleWarning, null);

  // Sufficient sample but no positive edge → still not eligible (honest).
  const flat = summarizeMissionTest({
    kind: "BACKTEST", strategyKey: "flame_scalp", symbol: "EURUSD", timeframe: "M15",
    metrics: metrics({ totalTrades: 40, expectancyR: -0.1, profitFactor: 0.9 }),
  });
  assert.equal(flat.promotionEligible, false);
});

// ── Strategy drift ───────────────────────────────────────────────────────────

test("drift: stable forward vs historical trips nothing", () => {
  const d = detectMissionDrift({
    historical: metrics({ totalTrades: 40, winRate: 0.6, expectancyR: 0.4, maxDrawdownPct: 8 }),
    forward: metrics({ totalTrades: 30, winRate: 0.58, expectancyR: 0.38, maxDrawdownPct: 9 }),
  });
  assert.ok(d.severity === "NONE" || d.severity === "MINOR");
  assert.equal(d.recommendDemote, false);
  assert.equal(driftBlocksPromotion(d.severity), false);
});

test("drift: a clear forward breakdown is SEVERE and is fail-safe", () => {
  const d = detectMissionDrift({
    historical: metrics({ totalTrades: 40, winRate: 0.65, expectancyR: 0.6, maxDrawdownPct: 6 }),
    forward: metrics({ totalTrades: 30, winRate: 0.35, expectancyR: -0.3, maxDrawdownPct: 18 }),
  });
  assert.equal(d.severity, "SEVERE");
  assert.equal(d.recommendDemote, true);
  assert.equal(d.recommendReduceRisk, true);
  assert.equal(d.recommendPausePromotion, true);
  assert.equal(driftBlocksPromotion(d.severity), true);
});

test("drift: insufficient forward evidence is UNKNOWN, never a false drift", () => {
  const d = detectMissionDrift({
    historical: metrics({ totalTrades: 40 }),
    forward: metrics({ totalTrades: 3 }),
  });
  assert.equal(d.severity, "UNKNOWN");
  assert.equal(d.score, 0);
  assert.equal(d.recommendDemote, false);
});

// ── Promotion gate (HARD, fail-closed) ───────────────────────────────────────

function fullyQualified(p: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    backtestSampleSize: 40, backtestPromotionEligible: true,
    forwardSampleSize: 30, forwardPromotionEligible: true,
    demoWinRate: 0.55, demoSampleSize: 30,
    maxDrawdownPct: 10, agentReliability: 0.7,
    riskRuleCompliant: true, driftSeverity: "NONE",
    liveAutoEnabled: true, liveGatesEnabled: true, certificateAccepted: true,
    guardrailMaxLevel: 6, ...p,
  };
}

test("promotion: levels 0–2 are always available regardless of evidence", () => {
  const bare = evaluateMissionPromotion(2, fullyQualified({
    backtestSampleSize: 0, backtestPromotionEligible: false,
    forwardSampleSize: 0, forwardPromotionEligible: false,
    demoSampleSize: 0, demoWinRate: 0, agentReliability: 0,
    liveAutoEnabled: false, certificateAccepted: false, liveGatesEnabled: false,
  }));
  assert.equal(bare.approved, true);
});

test("promotion: live auto (4) requires explicit enablement, certificate, and live gates", () => {
  // Missing explicit enablement → denied.
  const noEnable = evaluateMissionPromotion(4, fullyQualified({ liveAutoEnabled: false }));
  assert.equal(noEnable.approved, false);
  assert.ok(noEnable.failedGates.includes("explicit_user_enablement"));

  // Missing certificate → denied.
  const noCert = evaluateMissionPromotion(4, fullyQualified({ certificateAccepted: false }));
  assert.equal(noCert.approved, false);
  assert.ok(noCert.failedGates.includes("risk_certificate"));

  // Platform live gates disabled → denied (cannot bypass live gates).
  const noLive = evaluateMissionPromotion(4, fullyQualified({ liveGatesEnabled: false }));
  assert.equal(noLive.approved, false);
  assert.ok(noLive.failedGates.includes("live_gates_enabled"));

  // Everything satisfied → approved.
  const ok = evaluateMissionPromotion(4, fullyQualified());
  assert.equal(ok.approved, true);
});

test("promotion: a strong backtest alone can NEVER grant live auto", () => {
  // Great backtest but no forward, no demo, no enablement/cert/live-gates.
  const d = evaluateMissionPromotion(4, fullyQualified({
    backtestSampleSize: 500, backtestPromotionEligible: true,
    forwardSampleSize: 0, forwardPromotionEligible: false,
    demoSampleSize: 0, demoWinRate: 0,
    liveAutoEnabled: false, certificateAccepted: false, liveGatesEnabled: false,
  }));
  assert.equal(d.approved, false);
  assert.ok(d.allowedMaxLevel <= DEFAULT_MISSION_AUTOMATION_LEVEL);
});

test("promotion: MAJOR/SEVERE drift blocks promotion above approval", () => {
  const d = evaluateMissionPromotion(3, fullyQualified({ driftSeverity: "SEVERE" }));
  assert.equal(d.approved, false);
  assert.ok(d.failedGates.includes("no_major_drift"));
});

test("promotion: guardrail ceiling clamps the requested target", () => {
  // Investor ceiling = 2; even with perfect evidence, target 4 is blocked.
  const d = evaluateMissionPromotion(4, fullyQualified({ guardrailMaxLevel: 2 }));
  assert.equal(d.approved, false);
  assert.ok(d.allowedMaxLevel <= 2);
  assert.ok(d.blockers.some((b) => /ceiling/i.test(b)));
});

// ── Mission Risk Certificate ─────────────────────────────────────────────────

test("certificate: exact phrase required; fail-closed on mismatch/!confirmed", () => {
  assert.match(MISSION_CERTIFICATE_PHRASE, /not guaranteed and losses are possible/i);

  assert.equal(validateCertificateAcceptance({ confirmed: true, phrase: MISSION_CERTIFICATE_PHRASE }).ok, true);
  // case-insensitive + whitespace-normalized match still accepted
  assert.equal(
    validateCertificateAcceptance({ confirmed: true, phrase: `  ${MISSION_CERTIFICATE_PHRASE.toUpperCase()}  ` }).ok,
    true,
  );
  // wrong phrase
  assert.equal(validateCertificateAcceptance({ confirmed: true, phrase: "I accept" }).ok, false);
  // not confirmed
  assert.equal(validateCertificateAcceptance({ confirmed: false, phrase: MISSION_CERTIFICATE_PHRASE }).ok, false);
  // non-string
  assert.equal(validateCertificateAcceptance({ confirmed: true, phrase: 123 }).ok, false);

  const content = buildCertificateContent({
    startingAmount: 1000, targetAmount: 1300, riskProfile: "balanced",
    targetAutomationLevel: 4, observedMaxDrawdownPct: 12.3,
  });
  assert.equal(content.phrase, MISSION_CERTIFICATE_PHRASE);
  assert.ok(content.acknowledgements.length > 0);
});

// ── Briefing / EOD / report / learning loop ──────────────────────────────────

function briefState(p: Partial<MissionBriefingState> = {}): MissionBriefingState {
  return {
    missionId: 1, status: "active", startingAmount: 1000, targetAmount: 1300,
    currentValue: 1150, requiredProfit: 300, daysRemaining: 4,
    automationLevel: 2, promotionPaused: false,
    accountingBasis: "BROKER_RECONCILED", ...p,
  };
}

test("briefing/eod/report builders are deterministic and honest", () => {
  const brief = buildDailyBriefing(briefState(), NOW);
  assert.equal(brief.kind, "daily_briefing");
  assert.ok(brief.lines.length > 0);
  assert.deepEqual(buildDailyBriefing(briefState(), NOW), brief); // deterministic

  // Paused promotion surfaces a caution.
  const paused = buildDailyBriefing(briefState({ promotionPaused: true }), NOW);
  assert.ok(paused.cautions.some((c) => /paused/i.test(c)));

  const today: ClosedTradeAggregate = {
    totalTrades: 3, winningTrades: 2, losingTrades: 1, netPnl: 45,
    bestTradePnl: 60, worstTradePnl: -20,
  };
  const eod = buildEndOfDayReview(briefState(), today, NOW);
  assert.equal(eod.kind, "eod_review");
  assert.ok(eod.observations.length > 0);

  const report = buildMissionReport(briefState({ currentValue: 1300 }), {
    totalTrades: 30, winningTrades: 18, losingTrades: 12, netPnl: 300,
    bestTradePnl: 80, worstTradePnl: -30,
  }, NOW);
  assert.equal(report.kind, "mission_report");
  assert.equal(report.outcome, "reached");

  // ── Basis labelling: no money figure is ever shown unlabelled, and a
  // paper/demo (SIMULATED) briefing never reads as broker-confirmed money.
  assert.match(eod.headline, /broker-confirmed/);
  assert.ok(eod.lines.some((l) => /Basis: broker-confirmed/.test(l)));
  assert.match(report.headline, /broker-confirmed/);

  const simState = briefState({ accountingBasis: "SIMULATED" });
  const simEod = buildEndOfDayReview(simState, today, NOW);
  assert.match(simEod.headline, /SIMULATED/);
  assert.ok(simEod.lines.some((l) => /Basis: SIMULATED/.test(l)));
  assert.ok(!/broker-confirmed/.test(simEod.headline));
  const simBrief = buildDailyBriefing(simState, NOW);
  assert.ok(simBrief.lines.some((l) => /Basis: SIMULATED/.test(l)));
  const simReport = buildMissionReport(simState, {
    totalTrades: 30, winningTrades: 18, losingTrades: 12, netPnl: 300,
    bestTradePnl: 80, worstTradePnl: -30,
  }, NOW);
  assert.match(simReport.headline, /SIMULATED/);
  assert.ok(simReport.lines.some((l) => /Net realised across the mission \(SIMULATED\)/.test(l)));
});

test("learning loop aggregates reliability and never fabricates unknown dimensions", () => {
  const records: ClosedTradeRecord[] = [
    { agentKey: "scalper", strategyKey: "flame", symbol: "EURUSD", session: "LONDON", pattern: "breakout", rMultiple: 1.5, win: true },
    { agentKey: "scalper", strategyKey: "flame", symbol: "EURUSD", session: "LONDON", pattern: "breakout", rMultiple: -1, win: false },
    { agentKey: "scalper", strategyKey: "flame", symbol: "EURUSD", session: "LONDON", pattern: null, rMultiple: 2, win: true },
    { agentKey: null, strategyKey: null, symbol: null, session: null, pattern: null, rMultiple: 0.5, win: true },
  ];
  const loop = runMissionLearningLoop(records);
  assert.equal(loop.totalTrades, 4);
  // null dimensions are dropped, not fabricated into a bucket.
  assert.equal(loop.byAgent.length, 1);
  assert.equal(loop.byPattern.length, 1);
  assert.ok(loop.aggregateAgentReliability >= 0 && loop.aggregateAgentReliability <= 1);
  // empty input → all-zero, no crash
  const empty = runMissionLearningLoop([]);
  assert.equal(empty.totalTrades, 0);
  assert.equal(empty.aggregateAgentReliability, 0);
});

// ── Banned-vocabulary guard over generated copy ──────────────────────────────

test("all engine-generated copy is free of guaranteed-profit vocabulary", () => {
  const copy: unknown[] = [];

  // Testing lab summaries.
  for (const kind of ["BACKTEST", "FORWARD"] as const) {
    const s = summarizeMissionTest({
      kind, strategyKey: "flame_scalp", symbol: "EURUSD", timeframe: "M15",
      metrics: metrics({ totalTrades: kind === "BACKTEST" ? 40 : 5 }),
    });
    copy.push(s.headline, ...s.notes);
  }

  // Guardrail reasons.
  for (const role of ["OWNER", "TRADER", "INVESTOR", "VIEWER", "??"]) {
    copy.push(...resolveGuardrailCeiling({ role, accountType: "live", isNewUser: true }).reasons);
  }

  // Automation level metadata copy.
  for (const lvl of [0, 1, 2, 3, 4, 5, 6] as const) {
    copy.push(AUTOMATION_LEVEL_META[lvl].label, AUTOMATION_LEVEL_META[lvl].description);
  }

  // Promotion decision copy.
  const dec = evaluateMissionPromotion(4, fullyQualified({ liveAutoEnabled: false, certificateAccepted: false }));
  copy.push(...dec.reasons, ...dec.blockers, ...dec.gates.map((g) => g.detail));

  // Drift copy.
  const drift = detectMissionDrift({
    historical: metrics({ winRate: 0.65, expectancyR: 0.6 }),
    forward: metrics({ totalTrades: 30, winRate: 0.35, expectancyR: -0.3, maxDrawdownPct: 18 }),
  });
  copy.push(...drift.reasons, ...drift.signals.map((s) => s.detail));

  // Certificate copy.
  const cert = buildCertificateContent({
    startingAmount: 1000, targetAmount: 1300, riskProfile: "balanced",
    targetAutomationLevel: 4, observedMaxDrawdownPct: 12,
  });
  copy.push(cert.title, ...cert.summaryLines, ...cert.acknowledgements);

  // Briefing / eod / report copy.
  const brief = buildDailyBriefing(briefState({ promotionPaused: true }), NOW);
  const eod = buildEndOfDayReview(briefState(), {
    totalTrades: 2, winningTrades: 1, losingTrades: 1, netPnl: -5, bestTradePnl: 10, worstTradePnl: -15,
  }, NOW);
  const report = buildMissionReport(briefState({ currentValue: 1300 }), {
    totalTrades: 30, winningTrades: 18, losingTrades: 12, netPnl: 300, bestTradePnl: 80, worstTradePnl: -30,
  }, NOW);
  copy.push(
    brief.headline, ...brief.lines, ...brief.plan, ...brief.cautions,
    eod.headline, ...eod.lines, ...eod.observations,
    report.headline, ...report.lines, ...report.lessons,
  );

  const result = checkMissionCopyDeep(copy);
  assert.equal(result.ok, true, `banned vocabulary found: ${JSON.stringify(result)}`);
});
