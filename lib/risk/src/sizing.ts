// A1–A5 — the sizing chain. One pure pipeline in which every stage can only
// REDUCE size.
//
// THE MONOTONICITY INVARIANT
// --------------------------
// The chain is deliberately built so that no stage after the objective can ever
// increase the size. Vol targeting proposes, the Kelly cap trims, the learned
// nudge may only tighten, and the floor stack takes a minimum. That single
// property is what makes the system safe to extend: a new floor, a new model, a
// new governor can be added by anyone without a fresh safety review, because the
// worst it can do is trade smaller. A stage that could raise size would make
// every future addition a safety-critical change.
//
// This is enforced structurally (`Math.min`, a throwing tighten-only check),
// asserted by the unit suite, and re-asserted by `decideSize`, which fails
// closed if the composition ever produces more than the deterministic size.
//
// THE NO-EDGE RULE
// ----------------
// `kellyCapGovernor` returns EXACTLY 0 — not "small", not "a floor value" —
// without a measured out-of-sample edge. Undefined, null, NaN, zero and negative
// edges all size to zero. An unmeasured edge is not a small edge; it is an
// unknown one, and the honest size for an unknown edge is nothing. This is the
// arithmetic version of the same rule that stops the intelligence pages
// inventing a VIX.
//
// SCOPE: pure arithmetic plus `node:crypto` for the determinism hash. Imports
// nothing from the dispatch/gate path, reads no clock and no feed, and cannot
// place, size, or authorise a trade. Wiring this into live sizing is a separate,
// later work order.

import { createHash } from "node:crypto";
import { kellyStar } from "./objective.js";

// ── A1 — VolTargetSizer ─────────────────────────────────────────────────────

export interface VolTargetInput {
  /** Fraction of capital to put at risk at the target volatility. */
  targetRiskFrac: number;
  /** The volatility the target fraction is calibrated for. */
  sigmaTarget: number;
  /** The volatility actually expected over the horizon. */
  sigmaExpected: number;
}

export type VolTargetReason = "OK" | "NO_SIGMA";

export interface VolTargetResult {
  baseFrac: number;
  reason: VolTargetReason;
}

/**
 * Scale the risk budget inversely with expected volatility: a market moving
 * twice as much gets half the size, so the risk taken stays roughly constant
 * instead of doubling with the market's mood.
 *
 * `sigmaExpected <= 0`, `NaN` or `undefined` returns EXACTLY 0. Written as
 * `!(x > 0)` rather than `x <= 0` on purpose — `NaN <= 0` is false, so the
 * intuitive form would let a NaN volatility through and produce a NaN size,
 * which compares false against every subsequent cap and sails through the whole
 * chain unbounded. The negated form catches NaN.
 */
export function volTargetBaseFrac(a: VolTargetInput): VolTargetResult {
  if (!(a.sigmaExpected > 0)) return { baseFrac: 0, reason: "NO_SIGMA" };
  return {
    baseFrac: (a.targetRiskFrac * a.sigmaTarget) / a.sigmaExpected,
    reason: "OK",
  };
}

// ── A2 — KellyCapGovernor ───────────────────────────────────────────────────

export interface KellyCapInput {
  /** Measured OUT-OF-SAMPLE edge. `null`/`undefined` means "not measured". */
  edgeOOS: number | null | undefined;
  /** Out-of-sample variance of the same series. */
  varOOS: number;
  /** The growth-optimal fraction f* from the objective kernel. */
  fStar: number;
}

export type KellyCapReason = "OK" | "NO_EDGE" | "CAP_BOUND";

export interface KellyCapResult {
  fUsed: number;
  reason: KellyCapReason;
}

/**
 * The hard ceiling on the objective's answer: at most a QUARTER of f*.
 *
 * Full Kelly is growth-optimal only if μ and σ² are known exactly. They never
 * are — they are estimates from a finite sample, and the penalty for
 * over-estimating the edge is violently asymmetric: g(f) falls off far faster
 * above f* than below it, and is negative beyond 2f*. Quarter Kelly gives up
 * about 7% of the theoretical growth rate in exchange for roughly a quarter of
 * the drawdown, and stays growth-positive even if the true edge is only a
 * quarter of the measured one.
 *
 * Without a measured out-of-sample edge the answer is EXACTLY 0.
 */
