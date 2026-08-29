// ── Profit Mission Phase 7 — Execution-quality / exposure / net-profit service ─
//
// SAFETY / SCOPE:
//   - This service RESOLVES honest live inputs from the EXISTING seams
//     (getBrokerHealthVerdict, the per-user open `arx_live_positions`, the
//     MT5/feed runtime signals, the ARX Focus registry) and COMPOSES the five
//     pure Phase 7 domain engines into one aggregate pre-check verdict.
//   - It is BLOCK / DOWNGRADE ONLY. Nothing here can upgrade a setup, relax an
//     existing gate, or place an order. The real per-user governor + 23-gate live
//     dispatch still run unconditionally inside `executeInstant`; these pre-checks
//     only layer ADDITIONAL strictness on top of the Phase 6 gated path.
//   - It NEVER fabricates spread / slippage / quote data: when an input cannot be
//     honestly observed it is passed through as `unknown`/null, and the engines
//     surface that honestly (never "good"/"normal").
//   - Per-user isolation: open exposure is read ONLY from rows owned by the
//     dispatching `userId`.
//
// Aggregate-block policy (what blocks the FINAL dispatch):
//   - Broker/feed execution-health gate, exposure breach, and execution-quality
//     hard blockers ALWAYS block (these are fully resolvable from honest seams).
//   - Net-profit blocks dispatch ONLY on a positively-evidenced verdict
//     (net loss / below-floor). Its fail-closed "unverified" states (no target /
//     no cost estimate at the dispatch boundary) are surfaced as WARNINGS, not a
//     hard dispatch block — the net-profit filter's fail-closed teeth live at
//     proposal selection, and the 23-gate path still runs. This keeps the
//     pre-check additive (it never relaxes a gate) without falsely blocking an
//     already-approved, fully-gated draft on un-observable cost data.
//   - Capital efficiency is advisory/ranking ONLY and never blocks.
import { and, eq, isNull } from "drizzle-orm";
import { db, arxLivePositionsTable } from "@workspace/db";
import {
  composeExecutionHealthGate,
  computeExecutionQuality,
  computeNetProfitVerdict,
  evaluateExposure,
  aggregateExposure,
  computeCapitalEfficiency,
  type ExposureAggregates,
  type ExecutionHealthInput,
  type ExecutionHealthVerdict,
  type ExecutionQualityVerdict,
  type NetProfitVerdict,
  type NetProfitAssetClass,
  type ExposureVerdict,
  type ExposurePosition,
  type ExposureBudget,
  type CapitalEfficiencyScore,
  type ExecHealthBrokerSeverity,
  type ExecHealthFeedStatus,
  type ExecHealthSpread,
  type QuoteFreshness,
} from "@workspace/domain/profit-mission";
import { resolveArxMarket } from "@workspace/domain/market";
import type { BrokerHealthStatus } from "@workspace/domain/broker-health";
import type { SymbolFeedVerdict } from "@workspace/domain/safety-contracts/syntheticLiveFloor";
import { getBrokerHealthVerdict } from "../routes/brokerHealth.js";
import { evaluateEntryDataSufficiency } from "./live/entryDataSufficiency.js";
import { resolveExpectedMovePips } from "./marketModel/expectedMovePips.js";
import type { MissionLiveSignals } from "./missionRiskService.js";

// Net-profit blockers that are fail-closed "we could not verify" states rather
// than positively-evidenced rejections. These are surfaced as warnings at the
// dispatch boundary instead of hard-blocking an already-gated draft.
const NET_PROFIT_SOFT_BLOCKERS = new Set(["NET_PROFIT_UNVERIFIED", "COST_UNVERIFIED"]);

// Timeframes treated as scalps (stricter spread/edge + net-profit floors).
const SCALP_TIMEFRAMES = new Set(["S1", "S5", "S15", "S30", "M1", "M2", "M3", "M5"]);

export interface Phase7Verdict {
  /** True when the aggregate pre-check refuses the dispatch (additive only). */
  executionBlocked: boolean;
  /** Machine-readable block reasons (empty when not blocked). */
  blockReasons: string[];
  /** Honest, de-duplicated cautions across every engine. */
  warnings: string[];
  executionQuality: ExecutionQualityVerdict;
  netProfit: NetProfitVerdict;
  exposure: ExposureVerdict;
  capitalEfficiency: CapitalEfficiencyScore;
  health: ExecutionHealthVerdict;
}

