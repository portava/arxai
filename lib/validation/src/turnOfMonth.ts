// C8 — the turn-of-month trade generator and its wiring into the harness.
//
// THE PRE-REGISTERED RULE, RESTATED IN CODE TERMS
// -----------------------------------------------
//   "MONTH_BOUNDARY: enter at close of trading day T-1, exit at close of
//    trading day T+3", entryOffsetDays = -1, exitOffsetDays = +3.
//
// T is the FIRST TRADING DAY OF A MONTH — the month boundary itself. Offsets
// are in TRADING days (positions in the bar series), never calendar days, so
// T-1 is the last trading day of the previous month and T+3 is the fourth
// trading day of the new month. Reading the offsets as calendar days would
// silently land the entry on a weekend and change the experiment.
//
// ZERO LOOK-AHEAD BY CONSTRUCTION: a trade uses exactly two closes, both of
// which are in the past at the moment they are used, and the anchor is a
// calendar fact known years in advance. Nothing here consults a future bar.
//
// THE WINDOW SEAM — a real decision, made explicitly
// ---------------------------------------------------
// The January-2016 boundary trade ENTERS on 2015-12-31, the last trading day of
// the FIT window, and exits inside the holdout. Including it would make the
// evaluation's data window touch the fit window, which the harness refuses
// outright (FIT_WINDOW_OVERLAP) — correctly, because a bar the parameters were
// fitted on cannot also be a bar that proves them.
//
// So the rule here is: EVERY BAR A TRADE READS must lie inside the window. A
// boundary whose entry bar falls outside is SKIPPED, and it is skipped LOUDLY —
// it appears in `skipped` with a typed reason and a date, never dropped in
// silence. The cost is one boundary at each window seam. The alternative is a
// leak, which is not a cost, it is a lie.
//
// COSTS: each trade is one full round trip (buy a close, sell a close), so the
// cost schedule is `roundTripPerObservation` at the pre-registered size. That is
// C7's conservative branch and it is the honest one here — the position path is
// flat-in, flat-out with no netting between boundaries.
//
// Pure: no I/O, no clock, no randomness. Nothing here places, sizes, or
// authorises a trade.

import type { DailyBar } from "@workspace/markets";
import { dataFingerprint } from "@workspace/markets";
import type { InstrumentCostModel } from "./costModel.js";
import { netReturns } from "./costModel.js";
import type {
  DateWindow,
  ExperimentSpec,
  TransferEvaluationInput,
} from "./transferProof.js";
import { specHashOf, TURN_OF_MONTH_SPEC } from "./transferProof.js";
import { estimatePbo } from "./pbo.js";

// ── The pre-registration lock ────────────────────────────────────────────────

/**
 * The spec hash of `TURN_OF_MONTH_SPEC` as pre-registered, pinned here as a
 * literal.
 *
 * The harness already refuses a spec that mutated between registration and
 * evaluation — but only within one process's lifetime, because the registration
 * lives in an in-memory map. A one-shot evaluation run months later registers
 * and evaluates in the SAME process, so that check would compare the mutated
 * spec against itself and pass.
 *
 * This constant closes that hole across time: it was computed from the spec as
 * written, and any edit to the instrument, the calendar rule, the offsets, the
 * size, either window, the pass bar, or the notes changes the hash and makes
 * `verifyTurnOfMonthPreRegistration` fail. Quietly re-pinning it to the new
 * value is the exact move the whole C8 apparatus exists to make visible; a
 * genuine change of mind is a NEW experiment key, not a new hash under the old
 * one.
 */
export const TURN_OF_MONTH_LOCKED_SPEC_HASH =
  "019acc35f363e7b0e605c7449b1442d9514d0e64e4bca149dea697842d350dbc";

export type PreRegistrationCheck =
  | { intact: true; specHash: string }
  | { intact: false; specHash: string; expected: string; detail: string };

/** Is the pre-registration still byte-identical to what was locked? */
export function verifyTurnOfMonthPreRegistration(
  spec: ExperimentSpec = TURN_OF_MONTH_SPEC,
): PreRegistrationCheck {
  const specHash = specHashOf(spec);
  if (specHash === TURN_OF_MONTH_LOCKED_SPEC_HASH) return { intact: true, specHash };
  return {
    intact: false,
    specHash,
    expected: TURN_OF_MONTH_LOCKED_SPEC_HASH,
    detail:
      `the turn-of-month spec now hashes to ${specHash.slice(0, 16)} but was PRE-REGISTERED as ` +
      `${TURN_OF_MONTH_LOCKED_SPEC_HASH.slice(0, 16)}. Something in the spec changed after it was locked. ` +
      "A changed spec is a new, unregistered experiment — it does not inherit the old registration, and " +
      "re-pinning this constant to make the check pass would destroy the only evidence that it changed.",
  };
}

