// Ruby Scalp Signals — service layer.
//
// Gathers the live inputs the pure engine needs (scanner read, broker symbol
// specs, per-user account allocation) and calls `evaluateScalp`. ONE engine
// feeds all three surfaces:
//   - Focus card        -> evaluateScalpForSymbol (on-demand live read)
//   - Broad ranking     -> rankScalpsForUniverse  (shared scanner cache)
//   - Ruby Scalp Builder-> buildScalp             (target/risk driven)
//
// SAFETY:
//  - Per-user isolation: specs + account are read scoped by userId.
//  - DEMO/LIVE only. The engine rejects any non-LIVE_FEED read as AWAITING_DATA;
//    nothing here fabricates a price, lot, TP or SL.
//  - No global scanner state is mutated. Focus AND Broad both use the
//    non-mutating scanSymbolTimeframe for on-demand LIVE reads. Broad does
//    NOT depend on the background scanner cache (which can be empty and
//    mixes timeframes), so it never reports a false scanned:0.

import {
  scanSymbolTimeframe,
  decorateOpportunitiesWithNewsRisk,
  symbolsForUniverse,
  type ScannerOpportunity,
  type UniverseId,
} from "../marketScanner.js";
import { evaluateScalp } from "./scalpEngine.js";
import {
  loadSpecInput,
  loadAccountInput,
  candleWindowFor,
  loadExecutionInput,
  currentQuoteFor,
  liveSpreadPointsFrom,
  withLiveSpread,
  deriveHtfBias,
  SCALP_TIMEFRAME,
} from "./scalpServiceInputs.js";
import { getActiveLockoutDirections } from "./scalpManageService.js";
import {
  computeScalpAdvisory,
  toUserAdvisory,
  recordAdvisoryTrace,
} from "../agentEcosystem/advisoryInfluence.js";
import {
  computeSurfaceGovernance,
  maybeRecordDisagreement,
  runTrafficSelection,
  toUserGovernance,
  recordGovernanceTrace,
  persistGovernanceTrace,
} from "../agentEcosystem/governance.js";
import { loadSymbolPersonality } from "./scalpJournalService.js";
import type {
  ScalpCandle,
  ScalpEngineInput,
  ScalpMode,
  ScalpPatternImpact,
  ScalpResult,
  ScalpScannerInput,
  RiskBand,
  RiskPersonality,
} from "./scalpTypes.js";

/** Cap candidate symbols pulled through DB spec lookups on the hot path. */
const MAX_RANK_CANDIDATES = 40;

export const SCALP_MODES: readonly ScalpMode[] = [
  "SNIPER", "SAFER", "FAST", "MOMENTUM", "REVERSAL", "ANY",
];

export function isScalpMode(v: unknown): v is ScalpMode {
  return typeof v === "string" && (SCALP_MODES as readonly string[]).includes(v);
}

