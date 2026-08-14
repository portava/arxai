// Task #743 Cluster D — narrow kill-switch bypass for admin emergency-close.
//
// SAFETY (inviolable):
// - The ONLY relaxation this enables is per-user kill-switch gate #5
//   (KILL_SWITCH_ENGAGED), and ONLY for a CLOSE_LIVE_POSITION command (a
//   reduce-risk action). OPEN / MODIFY / increase-exposure NEVER qualify.
// - The bypass is honored only when a draft was stamped with a bypass marker by
//   createLiveOpsDraft, which is reachable for this purpose exclusively from the
//   admin emergency-close route (OWNER/ADMIN role + confirmation phrase +
//   read-only ownership already verified, intent audited before any dispatch).
// - The marker is part of the command payload that is integrity-hashed at draft
//   creation, so it cannot be forged after the fact without failing the
//   command-integrity pre-gate.
// - Every OTHER gate of the 18-gate Phase B evaluator still runs unchanged.

export const EMERGENCY_CLOSE_KILL_SWITCH_BYPASS_REASON =
  "EMERGENCY_CLOSE_KILL_SWITCH_BYPASS" as const;
export const ADMIN_EMERGENCY_CLOSE_SOURCE = "ADMIN_EMERGENCY_CLOSE" as const;

export interface KillSwitchCloseBypass {
  reason: string; // EMERGENCY_CLOSE_KILL_SWITCH_BYPASS
  source: string; // ADMIN_EMERGENCY_CLOSE
  initiatorAdminId: number | null;
  initiatorRole: "ADMIN" | "OWNER";
}

/**
 * Decide whether the narrow kill-switch bypass applies. Pure (no I/O). True
 * ONLY when the command is a CLOSE_LIVE_POSITION AND a bypass marker is present.
 * Any other command type (MODIFY, OPEN, …) returns false even with a marker.
 */
export function killSwitchCloseBypassApplies(args: {
  commandType: string;
  hasBypassMarker: boolean;
}): boolean {
  return args.commandType === "CLOSE_LIVE_POSITION" && args.hasBypassMarker;
}

/**
 * Compute the effective kill-switch value to feed the dispatch gate. The real
 * engaged state is only suppressed when the narrow CLOSE bypass is active; in
 * every other case the real value passes through unchanged. Pure (no I/O).
 */
export function effectiveKillSwitchEngaged(
  realKillSwitchEngaged: boolean,
  bypassActive: boolean,
): boolean {
  return realKillSwitchEngaged && !bypassActive;
}
