// Capability #36 — Incident Counterfactual Replay (replay-lab extension).
//
// Replays a reproducible incident fixture (a captured window of the event
// stream around an incident) under ALTERNATIVE safeguard parameterizations —
// price-staleness limit, idempotency window, reconciliation sweep cadence,
// daily-loss cap, per-symbol volume cap — and reports which configuration
// would have PREVENTED or REDUCED the incident.
//
// HOW THE COUNTERFACTUALS ARE EVALUATED — through the EXISTING pure engines,
// never through parallel re-implementations and never through live services:
//   - price staleness   → readPriceSensor (lib/domain live-inputs), via its
//                         existing `stalenessSeconds` parameter,
//   - risk caps         → evaluateLivePhaseBDispatchGate (the real 21-gate
//                         evaluator), via its existing `dailyLossLimitUsd` /
//                         `maxLotForSymbol` inputs,
//   - idempotency       → buildLiveIdempotencyKey (lib/live/phaseBConfig),
//                         via its existing `minuteBucket` override — the
//                         candidate window sets the bucket width,
//   - reconciliation    → classifySweepCandidate (safety-contracts
//                         guidedTtlPolicy); the CADENCE parameter controls
//                         when the replay invokes the unchanged classifier.
//
// SAFETY (inviolable):
// - REPLAY ONLY. Nothing here can place, modify, or cancel an order: no venue
//   adapter, no deliver(), no liveCommandPipeline / guidedDispatchEntry
//   import, no DB write. The runner is deterministic — identical fixture +
//   params always produce the identical outcome (pinned by test).
// - Gate facts come from the fixture's captured baseline, labeled as replay
//   context. This module journals EVIDENCE about counterfactual
//   configurations; it grants no authority and changes no parameter — any
//   real safeguard change stays an owner decision.

import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import {
  classifySweepCandidate,
} from "@workspace/domain/safety-contracts/guidedTtlPolicy";
import { readPriceSensor } from "@workspace/domain/live-inputs";
import { buildLiveIdempotencyKey } from "../live/phaseBConfig.js";

// ── Safeguard parameterization ──────────────────────────────────────────────

export interface SafeguardParams {
  /** Human label for the report ("baseline", "tight-staleness", ...). */
  label: string;
  /** Max age of the newest price tick before an attempt is refused. */
  priceStalenessSeconds: number;
  /** Width of the idempotency bucket: identical orders inside one bucket
   *  are duplicate-suppressed. */
  idempotencyWindowMs: number;
  /** How often the reconciliation sweep runs in the replay. */
  reconciliationSweepIntervalMs: number;
  /** Daily realized-loss cap (USD). 0 = no cap (existing gate semantics). */
  dailyLossCapUsd: number;
  /** Per-symbol max volume. */
  maxLotForSymbol: number;
}

// ── Incident fixture ────────────────────────────────────────────────────────

export type IncidentEvent =
  | { kind: "TICK"; atIso: string; symbol: string; bid: number; ask: number }
  | {
      kind: "COMMAND_ATTEMPT"; atIso: string; attemptId: string;
      userId: number; symbol: string; side: "BUY" | "SELL"; volume: number;
      stopLoss: number | null; takeProfit: number | null;
      /** Realized loss (USD, ≥0) this command eventually booked in the
       *  incident IF it dispatched. The fixture captures the outcome; the
       *  replay only decides whether each configuration lets it happen. */
      realizedLossUsdIfDispatched: number;
    }
  | {
      /** A dispatched command's delivery went epistemically UNKNOWN. */
      kind: "WENT_UNKNOWN"; atIso: string; attemptId: string;
      wireWritten: boolean; expiresAtIso: string;
    }
  | {
      /** Venue truth for the UNKNOWN command became fetchable at this time. */
      kind: "VENUE_TRUTH_AVAILABLE"; atIso: string; attemptId: string;
    };

