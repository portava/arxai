// Ruby Scalp — one price-precision authority for the entry engine and the
// manage side, so the same broker spec can never be rounded two ways.
//
// Broker truth only: digits as reported, or derived from the reported point
// size. When neither was reported the precision is UNKNOWN (null) — callers
// must say so, never invent 2 or 5 decimals.

import type { ScalpSpecInput } from "./scalpTypes.js";

export interface ScalpPricePrecision {
  digits: number;
  point: number;
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const MAX_DIGITS = 10;

/** Fewest decimals that represent `point` exactly (0.00001 → 5, 0.25 → 2). */
function decimalsOf(point: number): number | null {
  for (let d = 0; d <= MAX_DIGITS; d++) {
    const scaled = point * Math.pow(10, d);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return d;
  }
  return null;
}

export function resolveScalpPricePrecision(
  spec: Pick<ScalpSpecInput, "digits" | "point">,
): ScalpPricePrecision | null {
  const digits = num(spec.digits) && Number.isInteger(spec.digits) && spec.digits >= 0 && spec.digits <= MAX_DIGITS
    ? spec.digits
    : null;
  const point = num(spec.point) && spec.point > 0 ? spec.point : null;
  if (digits !== null) return { digits, point: point ?? Math.pow(10, -digits) };
  if (point !== null) {
    const derived = decimalsOf(point);
    return derived === null ? null : { digits: derived, point };
  }
  return null;
}
