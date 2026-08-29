// ── AUTONOMY PROVENANCE — who really placed this live order (pure) ───────────
//
// WHY THIS EXISTS: foundation gates #20 (STRATEGY_NOT_LIVE_PROMOTED) and #23
// (EDGE_CAPACITY_EXCEEDED) bind on the command's `actor_type`: they demand a
// promoted edge + a recorded capacity estimate for AUTONOMOUS origination
// (SELF_TRADE_AGENT / SYSTEM) and deliberately exempt a human press
// (USER / ADMIN / OWNER) — otherwise every manual click would block.
//
// The bug this closes: the mission DRIVER (missionDriver.ts) advances a
// mission scan → auto-approve → live dispatch on an unattended tick with NO
// human press anywhere in the chain, yet the resulting draft carried no
// self-trade agent id, so it was classified "USER" and BOTH autonomy gates
// stood down. An unattended order was being admitted on the human exemption.
//
// The fix is provenance, not a new gate: a producer that places an order with
// no human press stamps `autonomousOrigin`, and this pure classifier maps it
// to the SYSTEM actor the gates already bind. A user-PRESSED mission trade
// stamps nothing and stays a human actor — unchanged.
//
// HONESTY: this classifies origin; it never grants anything. The only movement
// possible here is USER → SYSTEM, i.e. strictly MORE gates bind. An unknown /
// malformed origin literal is treated as ABSENT (no autonomy claim invented)
// — and absent origin on a driver path is a wiring bug, not a licence, which
// is why `missionDriver` passes the literal explicitly rather than inferring
// it from a mission id (a mission id alone cannot tell a press from a tick).
//
// PURE + DETERMINISTIC + IO-FREE.

import type { CommandActorType } from "../security/commandIntegrity.js";

/**
 * Producers that can place a live order with NO human press. Each literal
 * names the unattended loop that originated it, so an audit reader can tell
 * WHICH autonomy placed the order, not merely that "something automated" did.
 */
export const LIVE_AUTONOMOUS_ORIGINS = [
  /** artifacts/api-server/src/lib/missionDriver.ts — the unattended mission tick. */
  "MISSION_DRIVER",
] as const;

export type LiveAutonomousOrigin = (typeof LIVE_AUTONOMOUS_ORIGINS)[number];

export function isLiveAutonomousOrigin(v: unknown): v is LiveAutonomousOrigin {
  return typeof v === "string"
    && (LIVE_AUTONOMOUS_ORIGINS as readonly string[]).includes(v);
}

/**
 * Classify the actor for a live DRAFT from its origination facts.
 *
 *  - a Self-Trade agent id  → SELF_TRADE_AGENT (unchanged, #213)
 *  - a recognised unattended origin → SYSTEM (gates #20/#23 bind)
 *  - anything else → USER (a human press; the documented gate exemption)
 *
 * Precedence is deliberate: an agent id is the more specific attribution and
 * both classes are autonomous, so the outcome at the gates is identical.
 */
export function classifyDraftActorType(args: {
  selfTradeAgentId?: number | null;
  autonomousOrigin?: string | null;
}): CommandActorType {
  if (args.selfTradeAgentId != null) return "SELF_TRADE_AGENT";
  if (isLiveAutonomousOrigin(args.autonomousOrigin)) return "SYSTEM";
  return "USER";
}

/** True when this draft was placed with no human press. */
export function isAutonomouslyOriginated(args: {
  selfTradeAgentId?: number | null;
  autonomousOrigin?: string | null;
}): boolean {
  const actor = classifyDraftActorType(args);
  return actor === "SELF_TRADE_AGENT" || actor === "SYSTEM";
}

/**
 * The owner-facing explanation for why an UNATTENDED order refuses where the
 * same setup pressed by hand would not. Attached to the mission journal so a
 * refusal reads as a designed rule rather than a malfunction. Purely
 * explanatory text — it changes no verdict.
 */
export const AUTONOMOUS_ENTRY_REFUSAL_NOTE: string =
  "This order was placed by the mission driver with no human press, so it is "
  + "classified as an autonomous entry. Autonomous live entries must be backed "
  + "by an owner-promoted edge (gate #20 STRATEGY_NOT_LIVE_PROMOTED) and by a "
  + "recorded edge-capacity estimate with a pressed USD ceiling (gate #23 "
  + "EDGE_CAPACITY_EXCEEDED). A trade you press yourself is exempt from both. "
  + "Promote the edge and record its capacity, or press the trade yourself.";