/** Honest plan economics for the proposed trade (resolved by the caller). */
export interface Phase7DraftEconomics {
  symbol: string;
  timeframe: string;
  direction: "BUY" | "SELL";
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lot: number | null;
  riskAmount: number | null;
  expectedR: number | null;
}

export interface Phase7EvaluateArgs {
  userId: number;
  missionId: number;
  draft: Phase7DraftEconomics;
  /** The mission risk budget (drives the exposure caps; stricter-only). */
  budget: ExposureBudget;
  /** Honest live runtime signals (same source the Phase 6 mission gate trusts). */
  signals: MissionLiveSignals;
  nowMs: number;
}

/** Injectable evaluator seam — production uses the real {@link evaluatePhase7PreChecks}. */
export type Phase7Evaluator = (args: Phase7EvaluateArgs) => Promise<Phase7Verdict>;

// ── Honest input mappers ─────────────────────────────────────────────────────

/** Map an ARX market category onto the net-profit asset-class bucket. */
function assetClassFor(symbol: string): NetProfitAssetClass {
  const market = resolveArxMarket(symbol);
  if (!market) return "unknown";
  switch (market.category) {
    case "forex_major":
      return "forex_major";
    case "forex_minor":
      return "forex_minor";
    case "metal":
      return "metal";
    case "index":
      return "index";
    case "crypto":
      return "crypto";
    case "synthetic":
      return "synthetic";
    default:
      return "unknown";
  }
}

/**
 * Currencies an instrument is exposed to, derived from its canonical symbol.
 * Only a clean 6-letter pair (EURUSD / XAUUSD / BTCUSD) yields currencies; an
 * index / synthetic yields none. Never guessed — empty when not parseable.
 */
function currenciesFor(symbol: string): string[] {
  const market = resolveArxMarket(symbol);
  const canonical = market?.canonicalSymbol ?? symbol;
  const upper = canonical.toUpperCase();
  if (/^[A-Z]{6}$/.test(upper)) {
    return [upper.slice(0, 3), upper.slice(3, 6)];
  }
  return [];
}

function isScalpTimeframe(timeframe: string): boolean {
  return SCALP_TIMEFRAMES.has(timeframe.trim().toUpperCase());
}

/** Broker-health verdict severity → execution-health severity bucket. */
function brokerSeverityFrom(severity: "OK" | "WARN" | "DANGER"): ExecHealthBrokerSeverity {
  if (severity === "OK") return "ok";
  if (severity === "WARN") return "warn";
  return "danger";
}

/** Honest feed-truth runtime signal → execution-health feed status. */
function feedStatusFrom(signals: MissionLiveSignals): ExecHealthFeedStatus {
  switch (signals.feedStatus) {
    case "live":
      return "live";
    case "delayed":
      return "delayed";
    case "stale":
      return "stale";
    default:
      return "unknown";
  }
}

/** Honest mt5_broker-aware feed verdict → execution-health feed status. */
function feedStatusFromVerdict(verdict: SymbolFeedVerdict): ExecHealthFeedStatus {
  switch (verdict) {
    case "LIVE":
      return "live";
    case "LIVE_DELAYED":
      return "delayed";
    default:
      // AWAITING — no confirmed live tick; honest unverified (never "live").
      return "awaiting";
  }
}

/** Strictness rank for a feed status (higher = stricter / more degraded). */
function feedSeverity(status: ExecHealthFeedStatus): number {
  switch (status) {
    case "live":
      return 0;
    case "delayed":
      return 1;
    case "stale":
      return 2;
    default:
      // awaiting | simulator | unknown — all fail-closed (refuse execution).
      return 3;
  }
}

/** Combine two feed statuses keeping the STRICTER one (never upgrades). */
function strictestFeedStatus(
  a: ExecHealthFeedStatus,
  b: ExecHealthFeedStatus,
): ExecHealthFeedStatus {
  return feedSeverity(a) >= feedSeverity(b) ? a : b;
}

