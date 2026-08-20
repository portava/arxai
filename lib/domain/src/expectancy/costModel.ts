// ── expectancy/costModel: explicit trading costs in R units ─────────────────
//
// R7 step 5 core (intel-engine.md §2 #18): every conservative-EV computation
// must include spread + commission + slippage. The vision's failure mode is a
// cost model that silently defaults a missing input to zero — a default that
// FLATTERS the EV and lets a costless fantasy trade look positive.
//
// Constraints this module enforces:
//   - Pure and deterministic. No IO, no clock, no imports outside this package.
//   - Costs are REQUIRED. A missing / non-numeric / non-finite / negative cost
//     input is a typed refusal (CostInputsRequiredError), never a zero. A
//     broker that genuinely charges no commission is expressed by the CALLER
//     passing an explicit 0 — an assertion the caller owns, not a default this
//     module invents.
//   - 1R is DEFINED by the entry-to-stop distance in price units
//     (stopDistancePrice). It must be strictly positive: a zero/negative stop
//     distance means the trade has no defined risk unit, so no cost (and no
//     EV) can honestly be expressed in R.
//   - A pre-built CostInputs object is re-validated before use
//     (assertCostInputs): totalR must equal the component sum, so a caller can
//     never smuggle in a flattering total that disagrees with its parts.

/** Round-trip trading costs expressed in R units (fractions of the 1R
 *  entry-to-stop risk). All components are >= 0 and finite; totalR is their
 *  exact sum. Build via computeCostsR() or validate hand-built objects with
 *  assertCostInputs(). */
export interface CostInputs {
  /** Round-trip spread cost as a fraction of 1R. */
  spreadR: number;
  /** Round-trip commission as a fraction of 1R. */
  commissionR: number;
  /** Expected round-trip slippage as a fraction of 1R. */
  slippageR: number;
  /** spreadR + commissionR + slippageR. Validated, never trusted. */
  totalR: number;
}

export const EXPECTANCY_COSTS_REQUIRED = "EXPECTANCY_COSTS_REQUIRED" as const;

/** Typed refusal: a required cost input is missing or invalid. Thrown — never
 *  swallowed into a zero — because a defaulted cost flatters the EV. */
export class CostInputsRequiredError extends Error {
  readonly code = EXPECTANCY_COSTS_REQUIRED;
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`${EXPECTANCY_COSTS_REQUIRED}: ${field} — ${detail}`);
    this.name = "CostInputsRequiredError";
    this.field = field;
  }
}

/** Explicit price-unit inputs for the cost model. Every field is REQUIRED;
 *  there are no defaults (see module header). All values are in the
 *  instrument's PRICE units for one round trip of the intended trade size. */
export interface CostModelInput {
  /** Entry-to-stop distance in price units. Defines 1R. Must be finite > 0. */
  stopDistancePrice: number;
  /** Round-trip spread paid, in price units. Finite >= 0. */
  spreadPrice: number;
  /** Round-trip commission converted to price units. Finite >= 0. An actually
   *  commission-free account passes an explicit 0. */
  commissionPrice: number;
  /** Expected round-trip slippage in price units. Finite >= 0. Pass the
   *  measured estimate from execution history when one exists; an explicit 0
   *  is a caller assertion of zero slippage, not a default. */
  slippagePrice: number;
}

function requireFinite(field: string, value: unknown, min: number): number {
  if (value === null || value === undefined) {
    throw new CostInputsRequiredError(field, "cost inputs are REQUIRED; missing values never default to zero");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CostInputsRequiredError(field, `must be a finite number (got ${String(value)})`);
  }
  if (value < min) {
    throw new CostInputsRequiredError(field, `must be >= ${min} (got ${value})`);
  }
  return value;
}

/** Convert explicit price-unit costs into R units. Throws
 *  CostInputsRequiredError on any missing/invalid input (typed refusal —
 *  never a flattering default). */
export function computeCostsR(input: CostModelInput): CostInputs {
  if (input === null || input === undefined || typeof input !== "object") {
    throw new CostInputsRequiredError("input", "cost model input object is REQUIRED");
  }
  const stopDistancePrice = requireFinite("stopDistancePrice", input.stopDistancePrice, 0);
  if (stopDistancePrice <= 0) {
    throw new CostInputsRequiredError(
      "stopDistancePrice",
      "must be > 0 — 1R is defined by the entry-to-stop distance; without it costs cannot be expressed in R",
    );
  }
  const spreadPrice = requireFinite("spreadPrice", input.spreadPrice, 0);
  const commissionPrice = requireFinite("commissionPrice", input.commissionPrice, 0);
  const slippagePrice = requireFinite("slippagePrice", input.slippagePrice, 0);

  const spreadR = spreadPrice / stopDistancePrice;
  const commissionR = commissionPrice / stopDistancePrice;
  const slippageR = slippagePrice / stopDistancePrice;
  return { spreadR, commissionR, slippageR, totalR: spreadR + commissionR + slippageR };
}

/** Tolerance for totalR-vs-component-sum agreement (floating-point only —
 *  never a loophole for smuggling a flattering total). */
export const COST_TOTAL_TOLERANCE = 1e-9;

/** Validate a CostInputs object before it is consumed (probabilityEngine calls
 *  this on every estimate). Throws CostInputsRequiredError on any defect. */
export function assertCostInputs(costs: unknown): asserts costs is CostInputs {
  if (costs === null || costs === undefined || typeof costs !== "object") {
    throw new CostInputsRequiredError("costs", "CostInputs object is REQUIRED — EV without costs is fiction");
  }
  const c = costs as Record<string, unknown>;
  const spreadR = requireFinite("costs.spreadR", c.spreadR, 0);
  const commissionR = requireFinite("costs.commissionR", c.commissionR, 0);
  const slippageR = requireFinite("costs.slippageR", c.slippageR, 0);
  const totalR = requireFinite("costs.totalR", c.totalR, 0);
  if (Math.abs(totalR - (spreadR + commissionR + slippageR)) > COST_TOTAL_TOLERANCE) {
    throw new CostInputsRequiredError(
      "costs.totalR",
      `must equal spreadR + commissionR + slippageR (got ${totalR}, components sum to ${spreadR + commissionR + slippageR})`,
    );
  }
}
