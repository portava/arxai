// 8c — DiscoveryPipeline: pre-registered hypothesis → inert edge candidate.
//
// THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY
// ----------------------------------------------
//   1. PRE-REGISTER. The hypothesis, its parameters and its horizon are hashed
//      and stamped with a monotonic transaction id BEFORE any metric exists. A
//      hypothesis invented after its results therefore carries a higher
//      `createdTx` than the trials that supposedly tested it — a contradiction
//      visible in the data, not a matter of trust.
//   2. VALIDATE. CPCV + Deflated Sharpe + PBO, through a local `ValidationPort`
//      so this package typechecks and commits independently of Phase 7's merge
//      order.
//   3. FDR-CERTIFY across the WHOLE family, niche-selection trials charged
//      exactly like parameter trials.
//   4. SHADOW at a nonzero, UNRISKED, logged-only size.
//   5. EMIT a candidate — and nothing else.
//
// THE KELLY-CAP-VS-SHADOW TRAP
// ----------------------------
// `@workspace/risk` sizes an unproven edge at EXACTLY zero, which is correct for
// live capital and fatal for discovery: an edge sized at zero accrues no
// evidence, so it can never earn the shadow record that would prove it, so it
// stays unproven forever. The escape is that shadow size is a DIFFERENT number
// from live size — nonzero, unrisked, logged only. It is passed in as an
// injected value precisely so this package never imports `lib/risk` and the two
// numbers can never be confused for one another.
//
// ONLY DETERMINISTIC CODE EMITS CANDIDATES
// ----------------------------------------
// There is no path from a model output to a verdict here. The verdict is a pure
// function of pre-registered inputs and measured statistics, and the terminal
// artefact is a CANDIDATE at the DATA/WALK_FORWARD stage with liveAllowed=false,
// shadowValidated=false, adminApproved=false. Nothing in this file can set any
// of those; reaching live still requires the existing human SHADOW and ADMIN
// stages, which are out of scope.
//
// Pure: `node:crypto` for the pre-registration hash, and nothing else. No DB, no
// clock (every timestamp is supplied), no randomness, nothing on the order path.

import { createHash } from "node:crypto";
import { controlFdr, sharpePValue, type FdrResult } from "./fdr.js";

/** Sorted-key JSON, so the pre-registration hash is order-independent. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return '"__undefined__"';
  if (v === null) return "null";
  if (typeof v === "number" && !Number.isFinite(v)) return `"__${String(v)}__"`;
  // A bigint has NO JSON form: JSON.stringify(1n) THROWS. Since @workspace/money
  // represents every amount as bigint minor units, an amount reaching this
  // hasher would have crashed the caller. Matches lib/features/eventChain's
  // canonicalization exactly, so hashes stay comparable across packages.
  // Strictly additive: every value that hashed before hashes identically.
  if (typeof v === "bigint") return `"${v.toString()}n"`;
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export interface HypothesisSpec {
  familyKey: string;
  instrument: string;
  /** The rule being tested, named. */
  rule: string;
  params: Record<string, number | string>;
  /** Label window in bars. Pre-registered so it cannot be tuned afterwards. */
  horizon: number;
  /** The metric that will decide it, named in advance. */
  metric: string;
}

export interface PreRegistration {
  spec: HypothesisSpec;
  preregHash: string;
}

/**
 * Hash a hypothesis for pre-registration.
 *
 * The hash covers the spec ONLY — never a result — so it can be computed and
 * recorded before any test is run. Two specs differing in any parameter, the
 * horizon, or the metric hash differently, which is what stops "we always meant
 * the 20-bar horizon" after the 20-bar horizon turns out to work.
 */
export function preRegister(spec: HypothesisSpec): PreRegistration {
  return {
    spec,
    preregHash: createHash("sha256").update(stableStringify(spec), "utf8").digest("hex"),
  };
}