/** Honest quote-freshness from a resolved feed status (never fabricated fresh). */
function quoteFreshnessFromResolved(
  status: ExecHealthFeedStatus,
  quoteFresh: boolean,
): QuoteFreshness {
  if (status === "stale") return "stale";
  if (status === "live") return quoteFresh ? "fresh" : "delayed";
  if (status === "delayed") return "delayed";
  // awaiting | simulator | unknown.
  return "unknown";
}

/** Honest mission-level (symbol-independent) feed status from broker health. */
function pulseFeedStatusFromBroker(status: BrokerHealthStatus | null): ExecHealthFeedStatus {
  if (status === "CONNECTED") return "live";
  if (status === "DEGRADED" || status === "PRICE_FEED_DELAYED") return "delayed";
  // null / DISCONNECTED / AUTH_ERROR / EXECUTION_DISABLED / MAINTENANCE_MODE.
  return "unknown";
}

function spreadFrom(signals: MissionLiveSignals): ExecHealthSpread {
  switch (signals.spread) {
    case "normal":
      return "normal";
    case "wide":
      return "wide";
    case "extreme":
      return "extreme";
    default:
      return "unknown";
  }
}

/** Load this user's OPEN live positions as honest exposure rows (per-user only). */
async function loadOpenExposure(userId: number): Promise<ExposurePosition[]> {
  const rows = await db
    .select()
    .from(arxLivePositionsTable)
    .where(and(eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt)));
  return rows.map((r) => {
    const direction: "BUY" | "SELL" = String(r.side).toUpperCase() === "SELL" ? "SELL" : "BUY";
    // Risk amount on an open broker position is not always known; a negative
    // floating P/L is an honest lower bound, otherwise 0 (never fabricated).
    const floating = typeof r.floatingPl === "number" && Number.isFinite(r.floatingPl) ? r.floatingPl : 0;
    const riskAmount = floating < 0 ? Math.abs(floating) : 0;
    return {
      symbol: r.symbol,
      assetClass: assetClassFor(r.symbol),
      currencies: currenciesFor(r.symbol),
      direction,
      riskAmount,
    };
  });
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v && v.trim().length > 0)));
}

/**
 * Resolve honest live inputs and compose the five Phase 7 engines into one
 * aggregate pre-check verdict. Block/downgrade only.
 */
