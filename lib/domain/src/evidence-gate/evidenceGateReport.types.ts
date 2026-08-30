// ── The shared shape of an EVIDENCE-GATED FLAG report ────────────────────────
//
// Two flags in this system are held OFF not because code is missing but
// because nobody can SEE whether the arming bar is met:
//
//   * ARX_CONFORMAL_GATE_ENABLED   (capability #4  — conformal authority)
//   * execution-policy promotion   (capability #27 — the shadow chooser)
//
// This module is the vocabulary both reports speak, so the owner reads the
// same five facts in the same order for either flag: how much evidence there
// is, over what window, what it measures, whether the bar is met, and what
// the single remaining press would change.
//
// HONESTY CONTRACT (the whole point — a report that lies is worse than none):
//
//   1. A ZERO SAMPLE IS NOT A PASSING MEASUREMENT. `INSUFFICIENT_HISTORY` is
//      the correct verdict below the bar and is the expected answer today.
//      No measurement may render as a confident number when it was not
//      measured: every `EvidenceMeasurement.value` is `number | null`, and
//      `null` always carries a `note` saying why.
//   2. AN UNREADABLE SOURCE IS NOT AN EMPTY SOURCE. A failed read is
//      `SOURCE_UNREADABLE` with `sampleSize: null` — never `0`, which would
//      read as "we looked and there was nothing".
//   3. `barMet` IS TRUE ONLY FOR `BAR_MET`. `buildEvidenceGateReport` derives
//      it from the verdict; no caller can hand-set a met flag.
//   4. A REPORT NEVER ARMS ANYTHING. These are plain data structures. No
//      field of this type is read by any authority path, and no function in
//      this module or its consumers writes a flag, a status row, or an env
//      var. The press stays the owner's.
//   5. A FEED WITH NO WRITER IS SAID OUT LOUD. `EvidenceFeedStatus.writerWired
//      = false` distinguishes "the system has been running and has not
//      accumulated enough yet" from "nothing in production ever writes this
//      feed, so it will never accumulate on its own" — a distinction an
//      owner staring at `0` cannot otherwise make.
//
// Pure: no IO, no clock (the caller supplies `nowIso`), no randomness.

/** The four honest answers. There is no fifth, and no "probably". */
export const EVIDENCE_GATE_VERDICTS = [
  /** Not enough evidence to judge the bar. Zero sample lands here. */
  "INSUFFICIENT_HISTORY",
  /** Enough evidence to judge, and the measurement does NOT clear the bar. */
  "BAR_NOT_MET",
  /** Enough evidence to judge, and the measurement clears the bar. */
  "BAR_MET",
  /** The evidence source could not be read. Not the same as empty. */
  "SOURCE_UNREADABLE",
] as const;

export type EvidenceGateVerdict = (typeof EVIDENCE_GATE_VERDICTS)[number];

export function isEvidenceGateVerdict(v: string): v is EvidenceGateVerdict {
  return (EVIDENCE_GATE_VERDICTS as readonly string[]).includes(v);
}

/** Where the evidence came from, and whether anything actually writes it. */
export interface EvidenceFeedStatus {
  /** Human name of the feed, e.g. an audit event type. */
  feedId: string;
  /**
   * Is there a PRODUCTION call site that appends to this feed? When false the
   * sample can never grow on its own, and `0` means "no writer", not "quiet
   * week". This is a static, source-pinned fact — a test greps for the caller
   * and fails red if one appears — never a runtime guess.
   */
  writerWired: boolean;
  /** What wires (or fails to wire) the writer, in one sentence. */
  writerNote: string;
  /** Rows actually read. `null` ONLY when the read failed — never for empty. */
  rowsRead: number | null;
  /** Rows read but not honestly interpretable; excluded, never guessed at. */
  unreadableRows: number;
  /** Populated only when the read failed. */
  sourceError: string | null;
}

/** The chronological span the evidence covers. `null` when there is none. */
export interface EvidenceWindow {
  fromIso: string;
  toIso: string;
  spanDays: number;
}

