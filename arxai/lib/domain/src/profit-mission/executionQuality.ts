// ── Profit Mission Phase 7 — Execution Quality Engine (pure, BLOCK-only) ─────
//
// PLANNING / PRE-EXECUTION PRE-CHECK ONLY. Turns honest microstructure inputs
// (spread, quote freshness, signal age, liquidity, latency) into an objective
// execution-quality verdict that can ONLY block or downgrade a draft — it can
// never upgrade a setup or relax a gate.
//
// HONESTY CONTRACT:
//   - Every "good"/"normal" status requires a POSITIVELY OBSERVED input. A
//     missing/unknown input yields the `unknown` status and is NEVER reported as
//     normal/good. Where the spec demands safety (stale quote, expired signal),
//     unknown fails CLOSED (blocks); elsewhere unknown simply withholds a verdict
//     component without fabricating a worse OR better state than observed.
//   - Slippage / latency are ESTIMATES composed from the shared execution-realism
//     engines and are tagged as estimates; they never claim to be a real fill.
//   - Scalps are held to stricter spread/edge tolerances than swing trades.
//
// PURE + DETERMINISTIC + IO-FREE: no clock, DB, network, or globals.

import {
  simulateSlippage,
  simulateLatency,
  type MarketConditions,
  type OrderRequest,
} from "../execution-realism/index.js";

export type SpreadStatus = "normal" | "wide" | "extreme" | "unknown";
export type SlippageRisk = "low" | "medium" | "high" | "unknown";
export type LiquidityStatus = "normal" | "thin" | "unknown";
export type FillQualityExpected = "good" | "degraded" | "poor" | "unknown";
export type QuoteFreshness = "fresh" | "delayed" | "stale" | "unknown";
export type ExecutionWindowStatus = "open" | "expired" | "unknown";

/**
 * Honest execution-quality inputs. Any numeric may be `null`/omitted = unknown.
 * `quoteFreshness` is REQUIRED (it comes from the feed-truth seam) so a missing
 * feed read can never be silently treated as fresh.
 */
export interface ExecutionQualityInput {
  /** Scalps get stricter spread/edge tolerances. */
  isScalp: boolean;
  direction: "BUY" | "SELL" | "NONE";
  /** Honest feed-truth verdict for the symbol (required). */
  quoteFreshness: QuoteFreshness;
  /** Observed spread in pips (null = unknown). */
  spreadPips?: number | null;
  /** Setup target distance entry→TP in pips (null = unknown). */
  expectedMovePips?: number | null;
  /** Average true range in pips (null = unknown). */
  atrPips?: number | null;
  /** Current vs average liquidity ratio (null = unknown). */
  volumeRatio?: number | null;
  /** True when a high-impact news window is active. */
  isNewsWindow?: boolean;
  /** Observed server round-trip latency in ms (null = unknown). */
  serverLatencyMs?: number | null;
  /** Age of the scouted setup in ms (null = unknown). */
  signalAgeMs?: number | null;
  /** Window before the setup expires in ms (null = unknown). */
  maxSignalAgeMs?: number | null;
  /** Price increment of one pip for slippage price math (null = unknown). */
  pipSize?: number | null;
  intendedPrice?: number | null;
  sizeLots?: number | null;
}

export interface ExecutionQualityVerdict {
  /** False blocks the draft from dispatch. */
  allowed: boolean;
  spreadStatus: SpreadStatus;
  slippageRisk: SlippageRisk;
  liquidityStatus: LiquidityStatus;
  fillQualityExpected: FillQualityExpected;
  quoteFreshness: QuoteFreshness;
  executionWindow: ExecutionWindowStatus;
  /** Estimated adverse slippage in pips (estimate only; null when unknowable). */
  estimatedSlippagePips: number | null;
  /** Estimated total latency in ms (estimate only; null when unknowable). */
  estimatedLatencyMs: number | null;
  /** Spread as a share of the expected move (0..1+); null when unknowable. */
  spreadShareOfMove: number | null;
  observedSpreadPips: number | null;
  /** Machine-readable hard blockers (any present → allowed=false). */
  blockers: string[];
  warnings: string[];
  reason: string;
}

