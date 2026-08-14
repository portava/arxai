import {
  type ModeCapabilities, type SystemMode, ROLLOUT_SEQUENCE,
} from "./systemMode.types";

// describeMode — pure function returning the capability set for a mode.
// This is the authoritative table of what each mode allows. Every other
// engine (authority, routing, rollout, lockdown) reads from here.
//
// Defensive: maxSizeLots NEVER exceeds the mode's real-exec ceiling
// even if a caller-provided override would push it higher.
export function describeMode(mode: SystemMode): ModeCapabilities {
  switch (mode) {
    case "OBSERVE_ONLY":
      return { canSuggest: false, canPaperTrade: false, canShadowTrade: false, canExecuteReal: false,
               maxSizeLots: 0, requiresGovernorApproval: true, requiresHumanApproval: false };
    case "SUGGEST_ONLY":
      return { canSuggest: true, canPaperTrade: false, canShadowTrade: false, canExecuteReal: false,
               maxSizeLots: 0, requiresGovernorApproval: true, requiresHumanApproval: true };
    case "SHADOW_TRADING":
      return { canSuggest: true, canPaperTrade: false, canShadowTrade: true, canExecuteReal: false,
               maxSizeLots: 0, requiresGovernorApproval: true, requiresHumanApproval: false };
    case "PAPER_TRADING":
      return { canSuggest: true, canPaperTrade: true, canShadowTrade: true, canExecuteReal: false,
               maxSizeLots: 0, requiresGovernorApproval: true, requiresHumanApproval: false };
    case "MICRO_LOT_LIVE":
      return { canSuggest: true, canPaperTrade: true, canShadowTrade: true, canExecuteReal: true,
               maxSizeLots: 0.10, requiresGovernorApproval: true, requiresHumanApproval: false };
    case "LIMITED_AUTO":
      return { canSuggest: true, canPaperTrade: true, canShadowTrade: true, canExecuteReal: true,
               maxSizeLots: 0.50, requiresGovernorApproval: true, requiresHumanApproval: false };
    case "FULL_AUTO_GOVERNED":
      return { canSuggest: true, canPaperTrade: true, canShadowTrade: true, canExecuteReal: true,
               maxSizeLots: Number.POSITIVE_INFINITY, requiresGovernorApproval: true, requiresHumanApproval: false };
    case "LOCKDOWN":
      return { canSuggest: false, canPaperTrade: false, canShadowTrade: false, canExecuteReal: false,
               maxSizeLots: 0, requiresGovernorApproval: true, requiresHumanApproval: true };
    case "RECOVERY_MODE":
      return { canSuggest: true, canPaperTrade: true, canShadowTrade: true, canExecuteReal: true,
               maxSizeLots: 0.05, requiresGovernorApproval: true, requiresHumanApproval: true };
  }
}

// isValidRolloutTransition — guards the gradual promotion path. Within
// ROLLOUT_SEQUENCE, only adjacent transitions allowed (one step at a
// time). LOCKDOWN/RECOVERY transitions are handled by their own engines
// and are NOT permitted via this function.
export function isValidRolloutTransition(from: SystemMode, to: SystemMode): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (from === "LOCKDOWN" || from === "RECOVERY_MODE" || to === "LOCKDOWN" || to === "RECOVERY_MODE") {
    return { valid: false, reasons: [`LOCKDOWN/RECOVERY transitions not allowed via rollout — use lockdown.engine / recoveryMode.engine`] };
  }
  const fromIdx = ROLLOUT_SEQUENCE.indexOf(from);
  const toIdx = ROLLOUT_SEQUENCE.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) {
    return { valid: false, reasons: [`mode not in rollout sequence: from=${from} to=${to}`] };
  }
  if (Math.abs(toIdx - fromIdx) !== 1) {
    return { valid: false, reasons: [`only adjacent rollout transitions allowed (from idx ${fromIdx} to idx ${toIdx})`] };
  }
  reasons.push(`${from} → ${to} is a valid adjacent rollout transition`);
  return { valid: true, reasons };
}

// nextRolloutMode / prevRolloutMode — returns the adjacent mode in the
// rollout sequence, or null if at the end.
export function nextRolloutMode(mode: SystemMode): SystemMode | null {
  const idx = ROLLOUT_SEQUENCE.indexOf(mode);
  if (idx < 0 || idx >= ROLLOUT_SEQUENCE.length - 1) return null;
  return ROLLOUT_SEQUENCE[idx + 1] ?? null;
}
export function prevRolloutMode(mode: SystemMode): SystemMode | null {
  const idx = ROLLOUT_SEQUENCE.indexOf(mode);
  if (idx <= 0) return null;
  return ROLLOUT_SEQUENCE[idx - 1] ?? null;
}
