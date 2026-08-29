// Phase 6 — venue gate parity.
//
// The dispatch wall in `livePhaseBDispatchGate.ts` (18 Phase B gates, plus the
// three venue-independent foundation gates #19-#21) is MT5-live-shaped in its
// transport rows:
// gates 6-12 read EA bridge facts (heartbeat age, EA version, EnableLiveExecution,
// ReadOnlyMode, terminalConnected, algoTradingAllowed) that simply do not exist
// for a Deriv WebSocket session, and gate 6 BLOCKS anything that is not a
// live/real account — by design, to keep the live path on live accounts.
//
// A second venue therefore cannot run those 18 gates verbatim. The two dishonest
// ways out are both forbidden here:
//
//   - fabricate EA facts so the gates "pass" — that mocks around the gate wall
//     and writes a lie into the audit log;
//   - quietly skip the gates that do not fit — that is silent weakening, and
//     nothing downstream would ever notice.
//
// Instead every gate gets an explicit, audited DISPOSITION per venue. A gate is
// either enforced by a venue-native equivalent, enforced more strictly, or
// declared NOT_APPLICABLE with a written reason naming the MT5-specific
// mechanism that has no counterpart. Nothing may be left undecided:
//
//   - COMPILE TIME: VenueGateParityMap is Record<LivePhaseBGateOnlyKey, ...>, so
//     omitting a gate fails the build. Adding a 19th gate to the union breaks
//     every venue map until someone maps it — the gate wall cannot silently
//     grow past a venue.
//   - RUN TIME: assertVenueGateParity re-checks, because a cast or an `any` at
//     a call site could otherwise slip past the compiler.
//
// This module is contract-only. Importing it does not unlock execution, does not
// evaluate any gate, and cannot cause a dispatch.

import type { LivePhaseBGateKey } from "./livePhaseBDispatchGate.js";

/**
 * `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is in the gate-key union but is NOT
 * a gate: the evaluator appends it as an audit/grep sentinel when the master
 * switch is off (livePhaseBDispatchGate.ts, after the gate list). Excluding it
 * is what makes the real gate count 21 rather than 22.
 */
export const LIVE_PHASE_B_GATE_SENTINEL = "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED" as const;

export type LivePhaseBGateOnlyKey = Exclude<
  LivePhaseBGateKey,
  typeof LIVE_PHASE_B_GATE_SENTINEL
>;

/** The 21 real gates, in the order the evaluator pushes them. */
export const LIVE_PHASE_B_GATE_KEYS = [
  "LIVE_BROKER_EXECUTION_DISABLED",   // 1  server master switch
  "USER_NOT_ARMED_FOR_LIVE",          // 2  per-user arming
  "USER_NOT_LIVE_APPROVED",           // 3  admin per-user approval
  "GLOBAL_LIVE_DISABLED",             // 4  global singleton flag
  "KILL_SWITCH_ENGAGED",              // 5  per-user kill switch
  "BRIDGE_NOT_LIVE_ACCOUNT",          // 6  account type
  "EA_HEARTBEAT_STALE",               // 7  transport liveness
  "EA_VERSION_TOO_OLD",               // 8  transport capability
  "EA_ENABLE_LIVE_EXECUTION_FALSE",   // 9  transport execution toggle
  "EA_READ_ONLY_MODE_TRUE",           // 10 transport read-only toggle
  "EA_TERMINAL_NOT_CONNECTED",        // 11 transport connectivity
  "EA_ALGO_TRADING_NOT_ALLOWED",      // 12 programmatic-order permission
  "SYMBOL_NOT_ALLOWED",               // 13 instrument allow-list
  "VOLUME_EXCEEDS_MAX_LIVE_LOT",      // 14 size ceiling
  "DAILY_LOSS_LIMIT_REACHED",         // 15 realised daily loss cap
  "MISSING_STOP_LOSS",                // 16 protection required
  "MISSING_TAKE_PROFIT",              // 17 protection required
  "DISCLOSURE_NOT_ACCEPTED",          // 18 risk disclosure
  "PROVENANCE_UNPROVEN",              // 19 decision-data provenance proven
  "STRATEGY_NOT_LIVE_PROMOTED",       // 20 edge owner-promoted for live
  "CAPITAL_TIER_EXCEEDED",            // 21 per-user capital tier cap
] as const satisfies readonly LivePhaseBGateOnlyKey[];