export interface IncidentFixture {
  incidentId: string;
  /** True for constructed event sequences. Carried into every report. */
  synthetic: boolean;
  description: string;
  capturedAtIso: string;
  /** Gate-input template captured at incident time. The replay overrides
   *  ONLY the safeguard-relevant fields (loss cap, volume cap, per-command
   *  facts); everything else replays as captured. */
  gateBaseline: LivePhaseBGateInput;
  /** The parameters that were in force when the incident happened. */
  baselineParams: SafeguardParams;
  /** Chronological event window (oldest → newest). */
  events: IncidentEvent[];
  /** Realized loss (USD) at/above which this fixture counts as "the
   *  incident occurred". */
  incidentLossThresholdUsd: number;
}

// ── Replay outcome ──────────────────────────────────────────────────────────

export type BlockStage = "PRICE_STALENESS" | "IDEMPOTENCY" | "DISPATCH_GATE";

export interface IncidentReplayOutcome {
  params: SafeguardParams;
  dispatched: { attemptId: string; atIso: string }[];
  blocked: { attemptId: string; atIso: string; stage: BlockStage; reasons: string[] }[];
  realizedLossUsd: number;
  unknown: {
    attemptId: string;
    /** When delivery actually became unknown (the fixture event time). */
    becameUnknownAtIso: string;
    /** When a sweep first CLASSIFIED it unknown (cadence-dependent). */
    detectedBySweepAtIso: string | null;
    resolvedAtIso: string | null;
    /** resolvedAt − becameUnknownAt: how long the exposure reservation was
     *  held on a position nobody could see. Null when unresolved or when the
     *  sweep proved non-transmission. */
    exposureHeldMs: number | null;
    note: string;
  }[];
  incidentOccurred: boolean;
  /** Loss dollars + minutes of unknown exposure held (documented, comparable
   *  across configurations of the SAME fixture only). */
  severityScore: number;
}

export type CounterfactualVerdict = "PREVENTED" | "REDUCED" | "NO_CHANGE" | "WORSENED";

export interface IncidentCounterfactualReport {
  incidentId: string;
  synthetic: boolean;
  description: string;
  baseline: IncidentReplayOutcome;
  alternatives: {
    params: SafeguardParams;
    outcome: IncidentReplayOutcome;
    verdict: CounterfactualVerdict;
    explanation: string;
  }[];
  /** Labels of configurations that fully prevented the incident. */
  preventedBy: string[];
  /** Labels that reduced severity without fully preventing it. */
  reducedBy: string[];
}

/** How long past the last event the sweep simulation may run before an
 *  unresolved UNKNOWN is reported as unresolved (honest null, not a guess). */
const SWEEP_HORIZON_MS = 24 * 60 * 60 * 1000;
/** guidedTtlPolicy's internal reconcile retry spacing (mirrored constant is
 *  NOT redefined — we import the classifier and simply honor whatever it
 *  answers at each sweep tick). */

function t(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) throw new Error(`invalid ISO timestamp in fixture: ${iso}`);
  return ms;
}

// ── The runner ──────────────────────────────────────────────────────────────

