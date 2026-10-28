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
  selectCertificateObservedDrawdown,
  certificateDrawdownLine,
  validateCertificateAcceptance,
  type CertificateObservedDrawdown,
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
import { projectMissionTestResult } from "../missionTestingEvidence.js";

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

test("testing lab labels unknown evidence unverified and separates test kinds", () => {
  assert.match(MISSION_TEST_LABEL.BACKTEST, /unverified/i);
  assert.notEqual(MISSION_TEST_LABEL.FORWARD, MISSION_TEST_LABEL.BACKTEST);

  const bt = summarizeMissionTest({
    kind: "BACKTEST", strategyKey: "flame_scalp", symbol: "EURUSD", timeframe: "M15",
    metrics: metrics({ totalTrades: 40 }),
  });
  assert.match(bt.headline, /unverified/i);
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

  // A minimum sample and positive metrics do not establish verified evidence.
  assert.equal(hasSufficientSample("BACKTEST", 40), true);
  assert.equal(sampleWarning("BACKTEST", 40), null);
  const big = summarizeMissionTest({
    kind: "BACKTEST", strategyKey: "flame_scalp", symbol: "EURUSD", timeframe: "M15",
    metrics: metrics({ totalTrades: 40, expectancyR: 0.4, profitFactor: 1.8 }),
  });
  assert.equal(big.promotionEligible, false);
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

// ── Certificate drawdown line: closed-draft evidence only ────────────────────

const CLOSED_DRAFT_DRAWDOWN: CertificateObservedDrawdown = {
  pct: 12.3, source: "closed_mission_drafts", validation: "unverified", sampleSize: 7,
  context: { strategyKey: "trend", symbol: "EURUSD", timeframe: "M15" },
};
const CERT_BASE = { startingAmount: 1000, targetAmount: 1300, riskProfile: "balanced", targetAutomationLevel: 4 as const };
const ACKNOWLEDGEMENT_LINES = [
  "Trading involves the risk of loss, including the possible loss of your starting capital.",
  "Past and simulated results are estimates only and do not predict future outcomes.",
  "This target is a goal, not a promise — the mission may fall short or lose money.",
  "Live automation only ever places trades through the platform's existing safety gates, which can refuse or stop a trade at any time.",
  "You can pause, reduce automation, or stop this mission at any time.",
];
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
    targetAutomationLevel: 4, observedDrawdown: CLOSED_DRAFT_DRAWDOWN,
  });
  assert.equal(content.phrase, MISSION_CERTIFICATE_PHRASE);
  assert.ok(content.acknowledgements.length > 0);
});

const drawdownLineOf = (lines: string[]) => {
  const found = lines.filter((l) => /drawdown/i.test(l));
  assert.equal(found.length, 1, `exactly one drawdown line: ${JSON.stringify(lines)}`);
  return found[0]!;
};

let rowId = 0;
function storedRow(p: { kind: string; metricsJson: unknown; createdAt: string; strategyKey?: string; symbol?: string; timeframe?: string }) {
  rowId += 1;
  return projectMissionTestResult({
    id: rowId, missionId: 1, kind: p.kind, strategyKey: p.strategyKey ?? "trend", symbol: p.symbol ?? "EURUSD",
    timeframe: p.timeframe ?? "M15", metricsJson: p.metricsJson, createdAt: new Date(p.createdAt),
  });
}
const GEN = { version: 1, source: "generated_prices", validation: "unverified" };
const CLOSED = { version: 1, source: "closed_mission_drafts", validation: "unverified" };
const m = (maxDrawdownPct: number, totalTrades = 10) => metrics({ totalTrades, winningTrades: Math.min(6, totalTrades), losingTrades: Math.max(0, Math.min(4, totalTrades - 6)), maxDrawdownPct });

