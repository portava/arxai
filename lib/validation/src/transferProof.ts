// C8 — TransferProofHarness: the enterprise gate. Data-agnostic machinery.
//
// THE ORDER OF OPERATIONS IS THE ENTIRE SAFETY PROPERTY
// -----------------------------------------------------
//   1. PRE-REGISTER. The full experiment spec — instrument, calendar rule,
//      entry/exit offsets, size, fit window, holdout window, and the PASS BAR
//      ITSELF — is hashed into a tamper-evident chain BEFORE any evaluation.
//      Evaluation refuses to run without a locked registration, and refuses if
//      the spec presented at evaluation time hashes differently from the one
//      that was locked. "We always meant the other exit offset" is not an
//      argument this harness can hear.
//   2. FIT / LOCK / OOS. The fit window and the holdout window are part of the
//      spec. An evaluation whose data window overlaps the fit window is
//      refused outright — data the parameters were fitted on cannot also be
//      the data that proves them.
//   3. NET OF COSTS. The pass bar is stated in NET terms and the evaluation
//      requires CostSlippageModel evidence (costModel.ts). A gross evaluation
//      is refused, not discounted.
//   4. LIVE SHADOW. Shadow P&L accrues per registered experiment; the shadow
//      clause passes only when the CI on the mean excludes zero FROM THE
//      POSITIVE SIDE after the pre-registered minimum number of observations.
//   5. VERDICT. PASS only when EVERY pre-registered clause passes. Any miss
//      retires the experiment, emits an FDR charge (consumable by
//      lib/discovery's controlFdr — choosing this niche was itself a trial),
//      and permanently refuses re-evaluation of the same spec on the same
//      data. A retired spec may only come back with demonstrably NEW data.
//
// WHAT THIS FILE DOES NOT DO
// --------------------------
// It holds no market data, fabricates none, and refuses to run without real
// inputs: the turn-of-month experiment below is REGISTERED but its evaluation
// is honestly BLOCKED_ON_DATA with a typed reason, because equity-index daily
// closes are not provisioned in this repo and provisioning them is an owner
// decision. Nothing here places, sizes, or authorises a trade; there is no
// path from any verdict to an execution surface.
//
// The internal chain uses the SAME canonical byte form as
// @workspace/features/eventChain (sorted-key JSON, `|`, prevHash folded last),
// so rows are verifiable by that package's `verifyChainRows` and a caller can
// mirror them into the real event_log without re-canonicalising. Parity is
// pinned by scripts/src/transferProofTest.ts.
//
// Pure: node:crypto only. No I/O, no clock (every timestamp is supplied), no
// randomness.

import { sharpe, skewness, kurtosis, meanCi95, mean } from "./stats.js";
import { deflatedSharpe } from "./deflatedSharpe.js";
import { estimatePbo } from "./pbo.js";
import { stableStringify, sha256Hex, type CostEvidence } from "./costModel.js";
import type { ArxAssetClass } from "@workspace/markets";

export const GENESIS_PREV_HASH = "0".repeat(64);

// ── Spec ─────────────────────────────────────────────────────────────────────

