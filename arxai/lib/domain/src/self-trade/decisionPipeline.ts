// Decision pipeline — the ordered, auditable "ecosystem handshake sequence" run
// for ONE agent×symbol candidate. PURE & deterministic. Produces the per-step
// checks, score breakdown, thesis, and a proposed outcome. One-owner-per-trade
// conflict resolution happens later at the fleet level (selfTradeSupervisor).
//
// SHADOW / decision-only: nothing here dispatches a real order. The advisory
// handshake-readiness input is used to downgrade a DECISION, never to gate the
// real 16-gate live pipeline (which is untouched).

import { round } from "../signal-intelligence/_math.js";
import type {
  DecisionCandidate,
  DecisionCandidateInput,
  DecisionCheck,
  SelfTradeDecisionOutcome,
} from "./selfTradeDecision.types.js";
import {
  applyConfidenceDecay,
  classifySetup,
  computeNoTradeScore,
  detectMarketRegime,
  evaluateEntryZone,
  evaluateLateEntry,
  evaluateMtfAlignment,
  evaluateSpreadSlippage,
} from "./decisionModules.js";
import { buildTradeThesis } from "./tradeThesis.js";
import { buildScoreBreakdown, computeRankScore } from "./opportunityRanking.js";

const MIN_EDGE_FOR_THESIS = 30;

// Live data-source allowlist. A decision may only become executable when the
// signal's provenance is one of these real feeds. Anything else — SIMULATOR,
// SHADOW, SIM, an empty/unknown tag — is treated as non-live and fail-closed.
const LIVE_DATA_SOURCES: ReadonlySet<string> = new Set([
  "LIVE_FEED",
  "MT5_BROKER",
  "DERIV",
]);

/**
 * True when a signal's dataSource is simulated / non-live and must never reach
 * an executable decision. Fail-closed: any source not on the live allowlist OR
 * whose tag mentions SIM/SHADOW is rejected. AWAITING_FEED is non-live too, but
 * it always arrives with hasSufficientData=false so it is handled by the blind
 * branch; this guard exists so a SIM tag with sufficient data still cannot pass.
 */
export function isSimulatedDataSource(dataSource: string): boolean {
  const tag = (dataSource || "").trim().toUpperCase();
  if (tag === "AWAITING_FEED") return false; // handled by the blind-data branch
  if (tag.includes("SIM") || tag.includes("SHADOW")) return true;
  return !LIVE_DATA_SOURCES.has(tag);
}

// Restriction ordering — most restrictive wins.
const OUTCOME_RANK: Record<SelfTradeDecisionOutcome, number> = {
  BLOCKED: 7,
  DENIED: 6,
  WAIT: 5,
  WATCH_ONLY: 4,
  PREPARE_ONLY: 3,
  APPROVED_REDUCED: 2,
  APPROVED: 1,
  ASSIGNED_TO_ANOTHER: 0,
};

interface Verdict {
  outcome: SelfTradeDecisionOutcome;
  reason: string;
}

function mostRestrictive(verdicts: Verdict[]): Verdict {
  return verdicts.reduce((acc, v) =>
    OUTCOME_RANK[v.outcome] >= OUTCOME_RANK[acc.outcome] ? v : acc,
  );
}

function riskBand(status: string): string {
  switch (status) {
    case "LOCKED": return "LOCKED";
    case "WATCH_ONLY": return "WATCH";
    case "PAPER_PAUSED": return "PAUSED";
    case "PAPER_ALLOWED": return "HEALTHY";
    default: return "UNKNOWN";
  }
}

function plannedActionFor(outcome: SelfTradeDecisionOutcome, side: string | null, symbol: string, reason: string): string {
  const s = side ?? "";
  switch (outcome) {
    case "APPROVED": return `Execute ${s} ${symbol} (shadow)`;
    case "APPROVED_REDUCED": return `Execute reduced ${s} ${symbol} (shadow)`;
    case "PREPARE_ONLY": return `Stage ${s} ${symbol}; await entry`;
    case "WATCH_ONLY": return `Monitor ${symbol}`;
    case "WAIT": return `Wait — ${reason}`;
    case "DENIED": return `No trade — ${reason}`;
    case "BLOCKED": return `Hold — blocked`;
    default: return `Monitor ${symbol}`;
  }
}

