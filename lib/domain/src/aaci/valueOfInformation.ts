// ── AACI Value-of-Information (WAIT_FOR_EVIDENCE) — pure ────────────────────
//
// For WAIT-capable decisions: is one more bar of waiting worth it?
//
//   expected uncertainty reduction  =  Σ_channel weight × penalty × P(resolve)
//   entry-decay cost of waiting     =  1 − e^(−waitMs / halfLife)
//
// P(resolve) — the probability that waiting one observation interval resolves
// a given uncertainty channel — is estimated from RECORDED history: pairs of
// consecutive channel observations for the same context. When that history
// does not exist (or is too thin), the advisory is an honest
// INSUFFICIENT_HISTORY — NEVER a made-up rate.
//
// ADVISORY / JOURNAL-ONLY. The output is numbers plus a label; it never gates,
// never routes, never changes a recommended action. Pure: no IO, no clocks.

import {
  AACI_UNCERTAINTY_CHANNEL_WEIGHTS,
  type AaciUncertaintyChannelName,
  type AaciUncertaintyChannels,
} from "./uncertainty";

/** One recorded before/after observation of a channel's penalty for the same
 *  context (same symbol/scope), one observation interval apart. */
export interface AaciChannelResolutionPair {
  channel: AaciUncertaintyChannelName;
  penaltyBefore: number;
  penaltyAfter: number;
}

export type AaciChannelResolutionRate =
  | { status: "OK"; rate: number; samples: number }
  | { status: "INSUFFICIENT_HISTORY"; samples: number };

export type AaciChannelResolutionRates = Record<
  AaciUncertaintyChannelName,
  AaciChannelResolutionRate
>;

export interface EstimateResolutionRatesOptions {
  /** A pair only counts as an attempt when penaltyBefore ≥ this. */
  minPenaltyConsidered?: number; // default 0.05
  /** Resolution = penalty dropped by at least this much. */
  resolveDelta?: number; // default 0.1
  /** Minimum attempts before a rate is honest enough to use. */
  minSamplesPerChannel?: number; // default 20
}

export const VOI_DEFAULT_MIN_PENALTY = 0.05;
export const VOI_DEFAULT_RESOLVE_DELTA = 0.1;
export const VOI_DEFAULT_MIN_SAMPLES = 20;

const CHANNEL_NAMES = Object.keys(
  AACI_UNCERTAINTY_CHANNEL_WEIGHTS,
) as AaciUncertaintyChannelName[];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Per-channel historical resolution rates from recorded observation pairs.
 * A channel with fewer than minSamplesPerChannel qualifying attempts reports
 * INSUFFICIENT_HISTORY — the caller must not substitute any number for it.
 */
export function estimateChannelResolutionRates(
  pairs: AaciChannelResolutionPair[],
  opts: EstimateResolutionRatesOptions = {},
): AaciChannelResolutionRates {
  const minPenalty = opts.minPenaltyConsidered ?? VOI_DEFAULT_MIN_PENALTY;
  const resolveDelta = opts.resolveDelta ?? VOI_DEFAULT_RESOLVE_DELTA;
  const minSamples = opts.minSamplesPerChannel ?? VOI_DEFAULT_MIN_SAMPLES;

  const attempts = new Map<AaciUncertaintyChannelName, { n: number; resolved: number }>();
  for (const name of CHANNEL_NAMES) attempts.set(name, { n: 0, resolved: 0 });

  for (const p of pairs) {
    const slot = attempts.get(p.channel);
    if (!slot) continue;
    const before = clamp01(p.penaltyBefore);
    const after = clamp01(p.penaltyAfter);
    if (before < minPenalty) continue; // nothing to resolve
    slot.n += 1;
    if (before - after >= resolveDelta) slot.resolved += 1;
  }

  const out = {} as AaciChannelResolutionRates;
  for (const name of CHANNEL_NAMES) {
    const slot = attempts.get(name)!;
    out[name] =
      slot.n >= minSamples
        ? { status: "OK", rate: slot.resolved / slot.n, samples: slot.n }
        : { status: "INSUFFICIENT_HISTORY", samples: slot.n };
  }
  return out;
}

