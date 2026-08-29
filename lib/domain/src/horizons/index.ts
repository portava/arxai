// ── Unified horizon representation (capability #10) — pure ──────────────────
//
// ONE canonical representation of the system's seven cognitive horizons —
// microstructure, entry, position, session, regime, strategy, capital — each
// carrying its CURRENT state, the AGE of that state, and a RELIABILITY
// reading, so downstream consumers (council, confidence gate) see the whole
// stack in one frame instead of scattering per-subsystem reads.
//
// INTEGRATION STATUS: CONSUMABLE, NOT YET CONSUMED. The confidence gate can
// carry the frame (`attachHorizonAdvisory` on confidenceGate.engine — pure
// copy, test-pinned), but no live assembler builds a HorizonFrame from the
// real subsystems yet: nothing in the api-server feeds per-horizon readings
// into buildHorizonFrame outside the test lane. Until that assembler exists,
// the frame is exercised machinery, not live evidence — do not describe it
// as "consumed by the confidence gate".
//
// HONESTY CONTRACT (fail-closed):
//   * A horizon nobody reported → state null + typed NOT_PROVIDED, stale=true.
//   * An unknown observation time → stale=true (unknown age is stale age).
//   * Reliability is MEASURED only when the provider supplies a real
//     value+sample count; otherwise UNMEASURED with a typed reason. An
//     UNMEASURED reliability is never treated as reliable.
//   * The frame is EVIDENCE. attachHorizonAdvisory (confidence-gate) rides it
//     on the gate result without touching any verdict field.

export const ARX_HORIZONS = [
  "microstructure",
  "entry",
  "position",
  "session",
  "regime",
  "strategy",
  "capital",
] as const;
export type ArxHorizon = (typeof ARX_HORIZONS)[number];

/** Per-horizon default max state age before the state counts as stale.
 *  These are epistemic freshness budgets (how long a reading of that horizon
 *  stays believable), not market facts. */
export const HORIZON_MAX_STATE_AGE_MS: Record<ArxHorizon, number> = {
  microstructure: 5_000, // ~tick scale
  entry: 60_000, // one short bar
  position: 5 * 60_000,
  session: 60 * 60_000,
  regime: 6 * 60 * 60_000,
  strategy: 7 * 24 * 60 * 60_000,
  capital: 30 * 24 * 60 * 60_000,
};

export type HorizonReliability =
  | { status: "MEASURED"; value01: number; samples: number }
  | { status: "UNMEASURED"; reason: string };

export interface HorizonStateInput {
  /** The horizon's current state label (subsystem vocabulary), null = unknown. */
  state: string | null;
  /** When the state was observed (epoch ms); null/undefined = unknown. */
  observedAtMs?: number | null;
  reliability?: HorizonReliability;
  /** Which subsystem produced the reading (for the journal). */
  source?: string;
  /** Override the freshness budget for this reading. */
  maxStateAgeMs?: number;
}

export interface HorizonState {
  horizon: ArxHorizon;
  state: string | null;
  /** Age of the state in ms; null when the observation time is unknown. */
  ageMs: number | null;
  maxStateAgeMs: number;
  /** Fail-closed: true when state is null, age unknown, or age > budget. */
  stale: boolean;
  reliability: HorizonReliability;
  source: string | null;
}

export interface HorizonFrame {
  atMs: number;
  horizons: Record<ArxHorizon, HorizonState>;
}

const RELIABLE_FLOOR_01 = 0.5;

function normalizeReliability(r: HorizonReliability | undefined): HorizonReliability {
  if (!r) return { status: "UNMEASURED", reason: "NOT_PROVIDED" };
  if (r.status === "MEASURED") {
    if (!Number.isFinite(r.value01) || !Number.isFinite(r.samples) || r.samples <= 0) {
      return { status: "UNMEASURED", reason: "MALFORMED_MEASUREMENT" };
    }
    return { status: "MEASURED", value01: Math.max(0, Math.min(1, r.value01)), samples: Math.floor(r.samples) };
  }
  return r;
}

/**
 * Build the unified frame from whatever per-horizon readings exist right now.
 * Missing horizons appear explicitly as null-state stale entries — the frame
 * ALWAYS contains all seven horizons so a consumer can never silently forget
 * one.
 */
export function buildHorizonFrame(
  inputs: Partial<Record<ArxHorizon, HorizonStateInput>>,
  nowMs: number,
): HorizonFrame {
  const horizons = {} as Record<ArxHorizon, HorizonState>;
  for (const h of ARX_HORIZONS) {
    const input = inputs[h];
    const maxAge = input?.maxStateAgeMs ?? HORIZON_MAX_STATE_AGE_MS[h];
    if (!input || input.state === null || input.state === undefined) {
      const provided = normalizeReliability(input?.reliability);
      horizons[h] = {
        horizon: h,
        state: null,
        ageMs: null,
        maxStateAgeMs: maxAge,
        stale: true,
        reliability:
          provided.status === "MEASURED"
            ? provided
            : { status: "UNMEASURED", reason: input ? "STATE_NOT_READABLE" : "NOT_PROVIDED" },
        source: input?.source ?? null,
      };
      continue;
    }
    const at = input.observedAtMs;
    const ageMs =
      at == null || !Number.isFinite(at) ? null : Math.max(0, nowMs - at);
    horizons[h] = {
      horizon: h,
      state: input.state,
      ageMs,
      maxStateAgeMs: maxAge,
      stale: ageMs === null || ageMs > maxAge,
      reliability: normalizeReliability(input.reliability),
      source: input.source ?? null,
    };
  }
  return { atMs: nowMs, horizons };
}

// ── Evidence summary for the confidence gate / council ──────────────────────

export interface HorizonFrameEvidence {
  atMs: number;
  /** Horizons whose state is null, unknown-aged, or over its budget. */
  staleHorizons: ArxHorizon[];
  /** Horizons with UNMEASURED reliability or measured reliability < 0.5. */
  unreliableHorizons: ArxHorizon[];
  /** Horizons that are both fresh and measured-reliable (≥ 0.5). */
  trustedHorizons: ArxHorizon[];
  perHorizon: Record<
    ArxHorizon,
    {
      state: string | null;
      ageMs: number | null;
      stale: boolean;
      reliability: HorizonReliability;
    }
  >;
}

/** Compress a frame into gate/council evidence. Pure re-projection. */
export function horizonFrameEvidence(frame: HorizonFrame): HorizonFrameEvidence {
  const staleHorizons: ArxHorizon[] = [];
  const unreliableHorizons: ArxHorizon[] = [];
  const trustedHorizons: ArxHorizon[] = [];
  const perHorizon = {} as HorizonFrameEvidence["perHorizon"];
  for (const h of ARX_HORIZONS) {
    const s = frame.horizons[h];
    perHorizon[h] = {
      state: s.state,
      ageMs: s.ageMs,
      stale: s.stale,
      reliability: s.reliability,
    };
    if (s.stale) staleHorizons.push(h);
    const reliable =
      s.reliability.status === "MEASURED" && s.reliability.value01 >= RELIABLE_FLOOR_01;
    if (!reliable) unreliableHorizons.push(h);
    if (!s.stale && reliable) trustedHorizons.push(h);
  }
  return { atMs: frame.atMs, staleHorizons, unreliableHorizons, trustedHorizons, perHorizon };
}