export async function replayIncident(
  fixture: IncidentFixture,
  params: SafeguardParams,
): Promise<IncidentReplayOutcome> {
  const dispatched: IncidentReplayOutcome["dispatched"] = [];
  const blocked: IncidentReplayOutcome["blocked"] = [];
  const unknown: IncidentReplayOutcome["unknown"] = [];

  let realizedLossUsd = 0;
  const lastTickBySymbol = new Map<string, { bid: number; ask: number; timestamp: string }>();
  const activeIdemKeys = new Set<string>();
  const dispatchedIds = new Set<string>();
  const pendingUnknown = new Map<string, { wentUnknownEvent: Extract<IncidentEvent, { kind: "WENT_UNKNOWN" }> }>();
  const truthAt = new Map<string, number>();

  for (const ev of fixture.events) {
    if (ev.kind === "TICK") {
      lastTickBySymbol.set(ev.symbol, { bid: ev.bid, ask: ev.ask, timestamp: ev.atIso });
      continue;
    }

    if (ev.kind === "COMMAND_ATTEMPT") {
      const now = new Date(ev.atIso);

      // 1) Price staleness — the EXISTING sensor engine with the candidate
      //    staleness parameter. A missing tick fails closed (engine behavior).
      const tick = lastTickBySymbol.get(ev.symbol) ?? null;
      const sensor = await readPriceSensor({
        port: { getLatestTick: async () => tick },
        symbol: ev.symbol,
        now,
        stalenessSeconds: params.priceStalenessSeconds,
      });
      if (!sensor.health.isHealthy) {
        blocked.push({ attemptId: ev.attemptId, atIso: ev.atIso, stage: "PRICE_STALENESS", reasons: sensor.blockers });
        continue;
      }

      // 2) Idempotency — the EXISTING key builder; the candidate window sets
      //    the bucket width through the builder's own bucket override.
      const bucket = Math.floor(t(ev.atIso) / params.idempotencyWindowMs);
      const key = buildLiveIdempotencyKey({
        userId: ev.userId,
        symbol: ev.symbol,
        side: ev.side,
        volume: ev.volume,
        stopLoss: ev.stopLoss,
        takeProfit: ev.takeProfit,
        minuteBucket: bucket,
      });
      if (activeIdemKeys.has(key)) {
        blocked.push({
          attemptId: ev.attemptId, atIso: ev.atIso, stage: "IDEMPOTENCY",
          reasons: [`duplicate suppressed: identical order inside the ${params.idempotencyWindowMs}ms idempotency window`],
        });
        continue;
      }

      // 3) Risk caps — the REAL 21-gate evaluator; only the safeguard-
      //    relevant inputs are overridden, the rest replay as captured.
      const gate = evaluateLivePhaseBDispatchGate({
        ...fixture.gateBaseline,
        commandSymbol: ev.symbol,
        commandVolume: ev.volume,
        commandHasStopLoss: ev.stopLoss !== null,
        commandHasTakeProfit: ev.takeProfit !== null,
        dailyLossLimitUsd: params.dailyLossCapUsd,
        realisedDailyLossUsd: realizedLossUsd,
        maxLotForSymbol: params.maxLotForSymbol,
      });
      if (gate.decision !== "PASS") {
        blocked.push({
          attemptId: ev.attemptId, atIso: ev.atIso, stage: "DISPATCH_GATE",
          reasons: gate.blockReasons.map(String),
        });
        continue;
      }

      dispatched.push({ attemptId: ev.attemptId, atIso: ev.atIso });
      dispatchedIds.add(ev.attemptId);
      activeIdemKeys.add(key);
      realizedLossUsd += Math.max(0, ev.realizedLossUsdIfDispatched);
      continue;
    }

    if (ev.kind === "WENT_UNKNOWN") {
      // Only meaningful for commands this configuration actually dispatched.
      if (dispatchedIds.has(ev.attemptId)) pendingUnknown.set(ev.attemptId, { wentUnknownEvent: ev });
      continue;
    }

    // VENUE_TRUTH_AVAILABLE
    truthAt.set(ev.attemptId, t(ev.atIso));
  }

  // ── Reconciliation simulation: sweep the unchanged classifier at the
  //    candidate cadence. Exposure held = first EXPIRE_TO_UNKNOWN → the first
  //    RECONCILE_NOW at/after venue truth is available. ────────────────────
  for (const [attemptId, { wentUnknownEvent }] of pendingUnknown) {
    const truth = truthAt.get(attemptId) ?? null;
    const start = t(wentUnknownEvent.atIso);
    let alreadyUnknown = false;
    let lastReconcileAttemptIso: string | null = null;
    let detectedBySweepAtIso: string | null = null;
    let resolvedAtIso: string | null = null;
    let provenNotTransmitted = false;

    for (
      let sweep = start + params.reconciliationSweepIntervalMs;
      sweep <= start + SWEEP_HORIZON_MS;
      sweep += params.reconciliationSweepIntervalMs
    ) {
      const nowIso = new Date(sweep).toISOString();
      const outcome = classifySweepCandidate(
        {
          expiresAtIso: wentUnknownEvent.expiresAtIso,
          wireWritten: wentUnknownEvent.wireWritten,
          alreadyUnknown,
          lastReconcileAttemptIso,
        },
        nowIso,
      );
      if (outcome === "EXPIRE_TO_UNKNOWN") {
        alreadyUnknown = true;
        detectedBySweepAtIso = nowIso;
        continue;
      }
      if (outcome === "RECONCILE_NOW") {
        lastReconcileAttemptIso = nowIso;
        if (truth !== null && sweep >= truth) {
          resolvedAtIso = nowIso;
          break;
        }
        continue;
      }
      if (outcome === "EXPIRE_NOT_TRANSMITTED") {
        // Provably never transmitted — the sweep fails it closed; no
        // exposure is held past this point.
        provenNotTransmitted = true;
        break;
      }
      // LEAVE: nothing to do this tick.
    }

    const resolved = resolvedAtIso !== null && !provenNotTransmitted;
    unknown.push({
      attemptId,
      becameUnknownAtIso: wentUnknownEvent.atIso,
      detectedBySweepAtIso,
      resolvedAtIso,
      exposureHeldMs: resolved ? t(resolvedAtIso!) - start : null,
      note: provenNotTransmitted
        ? "sweep proved non-transmission — failed closed, no exposure held"
        : resolved
          ? "resolved by reconciliation sweep"
          : "UNRESOLVED within the sweep horizon — reported honestly, not guessed",
    });
  }

  const heldMinutes = unknown.reduce(
    (acc, u) => acc + (u.exposureHeldMs !== null ? u.exposureHeldMs / 60_000 : 0),
    0,
  );

  return {
    params,
    dispatched,
    blocked,
    realizedLossUsd,
    unknown,
    incidentOccurred: realizedLossUsd >= fixture.incidentLossThresholdUsd,
    severityScore: realizedLossUsd + heldMinutes,
  };
}

