// Capability #36 — reproducible incident fixtures.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ SYNTHETIC. Every fixture in this file is a CONSTRUCTED event sequence.  │
// │ No fixture here was captured from a real production incident; each is   │
// │ labeled `synthetic: true` and that label is carried into every replay   │
// │ report and journal entry. A real-incident fixture, when one is ever     │
// │ captured, gets its own clearly-sourced entry — it is never mixed into   │
// │ this file's synthetic set.                                              │
// └─────────────────────────────────────────────────────────────────────────┘

import type { LivePhaseBGateInput } from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import type { IncidentFixture, SafeguardParams } from "./incidentReplay.js";

// Gate-input template for the synthetic incident: every non-safeguard gate is
// in its passing state so the replay isolates the safeguards under study.
// REPLAY CONTEXT ONLY — these are fixture facts for the pure evaluator, not
// claims about any live account. `foundation` is null, which the evaluator
// itself records loudly as "not evaluated — preview caller".
const SYNTHETIC_PASSING_GATE_BASELINE: LivePhaseBGateInput = {
  liveBrokerExecutionEnabled: true,
  globalLiveEnabled: true,
  userLiveApproved: true,
  userArmed: true,
  killSwitchEngaged: false,
  bridgeAccountType: "live",
  bridgeHeartbeatAgeSec: 2,
  bridgeEaVersion: "1.30",
  bridgeEnableLiveExecution: true,
  bridgeReadOnlyMode: false,
  bridgeTerminalConnected: true,
  bridgeAlgoTradingAllowed: true,
  commandSymbol: "EURUSD",       // overridden per attempt by the runner
  commandVolume: 1,              // overridden per attempt by the runner
  commandHasStopLoss: true,      // overridden per attempt by the runner
  allowedSymbols: ["EURUSD"],
  maxLotForSymbol: 5,            // overridden by the safeguard params
  dailyLossLimitUsd: 1000,       // overridden by the safeguard params
  realisedDailyLossUsd: 0,       // overridden by the runner's running total
  requireStopLoss: true,
  adminAllowNoStopLoss: false,
  requireTakeProfit: true,
  adminAllowNoTakeProfit: false,
  commandHasTakeProfit: true,    // overridden per attempt by the runner
  disclosureAccepted: true,
  foundation: null,
};

/** The parameters "in force" when the synthetic incident happened. */
export const SYNTHETIC_BASELINE_PARAMS: SafeguardParams = {
  label: "baseline",
  priceStalenessSeconds: 120,
  idempotencyWindowMs: 60_000,
  reconciliationSweepIntervalMs: 300_000,
  dailyLossCapUsd: 1000,
  maxLotForSymbol: 5,
};

/** Candidate safeguard alternatives the counterfactual matrix evaluates. */
export const SYNTHETIC_ALTERNATIVE_PARAMS: SafeguardParams[] = [
  { ...SYNTHETIC_BASELINE_PARAMS, label: "tight-staleness", priceStalenessSeconds: 30 },
  { ...SYNTHETIC_BASELINE_PARAMS, label: "wide-idempotency-window", idempotencyWindowMs: 300_000 },
  { ...SYNTHETIC_BASELINE_PARAMS, label: "tight-daily-loss-cap", dailyLossCapUsd: 500 },
  { ...SYNTHETIC_BASELINE_PARAMS, label: "tight-volume-cap", maxLotForSymbol: 1 },
  { ...SYNTHETIC_BASELINE_PARAMS, label: "tight-reconciliation-cadence", reconciliationSweepIntervalMs: 60_000 },
];

