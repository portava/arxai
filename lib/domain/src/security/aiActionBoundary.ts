// ── @workspace/domain/security — AI action boundary ─────────────────────────
// Pure, deterministic, IO-free. Encodes the inviolable rule that NO AI surface
// may directly execute a sensitive action. Every AI-initiated sensitive action
// must travel the full approved path:
//   intent creation → permission check → AACI security handshake →
//   (Risk Governor / 16-gate downstream) → audit log → approved execution route
//   → post-action reconciliation.
//
// SAFETY:
//   - Ruby (the read-only assistant) and the Scanner are READ-ONLY actors: they
//     can NEVER directly execute a sensitive action, regardless of path markers.
//   - Other AI actors (Self-Trade / agents) are allowed ONLY when every required
//     path step is satisfied. Missing any step ⇒ blocked.
//   - DEFAULT-DENY: an unknown/absent actor is blocked.
//   - ADDITIVE: this only ever ADDS a block. It never relaxes a downstream gate.

import { SENSITIVE_ACTIONS, type SensitiveAction } from "./handshake.js";

export type AiActorKind = "ruby" | "scanner" | "self_trade" | "agent" | "unknown";

export interface AiActionBoundaryInput {
  /** Which AI surface initiated the action. */
  actorKind: AiActorKind;
  /** The sensitive action being attempted. */
  action: SensitiveAction;
  /** An intent/draft row was created (not a direct placement). */
  intentCreated: boolean;
  /** A permission check was performed for the caller. */
  permissionChecked: boolean;
  /** The AACI security handshake returned a non-BLOCK verdict. */
  handshakePassed: boolean;
  /** An audit log row was written for the action. */
  auditWritten: boolean;
  /** The action was routed through the approved executor (not a direct call). */
  viaApprovedRoute: boolean;
}

export interface AiActionBoundaryVerdict {
  allowed: boolean;
  /** Stable machine code when blocked; null when allowed. */
  blockCode: string | null;
  /** Short human reason (safe for an admin log; not necessarily user copy). */
  reason: string;
  /** Which required path steps were missing (empty when allowed/read-only). */
  missing: string[];
}

const READ_ONLY_ACTORS: ReadonlySet<AiActorKind> = new Set<AiActorKind>(["ruby", "scanner"]);

/**
 * Evaluate whether an AI-initiated sensitive action may proceed. Pure and
 * deterministic. Read-only actors and unknown actors are always blocked; other
 * AI actors are allowed only when the full approved path is satisfied.
 */
export function evaluateAiActionBoundary(input: AiActionBoundaryInput): AiActionBoundaryVerdict {
  // DEFAULT-DENY: unknown/absent actor.
  if (!input || !input.actorKind || input.actorKind === "unknown") {
    return {
      allowed: false,
      blockCode: "AI_ACTOR_UNKNOWN",
      reason: "Unknown AI actor cannot initiate a sensitive action.",
      missing: ["known_actor"],
    };
  }

  const label = SENSITIVE_ACTIONS[input.action]?.label ?? input.action;

  // Ruby / Scanner are strictly read-only — no path markers can grant execution.
  if (READ_ONLY_ACTORS.has(input.actorKind)) {
    return {
      allowed: false,
      blockCode: "AI_READ_ONLY_ACTOR",
      reason: `${input.actorKind} is read-only and cannot execute "${label}".`,
      missing: ["read_only_actor_cannot_execute"],
    };
  }

  // Self-Trade / agent: require every approved-path step.
  const missing: string[] = [];
  if (!input.intentCreated) missing.push("intent");
  if (!input.permissionChecked) missing.push("permission");
  if (!input.handshakePassed) missing.push("handshake");
  if (!input.auditWritten) missing.push("audit");
  if (!input.viaApprovedRoute) missing.push("approved_route");

  if (missing.length > 0) {
    return {
      allowed: false,
      blockCode: "AI_DIRECT_EXECUTION_BLOCKED",
      reason: `AI-initiated "${label}" missing required path steps: ${missing.join(", ")}.`,
      missing,
    };
  }

  return {
    allowed: true,
    blockCode: null,
    reason: `AI-initiated "${label}" routed through the approved path.`,
    missing: [],
  };
}