/** One trial's measured outcome. */
export interface TrialOutcome {
  key: string;
  /** True when this trial was a choice of WHERE to look rather than a parameter. */
  isNicheSelection: boolean;
  params: Record<string, number | string>;
  /** Out-of-sample returns from purged combinatorial CV. */
  oosReturns: number[];
}

/** What the pipeline needs from Phase 7, expressed locally. */
export interface ValidationPort {
  /**
   * Validate a family of trials. Must apply CPCV + Deflated Sharpe + PBO and
   * charge the multiple-testing correction for `chargedTrials`.
   */
  validateFamily(
    familyKey: string,
    trials: ReadonlyArray<{ key: string; familyKey: string; returns: number[] }>,
    chargedTrials: number,
  ): {
    candidates: Array<{
      key: string;
      verdict: "PASS" | "REJECT";
      oosSharpe: number;
      dsr: number;
      pbo: number;
      vetoes: string[];
    }>;
    reportHash: string;
  };
}

/**
 * A minimal, deliberately CONSERVATIVE fallback port.
 *
 * Used only when Phase 7's factory is not wired in. It rejects everything, so a
 * missing validator can never be mistaken for a passing one — the failure mode
 * of a permissive stub is a candidate certified by nothing at all.
 */
export const REFUSING_VALIDATION_PORT: ValidationPort = {
  validateFamily(_familyKey, trials) {
    return {
      candidates: trials.map((t) => ({
        key: t.key,
        verdict: "REJECT" as const,
        oosSharpe: 0,
        dsr: 0,
        pbo: NaN,
        vetoes: ["NO_VALIDATOR_WIRED: refusing rather than certifying unvalidated"],
      })),
      reportHash: "0".repeat(64),
    };
  },
};

export interface EdgeCandidate {
  key: string;
  familyKey: string;
  preregHash: string;
  verdict: "PASS" | "REJECT";
  oosSharpe: number;
  dsr: number;
  pbo: number;
  pValue: number;
  fdrRejected: boolean;
  vetoes: string[];
  /** Nonzero for a PASS, so the candidate can actually accrue shadow evidence. */
  shadowSize: number;
  /** The inert registry row this candidate would write. */
  modelVersion: InertModelVersion;
}

/**
 * The registry row a candidate writes. Every gate is FALSE, by construction.
 *
 * The three booleans are the existing registry's own gates. They are not
 * weakened, bypassed, or set here; they are written false and left for the human
 * SHADOW and ADMIN stages that already exist.
 */
export interface InertModelVersion {
  versionId: string;
  changeType: string;
  changeSummary: string;
  dataValidated: boolean;
  walkForwardPassed: boolean;
  shadowValidated: false;
  adminApproved: false;
  liveAllowed: false;
}

export interface DiscoveryResult {
  preregHash: string;
  familyKey: string;
  /** m — the FULL family size, niche-selection trials INCLUDED. */
  familySize: number;
  fdr: FdrResult;
  candidates: EdgeCandidate[];
  passes: EdgeCandidate[];
  validationReportHash: string;
  detail: string;
}

export interface RunDiscoveryOptions {
  spec: HypothesisSpec;
  trials: readonly TrialOutcome[];
  validation: ValidationPort;
  /** Family-wide false-discovery rate. */
  q: number;
  /**
   * The nonzero, UNRISKED, logged-only shadow size a PASS accrues evidence at.
   * Injected, never derived from `lib/risk`: shadow size and live size are
   * different numbers and must never be confused.
   */
  shadowSize: number;
  /** Supplied by the caller — this package never reads a clock. */
  runId: string;
}

/**
 * Run the pipeline. Deterministic: the same inputs give the same candidates and
 * the same hashes.
 */