export type ScalpMarketGroup = UniverseId;
const MARKET_GROUPS: readonly ScalpMarketGroup[] = [
  "all", "forex", "metals", "indices", "crypto", "synthetic",
];
export function isMarketGroup(v: unknown): v is ScalpMarketGroup {
  return typeof v === "string" && (MARKET_GROUPS as readonly string[]).includes(v);
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Map the scanner's news risk-level to the engine's coarse band. */
function mapNewsRisk(level: string | null | undefined): RiskBand {
  switch ((level || "").toLowerCase()) {
    case "high":
    case "critical": return "HIGH";
    case "medium": return "MEDIUM";
    default: return "LOW";
  }
}

function coerceBias(b: string): ScalpScannerInput["bias"] {
  switch (b) {
    case "bullish":
    case "bearish":
    case "neutral":
    case "choppy": return b;
    default: return "neutral";
  }
}

function coerceAction(a: string): ScalpScannerInput["recommendedAction"] {
  switch (a) {
    case "BUY":
    case "SELL":
    case "WAIT":
    case "REJECT": return a;
    default: return "WAIT";
  }
}

type DecoratedOpportunity = ScannerOpportunity & {
  newsContext?: { riskLevel?: string | null };
};

/**
 * Map the opportunity's display-only `PatternScannerImpact` (Task #617) into the
 * scalp engine's local `ScalpPatternImpact`. DOWNGRADE-ONLY by construction: the
 * derived status/flags can only let the engine tighten the read. The scalp fold
 * only runs on a live feed (the engine gates non-live to AWAITING_DATA first), so
 * the lifecycle status comes through the label faithfully. Returns null when no
 * pattern was detected (labelHint "none") so the engine is untouched.
 */
function oppToScalpPatternImpact(
  impact: ScannerOpportunity["patternImpact"],
): ScalpPatternImpact | null {
  if (!impact || impact.labelHint === "none") return null;
  let status = "none";
  switch (impact.labelHint) {
    case "failed_setup": status = "failed"; break;
    case "too_late_chase": status = "exhausted"; break;
    case "forming_setup":
    case "needs_confirmation": status = "forming"; break;
    case "supportive": status = "confirmed"; break;
    default: status = "none"; break; // context_only | mixed_conditional | limited_room
  }
  const qualityCeiling =
    impact.qualityCeiling === "high" ? 100 :
    impact.qualityCeiling === "medium" ? 70 :
    impact.qualityCeiling === "low" ? 50 : 30;
  return {
    status,
    conditional: impact.conditional,
    contextOnly: impact.contextOnly,
    chaseRisk: impact.labelHint === "too_late_chase",
    qualityCeiling,
    limitedRoom: impact.labelHint === "limited_room",
  };
}

function oppToScannerInput(opp: DecoratedOpportunity): ScalpScannerInput {
  return {
    bias: coerceBias(opp.bias),
    recommendedAction: coerceAction(opp.recommendedAction),
    confidenceScore: opp.confidenceScore,
    entrySniperScore: opp.entrySniperScore,
    // The analyzer's REAL trend strength — without it the engine's trend-based
    // mode tilts and the ANY-mode type label ran forever on a constant 50
    // (every card "Sniper Scalp", every tilt zero). Absent ⇒ honest undefined.
    trendStrength:
      typeof opp.trendStrength === "number" && Number.isFinite(opp.trendStrength)
        ? opp.trendStrength
        : undefined,
    setupType: opp.setupType,
    entry: opp.entry,
    stopLoss: opp.stopLoss,
    takeProfit: opp.takeProfit,
    // The analyzer's structural entry zone — without it the engine synthesized
    // a band from spread/point constants and presented it as a precise range.
    entryZone: opp.entryZone ?? undefined,
    reasonForTrade: opp.reasonForTrade,
    reasonToAvoid: opp.reasonToAvoid,
    dataSource: opp.dataSource,
    // The scanner row's shared sufficiency verdict rides along so the engine
    // gates actionability on the SAME authority the scanner displays. `null`
    // (not omitted) when absent — the engine fail-closes either way.
    sufficiency: opp.sufficiency ?? null,
    newsRisk: mapNewsRisk(opp.newsContext?.riskLevel),
    generatedAt: opp.generatedAt,
  };
}

export interface ScalpFocusArgs {
  symbol: string;
  mode: ScalpMode;
  riskAmount?: number | null;
  targetProfitAmount?: number | null;
  riskPersonality?: RiskPersonality | null;
}

/** Focus card: on-demand live read of ONE symbol, evaluated by the engine. */
export async function evaluateScalpForSymbol(userId: number, args: ScalpFocusArgs): Promise<ScalpResult> {
  const [spec, account, opp, quote, candles, execution, personality] = await Promise.all([
    loadSpecInput(userId, args.symbol),
    loadAccountInput(userId),
    scanSymbolTimeframe(args.symbol, SCALP_TIMEFRAME),
    currentQuoteFor(args.symbol),
    candleWindowFor(args.symbol),
    loadExecutionInput(userId),
    loadSymbolPersonality(userId, args.symbol),
  ]);
  const price = quote.price;

  let scanner: ScalpScannerInput | null = null;
  if (opp) {
    const [decorated] = await decorateOpportunitiesWithNewsRisk([opp]);
    scanner = oppToScannerInput((decorated ?? opp) as DecoratedOpportunity);
  }

  const input: ScalpEngineInput = {
    symbol: args.symbol,
    currentPrice: price,
    spec,
    scanner,
    account,
    mode: args.mode,
    riskAmount: args.riskAmount ?? null,
    targetProfitAmount: args.targetProfitAmount ?? null,
    candles,
    // Live quote spread (converted to points) rides on the execution input so
    // the engine's spread evidence + the flame's spread-spike guard run on the
    // CURRENT market, not on the EA's last snapshot.
    execution: withLiveSpread(execution, liveSpreadPointsFrom(quote.spreadPrice, spec)),
    htfBias: deriveHtfBias(candles),
    riskPersonality: args.riskPersonality ?? "BALANCED",
    symbolPersonality: personality
      ? { qualityBias: personality.qualityBias, minQualityDelta: personality.minQualityDelta }
      : null,
    patternImpact: opp ? oppToScalpPatternImpact(opp.patternImpact) : null,
  };
  let result = evaluateScalp(input);

  // Failed-flame lockout: if the read points to a direction that recently had a
  // failed flame on THIS symbol (per-user), re-run with the cooldown flag so the
  // engine tightens it to NO_CLEAN_SCALP. The flag only ever tightens advice;
  // it never loosens a gate. The lockout read is skipped when there's no
  // actionable direction (nothing to cool down).
  if (result.direction) {
    try {
      const locked = await getActiveLockoutDirections(userId, args.symbol);
      if (locked.has(result.direction)) {
        result = evaluateScalp({ ...input, recentFailureLockout: true });
      }
    } catch {
      // Lockout is advisory-only; never fail a read because the lookup errored.
    }
  }

  // Populate riskDowngradeReason on the admin trace when isWeakFlame returns
  // true specifically because of poor run-on quality (qualityScore < 0.3).
  // This is the only RUN_ON-specific downgrade path — all other isWeakFlame
  // triggers (WEAKENING/EXHAUSTED/FAILED/chasing etc.) are not run-on-specific.
  if (
    result.flame.flameStage === "RUN_ON" &&
    result.flame.runOnTrace &&
    result.flame.runOnTrace.qualityScore < 0.3
  ) {
    result = {
      ...result,
      flame: {
        ...result.flame,
        runOnTrace: {
          ...result.flame.runOnTrace,
          riskDowngradeReason:
            `Run-on quality too low (${result.flame.runOnTrace.qualityScore.toFixed(2)}) — ` +
            `choppy bodies or heavy opposing wicks degraded the burst below the minimum threshold.`,
        },
      },
    };
  }

  return await attachScalpAdvisory(result);
}

/**
 * Honest weak-flame read for the Governance Court (drives the SCALP challenge).
 * True when the flame is decayed, late, chasing, reversal-prone, or built blind —
 * all derived from the engine's own flame fields, never fabricated.
 */
function isWeakFlame(f: ScalpResult["flame"]): boolean {
  if (f.blind) return true;
  if (["WEAKENING", "EXHAUSTED", "FAILED", "REVERSAL_RISK", "NONE"].includes(f.flameStage)) return true;
  if (f.freshness === "LATE" || f.freshness === "EXPIRED") return true;
  if (f.chaseRisk === "HIGH" || f.chaseRisk === "EXTREME") return true;
  if (f.entryTiming === "LATE" || f.entryTiming === "CHASING" || f.entryTiming === "NO_ENTRY") return true;
  // A RUN_ON with very poor quality (very choppy / wick-heavy run) signals a
  // degraded burst even though the stage is nominally active. Advisory only.
  if (f.flameStage === "RUN_ON" && f.runOnTrace && f.runOnTrace.qualityScore < 0.3) return true;
  return false;
}

/**
 * Agent Ecosystem advisory (Phase 0) — attach the SCALP specialist's plain-English
 * stance to a scalp read. Advisory only: it surfaces the agent view but NEVER
 * mutates the engine's verdict (status/score/lot) and is NEVER an execution input.
 * Absent while the specialist is in Shadow Mode (0 authority → zero influence) or
 * the registry is unavailable. Best-effort: any error leaves the read untouched.
 */
async function attachScalpAdvisory(result: ScalpResult): Promise<ScalpResult> {
  if (!result.direction) return result;
  try {
    const advisory = await computeScalpAdvisory({
      baseScore: result.qualityScore,
      direction: result.direction,
    });
    if (advisory && advisory.influencingAgentCount > 0) {
      result.agentAdvisory = toUserAdvisory(advisory);
      recordAdvisoryTrace({
        surface: "SCALP", symbol: result.symbol, timeframe: SCALP_TIMEFRAME,
        direction: result.direction,
        at: new Date().toISOString(), result: advisory,
      });
      // Layer 3 governance — the Court lets the SCALP specialist challenge a weak
      // flame and emits a bounded, PROTECTIVE outcome (can only LOWER the read).
      // Advisory only: it never mutates the engine's verdict (status/score/lot) and
      // is never an execution input. Fail-open within this try.
      const traffic = await runTrafficSelection("SCALP", "LOW");
      const review = computeSurfaceGovernance({
        surface: "SCALP",
        direction: result.direction,
        importance: "LOW",
        advisory,
        context: { weakFlame: isWeakFlame(result.flame) },
        traffic: traffic.summary,
        allowedAgentKeys: traffic.participants.map((p) => p.agentKey),
      });
      if (review && review.governanceApplied) {
        result.agentGovernance = toUserGovernance(review);
        recordGovernanceTrace({
          surface: "SCALP", symbol: result.symbol, timeframe: SCALP_TIMEFRAME,
          direction: result.direction,
          at: new Date().toISOString(), review,
        });
        // Agent Court auto-wiring — record a Court learning entry on a genuine
        // disagreement (fire-and-forget) and stamp the trace. Advisory; never live.
        const disagreementCourtUsed = maybeRecordDisagreement(review, {
          symbol: result.symbol, timeframe: SCALP_TIMEFRAME, tradeType: "scalp",
        });
        // Durable proof (fail-soft, fire-and-forget — never slows a scalp read).
        void persistGovernanceTrace({
          actionType: "SCALP_SCAN", surface: "SCALP",
          symbol: result.symbol, timeframe: SCALP_TIMEFRAME,
          review, participants: traffic.participants,
          consideredKeys: traffic.consideredKeys,
          disagreementCourtUsed,
        });
      }
    }
  } catch { /* advisory + governance are best-effort; never fail a scalp read */ }
  return result;
}

/**
 * Attach advisory to a bounded list of RETURNED scalp reads (Broad / Builder).
 * Mutates each result in place. Non-actionable / null entries are skipped by
 * `attachScalpAdvisory` itself. Runs over the cached registry snapshot, so the
 * batch is cheap; still fully fail-open per element.
 */
async function attachScalpAdvisoryToAll(results: (ScalpResult | null)[]): Promise<void> {
  await Promise.all(
    results
      .filter((r): r is ScalpResult => r !== null)
      .map((r) => attachScalpAdvisory(r)),
  );
}

const ACTIONABLE_STATUSES = new Set<ScalpResult["status"]>([
  "READY", "WAIT_FOR_ENTRY", "FORMING", "LATE",
]);

function isActionable(r: ScalpResult): boolean {
  return r.direction !== null && ACTIONABLE_STATUSES.has(r.status);
}

export interface RankInput {
  symbol: string;
  base: Omit<ScalpEngineInput, "mode">;
}

/**
 * Build engine inputs for a market group via an on-demand LIVE scan.
 *
 * We scan the universe's symbols directly at the scalp timeframe using the
 * non-mutating `scanSymbolTimeframe` — the same live read the Focus card uses.
 * This does NOT depend on the background scanner cache, so Broad Scan never
 * reports a false `scanned:0` just because the global loop has not run, and it
 * always reflects the scalp timeframe (not a mixed-timeframe cache row).
 * Symbols without a live feed come back as non-LIVE_FEED and are rejected by the
 * engine (AWAITING_DATA) → filtered out by `isActionable`; nothing fabricated.
 */
async function buildRankInputs(
  userId: number,
  group: ScalpMarketGroup,
  extra: { riskAmount?: number | null; targetProfitAmount?: number | null; riskPersonality?: RiskPersonality | null } = {},
): Promise<RankInput[]> {
  const universeSymbols = symbolsForUniverse(group).slice(0, MAX_RANK_CANDIDATES);
  const scanned = await Promise.all(
    universeSymbols.map((s) => scanSymbolTimeframe(s, SCALP_TIMEFRAME)),
  );
  const opps = scanned.filter(
    (o): o is ScannerOpportunity => o !== null,
  ) as DecoratedOpportunity[];

  // Account + execution are per-user and loaded ONCE (cheap), so the flame's
  // execution-quality band + personality thresholds apply across the ranking.
  // The candle window is NOT re-fetched per symbol here: 40 provider calls on
  // the Broad hot path would blow rate limits, so Broad reads the flame blind
  // (honest NONE) and the Focus card supplies the deep candle-backed read.
  const [decorated, account, execution] = await Promise.all([
    decorateOpportunitiesWithNewsRisk(opps),
    loadAccountInput(userId),
    loadExecutionInput(userId),
  ]);
  const decoratedList = (decorated.length ? decorated : opps) as DecoratedOpportunity[];

  // C2 — Broad/Builder fetch a REAL live quote per symbol, exactly as Focus
  // does via currentPriceFor(). They used to pass `o.entry` as `currentPrice`,
  // which made the two values identical, so `movedToward` was always ~0 and
  // every late/chase gate silently evaluated to "not late" — the one gate whose
  // whole job is to catch a stale pick could not fire on these surfaces.
  const [specs, personalities, liveQuotes] = await Promise.all([
    Promise.all(decoratedList.map((o) => loadSpecInput(userId, o.symbol))),
    Promise.all(decoratedList.map((o) => loadSymbolPersonality(userId, o.symbol))),
    Promise.all(decoratedList.map((o) => currentQuoteFor(o.symbol))),
  ]);

  return decoratedList.map((o, i) => {
    const p = personalities[i];
    return {
      symbol: o.symbol,
      base: {
        symbol: o.symbol,
        // A real quote, or an honest null. Deliberately NOT falling back to
        // `o.entry`: that is what produced the fake "price hasn't moved" read.
        // The engine already refuses to build a trade on a null price.
        currentPrice: liveQuotes[i]?.price ?? null,
        spec: specs[i]!,
        scanner: oppToScannerInput(o),
        account,
        riskAmount: extra.riskAmount ?? null,
        targetProfitAmount: extra.targetProfitAmount ?? null,
        candles: null,
        // Per-symbol LIVE spread from the same quote read — the shared per-user
        // execution signals plus the one per-symbol reading that must not be
        // shared across symbols.
        execution: withLiveSpread(
          execution,
          liveSpreadPointsFrom(liveQuotes[i]?.spreadPrice ?? null, specs[i]!),
        ),
        htfBias: null,
        riskPersonality: extra.riskPersonality ?? "BALANCED",
        // Learned per-symbol tightening also applies on Broad/Builder, not just
        // Focus — otherwise a cautious market would still rank cleanly here.
        symbolPersonality: p
          ? { qualityBias: p.qualityBias, minQualityDelta: p.minQualityDelta }
          : null,
        patternImpact: oppToScalpPatternImpact(o.patternImpact),
      },
    };
  });
}

export function rankUnder(inputs: RankInput[], mode: ScalpMode): ScalpResult[] {
  return inputs
    .map((i) => evaluateScalp({ ...i.base, mode }))
    .filter(isActionable)
    .sort((a, b) => b.qualityScore - a.qualityScore);
}

export interface ScalpRankArgs {
  marketGroup: ScalpMarketGroup;
  mode: ScalpMode;
  limit: number;
  riskPersonality?: RiskPersonality | null;
}

export interface ScalpRankResult {
  opportunities: ScalpResult[];
  best: ScalpResult | null;
  safer: ScalpResult | null;
  fastest: ScalpResult | null;
  scanned: number;
}

/** Broad ranking: Best / Safer / Fastest picks + a ranked list. */
export async function rankScalpsForUniverse(userId: number, args: ScalpRankArgs): Promise<ScalpRankResult> {
  const inputs = await buildRankInputs(userId, args.marketGroup, {
    riskPersonality: args.riskPersonality ?? null,
  });
  const main = rankUnder(inputs, args.mode);
  const opportunities = main.slice(0, Math.max(1, Math.min(20, args.limit)));
  const best = rankUnder(inputs, "SNIPER")[0] ?? null;
  const safer = rankUnder(inputs, "SAFER")[0] ?? null;
  const fastest = rankUnder(inputs, "FAST")[0] ?? null;
  // Agent Ecosystem advisory (Phase 0) — attach the SCALP specialist's stance to
  // the bounded set of RETURNED reads only (≤20 + 3 headlines), over the cached
  // registry snapshot. Advisory-only, fail-open, and never an execution input;
  // absent while the specialist is in Shadow Mode (0 authority → zero influence).
  await attachScalpAdvisoryToAll([...opportunities, best, safer, fastest]);
  return { opportunities, best, safer, fastest, scanned: inputs.length };
}

export interface ScalpBuildArgs {
  targetProfitAmount?: number | null;
  riskAmount?: number | null;
  mode: ScalpMode;
  marketGroup: ScalpMarketGroup;
  riskPersonality?: RiskPersonality | null;
}

export interface ScalpBuildResult {
  primary: ScalpResult | null;
  alternatives: ScalpResult[];
  scanned: number;
  noTradeReason: string | null;
}

/** Ruby Scalp Builder: find the best scalp matching a target/risk. */
export async function buildScalp(userId: number, args: ScalpBuildArgs): Promise<ScalpBuildResult> {
  const inputs = await buildRankInputs(userId, args.marketGroup, {
    riskAmount: args.riskAmount ?? null,
    targetProfitAmount: args.targetProfitAmount ?? null,
    riskPersonality: args.riskPersonality ?? null,
  });
  const ranked = rankUnder(inputs, args.mode);
  const primary = ranked[0] ?? null;
  const alternatives = ranked.slice(1, 4);
  // Agent Ecosystem advisory (Phase 0) — same bounded, advisory-only attach as
  // the Focus and Broad paths so the Ruby Scalp Builder surfaces the specialist's
  // stance consistently (zero influence while the specialist is in Shadow Mode).
  await attachScalpAdvisoryToAll([primary, ...alternatives]);
  return {
    primary,
    alternatives,
    scanned: inputs.length,
    noTradeReason: primary
      ? null
      : "No clean scalp matches your target right now. Try a wider market group, a different mode, or a smaller target.",
  };
}