export const evaluatePhase7PreChecks: Phase7Evaluator = async (args) => {
  const { draft, signals } = args;
  const isScalp = isScalpTimeframe(draft.timeframe);

  // ── Broker/feed execution-health gate (honest seams; fail-closed unknowns). ─
  let brokerSeverity: ExecHealthBrokerSeverity = "unknown";
  let brokerConnected: boolean | null = null;
  try {
    const bh = await getBrokerHealthVerdict();
    brokerSeverity = brokerSeverityFrom(bh.severity);
    brokerConnected =
      bh.status === "CONNECTED" || bh.status === "DEGRADED" || bh.status === "PRICE_FEED_DELAYED";
  } catch {
    // Honest unknown — the gate fails closed (never fabricates broker health).
    brokerSeverity = "unknown";
    brokerConnected = null;
  }
  // The runtime signal can only ADD strictness (disconnected stays disconnected).
  if (signals.brokerConnected === false) brokerConnected = false;

  // ── Honest per-symbol feed truth (mt5_broker-aware; fail-closed). ───────────
  // Feed/quote liveness comes from the SAME chart-intelligence seam the live-entry
  // gate uses (built over routeCandles → recognizes the `mt5_broker` slot), NOT
  // the Deriv-tick resolver (which falsely marks MT5-broker forex like EURUSD as
  // AWAITING). An unverifiable feed fails closed to "awaiting"/"unknown" — it
  // never reads "live". The runtime `signals` channel can only ADD strictness on
  // top of this verified truth (observed degradation), never upgrade it.
  let feedStatus: ExecHealthFeedStatus = "unknown";
  let quoteFresh = false;
  try {
    const entry = await evaluateEntryDataSufficiency(draft.symbol);
    feedStatus = feedStatusFromVerdict(entry.freshnessVerdict);
    quoteFresh = entry.freshnessVerdict === "LIVE";
  } catch {
    // FAIL-CLOSED: an unverifiable feed never reads live.
    feedStatus = "unknown";
    quoteFresh = false;
  }
  feedStatus = strictestFeedStatus(feedStatus, feedStatusFrom(signals));
  if (!signals.quoteFresh) quoteFresh = false;

  const healthInput: ExecutionHealthInput = {
    brokerSeverity,
    brokerConnected,
    feedStatus,
    // Honest "quote tracks the live candle bucket": true only on a confirmed LIVE
    // feed; null (unverified) on any degraded/unconfirmed feed — never fabricated.
    quoteCandleAligned: feedStatus === "live" ? quoteFresh : null,
    spread: spreadFrom(signals),
    ghostPosition: signals.ghostPosition ?? false,
    equityReconciled: signals.equityMismatch === true ? false : true,
    routeHealthy: feedSeverity(feedStatus) >= 3 ? null : true,
  };
  const health = composeExecutionHealthGate(healthInput);

  // ── Execution quality (honest microstructure; unknowns never read "good"). ──
  // Expected move over the trade's timeframe: honestly producible for
  // Volatility-N synthetics (closed-form σ, broker-point pip unit) at the
  // draft's entry price; everything unresolvable stays null — never a guess.
  let expectedMovePips: number | null = null;
  try {
    expectedMovePips = (
      await resolveExpectedMovePips({
        userId: args.userId,
        symbol: draft.symbol,
        timeframe: draft.timeframe,
        price: draft.entryPrice,
        nowMs: args.nowMs,
      })
    ).pips;
  } catch {
    // Honest unknown — a failed pip/spec read never fabricates a move.
    expectedMovePips = null;
  }
  const executionQuality = computeExecutionQuality({
    isScalp,
    direction: draft.direction,
    quoteFreshness: quoteFreshnessFromResolved(feedStatus, quoteFresh),
    // Per-symbol spread / ATR / latency are not honestly observable at the
    // dispatch boundary; left unknown rather than fabricated. The coarse spread
    // regime is enforced by the execution-health gate above.
    spreadPips: null,
    expectedMovePips,
    atrPips: null,
    volumeRatio: null,
    isNewsWindow: signals.highImpactNews === true,
    serverLatencyMs: null,
    signalAgeMs: null,
    maxSignalAgeMs: null,
  });

  // ── Net-profit after costs (target from the draft's own risk model). ───────
  const targetProfit =
    draft.riskAmount != null &&
    Number.isFinite(draft.riskAmount) &&
    draft.riskAmount > 0 &&
    draft.expectedR != null &&
    Number.isFinite(draft.expectedR) &&
    draft.expectedR > 0
      ? draft.riskAmount * draft.expectedR
      : null;
  const netProfit = computeNetProfitVerdict({
    isScalp,
    assetClass: assetClassFor(draft.symbol),
    targetProfit,
    riskAmount: draft.riskAmount,
    // Cost components are not honestly observable here; left unverified (the
    // engine surfaces that honestly rather than fabricating a cheap trade).
    spreadCost: null,
    estimatedSlippageCost: null,
    commission: null,
    swap: null,
    holdsOvernight: false,
  });

  // ── Exposure: this user's open positions + the proposed trade. ─────────────
  const open = await loadOpenExposure(args.userId);
  const exposure = evaluateExposure({
    open,
    proposed: {
      symbol: draft.symbol,
      assetClass: assetClassFor(draft.symbol),
      currencies: currenciesFor(draft.symbol),
      direction: draft.direction,
      riskAmount:
        draft.riskAmount != null && Number.isFinite(draft.riskAmount) && draft.riskAmount > 0
          ? draft.riskAmount
          : 0,
    },
    budget: args.budget,
  });

  // ── Capital efficiency (advisory / ranking only; never blocks). ────────────
  const capitalEfficiency = computeCapitalEfficiency({
    expectedR: draft.expectedR,
    riskAmount: draft.riskAmount,
    estimatedProfit: targetProfit,
  });

  // ── Aggregate block decision (additive, stricter-only). ────────────────────
  const netProfitHardBlockers = netProfit.blockers.filter((b) => !NET_PROFIT_SOFT_BLOCKERS.has(b));
  const executionBlocked =
    !health.executionAllowed ||
    !exposure.allowed ||
    !executionQuality.allowed ||
    netProfitHardBlockers.length > 0;
  const blockReasons = dedupe([
    ...health.blockers,
    ...exposure.blockers,
    ...executionQuality.blockers,
    ...netProfitHardBlockers,
  ]);
  const warnings = dedupe([
    ...health.warnings,
    ...exposure.warnings,
    ...executionQuality.warnings,
    ...netProfit.warnings,
    ...capitalEfficiency.warnings,
  ]);

  return {
    executionBlocked,
    blockReasons,
    warnings,
    executionQuality,
    netProfit,
    exposure,
    capitalEfficiency,
    health,
  };
};