/** Inclusive ISO-date window (yyyy-mm-dd). Compared lexically — ISO sorts. */
export interface DateWindow {
  start: string;
  end: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validWindow(w: DateWindow): boolean {
  return ISO_DATE.test(w.start) && ISO_DATE.test(w.end) && w.start <= w.end;
}

/** Inclusive interval overlap — lexical compare is date compare for ISO. */
export function windowsOverlap(a: DateWindow, b: DateWindow): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** The pass bar, pre-registered as data so it cannot drift after the fact. */
export interface ExperimentPassBar {
  /** OOS net DSR > 0 at the 5% level ⇒ the DSR probability must be ≥ 0.95. */
  minNetDsr: number;
  /** PBO strictly below this. NaN (unmeasurable) FAILS the clause. */
  maxPbo: number;
  /** Net Sharpe over the OOS track must be ≥ this. */
  minNetSharpe: number;
  /** Shadow observations required before the shadow CI clause can pass. */
  minShadowObservations: number;
}

export interface ExperimentSpec {
  /** Stable human name of the experiment. */
  experimentKey: string;
  instrument: string;
  instrumentClass: ArxAssetClass;
  /** The deterministic calendar rule, named. Zero look-ahead by construction. */
  calendarRule: string;
  /** Trading days relative to the calendar anchor. */
  entryOffsetDays: number;
  exitOffsetDays: number;
  /** Pre-registered size (exposure units). */
  size: number;
  /** Parameters are FITTED here, then locked. */
  fitWindow: DateWindow;
  /** Evaluation data must live here and ONLY here. */
  holdoutWindow: DateWindow;
  passBar: ExperimentPassBar;
  /** Free-form pre-registered notes (hashed with everything else). */
  notes?: string;
}

/** The registration hash covers the spec ONLY — never a result. */
export function specHashOf(spec: ExperimentSpec): string {
  return sha256Hex(stableStringify(spec));
}

// ── Chain rows (structurally @workspace/features ChainRow) ───────────────────

export interface TransferChainRow {
  eventId: string;
  fields: Record<string, unknown>;
  prevHash: string | null;
  rowHash: string;
}

// ── Statuses and typed refusals ──────────────────────────────────────────────

export type ExperimentStatus =
  | "REGISTERED"
  | "BLOCKED_ON_DATA"
  | "EVALUATED"
  | "PASSED"
  | "RETIRED";

/** Typed reason an evaluation cannot honestly run. Never a silent skip. */
export interface BlockedReason {
  code: "DATA_NOT_PROVISIONED";
  /** What is missing, named. */
  missing: string;
  /** Who owns the unblock. Provisioning data is not this harness's call. */
  decisionOwner: "OWNER";
  detail: string;
}

export type TransferRefusal =
  | { refused: true; code: "NOT_REGISTERED"; detail: string }
  | { refused: true; code: "SPEC_HASH_MUTATED"; detail: string }
  | { refused: true; code: "FIT_WINDOW_OVERLAP"; detail: string }
  | { refused: true; code: "GROSS_ONLY"; detail: string }
  | { refused: true; code: "NO_RESPIN_ON_SAME_DATA"; detail: string }
  | { refused: true; code: "ALREADY_RETIRED"; detail: string }
  | { refused: true; code: "ALREADY_REGISTERED"; detail: string }
  | { refused: true; code: "BLOCKED_ON_DATA"; reason: BlockedReason; detail: string }
  | { refused: true; code: "INVALID_SPEC"; detail: string }
  | { refused: true; code: "INVALID_INPUT"; detail: string };

export function isRefusal(v: unknown): v is TransferRefusal {
  return typeof v === "object" && v !== null && (v as { refused?: unknown }).refused === true;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface TransferEvaluationInput {
  /** Supplied timestamp — the harness never reads a clock. */
  at: string;
  /** OOS returns ALREADY net of the cost model (costModel.netReturns). */
  netOosReturns: readonly number[];
  /** The cost evidence those returns were netted under. Required. */
  costs: CostEvidence;
  /** The window the OOS data actually spans. Checked against the fit window. */
  dataWindow: DateWindow;
  /** Content hash of the dataset evaluated — the no-respin key. */
  dataFingerprint: string;
  /** Multiplicity charged to the DSR (≥1; the experiment itself is a trial). */
  nTrials: number;
  /** Sharpe dispersion across the charged trials (0 for a single trial). */
  trialSharpeSd?: number;
  /**
   * The fit-stage selection field (per-variant return rows, this experiment's
   * variant included) for PBO. Absent ⇒ PBO is UNMEASURABLE ⇒ the PBO clause
   * FAILS — an unmeasurable overfitting probability is not a low one.
   */
  selectionField?: readonly (readonly number[])[];
  /** Even block count for PBO's CSCV. */
  pboBlocks?: number;
}

export interface ClauseResult {
  clause: "OOS_NET_DSR" | "PBO" | "NET_SHARPE" | "SHADOW_CI";
  pass: boolean;
  observed: number | null;
  bar: string;
  detail: string;
}

export interface TransferEvaluation {
  at: string;
  netSharpe: number;
  netDsr: number;
  pbo: number;
  nObs: number;
  dataWindow: DateWindow;
  dataFingerprint: string;
  costModelHash: string;
}

/** The FDR charge a MISS emits — structurally lib/discovery's FdrTest. */
export interface FdrChargeRecord {
  key: string;
  p: number;
}

export interface TransferVerdict {
  specHash: string;
  experimentKey: string;
  verdict: "PASS" | "MISS";
  clauses: ClauseResult[];
  /** Present on a MISS: the trial charge for the family's FDR accounting. */
  fdrCharge: FdrChargeRecord | null;
  detail: string;
}

export interface ExperimentRecord {
  spec: ExperimentSpec;
  specHash: string;
  status: ExperimentStatus;
  registeredAt: string;
  blocked: BlockedReason | null;
  evaluation: TransferEvaluation | null;
  shadowPnls: number[];
  verdict: TransferVerdict | null;
}

/**
 * One-sided p-value for a Sharpe under the no-edge null (mirrors
 * lib/discovery/fdr.ts sharpePValue — duplicated, not imported, because
 * validation and discovery are deliberately decoupled packages; the transfer
 * test pins the two functions to identical outputs).
 */
export function transferSharpePValue(observedSharpe: number, trackLength: number): number {
  if (!Number.isFinite(observedSharpe) || !(trackLength > 1)) return 1;
  const z = observedSharpe * Math.sqrt(trackLength);
  const sign = z < 0 ? -1 : 1;
  const q = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * q);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-q * q);
  return 1 - 0.5 * (1 + sign * y);
}