/**
 * SYNTHETIC incident: a stale-price entry, a near-duplicate re-entry, and an
 * oversized third entry stack up $1,150 of realized loss; the third entry's
 * delivery also goes UNKNOWN and reconciliation under the slow baseline
 * cadence holds its exposure for ~15 minutes after venue truth was already
 * fetchable.
 *
 * The event window is CONSTRUCTED so each candidate safeguard has a distinct,
 * hand-checkable effect (asserted by the incident-replay test suite):
 *   - tight-staleness (30s)        blocks attempt A1 (its tick is 90s old),
 *   - wide-idempotency (5min)      suppresses A2 (identical to A1, 90s later),
 *   - tight-daily-loss-cap ($500)  blocks A3 (realized loss already $750),
 *   - tight-volume-cap (1 lot)     blocks A3 (2 lots),
 *   - tight-reconciliation (60s)   shortens the UNKNOWN exposure hold.
 */
export const SYNTHETIC_STALE_DUPLICATE_OVERSIZE_FIXTURE: IncidentFixture = {
  incidentId: "SYNTHETIC-STALE-DUP-OVERSIZE-001",
  synthetic: true,
  description:
    "SYNTHETIC incident (constructed event sequence, not a captured production event): "
    + "stale-price entry + duplicate re-entry + oversized third entry reach $1,150 realized loss; "
    + "the third delivery goes UNKNOWN and is slow to reconcile.",
  capturedAtIso: "2026-08-20T10:30:00.000Z",
  gateBaseline: SYNTHETIC_PASSING_GATE_BASELINE,
  baselineParams: SYNTHETIC_BASELINE_PARAMS,
  incidentLossThresholdUsd: 1000,
  events: [
    { kind: "TICK", atIso: "2026-08-20T10:00:00.000Z", symbol: "EURUSD", bid: 1.1000, ask: 1.1002 },
    // A1 — entered on a 90s-old tick (baseline staleness 120s lets it through).
    {
      kind: "COMMAND_ATTEMPT", atIso: "2026-08-20T10:01:30.000Z", attemptId: "A1",
      userId: 7, symbol: "EURUSD", side: "BUY", volume: 1,
      stopLoss: 1.0950, takeProfit: 1.1080, realizedLossUsdIfDispatched: 400,
    },
    { kind: "TICK", atIso: "2026-08-20T10:02:50.000Z", symbol: "EURUSD", bid: 1.0990, ask: 1.0992 },
    // A2 — byte-identical order 90s after A1: a different 60s idempotency
    // bucket under the baseline, the SAME 5-minute bucket under the
    // wide-idempotency alternative.
    {
      kind: "COMMAND_ATTEMPT", atIso: "2026-08-20T10:03:00.000Z", attemptId: "A2",
      userId: 7, symbol: "EURUSD", side: "BUY", volume: 1,
      stopLoss: 1.0950, takeProfit: 1.1080, realizedLossUsdIfDispatched: 350,
    },
    { kind: "TICK", atIso: "2026-08-20T10:03:55.000Z", symbol: "EURUSD", bid: 1.0985, ask: 1.0987 },
    // A3 — 2 lots with $750 already realized. Baseline caps (5 lots / $1000)
    // let it through; either tight cap blocks it.
    {
      kind: "COMMAND_ATTEMPT", atIso: "2026-08-20T10:04:00.000Z", attemptId: "A3",
      userId: 7, symbol: "EURUSD", side: "BUY", volume: 2,
      stopLoss: 1.0940, takeProfit: 1.1060, realizedLossUsdIfDispatched: 400,
    },
    // A3's delivery goes epistemically UNKNOWN (frame may have reached the
    // venue) and its command deadline passes at 10:05:10.
    {
      kind: "WENT_UNKNOWN", atIso: "2026-08-20T10:04:10.000Z", attemptId: "A3",
      wireWritten: true, expiresAtIso: "2026-08-20T10:05:10.000Z",
    },
    // Venue truth became fetchable at 10:20:00 — everything after this is
    // reconciliation latency, not venue latency.
    { kind: "VENUE_TRUTH_AVAILABLE", atIso: "2026-08-20T10:20:00.000Z", attemptId: "A3" },
  ],
};