export function runDecisionPipeline(input: DecisionCandidateInput): DecisionCandidate {
  const { signal, htfSignals, currentPrice, now } = input;
  const checks: DecisionCheck[] = [];
  const add = (c: DecisionCheck) => checks.push(c);
  const verdicts: Verdict[] = [];

  // ── 1. Kill switch (TOCTOU-style re-check at decision time) ────────────────
  if (input.killEngaged) {
    add({ key: "kill_switch", label: "Kill switch", status: "FAIL", detail: "Emergency kill switch engaged.", blocking: true });
    verdicts.push({ outcome: "BLOCKED", reason: "Emergency kill switch engaged" });
  } else {
    add({ key: "kill_switch", label: "Kill switch", status: "PASS", detail: "Kill switch clear.", blocking: true });
  }

  // ── 2. Risk Governor ──────────────────────────────────────────────────────
  if (input.governor.status === "LOCKED") {
    add({ key: "risk_governor", label: "Risk Governor", status: "FAIL", detail: `Governor LOCKED: ${input.governor.hardBlocks.join(", ") || "hard block"}.`, blocking: true });
    verdicts.push({ outcome: "BLOCKED", reason: "Risk Governor locked" });
  } else if (input.governor.status === "WATCH_ONLY" || input.governor.status === "PAPER_PAUSED") {
    add({ key: "risk_governor", label: "Risk Governor", status: "WARN", detail: `Governor ${input.governor.status}.`, blocking: false });
    verdicts.push({ outcome: "WAIT", reason: "Risk Governor not in a trading state" });
  } else {
    add({ key: "risk_governor", label: "Risk Governor", status: "PASS", detail: `Governor ${input.governor.status || "UNKNOWN"}.`, blocking: false });
  }

  // ── 3. Ecosystem handshake readiness (advisory) ───────────────────────────
  if (input.handshake.blocked.length > 0) {
    add({ key: "handshake_readiness", label: "Handshake network", status: "FAIL", detail: `Blocked: ${input.handshake.blocked.join(", ")}.`, blocking: false });
    verdicts.push({ outcome: "WAIT", reason: "System readiness handshake not green" });
  } else if (input.handshake.degraded.length > 0) {
    add({ key: "handshake_readiness", label: "Handshake network", status: "WARN", detail: `Degraded: ${input.handshake.degraded.join(", ")}.`, blocking: false });
  } else {
    add({ key: "handshake_readiness", label: "Handshake network", status: input.handshake.ready ? "PASS" : "WARN", detail: input.handshake.ready ? "All layers ready." : "Readiness unknown.", blocking: false });
  }

  // ── 4. Symbol allowlist ───────────────────────────────────────────────────
  if (!input.symbolAllowed) {
    add({ key: "symbol_allowlist", label: "Symbol allowlist", status: "FAIL", detail: `${input.symbol} not in this agent's allowlist.`, blocking: true });
    verdicts.push({ outcome: "BLOCKED", reason: "Symbol not in agent allowlist" });
  } else {
    add({ key: "symbol_allowlist", label: "Symbol allowlist", status: "PASS", detail: `${input.symbol} permitted.`, blocking: true });
  }

  // ── 5. Funding headroom ───────────────────────────────────────────────────
  if (input.funding.availableFunds <= 0) {
    add({ key: "funding", label: "Funding", status: "FAIL", detail: "No available funds allocated.", blocking: true });
    verdicts.push({ outcome: "BLOCKED", reason: "No available funds" });
  } else {
    const headroomPct = input.funding.allocatedFunds > 0
      ? (input.funding.availableFunds / input.funding.allocatedFunds) * 100
      : 100;
    if (headroomPct < 20) {
      add({ key: "funding", label: "Funding", status: "WARN", detail: `Low headroom (${round(headroomPct)}% free).`, blocking: false });
      verdicts.push({ outcome: "APPROVED_REDUCED", reason: "Low funding headroom — reduce size" });
    } else {
      add({ key: "funding", label: "Funding", status: "PASS", detail: `Headroom ${round(headroomPct)}% free.`, blocking: false });
    }
  }

  // ── 6. Quota ──────────────────────────────────────────────────────────────
  if (input.quota.hardCapReached) {
    add({ key: "quota", label: "Trade quota", status: "FAIL", detail: `Daily max ${input.quota.effectiveMaxTrades} reached.`, blocking: false });
    verdicts.push({ outcome: "WAIT", reason: "Daily trade quota reached" });
  } else {
    add({ key: "quota", label: "Trade quota", status: "PASS", detail: `${input.quota.tradesTakenToday}/${input.quota.effectiveMaxTrades} taken; ${input.quota.remainingToMax} left.`, blocking: false });
  }

  // ── 7. Data feed honesty ──────────────────────────────────────────────────
  // Defense-in-depth: simulated/shadow provenance can NEVER reach an executable
  // decision, even if it somehow arrives with hasSufficientData=true. Upstream
  // (signalIntelligenceService) already drops SIMULATOR scanner input, but this
  // is the fail-closed last line: any non-live source hard-BLOCKS here. Live
  // sources are an explicit allowlist; everything else (SIMULATOR/SHADOW/SIM/
  // unknown) is refused rather than trusted.
  const dataOk = signal.hasSufficientData;
  if (isSimulatedDataSource(signal.dataSource)) {
    add({ key: "data_feed", label: "Market data", status: "FAIL", detail: `Simulated/non-live data source (${signal.dataSource}) — not tradeable.`, blocking: true });
    verdicts.push({ outcome: "BLOCKED", reason: "Simulated/non-live market data — never executable" });
  } else if (!dataOk) {
    add({ key: "data_feed", label: "Market data", status: "FAIL", detail: `Insufficient/blind data (${signal.dataSource}).`, blocking: true });
    verdicts.push({ outcome: "WATCH_ONLY", reason: "Insufficient market data to read" });
  } else if (signal.freshness === "STALE" || signal.freshness === "EXPIRED") {
    add({ key: "data_feed", label: "Market data", status: "WARN", detail: `Feed ${signal.freshness.toLowerCase()}.`, blocking: false });
    verdicts.push({ outcome: "WAIT", reason: "Market data stale" });
  } else {
    add({ key: "data_feed", label: "Market data", status: "PASS", detail: `${signal.dataSource} (${signal.freshness.toLowerCase()}).`, blocking: false });
  }

  // ── Module reads (all derived from the signal — no candle math here) ───────
  const regime = detectMarketRegime(signal);
  const setup = classifySetup(signal);
  const mtf = evaluateMtfAlignment(signal, htfSignals);
  const zone = evaluateEntryZone(signal, currentPrice);
  const late = evaluateLateEntry(signal);
  const spread = evaluateSpreadSlippage(input.execution, input.maxSpreadPoints);
  const noTrade = computeNoTradeScore(signal, regime);
  const decay = applyConfidenceDecay(signal, now);

  // ── 8. Regime ─────────────────────────────────────────────────────────────
  add({ key: "regime", label: "Market regime", status: regime.tradeable ? "PASS" : "WARN", detail: regime.note, blocking: false });
  if (!regime.tradeable && dataOk) verdicts.push({ outcome: "WATCH_ONLY", reason: regime.note });

  // ── 9. Setup classification ───────────────────────────────────────────────
  if (setup.setup === "NONE") {
    add({ key: "setup", label: "Setup", status: dataOk ? "FAIL" : "SKIP", detail: setup.reasons[0] || "No clean setup.", blocking: false });
    if (dataOk) verdicts.push({ outcome: "WATCH_ONLY", reason: "No clean setup formed" });
  } else {
    add({ key: "setup", label: "Setup", status: "PASS", detail: `${setup.setup} (${setup.score}).`, blocking: false });
  }

  // ── 10. Direction / edge ──────────────────────────────────────────────────
  if (dataOk && (signal.direction === "NEUTRAL" || signal.edgeScore < MIN_EDGE_FOR_THESIS)) {
    add({ key: "edge", label: "Directional edge", status: "FAIL", detail: `Edge ${signal.edgeScore} below ${MIN_EDGE_FOR_THESIS} / no direction.`, blocking: false });
    verdicts.push({ outcome: "WATCH_ONLY", reason: "Edge too thin to act" });
  } else if (dataOk) {
    add({ key: "edge", label: "Directional edge", status: "PASS", detail: `Edge ${signal.edgeScore}, ${signal.direction}.`, blocking: false });
  }

  // ── 11. Multi-timeframe alignment ─────────────────────────────────────────
  add({ key: "mtf_alignment", label: "Timeframe alignment", status: mtf.conflict ? "WARN" : "PASS", detail: mtf.note, blocking: false });
  if (mtf.conflict) verdicts.push({ outcome: "APPROVED_REDUCED", reason: "Higher timeframe opposes — reduce size" });

  // ── 12. Entry zone ────────────────────────────────────────────────────────
  add({ key: "entry_zone", label: "Entry zone", status: zone.state === "AT_ENTRY" ? "PASS" : zone.state === "NO_ZONE" ? "WARN" : "WARN", detail: zone.note, blocking: false });
  if (dataOk && setup.setup !== "NONE") {
    if (zone.state === "APPROACHING" || zone.state === "FAR") {
      verdicts.push({ outcome: "PREPARE_ONLY", reason: "Setup valid; awaiting price at entry" });
    } else if (zone.state === "NO_ZONE") {
      verdicts.push({ outcome: "WATCH_ONLY", reason: "No defined entry zone yet" });
    }
  }

  // ── 13. Late / do-not-chase ───────────────────────────────────────────────
  if (late.doNotChase) {
    add({ key: "late_entry", label: "Late entry", status: "FAIL", detail: late.reason || "Do not chase.", blocking: false });
    verdicts.push({ outcome: "WAIT", reason: "Clean entry already passed — do not chase" });
  } else if (late.isLate) {
    add({ key: "late_entry", label: "Late entry", status: "WARN", detail: late.reason || "Entry getting late.", blocking: false });
    verdicts.push({ outcome: "APPROVED_REDUCED", reason: "Entry getting late — reduce size" });
  } else {
    add({ key: "late_entry", label: "Late entry", status: "PASS", detail: "Entry timing intact.", blocking: false });
  }

  // ── 14. News risk ─────────────────────────────────────────────────────────
  if (input.newsRisk === "critical") {
    add({ key: "news", label: "News risk", status: "FAIL", detail: "Critical event risk.", blocking: false });
    verdicts.push({ outcome: "WAIT", reason: "Critical news risk window" });
  } else if (input.newsRisk === "high") {
    add({ key: "news", label: "News risk", status: "WARN", detail: "Elevated event risk.", blocking: false });
    verdicts.push({ outcome: "APPROVED_REDUCED", reason: "Elevated news risk — reduce size" });
  } else {
    add({ key: "news", label: "News risk", status: "PASS", detail: `News risk ${input.newsRisk}.`, blocking: false });
  }

  // ── 15. Spread / slippage ─────────────────────────────────────────────────
  if (spread.status === "BLOCKED") {
    add({ key: "spread", label: "Spread", status: "FAIL", detail: spread.note, blocking: false });
    verdicts.push({ outcome: "WAIT", reason: "Spread above tolerance" });
  } else if (spread.status === "WIDE") {
    add({ key: "spread", label: "Spread", status: "WARN", detail: spread.note, blocking: false });
    verdicts.push({ outcome: "APPROVED_REDUCED", reason: "Spread wide — reduce size" });
  } else {
    add({ key: "spread", label: "Spread", status: spread.status === "UNKNOWN" ? "SKIP" : "PASS", detail: spread.note, blocking: false });
  }

  // ── 16. Risk geometry (protective stop required) ──────────────────────────
  if (dataOk && setup.setup !== "NONE" && signal.stopLoss == null) {
    add({ key: "risk_geometry", label: "Risk geometry", status: "FAIL", detail: "No protective stop derivable — risk undefined.", blocking: true });
    verdicts.push({ outcome: "DENIED", reason: "No protective stop — risk cannot be defined" });
  } else if (signal.stopLoss != null) {
    add({ key: "risk_geometry", label: "Risk geometry", status: "PASS", detail: `Stop @ ${signal.stopLoss}.`, blocking: false });
  } else {
    add({ key: "risk_geometry", label: "Risk geometry", status: "SKIP", detail: "No setup to size.", blocking: false });
  }

  // ── 17. No-trade intelligence ─────────────────────────────────────────────
  add({ key: "no_trade", label: "No-trade score", status: noTrade.isNoTrade ? "WARN" : "PASS", detail: noTrade.reason || `No-trade score ${noTrade.score}.`, blocking: false });
  if (noTrade.isNoTrade && dataOk) verdicts.push({ outcome: "WATCH_ONLY", reason: noTrade.reason || "Skipping is the higher-probability call" });

  // ── 18. Confidence decay ──────────────────────────────────────────────────
  add({ key: "confidence_decay", label: "Confidence decay", status: decay.expired ? "WARN" : "PASS", detail: decay.note, blocking: false });
  if (decay.expired && dataOk) verdicts.push({ outcome: "WAIT", reason: "Signal confidence expired" });

  // ── Thesis (no thesis ⇒ no decision) ──────────────────────────────────────
  const thesis = buildTradeThesis({ signal, setup: setup.setup, side: setup.side, decayedConfidence: decay.decayed });

  // ── Base verdict ──────────────────────────────────────────────────────────
  if (thesis) {
    verdicts.push({ outcome: "APPROVED", reason: "All decision checks passed (shadow)." });
  } else if (verdicts.length === 0) {
    verdicts.push({ outcome: "WATCH_ONLY", reason: "No actionable thesis yet." });
  }

  const finalVerdict = mostRestrictive(verdicts);

  // ── Scoring ───────────────────────────────────────────────────────────────
  const rank = computeRankScore({
    edge: signal.edgeScore,
    setupScore: setup.score,
    regimeFit: regime.fitScore,
    mtfAgreement: mtf.agreementScore,
    newsSafety: signal.scores.newsSafety,
    noTradeScore: noTrade.score,
    decayedConfidence: decay.decayed,
    agentRankWeight: input.agentRankWeight,
  });
  const scoreBreakdown = buildScoreBreakdown({
    scores: signal.scores,
    regimeFit: regime.fitScore,
    mtfAgreement: mtf.agreementScore,
    setup: setup.score,
    noTrade: noTrade.score,
    rank,
  });

  const reason = finalVerdict.reason;
  return {
    agentId: input.agentId,
    agentKey: input.agentKey,
    agentRankWeight: input.agentRankWeight,
    symbol: input.symbol,
    timeframe: input.timeframe,
    side: setup.side,
    setup: setup.setup,
    outcome: finalVerdict.outcome,
    conflictState: "NONE",
    ownerAgentKey: null,
    plannedAction: plannedActionFor(finalVerdict.outcome, setup.side, input.symbol, reason),
    reason,
    riskState: riskBand(input.governor.status),
    setupScore: setup.score,
    rankScore: rank,
    noTradeScore: noTrade.score,
    confidence: round(signal.scores.overall),
    confidenceDecayed: decay.decayed,
    setupExpiresAt: thesis ? signal.expiresAt : null,
    checks,
    scoreBreakdown,
    thesis,
    quotaProgress: input.quota,
  };
}