// ── The harness ──────────────────────────────────────────────────────────────

export class TransferProofHarness {
  private readonly records = new Map<string, ExperimentRecord>();
  /** `${specHash}|${dataFingerprint}` for every retirement — the no-respin memory. */
  private readonly retiredOnData = new Set<string>();
  /** Retired spec hashes (any data) — re-registration needs a new-data declaration. */
  private readonly retiredSpecs = new Map<string, string[]>();
  private readonly chainRows: TransferChainRow[] = [];
  private seq = 0;

  // Chain append uses the features-parity canonical form:
  // sha256(`${stableStringify(fields)}|${prevHash}`).
  private append(fields: Record<string, unknown>): TransferChainRow {
    const prevHash = this.chainRows.length === 0 ? null : this.chainRows[this.chainRows.length - 1]!.rowHash;
    const rowHash = sha256Hex(`${stableStringify(fields)}|${prevHash ?? GENESIS_PREV_HASH}`);
    const row: TransferChainRow = {
      eventId: `tp_${String(++this.seq).padStart(6, "0")}`,
      fields,
      prevHash,
      rowHash,
    };
    this.chainRows.push(row);
    return row;
  }

  /** The chain, oldest first — verifiable by @workspace/features verifyChainRows. */
  chain(): readonly TransferChainRow[] {
    return this.chainRows;
  }

  get(specHash: string): ExperimentRecord | null {
    return this.records.get(specHash) ?? null;
  }

  list(): ExperimentRecord[] {
    return [...this.records.values()];
  }

