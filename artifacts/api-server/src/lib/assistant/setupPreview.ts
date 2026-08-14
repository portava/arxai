// Ruby/AI Setup-Preview producer — deterministic, honest, READ-ONLY (Task #374).
//
// Turns a verified chart read into a *setup preview*: concrete entry / stop /
// target levels, a risk zone and reward zone, an invalidation marker, a
// confidence + setup-type label, and a plain-English explanation. A preview is
// a DRAWING — a visual reasoning aid. It is NEVER a trade order and this module
// can never place, modify, or close a trade.
//
// SAFETY / HONESTY (inviolable):
//   - NO LLM. Pure and deterministic. Levels are derived ONLY from the REAL
//     candles passed in — never fabricated.
//   - The producer is PURE: every honesty input (data freshness/basis, provider
//     class, bridge, balance, scanner/flame/run-on/risk/governance) is passed
//     in by the caller, which sources them from the real per-user/per-symbol
//     services. This keeps the producer fully testable and impossible to fake.
//   - Refusal gates hold: feed not VERIFIED → no confident tradeable preview;
//     no resolvable directional edge → caution/avoid with no fabricated levels;
//     governance "rejected" → avoid; composite/synthetic feed → never
//     broker-native language; missing balance → no account-currency risk math
//     (we surface the price-based reward:risk only and defer real risk to the
//     ticket after lot sizing).
//   - Output carries NO internal codes; explanation strings are plain English
//     and reference the exact drawn levels so the words match the chart.

import type { Candle } from "../data/types.js";
import type { ChartReadResult, StructureBias } from "./chartStructure.js";
import type { RubyChartReadBasis } from "../data/chart/rubyChartContext.js";

export type SetupSide = "BUY" | "SELL";

/** Plain-English tradeability verdict for a preview. Never an execution gate. */
export type SetupPreviewVerdict = "tradeable" | "caution" | "avoid" | "refused";

/** Lifecycle status. Server only ever emits "preview"; the client owns the rest. */
export type SetupPreviewStatus =
  | "preview"
  | "user_confirmed"
  | "discarded"
  | "stale";

/** Who drew the preview. */
export type SetupPreviewAuthor =
  | "ruby"
  | "scanner"
  | "risk"
  | "flame"
  | "run_on"
  | "governance";

/** User-safe governance verdict (already humanized upstream into an enum). */
export type GovernanceVerdict =
  | "approved"
  | "approved_with_caution"
  | "downgraded"
  | "rejected"
  | "escalated"
  | "needs_more_data"
  | "muted_low_confidence"
  | "neutral";

export interface SetupPreviewProviderSource {
  /** Honest asset-class label, e.g. "forex", "synthetic_index". */
  assetClass: string;
  /** True when the feed is a composite/synthetic source — never broker-native. */
  composite: boolean;
  /** Plain-English source label shown to the user (never says "broker" when composite). */
  label: string;
}

export interface SetupPreviewBridge {
  availability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE";
  message: string;
}

export interface SetupPreviewLevels {
  entry: number;
  sl: number;
  tp: number;
  secondaryTp: number | null;
  /** Invalidation price (mirrors SL by default, may differ for structure). */
  invalidation: number;
}

export interface SetupPreview {
  previewId: string;
  symbol: string;
  displaySymbol: string;
  timeframe: string;
  side: SetupSide | null;
  setupType: string;

  /** Concrete levels — null on a refused / no-edge preview (never fabricated). */
  levels: SetupPreviewLevels | null;

  /** Price-based reward-to-risk ratio (pure geometry; always honest). */
  rewardToRisk: number | null;
  /**
   * Account-currency risk / reward. Intentionally null: real risk depends on
   * lot size + contract value which the preview does not assume. The trade
   * ticket computes it after the user sets a lot. Never a dummy value.
   */
  riskAmount: number | null;
  potentialReward: number | null;

  confidence: { label: "Low" | "Medium" | "High"; score: number };
  verdict: SetupPreviewVerdict;
  /** Honest reason when verdict is "refused"/"avoid", else null. */
  refusalReason: string | null;

  dataFreshness: { basis: RubyChartReadBasis; trustLine: string };
  providerSource: SetupPreviewProviderSource;
  bridgeStatus: SetupPreviewBridge | null;
  allocationKnown: boolean;

  scannerScore: number | null;
  flameStage: string | null;
  runOnQuality: string | null;
  riskScore: number | null;
  governanceOutcome: GovernanceVerdict | null;

  /** Plain-English, references the exact drawn levels. */
  explanation: string[];
  invalidationNote: string;

  createdBy: SetupPreviewAuthor;
  createdAt: string;
  expiresAt: string;
  status: SetupPreviewStatus;
}