export function runDiscovery(opts: RunDiscoveryOptions): DiscoveryResult {
  const { spec, trials, validation, q, shadowSize, runId } = opts;

  if (!(shadowSize > 0)) {
    // A zero shadow size is the Kelly-cap trap: an edge that cannot accrue
    // evidence can never earn promotion, so the pipeline would be a machine that
    // rejects everything forever while appearing to work.
    throw new Error(
      `runDiscovery: shadowSize must be > 0 (got ${shadowSize}) — an edge sized at zero ` +
        "accrues no shadow evidence and can never earn promotion",
    );
  }

  const { preregHash } = preRegister(spec);

  // m includes EVERY trial. Niche-selection trials are charged exactly like
  // parameter trials, because choosing where to look is itself multiplicity.
  const familySize = trials.length;

  const validated = validation.validateFamily(
    spec.familyKey,
    trials.map((t) => ({ key: t.key, familyKey: spec.familyKey, returns: t.oosReturns })),
    familySize,
  );
  const byKey = new Map(validated.candidates.map((c) => [c.key, c]));

  // FDR over the whole family, using each trial's own p-value.
  const pTests = trials.map((t) => {
    const v = byKey.get(t.key);
    return {
      key: t.key,
      p: v ? sharpePValue(v.oosSharpe, t.oosReturns.length) : 1,
    };
  });
  const fdr = controlFdr(pTests, q, familySize);
  const fdrRejectedKeys = new Set(fdr.decisions.filter((d) => d.rejected).map((d) => d.key));

  const candidates: EdgeCandidate[] = trials.map((t) => {
    const v = byKey.get(t.key);
    const vetoes = [...(v?.vetoes ?? ["NO_VALIDATION_RESULT"])];
    const fdrRejected = fdrRejectedKeys.has(t.key);

    // The FDR certificate is an ADDITIONAL veto, ANDed with the factory's.
    // A trial can clear DSR and PBO on its own and still fail here because of
    // how many other trials were run — which is the point of family control.
    if (!fdrRejected) {
      vetoes.push(`FDR_NOT_CERTIFIED (family q=${q}, m=${familySize})`);
    }

    const verdict: "PASS" | "REJECT" =
      v?.verdict === "PASS" && fdrRejected && vetoes.length === 0 ? "PASS" : "REJECT";

    return {
      key: t.key,
      familyKey: spec.familyKey,
      preregHash,
      verdict,
      oosSharpe: v?.oosSharpe ?? 0,
      dsr: v?.dsr ?? 0,
      pbo: v?.pbo ?? NaN,
      pValue: pTests.find((p) => p.key === t.key)?.p ?? 1,
      fdrRejected,
      vetoes,
      // Only a PASS gets a nonzero shadow size — a REJECT accrues nothing.
      shadowSize: verdict === "PASS" ? shadowSize : 0,
      modelVersion: {
        versionId: `disc_${runId}_${t.key}`,
        changeType: "global_signal_edges",
        changeSummary:
          `Discovery candidate from pre-registered hypothesis ${preregHash.slice(0, 12)} ` +
          `(${spec.rule} on ${spec.instrument}, horizon ${spec.horizon}). ` +
          "INERT: DATA/WALK_FORWARD stage only.",
        dataValidated: verdict === "PASS",
        walkForwardPassed: verdict === "PASS",
        // Not negotiable, and not reachable from here.
        shadowValidated: false,
        adminApproved: false,
        liveAllowed: false,
      },
    };
  });

  const passes = candidates.filter((c) => c.verdict === "PASS");

  return {
    preregHash,
    familyKey: spec.familyKey,
    familySize,
    fdr,
    candidates,
    passes,
    validationReportHash: validated.reportHash,
    detail:
      `${passes.length}/${candidates.length} candidates PASSED. ${fdr.detail}. ` +
      `Shadow size ${shadowSize} (unrisked, logged only). ` +
      "All emitted registry rows are liveAllowed=false.",
  };
}

/** Count the niche-selection trials in a family — the multiplicity usually missed. */
export function nicheSelectionCount(trials: readonly TrialOutcome[]): number {
  return trials.filter((t) => t.isNicheSelection).length;
}