export function kellyCapGovernor(a: KellyCapInput): KellyCapResult {
  if (
    a.edgeOOS == null ||
    !Number.isFinite(a.edgeOOS) ||
    a.edgeOOS <= 0 ||
    !(a.varOOS > 0) ||
    // A non-positive f* means the objective sees no long edge, whatever the
    // measured OOS number says. Without this the cap `0.25 · f*` goes NEGATIVE
    // and, since a positive raw fraction always exceeds it, the governor would
    // return that negative value as a SIZE. The 5,000-draw monotonicity fuzz in
    // `objectiveSizingTest` found exactly this: 839 draws where μ < 0 produced a
    // negative deterministic size. A negative size is not a short — direction is
    // decided elsewhere — it is a bug, and it would have propagated through the
    // rest of the chain comparing false against every subsequent ceiling.
    !(a.fStar > 0)
  ) {
    return { fUsed: 0, reason: "NO_EDGE" };
  }
  const raw = a.edgeOOS / a.varOOS;
  const cap = 0.25 * a.fStar;
  return raw >= cap ? { fUsed: cap, reason: "CAP_BOUND" } : { fUsed: raw, reason: "OK" };
}

// ── A3 — TightenOnly ────────────────────────────────────────────────────────

/**
 * Apply a learned multiplier that may only REDUCE the deterministic size.
 *
 * The nudge is the one place a learned model touches sizing, so it is the one
 * place a model could talk the system into a bigger position. It cannot: the
 * result is `min(deterministic, deterministic · nudge)`, and a nudge outside
 * [0,1] THROWS rather than being clamped.
 *
 * Throwing is the point. Clamping a 1.5 nudge to 1.0 would silently accept a
 * model that is trying to increase size — the behaviour would look correct while
 * the model's intent went unnoticed. A throw surfaces it as a defect, which is
 * what "a model asked to size up" is.
 *
 * The explicit `min` is belt-and-braces: for a nudge in [0,1] the product is
 * already ≤ the deterministic size for POSITIVE sizes, but the min also holds
 * the invariant for a negative deterministic input, where multiplying by a
 * fraction would move it UP toward zero.
 */
export function enforceTightenOnly(deterministic: number, nudge: number): number {
  if (!(nudge >= 0 && nudge <= 1)) {
    throw new Error(`nudge out of [0,1]: ${nudge}`);
  }
  return Math.min(deterministic, deterministic * nudge);
}

// ── A4 — FloorStack ─────────────────────────────────────────────────────────

/** A hard ceiling on size, contributed by one risk control. */
export interface Floor {
  /** Stable identifier, surfaced as `bindingFloor` so the reason is legible. */
  name: string;
  /** Maximum fraction this control permits. */
  maxFrac: number;
}

export interface FloorStackResult {
  /** The tightest permitted fraction. */
  maxFrac: number;
  /** Which floor bound it, or `null` when no floor was supplied. */
  bindingFloor: string | null;
}

/**
 * The tightest floor wins, and its NAME is carried out with the number.
 *
 * Reporting which control bound the size is not decoration: "we traded small"
 * and "we traded small because the weekly loss cap was one bad day from
 * tripping" are different facts, and only the second is actionable. A floor
 * stack that returns a bare number makes every size unexplainable after the
 * fact.
 *
 * Ties resolve to the FIRST floor listed, so the ordering of the stack is the
 * documented tie-break rather than an accident of iteration.
 */
export function applyFloorStack(floors: readonly Floor[]): FloorStackResult {
  let best: Floor | null = null;
  for (const f of floors) {
    if (best === null || f.maxFrac < best.maxFrac) best = f;
  }
  return best === null
    ? { maxFrac: Infinity, bindingFloor: null }
    : { maxFrac: best.maxFrac, bindingFloor: best.name };
}

/**
 * Daily / weekly realised-loss cap, expressed as a floor.
 *
 * Consumed budget is clamped into [0,1] and the remaining allowance scales the
 * base size linearly, reaching EXACTLY 0 when the cap is spent. A non-finite or
 * unknown consumed figure yields a 0 floor — fail-safe, treating unknown as
 * fully consumed, never as fully available. That direction is deliberate: the
 * opposite convention turns a broken telemetry feed into an uncapped account.
 */
export function dailyWeeklyLossCapFloor(a: {
  baseFrac: number;
  consumedFrac: number | null | undefined;
}): Floor {
  const c = a.consumedFrac;
  if (c == null || !Number.isFinite(c)) {
    return { name: "DailyWeeklyLossCap", maxFrac: 0 };
  }
  const consumed = Math.min(1, Math.max(0, c));
  return { name: "DailyWeeklyLossCap", maxFrac: a.baseFrac * (1 - consumed) };
}