  /**
   * PRE-REGISTER an experiment. This is the only door in: evaluation without a
   * registration row that PRECEDES it in the chain is structurally impossible,
   * because evaluate() looks the registration up by spec hash and the chain
   * orders every row.
   *
   * A spec that was retired (any data) refuses re-registration unless the
   * caller declares the fingerprint of genuinely NEW data — and that declared
   * fingerprint must differ from every fingerprint the spec was retired on.
   */
  register(
    spec: ExperimentSpec,
    at: string,
    opts?: { newDataFingerprint?: string },
  ): { specHash: string; record: ExperimentRecord; chainRow: TransferChainRow } | TransferRefusal {
    if (!validWindow(spec.fitWindow) || !validWindow(spec.holdoutWindow)) {
      return { refused: true, code: "INVALID_SPEC", detail: "fit/holdout windows must be valid ISO date ranges" };
    }
    if (windowsOverlap(spec.fitWindow, spec.holdoutWindow)) {
      return {
        refused: true,
        code: "INVALID_SPEC",
        detail:
          `fit window ${spec.fitWindow.start}..${spec.fitWindow.end} overlaps holdout ` +
          `${spec.holdoutWindow.start}..${spec.holdoutWindow.end} — a holdout the fit can see is not held out`,
      };
    }
    if (!(spec.size > 0) || !Number.isFinite(spec.size)) {
      return { refused: true, code: "INVALID_SPEC", detail: `size must be a positive finite number (got ${spec.size})` };
    }
    const b = spec.passBar;
    if (!(b.minNetDsr > 0 && b.minNetDsr <= 1) || !(b.maxPbo > 0 && b.maxPbo < 1) ||
        !Number.isFinite(b.minNetSharpe) || !(Number.isInteger(b.minShadowObservations) && b.minShadowObservations > 0)) {
      return { refused: true, code: "INVALID_SPEC", detail: "pass bar is malformed — every clause must be a real, checkable bar" };
    }

    const specHash = specHashOf(spec);
    const existing = this.records.get(specHash);
    if (existing && existing.status !== "RETIRED") {
      return { refused: true, code: "ALREADY_REGISTERED", detail: `spec ${specHash.slice(0, 12)} is already registered` };
    }
    const retiredFps = this.retiredSpecs.get(specHash);
    if (retiredFps !== undefined) {
      const declared = opts?.newDataFingerprint;
      if (declared === undefined || declared.length === 0) {
        return {
          refused: true,
          code: "NO_RESPIN_ON_SAME_DATA",
          detail:
            `spec ${specHash.slice(0, 12)} was retired after a MISS; re-registration requires an explicit ` +
            "NEW-data fingerprint declaration — a retired hypothesis does not get another spin for free",
        };
      }
      if (retiredFps.includes(declared)) {
        return {
          refused: true,
          code: "NO_RESPIN_ON_SAME_DATA",
          detail: `declared fingerprint matches data this spec already MISSED on — that is the exact respin this harness exists to refuse`,
        };
      }
    }

    const record: ExperimentRecord = {
      spec,
      specHash,
      status: "REGISTERED",
      registeredAt: at,
      blocked: null,
      evaluation: null,
      shadowPnls: [],
      verdict: null,
    };
    this.records.set(specHash, record);
    const chainRow = this.append({ type: "PREREGISTRATION", specHash, spec: spec as unknown as Record<string, unknown>, at });
    return { specHash, record, chainRow };
  }

  /**
   * Record that an experiment's evaluation cannot run because its data is not
   * provisioned. Typed and chained — an honest BLOCKED is a real state, not a
   * silent absence of progress. Never a substitute is fabricated.
   */
  markBlockedOnData(specHash: string, reason: BlockedReason, at: string): ExperimentRecord | TransferRefusal {
    const rec = this.records.get(specHash);
    if (!rec) return { refused: true, code: "NOT_REGISTERED", detail: `no registration for ${specHash.slice(0, 12)}` };
    if (rec.status === "RETIRED" || rec.status === "PASSED") {
      return { refused: true, code: "ALREADY_RETIRED", detail: `experiment is terminal (${rec.status})` };
    }
    rec.status = "BLOCKED_ON_DATA";
    rec.blocked = reason;
    this.append({ type: "BLOCKED_ON_DATA", specHash, reason: reason as unknown as Record<string, unknown>, at });
    return rec;
  }

