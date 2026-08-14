// buildRubyMarketEdge — composes every pure engine into the ONE normalized
// Ruby Market Edge signal. Deterministic: all time comes from `input.now`.
//
// This is the single seam the api-server service calls after it has normalized
// real scanner/scalp/market-data outputs and loaded the per-user previous
// snapshot. It NEVER fabricates: a blind/insufficient read yields an honest
// WATCHING signal with zeroed scores, null zones, and hasSufficientData=false.

import type {
  PriceZone,
  RubyMarketEdgeSignal,
  SignalBias,
  SignalDirection,
  SignalEngineInput,
} from "./signalIntelligence.types.js";
import { MIN_STRUCTURE_CANDLES } from "./signalIntelligence.types.js";
import { readEarlyTrend } from "./earlyTrendRadar.js";
import { classifyRegime, detectFakeout } from "./regimeFakeout.js";
import { classifyLifecycle } from "./lifecycleEngine.js";
import { computeFreshness, buildEvidence } from "./freshnessEvidence.js";
import {
  computeLateDetection,
  computeScores,
  confidenceBandFor,
} from "./scoring.js";
import { diffSignal } from "./marketMemory.js";
import { playbookWeight, sessionContext } from "./sessionIntelligence.js";

const ENTRY_STAGES = new Set(["ENTRY_APPROACHING", "ENTRY_WINDOW_OPEN", "LATE"]);
const WATCH_STAGES = new Set(["WATCHING", "TREND_FORMING", "SETUP_FORMING"]);

function deriveBias(structure: string, blind: boolean): SignalBias {
  if (blind) return "UNCLEAR";
  switch (structure) {
    case "HH_HL": return "BULLISH";
    case "LH_LL": return "BEARISH";
    case "RANGE": return "RANGING";
    case "CHOPPY": return "MIXED";
    default: return "UNCLEAR";
  }
}

function deriveDirection(
  scanner: SignalEngineInput["scanner"],
  pressure: string,
): SignalDirection {
  if (scanner?.recommendedAction === "BUY") return "BUY";
  if (scanner?.recommendedAction === "SELL") return "SELL";
  if (scanner?.recommendedAction === "REJECT") return "NEUTRAL";
  if (pressure === "BUILDING_BULLISH") return "BUY";
  if (pressure === "BUILDING_BEARISH") return "SELL";
  return "NEUTRAL";
}