/**
 * Stop-ratchet floor: once a position's stop has been moved in, size may not
 * exceed what the remaining stop distance justifies.
 *
 * A non-positive or non-finite stop distance yields a 0 floor. Without a stop
 * distance there is no bounded loss to size against, and the honest size for an
 * unbounded loss is nothing.
 */
export function stopRatchetFloor(a: {
  riskPerUnit: number;
  stopDistance: number | null | undefined;
}): Floor {
  const d = a.stopDistance;
  if (d == null || !Number.isFinite(d) || !(d > 0) || !(a.riskPerUnit > 0)) {
    return { name: "StopRatchet", maxFrac: 0 };
  }
  return { name: "StopRatchet", maxFrac: a.riskPerUnit / d };
}

// ── A5 — SizingDecider ──────────────────────────────────────────────────────

export interface SizingInputs {
  /** Expected excess return over the horizon. */
  mu: number;
  /** Variance of the return over the same horizon. */
  sigmaSq: number;
  /** Vol-targeting parameters. */
  volTarget: VolTargetInput;
  /** Measured out-of-sample edge, or null/undefined when not measured. */
  edgeOOS: number | null | undefined;
  /** Out-of-sample variance. */
  varOOS: number;
  /** Learned multiplier in [0,1]. Defaults to 1 (no nudge). */
  nudge?: number;
  /** Additional hard floors from risk controls. */
  floors?: readonly Floor[];
}

export type SizingReason = VolTargetReason | KellyCapReason;

export interface SizingDecision {
  /** The size to trade, as a fraction of capital. Never negative. */
  finalSize: number;
  /** Which floor bound the result, or `null` if no floor did. */
  bindingFloor: string | null;
  /** Why the chain arrived here — the tightest binding reason. */
  reason: SizingReason;
  /** The size before the learned nudge and the floor stack. */
  deterministicSize: number;
  /** f* from the objective kernel, for audit. */
  fStar: number;
  /** Stable hash of the inputs — identical inputs give an identical hash. */
  inputsHash: string;
}

/** JSON with keys sorted at every depth, so the hash is order-independent. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") {
    // `undefined` and non-finite numbers have no JSON form; name them
    // explicitly so two different absent-ish inputs cannot collide.
    if (v === undefined) return '"__undefined__"';
    if (typeof v === "number" && !Number.isFinite(v)) return `"__${String(v)}__"`;
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export function hashInputs(inputs: SizingInputs): string {
  return createHash("sha256").update(stableStringify(inputs)).digest("hex");
}

/**
 * The whole chain, composed. Pure: same inputs in, same decision out, always.
 *
 * Order is objective → vol target → Kelly cap → tighten-only nudge → floor
 * stack, and the result is clamped at 0 because a "negative size" is not a short
 * position, it is a bug — direction is decided elsewhere.
 *
 * The final `Math.min` against `deterministicSize` is a structural
 * belt-and-braces assertion of the monotonicity invariant: even if a future
 * floor or nudge implementation were wrong, the composition still cannot return
 * more than the deterministic size.
 */
export function decideSize(inputs: SizingInputs): SizingDecision {
  const fStar = kellyStar(inputs.mu, inputs.sigmaSq);

  const vt = volTargetBaseFrac(inputs.volTarget);
  const kc = kellyCapGovernor({
    edgeOOS: inputs.edgeOOS,
    varOOS: inputs.varOOS,
    fStar,
  });

  // Vol targeting and the Kelly cap are both ceilings; the tighter one holds.
  // Clamped at 0 because the whole chain works in NON-NEGATIVE fractions: a
  // negative size is not a short position, it is a bug, and letting one through
  // here would make every downstream `Math.min` compare against a nonsense
  // baseline. Belt-and-braces with the `fStar > 0` guard in kellyCapGovernor.
  const deterministicSize = Math.max(0, Math.min(vt.baseFrac, kc.fUsed));
  const reason: SizingReason = vt.reason === "NO_SIGMA" ? "NO_SIGMA" : kc.reason;

  const nudged = enforceTightenOnly(deterministicSize, inputs.nudge ?? 1);

  const stack = applyFloorStack(inputs.floors ?? []);
  const floored = Math.min(nudged, stack.maxFrac);

  const finalSize = Math.max(0, Math.min(floored, deterministicSize));

  return {
    finalSize,
    bindingFloor: stack.bindingFloor !== null && stack.maxFrac < nudged ? stack.bindingFloor : null,
    reason,
    deterministicSize,
    fStar,
    inputsHash: hashInputs(inputs),
  };
}