export const LIVE_PHASE_B_GATE_COUNT = 21 as const;

/**
 * Compile-time proof the list above covers EVERY gate key. If a new gate is
 * added to `LivePhaseBGateKey` and not listed here, `UnlistedGateKey` becomes
 * that key, the conditional resolves to `never`, and this assignment fails the
 * build. That is the mechanism preventing a gate from being added to the live
 * path while a second venue silently never checks it.
 */
type UnlistedGateKey = Exclude<
  LivePhaseBGateOnlyKey,
  (typeof LIVE_PHASE_B_GATE_KEYS)[number]
>;
export const ALL_GATE_KEYS_ARE_LISTED: UnlistedGateKey extends never ? true : never = true;

export type VenueGateDispositionKind =
  /** A venue-native check enforcing the same intent as the MT5 gate. */
  | "EQUIVALENT"
  /** A venue-native check strictly harder to pass than the MT5 gate. */
  | "STRICTER"
  /** No counterpart exists at this venue. Requires a written reason. */
  | "NOT_APPLICABLE";

export interface VenueGateDisposition {
  kind: VenueGateDispositionKind;
  /**
   * Why this disposition is honest. For NOT_APPLICABLE it must name the
   * MT5-specific mechanism that has no counterpart — "n/a" is not a reason,
   * and assertVenueGateParity rejects reasons that carry no information.
   */
  reason: string;
  /**
   * For EQUIVALENT / STRICTER: what actually enforces it at this venue.
   * Required for those kinds — a claimed equivalent with nothing enforcing it
   * is a weakened gate wearing a disguise.
   */
  enforcedBy?: string;
}

export type VenueGateParityMap = Readonly<
  Record<LivePhaseBGateOnlyKey, VenueGateDisposition>
>;

export interface VenueGateParityProblem {
  gate: string;
  problem: string;
}

export interface VenueGateParityVerdict {
  ok: boolean;
  venue: string;
  problems: VenueGateParityProblem[];
  /** Gate keys declared NOT_APPLICABLE, for the audit readout. */
  notApplicable: string[];
}

/** A reason must carry information. These are the shapes that do not. */
const EMPTY_REASON = /^(n\/?a|none|tbd|todo|-{0,3}|\?+)$/i;
const MIN_REASON_CHARS = 12;

/**
 * Runtime completeness check. Fails CLOSED: any unmapped gate, any empty
 * reason, or any EQUIVALENT/STRICTER claim without an enforcer makes the whole
 * verdict not-ok, and callers must refuse to dispatch on a not-ok verdict.
 */
export function assertVenueGateParity(
  venue: string,
  map: VenueGateParityMap,
): VenueGateParityVerdict {
  const problems: VenueGateParityProblem[] = [];
  const notApplicable: string[] = [];

  for (const gate of LIVE_PHASE_B_GATE_KEYS) {
    const d = (map as Record<string, VenueGateDisposition | undefined>)[gate];
    if (!d) {
      problems.push({ gate, problem: "no disposition declared for this venue" });
      continue;
    }
    const reason = typeof d.reason === "string" ? d.reason.trim() : "";
    if (reason === "" || EMPTY_REASON.test(reason) || reason.length < MIN_REASON_CHARS) {
      problems.push({ gate, problem: `reason carries no information: ${JSON.stringify(d.reason)}` });
    }
    if (d.kind === "NOT_APPLICABLE") {
      notApplicable.push(gate);
    } else if (d.kind === "EQUIVALENT" || d.kind === "STRICTER") {
      const by = typeof d.enforcedBy === "string" ? d.enforcedBy.trim() : "";
      if (by === "") {
        problems.push({
          gate,
          problem: `declared ${d.kind} but names nothing that enforces it`,
        });
      }
    } else {
      problems.push({ gate, problem: `unknown disposition kind: ${JSON.stringify(d.kind)}` });
    }
  }

  // A map carrying keys that are not gates means it was built against a
  // different gate list than the one shipping — refuse rather than guess.
  for (const key of Object.keys(map)) {
    if (!(LIVE_PHASE_B_GATE_KEYS as readonly string[]).includes(key)) {
      problems.push({ gate: key, problem: "not a Phase B gate key" });
    }
  }

  return { ok: problems.length === 0, venue, problems, notApplicable };
}