/** One completed turn-of-month round trip. */
export interface TurnOfMonthTrade {
  /** The boundary month, `yyyy-mm` — the month T falls in. */
  boundaryMonth: string;
  /** The month boundary date itself (T, the first trading day of the month). */
  anchorDate: string;
  entryDate: string;
  exitDate: string;
  entryClose: number;
  exitClose: number;
  /** Index into the source bars, so a report can point at the exact rows. */
  entryIndex: number;
  exitIndex: number;
  /** size × (exit/entry − 1). GROSS — costs are applied by the caller. */
  grossReturn: number;
}

export type SkipReason =
  | "ENTRY_BAR_BEFORE_SERIES_START"
  | "EXIT_BAR_PAST_SERIES_END"
  | "ENTRY_BAR_OUTSIDE_WINDOW"
  | "EXIT_BAR_OUTSIDE_WINDOW";

export interface SkippedBoundary {
  boundaryMonth: string;
  anchorDate: string;
  reason: SkipReason;
  detail: string;
}

export interface TurnOfMonthTrades {
  trades: TurnOfMonthTrade[];
  /** Boundaries that produced no trade, each with a typed reason. */
  skipped: SkippedBoundary[];
  /**
   * The span of bars the trades actually READ — first entry date to last exit
   * date. This is what goes to the harness as `dataWindow`; it is derived from
   * the bars used, never asserted by the caller.
   */
  barsRead: DateWindow | null;
  /** Index range of the bars read, inclusive. Used for the fingerprint slice. */
  barIndexRange: { from: number; to: number } | null;
}

export interface TradeGenOptions {
  entryOffsetDays: number;
  exitOffsetDays: number;
  size: number;
  /** Every bar a trade reads must lie inside this inclusive window. */
  window: DateWindow;
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Validate the bar series shape the generator depends on. The integrity guard
 * (@workspace/markets checkSeriesIntegrity) is the real gate; this is a
 * defensive re-check so a caller who skipped the guard gets an exception rather
 * than a plausible-looking wrong number.
 */
function assertUsableBars(bars: readonly DailyBar[]): void {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (!Number.isFinite(b.close) || b.close <= 0) {
      throw new Error(`turnOfMonth: bar ${i} (${b.date}) has a non-positive or non-finite close — run the integrity guard first`);
    }
    if (i > 0 && bars[i - 1]!.date >= b.date) {
      throw new Error(
        `turnOfMonth: bars must be strictly ascending and unique by date (${bars[i - 1]!.date} then ${b.date}) — run the integrity guard first`,
      );
    }
  }
}

/**
 * Indices of every month boundary in the series: the first bar of each month,
 * excluding index 0 (a boundary with no bar before it cannot supply a T−1).
 */
export function monthBoundaryIndices(bars: readonly DailyBar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (monthOf(bars[i]!.date) !== monthOf(bars[i - 1]!.date)) out.push(i);
  }
  return out;
}

/**
 * Generate the turn-of-month trades. Deterministic; the same bars and options
 * always produce the same trades.
 */