  /**
   * Evaluate the locked spec against out-of-sample, net-of-costs data.
   *
   * The caller re-presents the FULL spec: the harness recomputes its hash and
   * refuses on any difference from the locked registration. Passing only a
   * hash would let a mutated spec ride on its old hash.
   */
  evaluate(spec: ExperimentSpec, input: TransferEvaluationInput): ExperimentRecord | TransferRefusal {
    const presentedHash = specHashOf(spec);
    const rec = this.records.get(presentedHash);
    if (!rec) {
      // Either never registered, or registered under a DIFFERENT hash — i.e.
      // the spec mutated between lock and evaluation. Distinguish honestly.
      const sameKey = [...this.records.values()].find((r) => r.spec.experimentKey === spec.experimentKey);
      if (sameKey) {
        return {
          refused: true,
          code: "SPEC_HASH_MUTATED",
          detail:
            `experiment "${spec.experimentKey}" is locked as ${sameKey.specHash.slice(0, 12)} but the spec presented ` +
            `hashes to ${presentedHash.slice(0, 12)} — the spec changed after pre-registration, and a changed spec is a new, unregistered experiment`,
        };
      }
      return {
        refused: true,
        code: "NOT_REGISTERED",
        detail: `no pre-registered spec with hash ${presentedHash.slice(0, 12)} — evaluation refuses to run without a locked registration`,
      };
    }
    if (rec.status === "RETIRED" || rec.status === "PASSED") {
      return { refused: true, code: "ALREADY_RETIRED", detail: `experiment is terminal (${rec.status})` };
    }
    if (this.retiredOnData.has(`${presentedHash}|${input.dataFingerprint}`)) {
      return {
        refused: true,
        code: "NO_RESPIN_ON_SAME_DATA",
        detail: "this spec already MISSED on this exact data — re-evaluation is the respin the harness refuses",
      };
    }
    if (!validWindow(input.dataWindow)) {
      return { refused: true, code: "INVALID_INPUT", detail: "evaluation data window is not a valid ISO date range" };
    }
    // Fit/lock/OOS discipline: data touching the fit window proves nothing.
    if (windowsOverlap(input.dataWindow, rec.spec.fitWindow)) {
      return {
        refused: true,
        code: "FIT_WINDOW_OVERLAP",
        detail:
          `evaluation data ${input.dataWindow.start}..${input.dataWindow.end} overlaps the fit window ` +
          `${rec.spec.fitWindow.start}..${rec.spec.fitWindow.end} — data the parameters were fitted on cannot also prove them`,
      };
    }
    // Net-of-costs discipline: gross evaluation is refused, not discounted.
    if (input.costs.applied !== true || !(input.costs.perSideCostFrac > 0) || !/^[0-9a-f]{64}$/.test(input.costs.modelHash)) {
      return {
        refused: true,
        code: "GROSS_ONLY",
        detail: "evaluation requires CostSlippageModel evidence with a nonzero per-side cost — the pass bar is NET",
      };
    }
    const rets = input.netOosReturns;
    if (rets.length < 2 || rets.some((r) => !Number.isFinite(r))) {
      return { refused: true, code: "INVALID_INPUT", detail: "net OOS returns must be ≥2 finite observations" };
    }
    if (!(Number.isInteger(input.nTrials) && input.nTrials >= 1)) {
      return { refused: true, code: "INVALID_INPUT", detail: `nTrials must be a positive integer (got ${input.nTrials})` };
    }
    if (input.dataFingerprint.length === 0) {
      return { refused: true, code: "INVALID_INPUT", detail: "dataFingerprint is required — the no-respin rule needs an identity for the data" };
    }

    const netSharpe = sharpe(rets);
    const dsrRes = deflatedSharpe({
      observedSharpe: netSharpe,
      trackLength: rets.length,
      skew: skewness(rets),
      kurtosis: kurtosis(rets),
      nTrials: input.nTrials,
      trialSharpeSd: input.trialSharpeSd ?? 0,
    });
    const pboRes = input.selectionField
      ? estimatePbo(input.selectionField, input.pboBlocks ?? 10)
      : null;

    rec.evaluation = {
      at: input.at,
      netSharpe,
      netDsr: dsrRes.dsr,
      pbo: pboRes ? pboRes.pbo : NaN,
      nObs: rets.length,
      dataWindow: input.dataWindow,
      dataFingerprint: input.dataFingerprint,
      costModelHash: input.costs.modelHash,
    };
    rec.status = "EVALUATED";
    rec.blocked = null;
    this.append({
      type: "EVALUATION",
      specHash: presentedHash,
      at: input.at,
      netSharpe,
      netDsr: dsrRes.dsr,
      pbo: rec.evaluation.pbo,
      nObs: rets.length,
      dataWindow: input.dataWindow as unknown as Record<string, unknown>,
      dataFingerprint: input.dataFingerprint,
      costModelHash: input.costs.modelHash,
    });
    return rec;
  }

