// ═══════════════════════════════════════════════════════════════════════════
// poisonDataDetector.engine.ts — pure heuristic that flags abnormal or
// unreliable records BEFORE they can train future AI. Score in [0, 1].
//
// Heuristics (intentionally conservative — false positives are cheaper than
// false negatives for downstream learning):
//   - non-finite numbers (NaN / Infinity)
//   - extreme magnitudes (|x| > 1e12)
//   - probability/confidence values out of plausible range
//   - lot size out of plausible range
//   - all-zero candles / ticks
//   - flat constant series (zero variance across many points)
//   - low-entropy summaries (looks copy-pasted / templated repeatedly)
//   - empty critical/danger event payload
//   - massive payload (likely log dump rather than event)
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEventDraft } from "./eventSchema.types.js";
import { isCompressedMarker } from "./eventCompression.engine.js";

export interface PoisonReport {
  score: number;          // 0..1, higher = more suspicious
  signals: string[];      // human-readable diagnostic codes
}

const HARD_PAYLOAD_BYTE_LIMIT = 256 * 1024;

function payloadBytes(p: unknown): number {
  try { return JSON.stringify(p ?? {}).length; } catch { return 0; }
}

function isAllZeroNumeric(obj: unknown): boolean {
  if (obj === null || typeof obj !== "object") return false;
  const vals = Object.values(obj as Record<string, unknown>);
  if (vals.length === 0) return false;
  return vals.every((v) => v === 0);
}

function variance(nums: number[]): number {
  if (nums.length < 2) return 1; // not enough data to call flat
  const mean = nums.reduce((s, x) => s + x, 0) / nums.length;
  return nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length;
}

export function detectPoison(draft: AuditEventDraft): PoisonReport {
  const signals: string[] = [];
  let score = 0;
  const p = (draft.payload ?? {}) as Record<string, unknown>;

  // Non-finite / extreme numerics anywhere at top level
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) { signals.push(`non-finite:${k}`); score += 0.5; continue; }
      if (Math.abs(v) > 1e12) { signals.push(`extreme-magnitude:${k}=${v}`); score += 0.3; }
    }
  }

  // Probability/confidence sanity (codebase uses 0..100 scale)
  for (const k of ["confidence", "probability", "p", "prob", "score", "winRate"]) {
    const v = p[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      if (v < 0 || v > 100) { signals.push(`probability-out-of-range:${k}=${v}`); score += 0.3; }
    }
  }

  // Lot size sanity (Deriv synthetic lots are 0.01..1000-ish). A lot value
  // outside this range is wildly off — weight high enough to disqualify
  // training on its own.
  if (typeof p.lot === "number") {
    if (p.lot <= 0 || p.lot > 1000) { signals.push(`lot-out-of-range:${p.lot}`); score += 0.6; }
  }

  // All-zero candles / ticks (unless intentionally compressed)
  for (const k of ["candles", "ticks", "bars", "ohlc"] as const) {
    const v = p[k];
    if (Array.isArray(v) && v.length > 0 && v.every(isAllZeroNumeric)) {
      signals.push(`${k}-all-zero`);
      score += 0.5;
    } else if (Array.isArray(v) && v.length >= 5) {
      // flat-line price detection (zero variance over close-like field)
      const closes = v
        .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>).close : null))
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      if (closes.length >= 5 && variance(closes) === 0) {
        signals.push(`${k}-flatline`);
        score += 0.3;
      }
    } else if (isCompressedMarker(v)) {
      // compressed series — skip deep inspection
    }
  }

  // Low-entropy / templated summary text
  if (typeof p.summary === "string" && p.summary.length > 30) {
    const uniqueChars = new Set(p.summary).size;
    if (uniqueChars <= 3) { signals.push("low-entropy-summary"); score += 0.3; }
  }

  // CRITICAL/DANGER event with empty payload — usually a producer bug
  if ((draft.severity === "CRITICAL" || draft.severity === "DANGER") &&
      Object.keys(p).length === 0) {
    signals.push("critical-event-empty-payload");
    score += 0.2;
  }

  // Hard payload size cap — almost certainly a log dump
  if (payloadBytes(p) > HARD_PAYLOAD_BYTE_LIMIT) {
    signals.push(`hard-oversized:${payloadBytes(p)}B`);
    score += 0.4;
  }

  return { score: Math.min(1, score), signals };
}
