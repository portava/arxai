// Phase 3 — Chart Decision Snapshot type + in-memory service.
//
// Captures the point-in-time state at a "serious read" moment — the symbol,
// timeframe, both scores, feed/mirror status, price basis, and (optionally)
// an entry/SL/TP plan. Future-ready for persistence (Phase 5 wiring), but this
// phase only provides the type contract and an in-memory ring buffer so Phase 4
// consumers can reference the last known snapshot without needing DB I/O.
//
// REPLAY HONESTY RULE (inviolable):
//   Replay of a snapshot must use ONLY the data that was known at capturedAt.
//   Judgements applied in replay must be labelled with when the new information
//   was known, never back-projected as if the trader could have known it then.
//   The `replayNote` field encodes this — it must never be removed or modified.
//
// SAFETY: read-only; no execution path; no safety gate involvement.

import type { ChartTruthScore } from "./chartTruthScore.js";
import type { ChartReadScore } from "./chartReadScore.js";
import type { ChartGateOutput } from "./chartGateOutput.js";
import type { BrokerPriceAlignment } from "./brokerPriceAlignment.js";

// ── Snapshot type contract ────────────────────────────────────────────────────

export interface ChartDecisionSnapshotCandleRef {
  /** Bar open time (ISO 8601). */
  openTime: string;
  /** Bar close time (ISO 8601). */
  closeTime: string;
  /** Close price of the reference bar. */
  close: number;
  /** Whether this bar was closed (isComplete) at capture time. */
  isComplete: boolean;
}

export interface ChartDecisionSnapshotPlan {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number | null;
}

export interface ChartDecisionSnapshot {
  /** Unique snapshot id (UUID v4). */
  id: string;
  /** ISO 8601 timestamp when this snapshot was taken. */
  capturedAt: string;
  /** Symbol key (e.g. "EURUSD"). */
  symbol: string;
  /** Display symbol (e.g. "EUR/USD"). */
  displaySymbol: string;
  /** Timeframe (e.g. "M5"). */
  timeframe: string;
  /** Chart Truth Score at capture time. */
  chartTruthScore: ChartTruthScore;
  /** Chart Read Score at capture time. */
  chartReadScore: ChartReadScore;
  /** Gate output at capture time. */
  gateOutput: ChartGateOutput;
  /** Broker price alignment at capture time. */
  brokerAlignment: BrokerPriceAlignment;
  /** The last verified candle reference at capture time. Null when no candles were present. */
  verifiedCandleRef: ChartDecisionSnapshotCandleRef | null;
  /**
   * Optional planned entry/SL/TP if the user had a trade in mind.
   * NEVER treated as an executed trade — this is advisory capture only.
   */
  plan: ChartDecisionSnapshotPlan | null;
  /**
   * Inviolable replay honesty note. This field encodes the constraint that
   * replay must never judge with future-known data without labelling the
   * additional information. MUST NOT be removed or modified by any caller.
   */
  replayNote: "Point-in-time snapshot — replay must only judge with data known at capturedAt; any later-known information must be explicitly labelled.";
  /** Source that triggered the snapshot (e.g. "chart_read", "ruby_draft_read"). */
  source: string;
}

// ── In-memory ring buffer ─────────────────────────────────────────────────────
// Holds the N most recent snapshots per user (keyed by userId). Not persisted
// between server restarts — Phase 5 will wire DB persistence. This is
// sufficient for Phase 4 consumers to reference recent snapshot state without
// reading across the full history.

const RING_BUFFER_SIZE = 20;
const ringBuffers = new Map<number, ChartDecisionSnapshot[]>();

/**
 * Record a snapshot in the per-user ring buffer.
 * Safe to call without awaiting — no I/O.
 */
export function recordDecisionSnapshot(userId: number, snapshot: ChartDecisionSnapshot): void {
  let buf = ringBuffers.get(userId);
  if (!buf) {
    buf = [];
    ringBuffers.set(userId, buf);
  }
  buf.push(snapshot);
  if (buf.length > RING_BUFFER_SIZE) buf.shift();
}

/**
 * Get recent snapshots for a user (newest first), optionally filtered by symbol.
 */
export function getRecentSnapshots(
  userId: number,
  opts: { symbol?: string; limit?: number } = {},
): ChartDecisionSnapshot[] {
  const buf = ringBuffers.get(userId) ?? [];
  let result = [...buf].reverse();
  if (opts.symbol) {
    const up = opts.symbol.toUpperCase();
    result = result.filter((s) => s.symbol.toUpperCase() === up);
  }
  return result.slice(0, opts.limit ?? RING_BUFFER_SIZE);
}

/**
 * Get the most recent snapshot for a user + symbol + timeframe, or null.
 */
export function getLastSnapshot(
  userId: number,
  symbol: string,
  timeframe: string,
): ChartDecisionSnapshot | null {
  const buf = ringBuffers.get(userId) ?? [];
  const symUp = symbol.toUpperCase();
  const tfUp = timeframe.toUpperCase();
  for (let i = buf.length - 1; i >= 0; i--) {
    const s = buf[i]!;
    if (s.symbol.toUpperCase() === symUp && s.timeframe.toUpperCase() === tfUp) {
      return s;
    }
  }
  return null;
}

/**
 * Build a snapshot from the assembled Phase 3 outputs. Caller provides the
 * candle reference and optional plan; this function stamps the id + timestamp.
 */
export function buildDecisionSnapshot(params: {
  symbol: string;
  displaySymbol: string;
  timeframe: string;
  chartTruthScore: ChartTruthScore;
  chartReadScore: ChartReadScore;
  gateOutput: ChartGateOutput;
  brokerAlignment: BrokerPriceAlignment;
  verifiedCandleRef: ChartDecisionSnapshotCandleRef | null;
  plan?: ChartDecisionSnapshotPlan | null;
  source: string;
}): ChartDecisionSnapshot {
  return {
    id: generateSnapshotId(),
    capturedAt: new Date().toISOString(),
    symbol: params.symbol,
    displaySymbol: params.displaySymbol,
    timeframe: params.timeframe,
    chartTruthScore: params.chartTruthScore,
    chartReadScore: params.chartReadScore,
    gateOutput: params.gateOutput,
    brokerAlignment: params.brokerAlignment,
    verifiedCandleRef: params.verifiedCandleRef,
    plan: params.plan ?? null,
    replayNote:
      "Point-in-time snapshot — replay must only judge with data known at capturedAt; any later-known information must be explicitly labelled.",
    source: params.source,
  };
}

// ── Simple UUID-like id generator (no external dependency needed) ─────────────
function generateSnapshotId(): string {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `cds-${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}