export function buildRubyMarketEdge(input: SignalEngineInput): RubyMarketEdgeSignal {
  const now = input.now;
  const { candles, scanner, scalp, execution, newsRiskLevel, previous } = input;

  const hasSufficientData = !!candles && candles.length >= MIN_STRUCTURE_CANDLES;

  // ── Reads ────────────────────────────────────────────────────────────────
  const early = readEarlyTrend(candles);
  const regime = classifyRegime(candles);
  const fakeout = detectFakeout(candles, early);
  const session = sessionContext(now);
  const pbWeight = playbookWeight(input.assetClass, regime, session);

  const bias = deriveBias(early.structure, early.blind);
  const direction = deriveDirection(scanner, early.pressure);

  // ── Continuity / firstSeen ────────────────────────────────────────────────
  const prevFirstMs = previous?.firstSeenAt ? Date.parse(previous.firstSeenAt) : NaN;
  const continuity =
    !!previous &&
    previous.direction === direction &&
    direction !== "NEUTRAL" &&
    Number.isFinite(prevFirstMs);
  const firstSeenMs = continuity ? prevFirstMs : now;

  // ── Freshness / expiry ────────────────────────────────────────────────────
  const fresh = computeFreshness(input.timeframe, firstSeenMs, now);

  // ── Invalidation ──────────────────────────────────────────────────────────
  let invalidated = false;
  if (
    direction !== "NEUTRAL" &&
    input.currentPrice != null &&
    scanner?.stopLoss != null
  ) {
    invalidated =
      direction === "BUY"
        ? input.currentPrice <= scanner.stopLoss
        : input.currentPrice >= scanner.stopLoss;
  }

  // ── Late detection ────────────────────────────────────────────────────────
  const late = computeLateDetection({
    direction,
    candles,
    currentPrice: input.currentPrice,
    scanner,
    scalp,
    signalAgeSeconds: fresh.ageSeconds,
  });

  // ── Evidence ──────────────────────────────────────────────────────────────
  const evidence = buildEvidence({
    bias,
    direction,
    early,
    fakeout,
    scanner,
    scalp,
    newsRiskLevel,
    htfContext: scalp?.htfContext ?? null,
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  const lifecycle = classifyLifecycle({
    early,
    fakeout,
    scanner,
    late,
    hasSufficientData,
    invalidated,
    expired: fresh.expired,
  });

  // ── Scores ────────────────────────────────────────────────────────────────
  const scores = computeScores({
    direction,
    hasSufficientData,
    early,
    fakeout,
    scanner,
    scalp,
    execution,
    evidence,
    late,
    newsRiskLevel,
    playbookWeight: pbWeight,
  });
  const confidenceBand = confidenceBandFor(scores.overall);

  // ── Zones (honest null when not derivable) ────────────────────────────────
  const rawZone: PriceZone | null = scanner?.entryZone
    ? { from: scanner.entryZone.from, to: scanner.entryZone.to }
    : scanner?.entry != null
      ? { from: scanner.entry, to: scanner.entry }
      : null;

  let entryZone: PriceZone | null = null;
  let watchZone: PriceZone | null = null;
  if (ENTRY_STAGES.has(lifecycle.stage)) entryZone = rawZone;
  else if (WATCH_STAGES.has(lifecycle.stage) && direction !== "NEUTRAL") watchZone = rawZone;

  const retestZone: PriceZone | null =
    early.bosChoch !== "NONE" && rawZone ? rawZone : null;

  let doNotChaseZone: PriceZone | null = null;
  if (late.isLate && scanner?.entry != null && input.currentPrice != null) {
    doNotChaseZone = {
      from: Math.min(scanner.entry, input.currentPrice),
      to: Math.max(scanner.entry, input.currentPrice),
    };
  }

  const takeProfitZones: PriceZone[] =
    scanner?.takeProfit != null ? [{ from: scanner.takeProfit, to: scanner.takeProfit }] : [];
  const stopLoss = scanner?.stopLoss ?? null;
  const invalidationPrice = scanner?.stopLoss ?? null;

  // ── Market memory diff ────────────────────────────────────────────────────
  const whatChanged = diffSignal(previous, {
    bias,
    direction,
    regime,
    lifecycleStage: lifecycle.stage,
    confidenceBand,
    edgeScore: scores.edge,
    overallScore: scores.overall,
  });

  // ── Reason chain (terse factual; copy is Phase 2) ─────────────────────────
  const reasonChain: string[] = [];
  reasonChain.push(...lifecycle.reasons);
  if (!early.blind && early.notes.length > 0) reasonChain.push(early.notes[0]!);
  if (fakeout.detected && fakeout.reason) reasonChain.push(fakeout.reason);
  if (evidence.conflicts.length > 0) reasonChain.push(...evidence.conflicts.slice(0, 2));
  if (late.isLate && late.reason) reasonChain.push(`Late: ${late.reason}.`);
  if (!evidence.meetsMinimum && direction !== "NEUTRAL") {
    reasonChain.push("Below the minimum-evidence floor to act.");
  }
  if (whatChanged.hasPrevious && whatChanged.changes.length > 0) {
    reasonChain.push(whatChanged.summary);
  }

  const lateReason = late.isLate ? late.reason ?? "Clean entry already passed." : null;

  return {
    symbol: input.symbol,
    displayName: input.displayName,
    timeframe: input.timeframe,
    assetClass: input.assetClass,
    generatedAt: new Date(now).toISOString(),

    dataSource: input.dataSource,
    hasSufficientData,

    bias,
    direction,
    regime,
    lifecycleStage: lifecycle.stage,
    lifecycleReasons: lifecycle.reasons,

    entryZone,
    watchZone,
    retestZone,
    doNotChaseZone,
    invalidationPrice,
    takeProfitZones,
    stopLoss,

    scores,
    confidenceBand,
    edgeScore: scores.edge,

    earlyTrend: early,
    fakeout,
    late,
    evidence,
    session,

    reasonChain,
    whatChanged,

    freshness: fresh.freshness,
    validForSeconds: fresh.validForSeconds,
    expiresAt: new Date(firstSeenMs + fresh.validForSeconds * 1000).toISOString(),
    firstSeenAt: new Date(firstSeenMs).toISOString(),
    lateReason,
  } satisfies RubyMarketEdgeSignal;
}
