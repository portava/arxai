// C7 — CostSlippageModel: per-instrument-class trading costs with PROVENANCE.
//
// WHY COSTS ARE A VALIDATION CONCERN, NOT AN EXECUTION CONCERN
// ------------------------------------------------------------
// A gross backtest return is a number no live account can earn. Spread is paid
// on every entry and exit, slippage is paid whenever the venue fills at a price
// other than the one quoted, and commission is paid because the venue says so.
// An "edge" smaller than its own round-trip cost is not a small edge — it is a
// loss wearing a plus sign. So the validation factory now REFUSES to certify
// anything that was not evaluated net of this model (see factory.ts), and the
// transfer-proof harness (transferProof.ts) pre-registers its pass bar in NET
// terms.
//
// PROVENANCE IS THE NON-NEGOTIABLE PART
// -------------------------------------
// Every component of every estimate is stamped "measured" or "declared":
//
//   measured — computed from real observations (live quote history for spread,
//              demo fill records for slippage: requested price vs the venue's
//              own buy_price confirmation, the same seam derivGuidedBuy
//              validates). Only granted when the sample is large enough.
//   declared — a conservative default we CHOSE, written down per instrument
//              class / venue. Honest about being an assumption.
//
// A declared default is NEVER presented as measured: an insufficient sample
// falls back to the declared value AND keeps the "declared" stamp. The reverse
// lie — presenting an assumption as a measurement — is exactly how a cost
// model quietly becomes marketing.
//
// CONSERVATISM RULES
// ------------------
//   - Slippage is ADVERSE-ONLY: a favorable fill counts as zero, never as a
//     rebate. A mean that nets favorable against adverse slippage would let
//     lucky fills subsidise the bar.
//   - A measured estimate requires MIN_QUOTE_SAMPLE / MIN_FILL_SAMPLE
//     observations; below that the declared default applies. An under-powered
//     measurement is indistinguishable from a flattering one.
//   - `netReturns` only ever SUBTRACTS: net ≤ gross for every observation, by
//     construction. There is no code path by which applying costs raises a
//     return.
//
// Pure: node:crypto for the model hash, and nothing else. No I/O, no clock, no
// randomness, nothing on the order path. Nothing here places, sizes, or
// authorises a trade.

import { createHash } from "node:crypto";
import type { ArxAssetClass } from "@workspace/markets";

/** Where a cost number came from. There is no third value on purpose. */
export type CostProvenance = "measured" | "declared";

/** One live quote observation (both sides, same instant). */
export interface QuoteObservation {
  bid: number;
  ask: number;
}

/**
 * One demo fill record: what we asked to pay vs what the venue confirmed.
 *
 * Shape mirrors the phase6 guided-buy seam: `requestedPrice` is the validated
 * proposal ask the buy was submitted at, `filledPrice` is the venue's own
 * buy_price from the fill confirmation. Both venue-evidenced numbers — this
 * model never invents either side.
 */
export interface DemoFillObservation {
  requestedPrice: number;
  filledPrice: number;
}

/** Minimum quote observations before a spread may claim "measured". */
export const MIN_QUOTE_SAMPLE = 20;
/** Minimum demo fill records before slippage may claim "measured". */
export const MIN_FILL_SAMPLE = 20;

interface DeclaredClassDefaults {
  /** Half the relative bid/ask spread — the cost of ONE side. */
  halfSpreadFrac: number;
  /** Adverse per-side slippage as a fraction of notional. */
  perSideSlippageFrac: number;
}

/**
 * Conservative DECLARED defaults per instrument class, as fractions of
 * notional per SIDE. These are deliberately on the expensive side of realistic
 * retail conditions: the honest failure mode of a declared default is an edge
 * that survives real costs being told "not yet proven", never the reverse.
 * The Record is exhaustive over ArxAssetClass so a new class cannot ship
 * without a declared cost.
 */