// Spread as a share of expected move beyond which the cost eats the edge.
const SPREAD_SHARE_BLOCK = { scalp: 0.25, swing: 0.5 } as const;
const SPREAD_SHARE_WARN = { scalp: 0.15, swing: 0.3 } as const;
// Estimated slippage in pips beyond which execution risk is too high.
const SLIPPAGE_HIGH_PIPS = { scalp: 2.5, swing: 6 } as const;
const SLIPPAGE_MEDIUM_PIPS = { scalp: 1.2, swing: 3 } as const;
// Estimated latency in ms beyond which we refuse (mirrors broker-stress reject).
const LATENCY_BLOCK_MS = 1500;
const LATENCY_WARN_MS = 600;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute an honest execution-quality verdict. Pure. Block-only: the verdict can
 * refuse a draft but can never make a refused draft tradeable.
 */
export function computeExecutionQuality(input: ExecutionQualityInput): ExecutionQualityVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const scalp = input.isScalp;

  // ── Quote freshness (feed truth) — stale/unknown fail CLOSED. ──────────────
  const quoteFreshness = input.quoteFreshness;
  if (quoteFreshness === "stale") {
    blockers.push("QUOTE_STALE");
    warnings.push("Quote is stale — execution refused until a fresh tick confirms.");
  } else if (quoteFreshness === "unknown") {
    blockers.push("QUOTE_UNCONFIRMED");
    warnings.push("Quote freshness is unconfirmed — execution refused (no fabricated freshness).");
  } else if (quoteFreshness === "delayed") {
    warnings.push("Quote is delayed — execution-quality downgraded.");
  }

  // ── Execution window (signal expiry). ──────────────────────────────────────
  let executionWindow: ExecutionWindowStatus = "unknown";
  if (
    input.signalAgeMs != null && Number.isFinite(input.signalAgeMs) &&
    input.maxSignalAgeMs != null && Number.isFinite(input.maxSignalAgeMs) &&
    input.maxSignalAgeMs > 0
  ) {
    executionWindow = input.signalAgeMs > input.maxSignalAgeMs ? "expired" : "open";
    if (executionWindow === "expired") {
      blockers.push("SIGNAL_EXPIRED");
      warnings.push("Setup signal has expired — execution refused.");
    }
  }

  // ── Spread regime vs expected move (scalp-stricter). ───────────────────────
  let spreadStatus: SpreadStatus = "unknown";
  let spreadShareOfMove: number | null = null;
  const spreadPips =
    input.spreadPips != null && Number.isFinite(input.spreadPips) && input.spreadPips >= 0
      ? input.spreadPips
      : null;
  if (spreadPips != null) {
    if (
      input.expectedMovePips != null &&
      Number.isFinite(input.expectedMovePips) &&
      input.expectedMovePips > 0
    ) {
      spreadShareOfMove = round2(spreadPips / input.expectedMovePips);
      const blockAt = scalp ? SPREAD_SHARE_BLOCK.scalp : SPREAD_SHARE_BLOCK.swing;
      const warnAt = scalp ? SPREAD_SHARE_WARN.scalp : SPREAD_SHARE_WARN.swing;
      if (spreadShareOfMove >= blockAt) {
        spreadStatus = "extreme";
        blockers.push("SPREAD_EATS_EDGE");
        warnings.push(
          `Spread (${spreadPips}p) is ${(spreadShareOfMove * 100).toFixed(0)}% of the ${input.expectedMovePips}p target — too costly${scalp ? " for a scalp" : ""}.`,
        );
      } else if (spreadShareOfMove >= warnAt) {
        spreadStatus = "wide";
        warnings.push("Spread is wide relative to the target move — execution-quality downgraded.");
      } else {
        spreadStatus = "normal";
      }
    } else {
      // Spread observed but no target to compare against: cannot certify normal.
      spreadStatus = "unknown";
      warnings.push("Spread observed but target move unknown — spread quality unverified.");
    }
  }

  // ── Liquidity. ─────────────────────────────────────────────────────────────
  let liquidityStatus: LiquidityStatus = "unknown";
  if (input.volumeRatio != null && Number.isFinite(input.volumeRatio) && input.volumeRatio >= 0) {
    liquidityStatus = input.volumeRatio < 0.5 ? "thin" : "normal";
    if (liquidityStatus === "thin") {
      warnings.push("Thin liquidity — fills may be worse than quoted.");
    }
  }

  // ── Slippage + latency ESTIMATES via the shared execution-realism engines. ─
  let slippageRisk: SlippageRisk = "unknown";
  let estimatedSlippagePips: number | null = null;
  let estimatedLatencyMs: number | null = null;
  const canEstimate =
    spreadPips != null &&
    input.atrPips != null && Number.isFinite(input.atrPips) &&
    input.volumeRatio != null && Number.isFinite(input.volumeRatio) &&
    input.serverLatencyMs != null && Number.isFinite(input.serverLatencyMs);
  if (canEstimate) {
    const mkt: MarketConditions = {
      spreadPips: spreadPips!,
      atrPips: input.atrPips!,
      volumeRatio: input.volumeRatio!,
      isNewsWindow: input.isNewsWindow === true,
      serverLatencyMs: input.serverLatencyMs!,
    };
    const order: OrderRequest = {
      direction: input.direction === "SELL" ? "SELL" : "BUY",
      intendedPrice: input.intendedPrice ?? 0,
      sizeLots: input.sizeLots ?? 0.01,
      pipSize: input.pipSize ?? 0,
    };
    estimatedSlippagePips = round2(simulateSlippage(order, mkt).slippagePips);
    estimatedLatencyMs = simulateLatency(mkt).totalLatencyMs;

    const highP = scalp ? SLIPPAGE_HIGH_PIPS.scalp : SLIPPAGE_HIGH_PIPS.swing;
    const medP = scalp ? SLIPPAGE_MEDIUM_PIPS.scalp : SLIPPAGE_MEDIUM_PIPS.swing;
    if (estimatedSlippagePips >= highP) {
      slippageRisk = "high";
      blockers.push("SLIPPAGE_HIGH");
      warnings.push(
        `Estimated slippage ${estimatedSlippagePips}p exceeds the ${highP}p ceiling${scalp ? " for a scalp" : ""}.`,
      );
    } else if (estimatedSlippagePips >= medP) {
      slippageRisk = "medium";
      warnings.push("Estimated slippage is elevated — execution-quality downgraded.");
    } else {
      slippageRisk = "low";
    }

    if (estimatedLatencyMs >= LATENCY_BLOCK_MS) {
      blockers.push("LATENCY_HIGH");
      warnings.push(`Estimated latency ${estimatedLatencyMs}ms exceeds the ${LATENCY_BLOCK_MS}ms ceiling.`);
    } else if (estimatedLatencyMs >= LATENCY_WARN_MS) {
      warnings.push("Estimated latency is elevated — execution-quality downgraded.");
    }
  }

  // ── Expected fill quality is the honest worst of the observed components. ──
  let fillQualityExpected: FillQualityExpected;
  if (spreadStatus === "unknown" && slippageRisk === "unknown" && liquidityStatus === "unknown") {
    fillQualityExpected = "unknown";
  } else if (
    spreadStatus === "extreme" || slippageRisk === "high" || blockers.length > 0
  ) {
    fillQualityExpected = "poor";
  } else if (spreadStatus === "wide" || slippageRisk === "medium" || liquidityStatus === "thin") {
    fillQualityExpected = "degraded";
  } else if (spreadStatus === "normal" && slippageRisk === "low") {
    fillQualityExpected = "good";
  } else {
    // Some component still unknown → cannot certify "good".
    fillQualityExpected = "unknown";
  }

  const allowed = blockers.length === 0;
  const reason = allowed
    ? `Execution quality acceptable (fill ${fillQualityExpected}).`
    : `Execution blocked: ${blockers.join(", ")}.`;

  return {
    allowed,
    spreadStatus,
    slippageRisk,
    liquidityStatus,
    fillQualityExpected,
    quoteFreshness,
    executionWindow,
    estimatedSlippagePips,
    estimatedLatencyMs,
    spreadShareOfMove,
    observedSpreadPips: spreadPips,
    blockers,
    warnings,
    reason,
  };
}