test("certificate drawdown line: populated variant names source, sample, equity basis and exclusions", () => {
  const cert = buildCertificateContent({ ...CERT_BASE, observedDrawdown: CLOSED_DRAFT_DRAWDOWN });
  const line = drawdownLineOf(cert.summaryLines);
  assert.match(line, /12\.3%/);
  assert.match(line, /closed mission drafts, unverified/);
  assert.match(line, /7 closed trades/);
  assert.match(line, /strategy trend, EURUSD M15/);
  assert.match(line, /nominal starting-amount equity curve/);
  assert.match(line, /not broker account equity/);
  assert.match(line, /execution mode and net costs are unverified/);
  assert.match(line, /Generated-price simulations are excluded/);
  assert.doesNotMatch(line, /seen in testing/);
  assert.deepEqual(cert.acknowledgements, ACKNOWLEDGEMENT_LINES, "acknowledgements unchanged");
  assert.ok(cert.summaryLines.every((l) => typeof l === "string"), "summaryLines stays string[]");

  const mixed = certificateDrawdownLine({ ...CLOSED_DRAFT_DRAWDOWN, sampleSize: 1, context: "Mixed" });
  assert.match(mixed, /1 closed trade;/);
  assert.match(mixed, /mixed context/);
});

test("certificate drawdown line: null / unusable records say unavailable, never 0.0%, never suggest a backtest", () => {
  const unusable: (CertificateObservedDrawdown | null)[] = [
    null,
    { ...CLOSED_DRAFT_DRAWDOWN, sampleSize: 0 },
    { ...CLOSED_DRAFT_DRAWDOWN, pct: Number.NaN },
    { ...CLOSED_DRAFT_DRAWDOWN, pct: -1 },
    { ...CLOSED_DRAFT_DRAWDOWN, source: "generated_prices" as "closed_mission_drafts" },
  ];
  for (const d of unusable) {
    const cert = buildCertificateContent({ ...CERT_BASE, observedDrawdown: d });
    const line = drawdownLineOf(cert.summaryLines);
    assert.match(line, /unavailable/);
    assert.match(line, /no closed-trade drawdown record available/);
    assert.doesNotMatch(line, /\d+(\.\d+)?%/, "no numeric drawdown figure");
    assert.doesNotMatch(line, /\b(run|start|try)\b[^.]*\bbacktest/i, "must not suggest running a generated-price backtest");
    assert.doesNotMatch(line, /backtest/i);
    assert.deepEqual(cert.acknowledgements, ACKNOWLEDGEMENT_LINES);
  }
});