export const DECLARED_CLASS_DEFAULTS: Readonly<Record<ArxAssetClass, DeclaredClassDefaults>> =
  Object.freeze({
    forex_major: { halfSpreadFrac: 0.0001, perSideSlippageFrac: 0.0001 },
    forex_cross: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
    forex_exotic: { halfSpreadFrac: 0.0008, perSideSlippageFrac: 0.0005 },
    metal: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
    energy: { halfSpreadFrac: 0.0004, perSideSlippageFrac: 0.0003 },
    index: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
    stock: { halfSpreadFrac: 0.0003, perSideSlippageFrac: 0.0003 },
    etf: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
    crypto: { halfSpreadFrac: 0.0008, perSideSlippageFrac: 0.0007 },
    synthetic: { halfSpreadFrac: 0.0005, perSideSlippageFrac: 0.0003 },
    commodity: { halfSpreadFrac: 0.0004, perSideSlippageFrac: 0.0003 },
  });

/**
 * DECLARED per-venue commission, per side, as a fraction of notional.
 * Declared because no venue publishes its schedule into this repo as data yet;
 * when a reconciled fee feed exists these become measured. An UNKNOWN venue
 * gets the most expensive declared entry — never a free ride.
 */
export const DECLARED_VENUE_COMMISSION_PER_SIDE: Readonly<Record<string, number>> = Object.freeze({
  deriv: 0.0002,
  mt5: 0.0003,
});
export const UNKNOWN_VENUE_COMMISSION_PER_SIDE = 0.0005;

export interface CostComponentEstimate {
  /** Per-side cost as a fraction of notional. */
  frac: number;
  provenance: CostProvenance;
  /** Observations behind a measured estimate; 0 for a declared one. */
  n: number;
  detail: string;
}

export interface InstrumentCostModel {
  instrument: string;
  instrumentClass: ArxAssetClass;
  venue: string;
  spread: CostComponentEstimate;
  slippage: CostComponentEstimate;
  commission: CostComponentEstimate;
  /** spread.frac + slippage.frac + commission.frac — the cost of ONE side. */
  perSideCostFrac: number;
  /** sha256 over the canonical model — stamps evidence and chain rows. */
  modelHash: string;
}

/**
 * Sorted-key JSON canonicalization — byte-identical to
 * @workspace/features/eventChain's `stableStringify`. Deliberately DUPLICATED,
 * not imported: these are independently-versioned research packages and the
 * repo's standing pattern (discovery, features, risk) is a local copy pinned
 * by scripts/src/stableStringifyParityTest.ts, which now covers this one too.
 */