/** Map a mission risk budget onto the exposure caps (stricter-only). */
export function exposureBudgetFrom(budget: {
  maxSameSymbolExposure: number;
  maxCorrelatedExposure: number;
}): ExposureBudget {
  return {
    maxSameSymbolExposure: budget.maxSameSymbolExposure,
    maxCorrelatedExposure: budget.maxCorrelatedExposure,
    maxOpenTrades: null,
    maxMissionExposureAmount: null,
  };
}

// ── Pulse surface (advisory broker/feed health + open exposure) ──────────────

export interface MissionPulsePhase7 {
  /** Broker/feed execution-health gate verdict (symbol-independent). */
  health: ExecutionHealthVerdict;
  /** This user's aggregate OPEN live exposure (per-user isolation). */
  exposure: ExposureAggregates;
}

/**
 * Resolve the advisory Phase 7 pulse surface: honest broker/feed health plus the
 * user's aggregate open live exposure. Display only — never an execution path.
 */
export async function resolveMissionPulsePhase7(args: {
  userId: number;
  signals: MissionLiveSignals;
}): Promise<MissionPulsePhase7> {
  const { signals } = args;
  let brokerSeverity: ExecHealthBrokerSeverity = "unknown";
  let brokerConnected: boolean | null = null;
  let brokerStatus: BrokerHealthStatus | null = null;
  try {
    const bh = await getBrokerHealthVerdict();
    brokerSeverity = brokerSeverityFrom(bh.severity);
    brokerStatus = bh.status;
    brokerConnected =
      bh.status === "CONNECTED" || bh.status === "DEGRADED" || bh.status === "PRICE_FEED_DELAYED";
  } catch {
    brokerSeverity = "unknown";
    brokerConnected = null;
    brokerStatus = null;
  }
  if (signals.brokerConnected === false) brokerConnected = false;

  // The mission pulse is symbol-independent, so it cannot confirm a specific
  // per-symbol quote. Feed status is derived HONESTLY from the real broker-health
  // verdict (never the optimistic runtime signal); quote/route track broker
  // connectivity and the spread stays an honest "unknown" at this level. The
  // per-symbol feed truth is resolved at dispatch in evaluatePhase7PreChecks.
  const health = composeExecutionHealthGate({
    brokerSeverity,
    brokerConnected,
    feedStatus: pulseFeedStatusFromBroker(brokerStatus),
    quoteCandleAligned:
      brokerConnected === true ? true : brokerConnected === false ? false : null,
    spread: "unknown",
    ghostPosition: signals.ghostPosition ?? false,
    equityReconciled: signals.equityMismatch === true ? false : true,
    routeHealthy:
      brokerConnected === true ? true : brokerConnected === false ? false : null,
  });
  const exposure = aggregateExposure(await loadOpenExposure(args.userId));
  return { health, exposure };
}

// ── Scan-time annotation (advisory; NEVER an execution path) ─────────────────
//
// During a mission scan we attach an honest execution-quality + net-profit
// verdict to every reviewed proposal, plus an exposure verdict on the SELECTED
// proposal, so the Judge view and the frontend can show full cost/exposure truth
// alongside the setup. This is display/decision-support only — the scan never
// places an order, and these verdicts can only DOWNGRADE the read, never upgrade.

/** Honest scanner-feed source → quote-freshness (never fabricated fresh). */
function quoteFreshnessFromDataSource(dataSource: string): QuoteFreshness {
  switch (dataSource) {
    case "LIVE_FEED":
      return "fresh";
    case "LIVE_DELAYED":
      return "delayed";
    case "STALE_FEED":
      return "stale";
    default:
      // SIMULATOR / AWAITING_FEED / HISTORY_READY_AWAITING_LIVE_TICK / unknown.
      return "unknown";
  }
}