test("certificate drawdown selector: generated-price and unknown-source rows never contribute", () => {
  const rows = [
    storedRow({ kind: "BACKTEST", createdAt: "2026-03-05T00:00:00Z", metricsJson: { metrics: m(40), evidence: GEN } }),
    storedRow({ kind: "FORWARD", createdAt: "2026-03-01T00:00:00Z", metricsJson: { metrics: m(5), evidence: CLOSED } }),
    // Legacy FORWARD with valid metrics but no evidence blob → source "unknown".
    storedRow({ kind: "FORWARD", createdAt: "2026-03-04T00:00:00Z", metricsJson: { metrics: m(55) } }),
    // FORWARD claiming generated prices is not a recognised pairing → "unknown".
    storedRow({ kind: "FORWARD", createdAt: "2026-03-03T00:00:00Z", metricsJson: { metrics: m(60), evidence: GEN } }),
    // BACKTEST claiming closed drafts → "unknown" too.
    storedRow({ kind: "BACKTEST", createdAt: "2026-03-06T00:00:00Z", metricsJson: { metrics: m(70), evidence: CLOSED } }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  assert.equal(rows[2]!.evidence.source, "unknown");
  assert.deepEqual(selectCertificateObservedDrawdown(rows), {
    pct: 5, source: "closed_mission_drafts", validation: "unverified", sampleSize: 10,
    context: { strategyKey: "trend", symbol: "EURUSD", timeframe: "M15" },
  });
  // Generated-only / unknown-only history → null (no numeric line).
  assert.equal(selectCertificateObservedDrawdown(rows.filter((r) => r.evidence.source !== "closed_mission_drafts")), null);
  assert.equal(selectCertificateObservedDrawdown([]), null);
});

test("certificate drawdown selector: invalid, legacy and zero-sample closed-draft rows are ignored", () => {
  const invalidMetrics = [
    { metrics: { ...m(30), totalTrades: "40" }, evidence: CLOSED },
    { metrics: { ...m(30), maxDrawdownPct: -2 }, evidence: CLOSED },
    { metrics: { ...m(30), winRate: 4 }, evidence: CLOSED },
    { metrics: null, evidence: CLOSED },
    { evidence: CLOSED },
    "not-an-object",
    null,
    [m(30)],
    { metrics: m(30), evidence: { ...CLOSED, version: 2 } },
    { metrics: m(30), evidence: { ...CLOSED, validation: "verified" } },
  ];
  for (const metricsJson of invalidMetrics) {
    const r = storedRow({ kind: "FORWARD", createdAt: "2026-04-01T00:00:00Z", metricsJson });
    assert.equal(selectCertificateObservedDrawdown([r]), null, `ignored: ${JSON.stringify(metricsJson)}`);
    const line = drawdownLineOf(buildCertificateContent({ ...CERT_BASE, observedDrawdown: selectCertificateObservedDrawdown([r]) }).summaryLines);
    assert.doesNotMatch(line, /0\.0%/);
  }
  // Zero-trade closed-draft aggregate (no matching outcomes) is not a 0.0% record.
  const zero = storedRow({ kind: "FORWARD", createdAt: "2026-04-02T00:00:00Z", metricsJson: { metrics: metrics({ totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, maxDrawdownPct: 0 }), evidence: CLOSED } });
  assert.equal(zero.evidence.source, "closed_mission_drafts");
  assert.equal(selectCertificateObservedDrawdown([zero]), null);
  // ...and it does not shadow an older valid closed-draft record either.
  const older = storedRow({ kind: "FORWARD", createdAt: "2026-03-20T00:00:00Z", metricsJson: { metrics: m(8, 3), evidence: CLOSED } });
  assert.equal(selectCertificateObservedDrawdown([zero, older])?.pct, 8);
});

test("certificate drawdown selector: newest matching row wins, no max across contexts, deterministic", () => {
  const newestSmall = storedRow({ kind: "FORWARD", createdAt: "2026-05-02T00:00:00Z", symbol: "GBPUSD", metricsJson: { metrics: m(3, 4), evidence: CLOSED } });
  const olderLarge = storedRow({ kind: "FORWARD", createdAt: "2026-05-01T00:00:00Z", metricsJson: { metrics: m(25), evidence: CLOSED } });
  const listOrder = [newestSmall, olderLarge];
  const picked = selectCertificateObservedDrawdown(listOrder);
  assert.deepEqual(picked, {
    pct: 3, source: "closed_mission_drafts", validation: "unverified", sampleSize: 4,
    context: { strategyKey: "trend", symbol: "GBPUSD", timeframe: "M15" },
  });
  // Input order does not change the result.
  assert.deepEqual(selectCertificateObservedDrawdown([olderLarge, newestSmall]), picked);
  assert.deepEqual(selectCertificateObservedDrawdown(listOrder), selectCertificateObservedDrawdown(listOrder));
  // Same createdAt → higher id is newer (list order createdAt desc, id desc).
  const tieA = storedRow({ kind: "FORWARD", createdAt: "2026-06-01T00:00:00Z", metricsJson: { metrics: m(9), evidence: CLOSED } });
  const tieB = storedRow({ kind: "FORWARD", createdAt: "2026-06-01T00:00:00Z", metricsJson: { metrics: m(2), evidence: CLOSED } });
  assert.equal(selectCertificateObservedDrawdown([tieA, tieB])?.pct, 2);
  assert.equal(selectCertificateObservedDrawdown([tieB, tieA])?.pct, 2);
  // Mixed aggregate keeps the "Mixed" context label.
  const mixed = storedRow({ kind: "FORWARD", createdAt: "2026-07-01T00:00:00Z", strategyKey: "Mixed", symbol: "Mixed", timeframe: "Mixed", metricsJson: { metrics: m(11), evidence: CLOSED } });
  assert.equal(selectCertificateObservedDrawdown([mixed, tieB])?.context, "Mixed");
});

// ── Briefing / EOD / report / learning loop ──────────────────────────────────

function briefState(p: Partial<MissionBriefingState> = {}): MissionBriefingState {
  return {
    missionId: 1, status: "active", startingAmount: 1000, targetAmount: 1300,
    currentValue: 1150, requiredProfit: 300, daysRemaining: 4,
    automationLevel: 2, promotionPaused: false, ...p,
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
  for (const observedDrawdown of [
    CLOSED_DRAFT_DRAWDOWN,
    { ...CLOSED_DRAFT_DRAWDOWN, context: "Mixed" as const },
    null,
  ]) {
    const cert = buildCertificateContent({
      startingAmount: 1000, targetAmount: 1300, riskProfile: "balanced",
      targetAutomationLevel: 4, observedDrawdown,
    });
    copy.push(cert.title, ...cert.summaryLines, ...cert.acknowledgements);
  }

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