export function generateTurnOfMonthTrades(
  bars: readonly DailyBar[],
  opts: TradeGenOptions,
): TurnOfMonthTrades {
  assertUsableBars(bars);
  if (!(opts.exitOffsetDays > opts.entryOffsetDays)) {
    throw new Error(
      `turnOfMonth: exitOffsetDays (${opts.exitOffsetDays}) must be strictly after entryOffsetDays (${opts.entryOffsetDays})`,
    );
  }
  if (!(opts.size > 0) || !Number.isFinite(opts.size)) {
    throw new Error(`turnOfMonth: size must be a positive finite number (got ${opts.size})`);
  }

  const trades: TurnOfMonthTrade[] = [];
  const skipped: SkippedBoundary[] = [];

  for (const a of monthBoundaryIndices(bars)) {
    const anchorDate = bars[a]!.date;
    const boundaryMonth = monthOf(anchorDate);
    const entryIndex = a + opts.entryOffsetDays;
    const exitIndex = a + opts.exitOffsetDays;

    if (entryIndex < 0) {
      skipped.push({
        boundaryMonth,
        anchorDate,
        reason: "ENTRY_BAR_BEFORE_SERIES_START",
        detail: `entry bar would be index ${entryIndex}; the series starts at ${bars[0]!.date}`,
      });
      continue;
    }
    if (exitIndex > bars.length - 1) {
      skipped.push({
        boundaryMonth,
        anchorDate,
        reason: "EXIT_BAR_PAST_SERIES_END",
        detail: `exit bar would be index ${exitIndex}; the series ends at ${bars[bars.length - 1]!.date}`,
      });
      continue;
    }

    const entry = bars[entryIndex]!;
    const exit = bars[exitIndex]!;
    if (entry.date < opts.window.start || entry.date > opts.window.end) {
      skipped.push({
        boundaryMonth,
        anchorDate,
        reason: "ENTRY_BAR_OUTSIDE_WINDOW",
        detail:
          `entry bar ${entry.date} is outside ${opts.window.start}..${opts.window.end} — a trade may not read a bar ` +
          "from outside its own window, so this boundary is dropped rather than leaked",
      });
      continue;
    }
    if (exit.date < opts.window.start || exit.date > opts.window.end) {
      skipped.push({
        boundaryMonth,
        anchorDate,
        reason: "EXIT_BAR_OUTSIDE_WINDOW",
        detail: `exit bar ${exit.date} is outside ${opts.window.start}..${opts.window.end}`,
      });
      continue;
    }

    trades.push({
      boundaryMonth,
      anchorDate,
      entryDate: entry.date,
      exitDate: exit.date,
      entryClose: entry.close,
      exitClose: exit.close,
      entryIndex,
      exitIndex,
      grossReturn: opts.size * (exit.close / entry.close - 1),
    });
  }

  if (trades.length === 0) {
    return { trades, skipped, barsRead: null, barIndexRange: null };
  }
  let lo = trades[0]!.entryIndex;
  let hi = trades[0]!.exitIndex;
  for (const t of trades) {
    if (t.entryIndex < lo) lo = t.entryIndex;
    if (t.exitIndex > hi) hi = t.exitIndex;
  }
  return {
    trades,
    skipped,
    barsRead: { start: bars[lo]!.date, end: bars[hi]!.date },
    barIndexRange: { from: lo, to: hi },
  };
}

// ── Wiring into the harness ──────────────────────────────────────────────────

export type TurnOfMonthBuildRefusal =
  | { refused: true; code: "NO_TRADES"; detail: string }
  | { refused: true; code: "TOO_FEW_TRADES"; detail: string };

export function isTurnOfMonthBuildRefusal(v: unknown): v is TurnOfMonthBuildRefusal {
  return typeof v === "object" && v !== null && (v as { refused?: unknown }).refused === true;
}

export interface TurnOfMonthEvaluationBuild {
  input: TransferEvaluationInput;
  trades: TurnOfMonthTrade[];
  skipped: SkippedBoundary[];
  /** Gross per-trade returns, pre-cost — kept so a report can show the netting. */
  grossReturns: number[];
  /** Total cost charged across the track, from the C7 model. */
  totalCostCharged: number;
  /** The exact bars hashed into `input.dataFingerprint`. */
  fingerprintedBars: DailyBar[];
}

export interface BuildEvaluationOptions {
  /** ISO instant for the evaluation record. The harness never reads a clock. */
  at: string;
  /** The C7 cost model the returns are netted through. */
  costModel: InstrumentCostModel;
  /** Symbol + adjustment identity folded into the fingerprint. */
  fingerprintSymbol: string;
  fingerprintAdjustment: Parameters<typeof dataFingerprint>[0]["adjustment"];
  /** Multiplicity charged to the DSR. ≥1; the experiment itself is a trial. */
  nTrials: number;
  trialSharpeSd?: number;
  /** Fit-stage selection field for PBO. Absent ⇒ PBO UNMEASURABLE ⇒ that clause FAILS. */
  selectionField?: readonly (readonly number[])[];
  pboBlocks?: number;
  /** Minimum trades before an evaluation is worth running at all. */
  minTrades?: number;
}