  /** Accrue one live-shadow P&L observation for a registered experiment. */
  recordShadowPnl(specHash: string, pnl: number, at: string): ExperimentRecord | TransferRefusal {
    const rec = this.records.get(specHash);
    if (!rec) return { refused: true, code: "NOT_REGISTERED", detail: `no registration for ${specHash.slice(0, 12)}` };
    if (rec.status === "RETIRED") {
      return { refused: true, code: "ALREADY_RETIRED", detail: "a retired experiment accrues nothing" };
    }
    if (!Number.isFinite(pnl)) {
      return { refused: true, code: "INVALID_INPUT", detail: "shadow P&L must be finite — a NaN observation is a failed read, not evidence" };
    }
    rec.shadowPnls.push(pnl);
    this.append({ type: "SHADOW_PNL", specHash, pnl, n: rec.shadowPnls.length, at });
    return rec;
  }

  /**
   * The verdict: PASS only when EVERY pre-registered clause passes.
   * Anything else is a MISS — the experiment retires, an FDR charge is
   * emitted, and the same spec can never be re-run on the same data.
   */
  verdict(specHash: string, at: string): TransferVerdict | TransferRefusal {
    const rec = this.records.get(specHash);
    if (!rec) return { refused: true, code: "NOT_REGISTERED", detail: `no registration for ${specHash.slice(0, 12)}` };
    if (rec.verdict) return rec.verdict; // terminal — a verdict does not restate
    if (rec.status === "BLOCKED_ON_DATA" && rec.blocked) {
      return {
        refused: true,
        code: "BLOCKED_ON_DATA",
        reason: rec.blocked,
        detail: `no verdict without an evaluation: ${rec.blocked.missing} (unblock is an ${rec.blocked.decisionOwner} decision)`,
      };
    }
    if (!rec.evaluation) {
      return { refused: true, code: "INVALID_INPUT", detail: "no evaluation has run — a verdict without evidence is a story" };
    }

    const bar = rec.spec.passBar;
    const ev = rec.evaluation;
    const shadow = rec.shadowPnls;
    const ci = meanCi95(shadow);
    const shadowMean = shadow.length > 0 ? mean(shadow) : NaN;

    const clauses: ClauseResult[] = [
      {
        clause: "OOS_NET_DSR",
        pass: ev.netDsr >= bar.minNetDsr,
        observed: ev.netDsr,
        bar: `≥ ${bar.minNetDsr}`,
        detail: `net DSR ${ev.netDsr.toFixed(4)} over ${ev.nObs} OOS obs`,
      },
      {
        // NaN (unmeasurable) fails: !(NaN < x) is true.
        clause: "PBO",
        pass: ev.pbo < bar.maxPbo,
        observed: Number.isFinite(ev.pbo) ? ev.pbo : null,
        bar: `< ${bar.maxPbo}`,
        detail: Number.isFinite(ev.pbo)
          ? `PBO ${ev.pbo.toFixed(4)}`
          : "PBO UNMEASURABLE (no selection field supplied) — an unmeasurable overfitting probability is not a low one",
      },
      {
        clause: "NET_SHARPE",
        pass: ev.netSharpe >= bar.minNetSharpe,
        observed: ev.netSharpe,
        bar: `≥ ${bar.minNetSharpe}`,
        detail: `net Sharpe ${ev.netSharpe.toFixed(4)}`,
      },
      {
        clause: "SHADOW_CI",
        pass:
          shadow.length >= bar.minShadowObservations && ci.excludesZero && shadowMean > 0,
        observed: shadow.length > 0 ? shadowMean : null,
        bar: `n ≥ ${bar.minShadowObservations}, 95% CI excludes 0, mean > 0`,
        detail:
          shadow.length < bar.minShadowObservations
            ? `only ${shadow.length}/${bar.minShadowObservations} shadow observations`
            : `n=${shadow.length}, mean ${shadowMean.toExponential(3)}, CI [${ci.lo.toExponential(3)}, ${ci.hi.toExponential(3)}]`,
      },
    ];

    const allPass = clauses.every((c) => c.pass);
    let fdrCharge: FdrChargeRecord | null = null;
    if (allPass) {
      rec.status = "PASSED";
    } else {
      // MISS: retire, charge the FDR family, remember the data forever. The
      // record stays in the map with a terminal status — retirement is a
      // visible state, not an erasure.
      rec.status = "RETIRED";
      this.retiredOnData.add(`${specHash}|${ev.dataFingerprint}`);
      const fps = this.retiredSpecs.get(specHash) ?? [];
      fps.push(ev.dataFingerprint);
      this.retiredSpecs.set(specHash, fps);
      fdrCharge = {
        key: `${rec.spec.experimentKey}:${specHash.slice(0, 12)}`,
        p: transferSharpePValue(ev.netSharpe, ev.nObs),
      };
    }

    const verdict: TransferVerdict = {
      specHash,
      experimentKey: rec.spec.experimentKey,
      verdict: allPass ? "PASS" : "MISS",
      clauses,
      fdrCharge,
      detail: allPass
        ? "every pre-registered clause passed"
        : `MISS: ${clauses.filter((c) => !c.pass).map((c) => c.clause).join(", ")} failed — experiment retired, FDR charged, no respin on this data`,
    };
    rec.verdict = verdict;
    this.append({
      type: "VERDICT",
      specHash,
      at,
      verdict: verdict.verdict,
      clauses: clauses.map((c) => ({ clause: c.clause, pass: c.pass })) as unknown as Record<string, unknown>,
      fdrCharge: fdrCharge as unknown as Record<string, unknown> | null,
    });
    return verdict;
  }
}