export interface BuildSetupPreviewInput {
  symbol: string;
  displaySymbol: string;
  timeframe: string;
  /** Requested side; when null the side is resolved from structural bias. */
  requestedSide?: SetupSide | null;
  read: ChartReadResult;
  candles: Candle[];
  basis: RubyChartReadBasis;
  trustLine: string;
  blockReason?: string | null;
  providerSource: SetupPreviewProviderSource;
  bridge?: SetupPreviewBridge | null;
  /** Available allocation, or null when unknown (→ no account-currency math). */
  availableAllocation?: number | null;
  scannerScore?: number | null;
  flameStage?: string | null;
  runOnQuality?: string | null;
  riskScore?: number | null;
  governanceOutcome?: GovernanceVerdict | null;
  governanceCautions?: string[];
  createdBy?: SetupPreviewAuthor;
  nowMs?: number;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 90_000; // a drawing ages out after 90s by default.

let previewSeq = 0;
function nextPreviewId(nowMs: number): string {
  previewSeq = (previewSeq + 1) % 1_000_000;
  return `preview-${nowMs.toString(36)}-${previewSeq.toString(36)}`;
}

function sortAscending(candles: Candle[]): Candle[] {
  return [...candles].sort((a, b) => {
    const ta = Date.parse(a.time);
    const tb = Date.parse(b.time);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return 0;
  });
}

function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function decimalsFor(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  return 5;
}

function roundTo(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function fmt(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

/** Resolve a directional side from the requested side or the structural bias. */
function resolveSide(
  requested: SetupSide | null | undefined,
  bias: StructureBias,
): SetupSide | null {
  if (requested === "BUY" || requested === "SELL") return requested;
  if (bias === "Bullish") return "BUY";
  if (bias === "Bearish") return "SELL";
  return null;
}

function confidenceScore(label: "Low" | "Medium" | "High"): number {
  return label === "High" ? 0.85 : label === "Medium" ? 0.6 : 0.35;
}

/** Map structure + flame into a plain-English setup-type label. */
function deriveSetupType(
  side: SetupSide,
  read: ChartReadResult,
  flameStage: string | null | undefined,
): string {
  const aligned =
    (side === "BUY" && read.htfBias === "Bullish") ||
    (side === "SELL" && read.htfBias === "Bearish");
  const counter =
    (side === "BUY" && read.bias === "Bearish") ||
    (side === "SELL" && read.bias === "Bullish");
  const flame = (flameStage || "").toUpperCase();
  if (flame === "IGNITING" || flame === "RUNNING" || flame === "RUN_ON") {
    return "Momentum scalp";
  }
  if (counter) return "Counter-trend reversal";
  if (read.bias === "Range-bound") return side === "BUY" ? "Range buy (support)" : "Range sell (resistance)";
  if (aligned) return "Trend continuation";
  return "Structure pullback";
}

/**
 * Build a setup preview. Always returns an honest preview object; on a gated or
 * no-edge read the verdict is "refused"/"avoid"/"caution" with NO fabricated
 * levels and a plain-English reason.
 */
export function buildSetupPreview(input: BuildSetupPreviewInput): SetupPreview {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const createdBy: SetupPreviewAuthor = input.createdBy ?? "ruby";
  const allocationKnown =
    typeof input.availableAllocation === "number" &&
    Number.isFinite(input.availableAllocation);

  const base = {
    previewId: nextPreviewId(nowMs),
    symbol: input.symbol,
    displaySymbol: input.displaySymbol,
    timeframe: input.timeframe,
    providerSource: input.providerSource,
    bridgeStatus: input.bridge ?? null,
    allocationKnown,
    scannerScore: input.scannerScore ?? null,
    flameStage: input.flameStage ?? null,
    runOnQuality: input.runOnQuality ?? null,
    riskScore: input.riskScore ?? null,
    governanceOutcome: input.governanceOutcome ?? null,
    dataFreshness: { basis: input.basis, trustLine: input.trustLine },
    riskAmount: null,
    potentialReward: null,
    createdBy,
    createdAt,
    expiresAt,
    status: "preview" as const,
  };

  // ── Gate 1: feed not VERIFIED → refuse a confident tradeable preview ──────
  if (input.basis !== "VERIFIED" || input.read.dataQuality !== "ok") {
    const reason =
      input.blockReason ||
      "The chart feed isn't confirmed yet, so I won't draw a tradeable setup. I'll mark levels once candles are verified.";
    return {
      ...base,
      side: null,
      setupType: "Awaiting confirmed data",
      levels: null,
      rewardToRisk: null,
      confidence: { label: "Low", score: 0 },
      verdict: "refused",
      refusalReason: reason,
      explanation: [reason],
      invalidationNote: "No structure to invalidate yet — nothing is drawn.",
    };
  }

  // ── Gate 2: governance rejected → steer away (no confident preview) ───────
  if (input.governanceOutcome === "rejected") {
    const reason =
      "The trading team is steering away from this setup, so I won't draw it as tradeable.";
    return {
      ...base,
      side: resolveSide(input.requestedSide, input.read.bias),
      setupType: "Team is steering away",
      levels: null,
      rewardToRisk: null,
      confidence: { label: "Low", score: 0 },
      verdict: "avoid",
      refusalReason: reason,
      explanation: [reason, ...(input.governanceCautions ?? [])],
      invalidationNote: "No setup drawn while the team is against this read.",
    };
  }

  // ── Gate 3: no resolvable directional edge → caution, no fabricated levels ─
  const side = resolveSide(input.requestedSide, input.read.bias);
  if (!side) {
    const reason =
      "There's no clean directional edge here right now, so there's no setup worth drawing. Waiting is a valid decision.";
    return {
      ...base,
      side: null,
      setupType: "No clear edge",
      levels: null,
      rewardToRisk: null,
      confidence: { label: "Low", score: 0 },
      verdict: "caution",
      refusalReason: reason,
      explanation: [reason, input.read.why],
      invalidationNote: input.read.invalidation,
    };
  }

  // ── Compute concrete levels from REAL candles ─────────────────────────────
  const candles = sortAscending(input.candles);
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1]!;
  const decimals = decimalsFor(last);
  const lookback = Math.min(candles.length, 60);
  const window = candles.slice(candles.length - lookback);
  const swingHigh = Math.max(...window.map((c) => c.high));
  const swingLow = Math.min(...window.map((c) => c.low));
  const span = Math.max(swingHigh - swingLow, Math.abs(last) * 1e-6);
  const atr14 = atr(candles, Math.min(14, candles.length - 1)) ?? span * 0.05;
  const buffer = Math.max(atr14 * 0.5, span * 0.02);

  // Target reward-to-risk by confidence (deterministic, conservative).
  const targetRr =
    input.read.confidence === "High" ? 2 : input.read.confidence === "Medium" ? 1.6 : 1.2;

  const entry = roundTo(last, decimals);
  let sl: number;
  let tp: number;
  if (side === "BUY") {
    sl = roundTo(Math.min(swingLow - buffer, entry - atr14), decimals);
    const risk = Math.max(entry - sl, atr14 * 0.5);
    tp = roundTo(entry + risk * targetRr, decimals);
  } else {
    sl = roundTo(Math.max(swingHigh + buffer, entry + atr14), decimals);
    const risk = Math.max(sl - entry, atr14 * 0.5);
    tp = roundTo(entry - risk * targetRr, decimals);
  }
  const riskDist = Math.abs(entry - sl);
  const rewardDist = Math.abs(tp - entry);
  const rewardToRisk = riskDist > 0 ? roundTo(rewardDist / riskDist, 2) : null;

  // ── Verdict (tradeable / caution) — never an execution gate ───────────────
  const counter =
    (side === "BUY" && input.read.bias === "Bearish") ||
    (side === "SELL" && input.read.bias === "Bullish");
  let verdict: SetupPreviewVerdict = "tradeable";
  const cautions = [...input.read.cautions];
  if (input.governanceOutcome === "downgraded" || input.governanceOutcome === "needs_more_data") {
    verdict = "caution";
  }
  if (input.read.confidence === "Low" || counter) verdict = "caution";
  if (verdict === "tradeable" && (input.governanceCautions?.length ?? 0) > 0) {
    verdict = "caution";
  }

  const setupType = deriveSetupType(side, input.read, input.flameStage);
  const confLabel = input.read.confidence;

  // ── Plain-English explanation referencing the EXACT drawn levels ──────────
  const sideWord = side === "BUY" ? "long" : "short";
  const explanation: string[] = [];
  explanation.push(
    `${setupType}: a ${sideWord} idea with entry near ${fmt(entry, decimals)}, stop at ${fmt(sl, decimals)}, target ${fmt(tp, decimals)}` +
      (rewardToRisk != null ? ` (about ${rewardToRisk.toFixed(1)}:1 reward-to-risk).` : "."),
  );
  explanation.push(input.read.why);
  explanation.push(
    side === "BUY"
      ? `The stop sits below recent support — a decisive close under ${fmt(sl, decimals)} breaks this idea.`
      : `The stop sits above recent resistance — a decisive close over ${fmt(sl, decimals)} breaks this idea.`,
  );
  if (input.providerSource.composite) {
    explanation.push(
      `Heads up: this instrument is priced from a ${input.providerSource.label} feed, not a broker-native quote — treat exact levels as indicative.`,
    );
  }
  if (!allocationKnown) {
    explanation.push(
      "I can't size account-currency risk here — set your lot in the ticket and it'll show the real risk before you confirm.",
    );
  }
  for (const c of cautions) explanation.push(c);
  for (const c of input.governanceCautions ?? []) explanation.push(c);
  explanation.push(
    "This is a preview drawing, not an order. Nothing is placed unless you open the ticket and confirm.",
  );

  const invalidationNote =
    side === "BUY"
      ? `A decisive close below ${fmt(sl, decimals)} invalidates this long.`
      : `A decisive close above ${fmt(sl, decimals)} invalidates this short.`;

  return {
    ...base,
    side,
    setupType,
    levels: { entry, sl, tp, secondaryTp: null, invalidation: sl },
    rewardToRisk,
    confidence: { label: confLabel, score: confidenceScore(confLabel) },
    verdict,
    // avoid/refused verdicts return earlier (with no levels); a drawable setup
    // is always tradeable|caution here, so there is no refusal reason.
    refusalReason: null,
    explanation,
    invalidationNote,
  };
}
