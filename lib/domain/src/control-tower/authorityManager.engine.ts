import {
  type AiRole, type AuthorityCheck, type AuthorityScope, type SystemMode,
} from "./systemMode.types";
import { describeMode } from "./systemMode.engine";

// checkAuthority — central authorization gate. Combines two checks
// (defense in depth — both must pass):
//
//   1. Role permission: hard-coded per-role scope whitelist that is
//      INVARIANT across modes:
//        RESEARCH_AI    → only RESEARCH (NEVER live execution)
//        AUDIT_AI       → only ANALYSIS (NEVER execution)
//        EXECUTION_AI   → all execution scopes (mode still gates)
//        HUMAN_OPERATOR → all scopes (operator override path)
//
//   2. Mode permission: the current SystemMode must allow the scope.
//      LOCKDOWN denies everything except MODE_CHANGE (so operator
//      can release it).
//
// Both checks fail-closed.
export function checkAuthority(role: AiRole, scope: AuthorityScope, mode: SystemMode): AuthorityCheck {
  const reasons: string[] = [];

  // ── Gate 1: role permission (mode-invariant) ────────────────────────
  if (!isScopePermittedForRole(role, scope)) {
    return {
      verdict: "DENIED", role, scope, mode,
      reasons: [`role ${role} is NEVER permitted scope ${scope} in any mode`],
    };
  }
  reasons.push(`role ${role} permitted scope ${scope} (mode-invariant gate passed)`);

  // ── Gate 2: mode permission ─────────────────────────────────────────
  const modeAllows = isScopeAllowedInMode(scope, mode);
  if (!modeAllows.allowed) {
    return { verdict: "DENIED", role, scope, mode,
      reasons: [...reasons, ...modeAllows.reasons] };
  }
  reasons.push(...modeAllows.reasons);
  return { verdict: "AUTHORIZED", role, scope, mode, reasons };
}

// Hard-coded role × scope matrix. Enforced as INVARIANT across modes —
// no mode can grant Research AI live execution authority.
function isScopePermittedForRole(role: AiRole, scope: AuthorityScope): boolean {
  switch (role) {
    case "RESEARCH_AI":
      return scope === "RESEARCH";
    case "AUDIT_AI":
      return scope === "ANALYSIS";
    case "EXECUTION_AI":
      return scope === "PAPER_EXECUTE"
          || scope === "SHADOW_EXECUTE"
          || scope === "LIVE_EXECUTE_MICRO"
          || scope === "LIVE_EXECUTE_LIMITED"
          || scope === "LIVE_EXECUTE_FULL"
          || scope === "SUGGEST";
    case "HUMAN_OPERATOR":
      return true;                      // human can request any scope (mode still gates)
  }
}

function isScopeAllowedInMode(scope: AuthorityScope, mode: SystemMode): { allowed: boolean; reasons: string[] } {
  // LOCKDOWN denies everything except MODE_CHANGE (operator must be able
  // to release lockdown).
  if (mode === "LOCKDOWN") {
    if (scope === "MODE_CHANGE") return { allowed: true, reasons: [`LOCKDOWN allows only MODE_CHANGE`] };
    return { allowed: false, reasons: [`LOCKDOWN denies scope ${scope}`] };
  }

  // MODE_CHANGE always allowed (caller must have appropriate role)
  if (scope === "MODE_CHANGE") return { allowed: true, reasons: [`MODE_CHANGE always permitted by mode`] };

  const cap = describeMode(mode);
  switch (scope) {
    case "RESEARCH":  return { allowed: true, reasons: [`RESEARCH permitted in all non-LOCKDOWN modes`] };
    case "ANALYSIS":  return { allowed: true, reasons: [`ANALYSIS permitted in all non-LOCKDOWN modes`] };
    case "SUGGEST":   return cap.canSuggest
                           ? { allowed: true, reasons: [`mode ${mode} allows suggestions`] }
                           : { allowed: false, reasons: [`mode ${mode} does not allow suggestions`] };
    case "SHADOW_EXECUTE":  return cap.canShadowTrade
                           ? { allowed: true, reasons: [`mode ${mode} allows shadow trading`] }
                           : { allowed: false, reasons: [`mode ${mode} does not allow shadow trading`] };
    case "PAPER_EXECUTE":   return cap.canPaperTrade
                           ? { allowed: true, reasons: [`mode ${mode} allows paper trading`] }
                           : { allowed: false, reasons: [`mode ${mode} does not allow paper trading`] };
    case "LIVE_EXECUTE_MICRO":
    case "LIVE_EXECUTE_LIMITED":
    case "LIVE_EXECUTE_FULL": {
      if (!cap.canExecuteReal) return { allowed: false, reasons: [`mode ${mode} does not allow real execution`] };
      // size-tier alignment with mode cap
      const requested = scope === "LIVE_EXECUTE_MICRO" ? 0.10
                      : scope === "LIVE_EXECUTE_LIMITED" ? 0.50
                      : Number.POSITIVE_INFINITY;
      if (requested > cap.maxSizeLots) {
        return { allowed: false, reasons: [`scope ${scope} (req ${requested === Number.POSITIVE_INFINITY ? "∞" : requested} lots) exceeds mode ${mode} cap ${cap.maxSizeLots} lots`] };
      }
      return { allowed: true, reasons: [`mode ${mode} allows real execution up to ${cap.maxSizeLots} lots`] };
    }
  }
}
