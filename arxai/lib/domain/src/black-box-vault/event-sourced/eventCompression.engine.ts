// ═══════════════════════════════════════════════════════════════════════════
// eventCompression.engine.ts — pure size reducer for large replay records
// and candle/tick snapshots. Replaces oversized arrays inside payload with a
// summary object {_compressed, originalLength, head, tail} so the chain stays
// queryable + replayable while bounding storage cost.
//
// Pure: no IO, no zlib. Downstream binary compression (gzip, etc.) can layer
// on top of this without changing the canonical event body.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_ARRAY_THRESHOLD = 50;
const DEFAULT_HEAD_KEEP = 5;
const DEFAULT_TAIL_KEEP = 5;
const KNOWN_SERIES_KEYS: ReadonlyArray<string> = [
  "candles", "ticks", "ohlc", "bars", "quotes", "prices",
  "priceSeries", "priceHistory", "trades", "snapshots", "ladder",
];
const HARD_LENGTH_THRESHOLD = 500;

export interface CompressedArrayMarker {
  _compressed: true;
  originalLength: number;
  head: unknown[];
  tail: unknown[];
}

export interface CompressionResult {
  payload: Record<string, unknown>;
  compressed: boolean;
  fieldsCompressed: string[];
  originalLengths: Record<string, number>;
  bytesSavedEstimate: number;
}

export interface CompressionOpts {
  arrayThreshold?: number;
  headKeep?: number;
  tailKeep?: number;
  knownSeriesKeys?: ReadonlyArray<string>;
}

function approxBytes(v: unknown): number {
  try { return JSON.stringify(v).length; } catch { return 0; }
}

export function compressPayload(
  payload: Record<string, unknown>,
  opts: CompressionOpts = {},
): CompressionResult {
  const threshold = opts.arrayThreshold ?? DEFAULT_ARRAY_THRESHOLD;
  const headKeep = opts.headKeep ?? DEFAULT_HEAD_KEEP;
  const tailKeep = opts.tailKeep ?? DEFAULT_TAIL_KEEP;
  const knownKeys = new Set(opts.knownSeriesKeys ?? KNOWN_SERIES_KEYS);

  const fieldsCompressed: string[] = [];
  const originalLengths: Record<string, number> = {};
  let bytesSavedEstimate = 0;

  function shouldCompress(key: string, arr: unknown[]): boolean {
    if (arr.length <= threshold) return false;
    if (knownKeys.has(key)) return true;
    if (arr.length > HARD_LENGTH_THRESHOLD) return true;
    return false;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v) && shouldCompress(k, v)) {
      const before = approxBytes(v);
      const marker: CompressedArrayMarker = {
        _compressed: true,
        originalLength: v.length,
        head: v.slice(0, headKeep),
        tail: v.slice(-tailKeep),
      };
      out[k] = marker;
      const after = approxBytes(marker);
      bytesSavedEstimate += Math.max(0, before - after);
      fieldsCompressed.push(k);
      originalLengths[k] = v.length;
    } else {
      out[k] = v;
    }
  }

  return {
    payload: out,
    compressed: fieldsCompressed.length > 0,
    fieldsCompressed,
    originalLengths,
    bytesSavedEstimate,
  };
}

/** Best-effort detection: returns true if this payload field is a compressed
 *  marker produced by compressPayload(). Useful for downstream replay tooling. */
export function isCompressedMarker(v: unknown): v is CompressedArrayMarker {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as { _compressed?: unknown })._compressed === true &&
    typeof (v as { originalLength?: unknown }).originalLength === "number" &&
    Array.isArray((v as { head?: unknown }).head) &&
    Array.isArray((v as { tail?: unknown }).tail)
  );
}