// ── THE experiment (registered, never fabricated) ────────────────────────────

/**
 * C8's pre-registered turn-of-month equity-index drift experiment, exactly as
 * the master plan states it: long from the close of T−1 to the close of T+3
 * around each month boundary; entry/exit offsets and size fitted 2005–2015
 * then LOCKED; 2016–2025 held out; pass bar in NET terms.
 *
 * Its evaluation is BLOCKED_ON_DATA and stays that way until equity-index
 * daily closes are provisioned — an owner decision. NOTHING in this repo may
 * substitute synthetic data for this experiment: the null oracle's synthetics
 * exist to calibrate the factory, and by construction they contain no
 * turn-of-month effect to find. A synthetic "evaluation" here would be the
 * exact self-deception this harness exists to make impossible.
 */
export const TURN_OF_MONTH_SPEC: ExperimentSpec = {
  experimentKey: "TURN_OF_MONTH_EQUITY_INDEX_DRIFT_V1",
  instrument: "ES",
  instrumentClass: "index",
  calendarRule: "MONTH_BOUNDARY: enter at close of trading day T-1, exit at close of trading day T+3",
  entryOffsetDays: -1,
  exitOffsetDays: 3,
  size: 1,
  fitWindow: { start: "2005-01-01", end: "2015-12-31" },
  holdoutWindow: { start: "2016-01-01", end: "2025-12-31" },
  passBar: {
    minNetDsr: 0.95, // "OOS net DSR > 0 at 5%" — the DSR probability must reach 0.95
    maxPbo: 0.2,
    minNetSharpe: 0.5,
    minShadowObservations: 6, // ≥6 month-boundary shadow observations before the CI clause can speak
  },
  notes:
    "Instrument is ES future or an equivalent index ETF — the final venue instrument is an owner " +
    "decision; both satisfy the pre-registered latency-insensitive close-to-close requirement. " +
    "Documented forced-flow cause: pension/fund month-boundary reinvestment.",
};

export const TURN_OF_MONTH_BLOCKED_REASON: BlockedReason = {
  code: "DATA_NOT_PROVISIONED",
  missing: "equity-index daily closes, 2005-01-01..2025-12-31 (fit + holdout), venue-evidenced",
  decisionOwner: "OWNER",
  detail:
    "No equity-index daily-close dataset is provisioned in this repository, and choosing/paying for " +
    "one is an owner decision. Evaluation stays honestly blocked; synthetic data is NEVER substituted.",
};

/**
 * Register the turn-of-month experiment and mark it blocked on data, in one
 * step. Returns the registration record; refuses (typed) if already present.
 */
export function registerTurnOfMonthExperiment(
  harness: TransferProofHarness,
  at: string,
): { specHash: string; record: ExperimentRecord } | TransferRefusal {
  const reg = harness.register(TURN_OF_MONTH_SPEC, at);
  if (isRefusal(reg)) return reg;
  const blocked = harness.markBlockedOnData(reg.specHash, TURN_OF_MONTH_BLOCKED_REASON, at);
  if (isRefusal(blocked)) return blocked;
  return { specHash: reg.specHash, record: blocked };
}