/**
 * Build the `TransferEvaluationInput` for a window of the pre-registered spec.
 *
 * This function does NOT evaluate anything and does not touch the harness. It
 * turns bars into the exact typed input the harness demands, netted through the
 * C7 cost model, with the data window and fingerprint DERIVED FROM THE BARS
 * ACTUALLY READ rather than asserted. Whether that input is ever handed to
 * `harness.evaluate` on the holdout window is the owner's press.
 */
export function buildTurnOfMonthEvaluationInput(
  bars: readonly DailyBar[],
  spec: ExperimentSpec,
  window: DateWindow,
  opts: BuildEvaluationOptions,
): TurnOfMonthEvaluationBuild | TurnOfMonthBuildRefusal {
  const gen = generateTurnOfMonthTrades(bars, {
    entryOffsetDays: spec.entryOffsetDays,
    exitOffsetDays: spec.exitOffsetDays,
    size: spec.size,
    window,
  });
  if (gen.trades.length === 0 || gen.barsRead === null || gen.barIndexRange === null) {
    return {
      refused: true,
      code: "NO_TRADES",
      detail:
        `no turn-of-month trade lies wholly inside ${window.start}..${window.end} ` +
        `(${gen.skipped.length} boundary/boundaries skipped) — an empty track is a failed read, not a zero edge`,
    };
  }
  const minTrades = opts.minTrades ?? 2;
  if (gen.trades.length < minTrades) {
    return {
      refused: true,
      code: "TOO_FEW_TRADES",
      detail: `${gen.trades.length} trade(s) < the ${minTrades} required for a meaningful track`,
    };
  }

  const grossReturns = gen.trades.map((t) => t.grossReturn);
  // One full round trip per trade: flat in, flat out, nothing netted between
  // boundaries. C7's conservative branch, and the truthful one here.
  const netted = netReturns(grossReturns, opts.costModel, {
    kind: "roundTripPerObservation",
    size: spec.size,
  });

  const fingerprintedBars = bars.slice(gen.barIndexRange.from, gen.barIndexRange.to + 1);
  const fingerprint = dataFingerprint({
    symbol: opts.fingerprintSymbol,
    adjustment: opts.fingerprintAdjustment,
    bars: fingerprintedBars,
  });

  const input: TransferEvaluationInput = {
    at: opts.at,
    netOosReturns: netted.net,
    costs: netted.evidence,
    dataWindow: gen.barsRead,
    dataFingerprint: fingerprint,
    nTrials: opts.nTrials,
    ...(opts.trialSharpeSd === undefined ? {} : { trialSharpeSd: opts.trialSharpeSd }),
    ...(opts.selectionField === undefined ? {} : { selectionField: opts.selectionField }),
    ...(opts.pboBlocks === undefined ? {} : { pboBlocks: opts.pboBlocks }),
  };

  return {
    input,
    trades: gen.trades,
    skipped: gen.skipped,
    grossReturns,
    totalCostCharged: netted.totalCostCharged,
    fingerprintedBars,
  };
}

// ── The fit-stage selection field (PBO's input) ──────────────────────────────

export interface TomVariant {
  entryOffsetDays: number;
  exitOffsetDays: number;
}

/**
 * The offset grid this repository DECLARES as the fit-stage search space.
 *
 * PBO measures the probability that the selected variant's OOS rank is worse
 * than median across the FIELD IT WAS SELECTED FROM. That makes the field a
 * fact about what the fit actually searched — not a decoration. This constant
 * is a declared default, honest about being one: if the owner's fit considered
 * a different set of offsets, they must pass THAT set, because a PBO computed
 * against a field the search never saw is measuring a fiction.
 *
 * The grid brackets the pre-registered (−1, +3) on both axes: entries from
 * three sessions before the boundary, exits from the boundary day itself out to
 * the fifth session.
 */
export const DECLARED_FIT_VARIANT_GRID: readonly TomVariant[] = Object.freeze(
  [-3, -2, -1].flatMap((entryOffsetDays) =>
    [1, 2, 3, 4, 5].map((exitOffsetDays) => ({ entryOffsetDays, exitOffsetDays })),
  ),
);

export interface SelectionFieldResult {
  /** One row per variant, all the same length — the shape estimatePbo requires. */
  field: number[][];
  variants: TomVariant[];
  /** The boundary months every variant had a complete trade for. */
  commonBoundaryMonths: string[];
  /** Index of the spec's own variant within `variants`, or −1 if absent. */
  specVariantIndex: number;
}