export function stableStringify(v: unknown): string {
  if (v === undefined) return '"__undefined__"';
  if (v === null) return "null";
  if (typeof v === "number" && !Number.isFinite(v)) return `"__${String(v)}__"`;
  if (typeof v === "bigint") return `"${v.toString()}n"`;
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Spread estimate: measured from live quote history when the sample allows,
 * conservative declared default otherwise. Malformed quotes (crossed, zero,
 * non-finite) are DROPPED from the sample rather than repaired — repairing a
 * quote is fabricating one.
 */
export function estimateSpread(
  instrumentClass: ArxAssetClass,
  quotes: readonly QuoteObservation[] = [],
): CostComponentEstimate {
  const usable = quotes.filter(
    (q) =>
      Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.bid > 0 && q.ask > 0 && q.ask >= q.bid,
  );
  if (usable.length >= MIN_QUOTE_SAMPLE) {
    const rel = usable.map((q) => (q.ask - q.bid) / (q.ask + q.bid)); // (ask−bid)/(2·mid)
    const m = rel.reduce((a, b) => a + b, 0) / rel.length;
    return {
      frac: m,
      provenance: "measured",
      n: usable.length,
      detail: `measured from ${usable.length} live quotes (mean relative half-spread)`,
    };
  }
  const d = DECLARED_CLASS_DEFAULTS[instrumentClass];
  return {
    frac: d.halfSpreadFrac,
    provenance: "declared",
    n: 0,
    detail:
      `declared class default for ${instrumentClass} ` +
      `(${usable.length} usable quotes < ${MIN_QUOTE_SAMPLE} — an under-powered measurement is not a measurement)`,
  };
}

/**
 * Slippage estimate from demo fill records: requested price vs the venue's own
 * fill confirmation. ADVERSE-ONLY — a favorable fill clamps to 0 per record,
 * so the mean can never go negative and lucky fills can never subsidise the
 * certification bar.
 */
export function estimateSlippage(
  instrumentClass: ArxAssetClass,
  fills: readonly DemoFillObservation[] = [],
): CostComponentEstimate {
  const usable = fills.filter(
    (f) =>
      Number.isFinite(f.requestedPrice) &&
      Number.isFinite(f.filledPrice) &&
      f.requestedPrice > 0 &&
      f.filledPrice > 0,
  );
  if (usable.length >= MIN_FILL_SAMPLE) {
    const adverse = usable.map((f) =>
      Math.max(0, (f.filledPrice - f.requestedPrice) / f.requestedPrice),
    );
    const m = adverse.reduce((a, b) => a + b, 0) / adverse.length;
    return {
      frac: m,
      provenance: "measured",
      n: usable.length,
      detail: `measured from ${usable.length} demo fills (mean ADVERSE relative slippage; favorable fills count 0)`,
    };
  }
  const d = DECLARED_CLASS_DEFAULTS[instrumentClass];
  return {
    frac: d.perSideSlippageFrac,
    provenance: "declared",
    n: 0,
    detail:
      `declared class default for ${instrumentClass} ` +
      `(${usable.length} usable fills < ${MIN_FILL_SAMPLE})`,
  };
}

/** Commission: declared per venue; an unknown venue pays the most, not the least. */
export function commissionForVenue(venue: string): CostComponentEstimate {
  const known = DECLARED_VENUE_COMMISSION_PER_SIDE[venue];
  if (known !== undefined) {
    return { frac: known, provenance: "declared", n: 0, detail: `declared schedule for venue "${venue}"` };
  }
  return {
    frac: UNKNOWN_VENUE_COMMISSION_PER_SIDE,
    provenance: "declared",
    n: 0,
    detail: `venue "${venue}" has no declared schedule — charged the conservative unknown-venue default`,
  };
}

/**
 * Build the cost model for one instrument. Quotes and fills are optional;
 * whatever cannot be measured falls back to declared, stamped as such.
 */
export function buildCostModel(opts: {
  instrument: string;
  instrumentClass: ArxAssetClass;
  venue: string;
  quotes?: readonly QuoteObservation[];
  fills?: readonly DemoFillObservation[];
}): InstrumentCostModel {
  const spread = estimateSpread(opts.instrumentClass, opts.quotes ?? []);
  const slippage = estimateSlippage(opts.instrumentClass, opts.fills ?? []);
  const commission = commissionForVenue(opts.venue);
  const perSideCostFrac = spread.frac + slippage.frac + commission.frac;
  const modelHash = sha256Hex(
    stableStringify({
      instrument: opts.instrument,
      instrumentClass: opts.instrumentClass,
      venue: opts.venue,
      spread: { frac: spread.frac, provenance: spread.provenance, n: spread.n },
      slippage: { frac: slippage.frac, provenance: slippage.provenance, n: slippage.n },
      commission: { frac: commission.frac, provenance: commission.provenance, n: commission.n },
    }),
  );
  return {
    instrument: opts.instrument,
    instrumentClass: opts.instrumentClass,
    venue: opts.venue,
    spread,
    slippage,
    commission,
    perSideCostFrac,
    modelHash,
  };
}

/**
 * How the position path is charged.
 *
 *   positions — the signed exposure held during each return observation
 *               (positions[t] earns gross[t]); each CHANGE in exposure pays
 *               one side's cost on the size of the change, and the final
 *               position pays its own unwind. This matches
 *               strategyFamilies.strategyReturns exactly.
 *   roundTripPerObservation — the conservative upper bound when the position
 *               path is unknown: every observation is charged a full round
 *               trip at `size`. Used by callers that only hold a return
 *               series (e.g. the discovery pipeline's trial outcomes).
 */
export type SizeSchedule =
  | { kind: "positions"; positions: readonly number[] }
  | { kind: "roundTripPerObservation"; size: number };

/** The evidence stamp the validation factory requires. See factory.ts. */
export interface CostEvidence {
  /** Literal true — a structural witness that netting actually ran. */
  applied: true;
  instrument: string;
  instrumentClass: ArxAssetClass;
  venue: string;
  perSideCostFrac: number;
  provenance: {
    spread: CostProvenance;
    slippage: CostProvenance;
    commission: CostProvenance;
  };
  modelHash: string;
  scheduleKind: SizeSchedule["kind"];
}

/**
 * The evidence stamp for a model + schedule kind. `netReturns` derives its
 * evidence through this same function, so a family-level attestation (one
 * evidence object covering every trial netted under the same model and
 * schedule kind) can never diverge from the per-series one.
 */
export function costEvidence(model: InstrumentCostModel, scheduleKind: SizeSchedule["kind"]): CostEvidence {
  if (!(model.perSideCostFrac > 0)) {
    throw new Error(
      `costEvidence: perSideCostFrac must be > 0 (got ${model.perSideCostFrac}) — a zero-cost model is a gross evaluation in disguise`,
    );
  }
  return {
    applied: true,
    instrument: model.instrument,
    instrumentClass: model.instrumentClass,
    venue: model.venue,
    perSideCostFrac: model.perSideCostFrac,
    provenance: {
      spread: model.spread.provenance,
      slippage: model.slippage.provenance,
      commission: model.commission.provenance,
    },
    modelHash: model.modelHash,
    scheduleKind,
  };
}

export interface NetReturnsResult {
  /** gross − cost, observation by observation. net[t] ≤ gross[t] always. */
  net: number[];
  /** Total cost charged over the whole series (sum of per-obs charges). */
  totalCostCharged: number;
  evidence: CostEvidence;
}

/**
 * Apply the cost model to a gross return series.
 *
 * The ONLY operation on a return is subtraction of a non-negative charge, so
 * `net[t] ≤ gross[t]` for every t by construction — costs can make the bar
 * higher, never lower. Non-finite inputs throw: a NaN return reaching a cost
 * model is an upstream fabrication, and repairing it here would launder it.
 */
export function netReturns(
  grossReturns: readonly number[],
  model: InstrumentCostModel,
  schedule: SizeSchedule,
): NetReturnsResult {
  if (grossReturns.some((r) => !Number.isFinite(r))) {
    throw new Error("netReturns: non-finite gross return — refusing to net fabricated inputs");
  }
  const perSide = model.perSideCostFrac;
  if (!(perSide > 0)) {
    // Every declared default is nonzero and measured components only add, so
    // this is unreachable through buildCostModel — but a hand-rolled zero-cost
    // model is gross-only evaluation wearing a costume.
    throw new Error(
      `netReturns: perSideCostFrac must be > 0 (got ${perSide}) — a zero-cost model is a gross evaluation in disguise`,
    );
  }

  const n = grossReturns.length;
  const charges = new Array<number>(n).fill(0);

  if (schedule.kind === "positions") {
    const pos = schedule.positions;
    if (pos.length < n) {
      throw new Error(
        `netReturns: positions schedule has ${pos.length} entries for ${n} return observations — ` +
          "every observation's exposure must be declared, not assumed",
      );
    }
    if (pos.some((p) => !Number.isFinite(p))) {
      throw new Error("netReturns: non-finite position in size schedule");
    }
    let prev = 0;
    for (let t = 0; t < n; t++) {
      const p = pos[t]!;
      charges[t] = perSide * Math.abs(p - prev);
      prev = p;
    }
    // The final position does not get to die free: its unwind is charged on
    // the last observation. Omitting it would make "hold forever" a cost
    // loophole.
    if (n > 0) charges[n - 1]! += perSide * Math.abs(prev);
  } else {
    const size = schedule.size;
    if (!(size > 0) || !Number.isFinite(size)) {
      throw new Error(`netReturns: roundTripPerObservation size must be a positive finite number (got ${size})`);
    }
    for (let t = 0; t < n; t++) charges[t] = perSide * 2 * size;
  }

  let total = 0;
  const net = grossReturns.map((g, t) => {
    total += charges[t]!;
    return g - charges[t]!;
  });

  return {
    net,
    totalCostCharged: total,
    evidence: costEvidence(model, schedule.kind),
  };
}