export interface WaitAdvisoryInput {
  /** Current per-channel uncertainty penalties (0..1 each). */
  channels: AaciUncertaintyChannels;
  /** Historical resolution rates (from estimateChannelResolutionRates). */
  resolutionRates: AaciChannelResolutionRates;
  /** Edge half-life of the strategy (ms) — the measured entry-decay clock. */
  halfLifeMs: number;
  /** How long one more bar/tick of waiting is (ms). */
  waitMs: number;
  /** Channels below this penalty are ignored (nothing worth resolving). */
  minPenaltyConsidered?: number; // default 0.05
}

export interface WaitAdvisoryChannelDetail {
  channel: AaciUncertaintyChannelName;
  penalty: number;
  weight: number;
  resolutionRate: number | null; // null when INSUFFICIENT_HISTORY
  samples: number;
  /** weight × penalty × rate (0 when rate unknown). */
  expectedReduction: number;
}

export type AaciWaitAdvisory =
  | {
      status: "INSUFFICIENT_HISTORY";
      advisory: "NONE";
      insufficientChannels: AaciUncertaintyChannelName[];
      entryDecayCost: number;
      waitMs: number;
      halfLifeMs: number;
      perChannel: WaitAdvisoryChannelDetail[];
    }
  | {
      status: "OK";
      advisory: "WAIT_FOR_EVIDENCE" | "NO_WAIT_EDGE";
      expectedUncertaintyReduction: number;
      entryDecayCost: number;
      /** expectedUncertaintyReduction − entryDecayCost. */
      netValue: number;
      waitMs: number;
      halfLifeMs: number;
      perChannel: WaitAdvisoryChannelDetail[];
    };

/**
 * The prospective wait-vs-act computation. HONESTY CONTRACT: when ANY channel
 * that currently carries meaningful penalty has no measured resolution rate,
 * the whole advisory is INSUFFICIENT_HISTORY (with the numbers that ARE known)
 * — a partial fabricated estimate would be false certainty.
 */
export function computeWaitAdvisory(input: WaitAdvisoryInput): AaciWaitAdvisory {
  const minPenalty = input.minPenaltyConsidered ?? VOI_DEFAULT_MIN_PENALTY;
  const halfLifeMs = Number.isFinite(input.halfLifeMs) && input.halfLifeMs > 0 ? input.halfLifeMs : 1;
  const waitMs = Number.isFinite(input.waitMs) && input.waitMs > 0 ? input.waitMs : 0;
  const entryDecayCost = clamp01(1 - Math.exp(-waitMs / halfLifeMs));

  const perChannel: WaitAdvisoryChannelDetail[] = [];
  const insufficient: AaciUncertaintyChannelName[] = [];
  let expectedReduction = 0;

  for (const name of CHANNEL_NAMES) {
    const penalty = clamp01(input.channels[name]);
    if (penalty < minPenalty) continue; // nothing to resolve for this channel
    const weight = AACI_UNCERTAINTY_CHANNEL_WEIGHTS[name];
    const rate = input.resolutionRates[name];
    if (!rate || rate.status !== "OK") {
      insufficient.push(name);
      perChannel.push({
        channel: name,
        penalty,
        weight,
        resolutionRate: null,
        samples: rate?.samples ?? 0,
        expectedReduction: 0,
      });
      continue;
    }
    const contribution = weight * penalty * clamp01(rate.rate);
    expectedReduction += contribution;
    perChannel.push({
      channel: name,
      penalty,
      weight,
      resolutionRate: clamp01(rate.rate),
      samples: rate.samples,
      expectedReduction: contribution,
    });
  }

  if (insufficient.length > 0) {
    return {
      status: "INSUFFICIENT_HISTORY",
      advisory: "NONE",
      insufficientChannels: insufficient,
      entryDecayCost,
      waitMs,
      halfLifeMs,
      perChannel,
    };
  }

  return {
    status: "OK",
    advisory: expectedReduction > entryDecayCost ? "WAIT_FOR_EVIDENCE" : "NO_WAIT_EDGE",
    expectedUncertaintyReduction: expectedReduction,
    entryDecayCost,
    netValue: expectedReduction - entryDecayCost,
    waitMs,
    halfLifeMs,
    perChannel,
  };
}