/**
 * Build the fit-stage selection field: each variant's NET per-trade returns over
 * the fit window, restricted to the boundary months EVERY variant completed.
 *
 * The restriction is not cosmetic. `estimatePbo` requires equal-length rows, and
 * the honest way to get them is to compare variants on the same boundaries —
 * padding a short row with zeros would hand a variant free flat trades and
 * flatter it into the field.
 */
export function buildFitSelectionField(
  bars: readonly DailyBar[],
  spec: ExperimentSpec,
  fitWindow: DateWindow,
  costModel: InstrumentCostModel,
  variants: readonly TomVariant[] = DECLARED_FIT_VARIANT_GRID,
): SelectionFieldResult {
  const perVariant = variants.map((v) => ({
    variant: v,
    gen: generateTurnOfMonthTrades(bars, {
      entryOffsetDays: v.entryOffsetDays,
      exitOffsetDays: v.exitOffsetDays,
      size: spec.size,
      window: fitWindow,
    }),
  }));

  let common: string[] | null = null;
  for (const p of perVariant) {
    const months = p.gen.trades.map((t) => t.boundaryMonth);
    common = common === null ? months : common.filter((m) => months.includes(m));
  }
  const commonBoundaryMonths = (common ?? []).slice().sort();

  const field = perVariant.map((p) => {
    const byMonth = new Map(p.gen.trades.map((t) => [t.boundaryMonth, t.grossReturn]));
    const gross = commonBoundaryMonths.map((m) => byMonth.get(m)!);
    if (gross.length === 0) return [];
    return netReturns(gross, costModel, { kind: "roundTripPerObservation", size: spec.size }).net;
  });

  const specVariantIndex = variants.findIndex(
    (v) => v.entryOffsetDays === spec.entryOffsetDays && v.exitOffsetDays === spec.exitOffsetDays,
  );

  return { field, variants: [...variants], commonBoundaryMonths, specVariantIndex };
}

// ── The PBO pre-flight ───────────────────────────────────────────────────────

/**
 * CSCV block count used by BOTH the pre-flight and the harness's PBO clause.
 *
 * They must be the same number or the pre-flight is a reassurance about a
 * different quantity: PBO at 8 blocks and PBO at 10 blocks are different
 * statistics, and a guard that clears one while the bar judges the other is
 * worse than no guard, because it is trusted.
 */
export const PBO_PREFLIGHT_BLOCKS = 10;

export interface PboPreflight {
  /** The PBO the pass bar's PBO clause will be judged on. NaN when unmeasurable. */
  pbo: number;
  /** Would the PBO clause pass, as of now, on this fit field? NaN counts as FAIL. */
  wouldPass: boolean;
  blocks: number;
  combinations: number;
  medianOosRank: number;
  detail: string;
}

/**
 * Decide the PBO clause BEFORE the holdout is opened.
 *
 * This is not a convenience. `TransferProofHarness.evaluate` computes PBO as
 * `estimatePbo(input.selectionField, …)` — from the FIT-STAGE field alone. The
 * out-of-sample returns never enter it. So the PBO clause of an AND-ed pass bar
 * is fully determined by the fit window, and a dataset can be in a state where
 * the verdict is a MISS no matter what the holdout says.
 *
 * That is the same shape as the SHADOW_CI trap — a clause knowably failed in
 * advance, whose verdict nonetheless retires the experiment and charges the
 * family's FDR — and it deserves the same treatment: compute it early, print
 * it, and refuse the one shot rather than spend it on an arithmetic certainty.
 *
 * NaN is a FAIL, matching the clause exactly (`!(NaN < x)` is true). An
 * unmeasurable overfitting probability is not a low one.
 */
export function pboPreflight(
  selectionField: readonly (readonly number[])[],
  spec: ExperimentSpec = TURN_OF_MONTH_SPEC,
  blocks: number = PBO_PREFLIGHT_BLOCKS,
): PboPreflight {
  const r = estimatePbo(selectionField, blocks);
  return {
    pbo: r.pbo,
    wouldPass: Number.isFinite(r.pbo) && r.pbo < spec.passBar.maxPbo,
    blocks,
    combinations: r.combinations,
    medianOosRank: r.medianOosRank,
    detail: r.detail,
  };
}
