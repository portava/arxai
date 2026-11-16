// Evidence provenance and the live-vs-replay precedence rule. PURE.
//
// Every graded sample carries the component it came from: a live source
// (resolved signal outcomes, an agent's own graded predictions) or a replay
// (a strategy / agent rule re-run on REAL price history: a committed,
// sha256-pinned real-history fixture, or stored broker candles). A fit is
// persisted with the list of components behind its N, so every number a
// payload serves says where its sample came from.
//
// PRECEDENCE (per fit key):
//   live N >= CALIBRATION_MIN_SAMPLE  → live only. Replay samples are dropped
//                                       from the fit and listed as excluded.
//   0 < live N < MIN_SAMPLE           → live + replay, both listed.
//   live N = 0                        → replay only.
// Live outcomes are what the call actually did in the market it is served in;
// replay is the same deterministic rule graded on history. Once live has
// enough to stand on its own it replaces replay instead of being diluted by it.

import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import {
  CALIBRATION_MIN_SAMPLE,
  type CalibrationSample,
} from "@workspace/domain/calibration";

export type EvidenceKind = "live" | "replay";

/** Where a graded sample came from. `id` is stable across runs. */
export interface EvidenceComponent {
  id: string;
  kind: EvidenceKind;
  /** eleanor_outcomes | scanner_outcomes | agent_predictions | strategy_replay | historical_replay */
  source: string;
  /** historical_replay only: the fixture directory, its dataset hash, the file and its sha256. */
  fixtureId?: string;
  datasetHash?: string;
  file?: string;
  sha256?: string;
  symbol?: string;
  timeframe?: string;
  /** "ohlc" = published highs/lows; "close_fixings" = close-only source, bars span consecutive fixings only (no derived wicks). */
  ranges?: "ohlc" | "close_fixings";
}

export interface TimedSample extends CalibrationSample {
  at: Date;
  symbol: string;
  timeframe: string;
  component: EvidenceComponent;
}

export type EvidenceBasis = "live_only" | "live_plus_replay" | "replay_only" | "none";

export interface ComponentTally extends EvidenceComponent {
  n: number;
  wins: number;
  dataFrom: string | null;
  dataTo: string | null;
}

export interface FitProvenance {
  basis: EvidenceBasis;
  rule: string;
  minSample: number;
  liveN: number;
  replayN: number;
  /** Components whose samples are IN the fit. */
  components: ComponentTally[];
  /** Replay components left out because live N reached the minimum. */
  excluded: ComponentTally[];
  /** sha256 over the components (ids, N, wins, ranges): changes iff the evidence changed. */
  digest: string;
}

export const PRECEDENCE_RULE =
  `live only once live N >= ${CALIBRATION_MIN_SAMPLE}; below that live + replay; replay only when there is no live outcome`;

export const LIVE_SOURCES = new Set(["eleanor_outcomes", "scanner_outcomes", "agent_predictions"]);
export const REPLAY_SOURCES = new Set(["strategy_replay", "historical_replay"]);

function tally(samples: readonly TimedSample[]): ComponentTally[] {
  const by = new Map<string, ComponentTally>();
  for (const s of samples) {
    let t = by.get(s.component.id);
    if (!t) {
      t = { ...s.component, n: 0, wins: 0, dataFrom: null, dataTo: null };
      by.set(s.component.id, t);
    }
    t.n++;
    t.wins += s.outcome;
    const iso = s.at.toISOString();
    if (t.dataFrom === null || iso < t.dataFrom) t.dataFrom = iso;
    if (t.dataTo === null || iso > t.dataTo) t.dataTo = iso;
  }
  return [...by.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function provenanceDigest(components: readonly ComponentTally[], excluded: readonly ComponentTally[]): string {
  return createHash("sha256").update(stableStringify({ components, excluded })).digest("hex");
}

/**
 * Apply the precedence rule to every sample graded for ONE fit key.
 * Returns the samples that enter the fit (oldest first) and their provenance.
 */
export function composeEvidence(samples: readonly TimedSample[]): { samples: TimedSample[]; provenance: FitProvenance } {
  const live = samples.filter((s) => s.component.kind === "live");
  const replay = samples.filter((s) => s.component.kind === "replay");
  let used: TimedSample[];
  let dropped: TimedSample[] = [];
  let basis: EvidenceBasis;
  if (live.length >= CALIBRATION_MIN_SAMPLE) {
    used = live;
    dropped = replay;
    basis = "live_only";
  } else if (live.length > 0 && replay.length > 0) {
    used = [...live, ...replay];
    basis = "live_plus_replay";
  } else if (live.length > 0) {
    used = live;
    basis = "live_only";
  } else if (replay.length > 0) {
    used = replay;
    basis = "replay_only";
  } else {
    used = [];
    basis = "none";
  }
  used = [...used].sort((a, b) => a.at.getTime() - b.at.getTime() || a.component.id.localeCompare(b.component.id));
  const components = tally(used);
  const excluded = tally(dropped);
  return {
    samples: used,
    provenance: {
      basis,
      rule: PRECEDENCE_RULE,
      minSample: CALIBRATION_MIN_SAMPLE,
      liveN: live.length,
      replayN: replay.length,
      components,
      excluded,
      digest: provenanceDigest(components, excluded),
    },
  };
}

/** The `source` column for a fit: its in-fit sources, sorted, joined by "+". */
export function sourceLabel(p: FitProvenance): string {
  const set = [...new Set(p.components.map((c) => c.source))].sort();
  return set.length ? set.join("+") : "none";
}

/** True when every in-fit source is a replay of public price history. */
export function isPublicReplay(source: string): boolean {
  const parts = source.split("+");
  return parts.length > 0 && parts.every((p) => REPLAY_SOURCES.has(p));
}

/** The compact provenance a payload stamp carries next to the number. */
export interface StampProvenance {
  basis: EvidenceBasis;
  liveN: number;
  replayN: number;
  sources: string[];
  /** Real-history fixtures behind the number: id + dataset hash. */
  fixtures: { fixtureId: string; datasetHash: string }[];
  rule: string;
}

export function toStampProvenance(p: FitProvenance | null | undefined): StampProvenance {
  if (!p) {
    return { basis: "none", liveN: 0, replayN: 0, sources: [], fixtures: [], rule: PRECEDENCE_RULE };
  }
  const fixtures = new Map<string, string>();
  for (const c of p.components) if (c.fixtureId && c.datasetHash) fixtures.set(c.fixtureId, c.datasetHash);
  return {
    basis: p.basis,
    liveN: p.liveN,
    replayN: p.replayN,
    sources: [...new Set(p.components.map((c) => c.source))].sort(),
    fixtures: [...fixtures].map(([fixtureId, datasetHash]) => ({ fixtureId, datasetHash })).sort((a, b) => a.fixtureId.localeCompare(b.fixtureId)),
    rule: p.rule,
  };
}