/** One named number the report claims, or an honest null with the reason. */
export interface EvidenceMeasurement {
  key: string;
  label: string;
  /** `null` = NOT MEASURED. Never substitute a plausible-looking zero. */
  value: number | null;
  unit: "ratio" | "count" | "percent" | "days";
  /** The bar this measurement is judged against, in words. */
  target: string;
  /** `null` = unmeasurable, which is never "met". */
  met: boolean | null;
  note: string;
}

/** The single owner press this report exists to inform — never taken here. */
export interface OwnerPressDescriptor {
  /** What the press is, named exactly (env var, endpoint, button). */
  label: string;
  /** The exact steps, in order. */
  steps: string[];
  /** True only when the bar is met. A report never makes a press available. */
  available: boolean;
  /** Why it is not available, when it is not. */
  unavailableReason: string | null;
  /**
   * What pressing would ACTUALLY change — including "nothing, today". A press
   * whose effect is a no-op must say so here rather than be sold as safety.
   */
  whatItChanges: string[];
}

export interface EvidenceGateReport {
  /** Stable id, e.g. "conformal-authority" / "execution-policy-promotion". */
  gateId: string;
  title: string;
  verdict: EvidenceGateVerdict;
  verdictReason: string;
  /** Derived from `verdict` — true ONLY for BAR_MET. Never hand-set. */
  barMet: boolean;
  bar: {
    /** The arming bar in one sentence. */
    description: string;
    /** The sample size the bar requires. */
    requiredSampleSize: number;
  };
  /** The sample the verdict was judged on. `null` = unreadable, not empty. */
  sampleSize: number | null;
  window: EvidenceWindow | null;
  feed: EvidenceFeedStatus;
  measurements: EvidenceMeasurement[];
  ownerPress: OwnerPressDescriptor;
  generatedAtIso: string;
  /** Hard-stamped: reading this report changes nothing, anywhere. */
  readOnly: true;
}

export interface BuildEvidenceGateReportInput {
  gateId: string;
  title: string;
  verdict: EvidenceGateVerdict;
  verdictReason: string;
  bar: { description: string; requiredSampleSize: number };
  sampleSize: number | null;
  window: EvidenceWindow | null;
  feed: EvidenceFeedStatus;
  measurements: EvidenceMeasurement[];
  ownerPress: Omit<OwnerPressDescriptor, "available"> & { available?: boolean };
  generatedAtIso: string;
}

/**
 * The ONLY constructor. It derives `barMet` from the verdict and refuses to
 * let a caller mark a press available under any verdict but `BAR_MET` — so a
 * bug in one report cannot present an unmet bar as pressable.
 */
export function buildEvidenceGateReport(
  input: BuildEvidenceGateReportInput,
): EvidenceGateReport {
  const barMet = input.verdict === "BAR_MET";
  const requestedAvailable = input.ownerPress.available ?? barMet;
  const available = barMet && requestedAvailable;
  return {
    gateId: input.gateId,
    title: input.title,
    verdict: input.verdict,
    verdictReason: input.verdictReason,
    barMet,
    bar: input.bar,
    sampleSize: input.sampleSize,
    window: input.window,
    feed: input.feed,
    measurements: input.measurements,
    ownerPress: {
      label: input.ownerPress.label,
      steps: input.ownerPress.steps,
      available,
      unavailableReason: available
        ? null
        : (input.ownerPress.unavailableReason ??
          `the arming bar is not met (verdict ${input.verdict}) — the press stays closed`),
      whatItChanges: input.ownerPress.whatItChanges,
    },
    generatedAtIso: input.generatedAtIso,
    readOnly: true,
  };
}

/** Chronological window from sorted-ascending epoch-ms stamps. */
export function windowFromStamps(stampsMs: readonly number[]): EvidenceWindow | null {
  const finite = stampsMs.filter((n) => Number.isFinite(n));
  if (finite.length === 0) return null;
  let min = finite[0]!;
  let max = finite[0]!;
  for (const n of finite) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return {
    fromIso: new Date(min).toISOString(),
    toIso: new Date(max).toISOString(),
    spanDays: Math.round(((max - min) / 86_400_000) * 100) / 100,
  };
}