export interface ScanProposalAnnotationInput {
  proposalId: string;
  symbol: string;
  timeframe: string;
  direction: "BUY" | "SELL" | "NONE";
  /** Honest scanner data source for the read (drives quote freshness). */
  dataSource: string;
  riskAmount: number | null;
  expectedR: number | null;
  /**
   * The proposal's planned entry price when it has one (additive; drives the
   * expected-move-in-pips production for synthetics). null/absent ⇒ the move
   * honestly stays unknown.
   */
  entryPrice?: number | null;
  /** True for the Judge-selected proposal (gets the exposure verdict). */
  isSelected: boolean;
}

export interface ScanProposalAnnotation {
  executionQuality: ExecutionQualityVerdict;
  netProfit: NetProfitVerdict;
  /** Full open + proposed exposure — populated for the selected proposal only. */
  exposure: ExposureVerdict | null;
}

/**
 * Compute advisory Phase 7 annotations for a set of reviewed scan proposals.
 * Reads this user's OPEN live positions ONCE (per-user isolation) for the
 * selected proposal's exposure. Honest unknowns throughout — no fabrication.
 */
export async function annotateScanProposals(args: {
  userId: number;
  budget: ExposureBudget;
  proposals: ScanProposalAnnotationInput[];
  /** Scan instant (defaults to now) — anchors the expected-move horizon. */
  nowMs?: number;
}): Promise<Map<string, ScanProposalAnnotation>> {
  const out = new Map<string, ScanProposalAnnotation>();
  if (args.proposals.length === 0) return out;

  const hasSelected = args.proposals.some((p) => p.isSelected);
  const open = hasSelected ? await loadOpenExposure(args.userId) : [];
  const nowMs = args.nowMs ?? Date.now();

  for (const p of args.proposals) {
    const isScalp = isScalpTimeframe(p.timeframe);
    // Expected move over the proposal's timeframe at its planned entry —
    // honestly producible for synthetics only (closed-form σ); null otherwise.
    let expectedMovePips: number | null = null;
    try {
      expectedMovePips = (
        await resolveExpectedMovePips({
          userId: args.userId,
          symbol: p.symbol,
          timeframe: p.timeframe,
          price: p.entryPrice ?? null,
          nowMs,
        })
      ).pips;
    } catch {
      expectedMovePips = null; // honest unknown — never fabricated
    }
    const executionQuality = computeExecutionQuality({
      isScalp,
      direction: p.direction,
      quoteFreshness: quoteFreshnessFromDataSource(p.dataSource),
      // Per-symbol microstructure is not honestly observable at scan time.
      spreadPips: null,
      expectedMovePips,
      atrPips: null,
      volumeRatio: null,
      serverLatencyMs: null,
      signalAgeMs: null,
      maxSignalAgeMs: null,
    });
    const targetProfit =
      p.riskAmount != null &&
      Number.isFinite(p.riskAmount) &&
      p.riskAmount > 0 &&
      p.expectedR != null &&
      Number.isFinite(p.expectedR) &&
      p.expectedR > 0
        ? p.riskAmount * p.expectedR
        : null;
    const netProfit = computeNetProfitVerdict({
      isScalp,
      assetClass: assetClassFor(p.symbol),
      targetProfit,
      riskAmount: p.riskAmount,
      spreadCost: null,
      estimatedSlippageCost: null,
      commission: null,
      swap: null,
      holdsOvernight: false,
    });

    let exposure: ExposureVerdict | null = null;
    if (p.isSelected && (p.direction === "BUY" || p.direction === "SELL")) {
      exposure = evaluateExposure({
        open,
        proposed: {
          symbol: p.symbol,
          assetClass: assetClassFor(p.symbol),
          currencies: currenciesFor(p.symbol),
          direction: p.direction,
          riskAmount:
            p.riskAmount != null && Number.isFinite(p.riskAmount) && p.riskAmount > 0
              ? p.riskAmount
              : 0,
        },
        budget: args.budget,
      });
    }

    out.set(p.proposalId, { executionQuality, netProfit, exposure });
  }
  return out;
}