// ── Counterfactual matrix ───────────────────────────────────────────────────

export async function runIncidentCounterfactuals(
  fixture: IncidentFixture,
  alternatives: readonly SafeguardParams[],
): Promise<IncidentCounterfactualReport> {
  const baseline = await replayIncident(fixture, fixture.baselineParams);
  const rows: IncidentCounterfactualReport["alternatives"] = [];

  for (const alt of alternatives) {
    const outcome = await replayIncident(fixture, alt);
    let verdict: CounterfactualVerdict;
    if (baseline.incidentOccurred && !outcome.incidentOccurred) verdict = "PREVENTED";
    else if (outcome.severityScore < baseline.severityScore) verdict = "REDUCED";
    else if (outcome.severityScore > baseline.severityScore) verdict = "WORSENED";
    else verdict = "NO_CHANGE";

    rows.push({
      params: alt,
      outcome,
      verdict,
      explanation:
        `loss $${outcome.realizedLossUsd.toFixed(2)} vs baseline $${baseline.realizedLossUsd.toFixed(2)}; ` +
        `severity ${outcome.severityScore.toFixed(2)} vs ${baseline.severityScore.toFixed(2)}; ` +
        `${outcome.blocked.length} attempt(s) blocked vs ${baseline.blocked.length}`,
    });
  }

  return {
    incidentId: fixture.incidentId,
    synthetic: fixture.synthetic,
    description: fixture.description,
    baseline,
    alternatives: rows,
    preventedBy: rows.filter((r) => r.verdict === "PREVENTED").map((r) => r.params.label),
    reducedBy: rows.filter((r) => r.verdict === "REDUCED").map((r) => r.params.label),
  };
}
