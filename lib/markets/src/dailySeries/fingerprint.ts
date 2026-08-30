// dataFingerprint — the identity of the exact bars an evaluation consumed.
//
// The transfer-proof harness's no-respin rule is keyed on this string: once a
// spec MISSES on a fingerprint, that pair is refused forever. So the hash has
// to have exactly two properties, and they pull in opposite directions:
//
//   1. It must change when the DATA changes. A different price, a different
//      date, a different order, a different symbol, a different adjustment
//      basis — every one of those is a different dataset and must hash apart.
//      (Adjustment is IN the hash because a split-adjusted and a
//      dividend-adjusted series with the same dates are different instruments,
//      and letting them collide would let a losing spec respin by switching
//      vendors' adjustment basis.)
//
//   2. It must NOT change when only the FETCH changes. `fetchedAt`, the source
//      adapter, and the exact URL are all excluded. If they were included, the
//      same data re-downloaded an hour later would hash differently and the
//      no-respin rule would be trivially defeated by pressing the button twice.
//
// Prices are canonicalised through a fixed-precision decimal form, not through
// JS number formatting, so 100.10 and 100.1 cannot hash apart while being the
// same price — and so the hash is stable across a vendor changing its trailing
// zeros. PRECISION is 8 decimal places; anything finer than that is below the
// resolution of every daily equity close in existence.
//
// Pure: node:crypto only.

import { createHash } from "node:crypto";
import type { DailyBar, PriceAdjustment } from "./types.js";

export const FINGERPRINT_VERSION = "arx-daily-close-v1";
export const FINGERPRINT_PRECISION = 8;

/**
 * Fixed-precision canonical decimal. Throws on a non-finite price: a NaN close
 * reaching the fingerprint is a failed read that upstream should have refused,
 * and hashing it would mint an identity for fabricated data.
 */
export function canonicalPrice(x: number): string {
  if (!Number.isFinite(x)) {
    throw new Error(`canonicalPrice: non-finite price (${x}) — a failed read has no fingerprint`);
  }
  // toFixed then strip trailing zeros (and a bare trailing dot) so 100.1 and
  // 100.100000 canonicalise identically.
  let s = x.toFixed(FINGERPRINT_PRECISION);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

export interface FingerprintInput {
  symbol: string;
  adjustment: PriceAdjustment;
  bars: readonly DailyBar[];
}

/**
 * The exact bytes hashed — returned separately so a report can show WHAT was
 * hashed rather than only the digest. `adjustedClose` is deliberately NOT
 * hashed: the evaluation reads `close`, and hashing a carried-for-audit column
 * would make two byte-identical evaluations hash apart.
 */
export function fingerprintPreimage(input: FingerprintInput): string {
  const head = `${FINGERPRINT_VERSION}|${input.symbol}|${input.adjustment}|n=${input.bars.length}`;
  const rows = input.bars.map((b) => `${b.date},${canonicalPrice(b.close)}`);
  return [head, ...rows].join("\n");
}

/** sha256 over the preimage, hex. This is the harness's dataFingerprint. */
export function dataFingerprint(input: FingerprintInput): string {
  return createHash("sha256").update(fingerprintPreimage(input), "utf8").digest("hex");
}
