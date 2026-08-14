import {
  FEATURE_FLAG_META,
} from "./featureFlags.types";
import type {
  FeatureFlag, FeatureFlagSet, FeatureFlagState,
  FlagChangeRequest, FlagChangeValidation,
} from "./featureFlags.types";

// ── Build the default flag set (used at boot / on reset) ───────────────────
export function buildDefaultFlags(now: Date = new Date()): FeatureFlagSet {
  const at = now.toISOString();
  const entries = (Object.keys(FEATURE_FLAG_META) as FeatureFlag[]).map((flag) => {
    const meta = FEATURE_FLAG_META[flag];
    const state: FeatureFlagState = {
      flag, enabled: meta.defaultEnabled,
      setBy: "default", setAt: at,
      reason: "Initial default",
      requiresConfirmation: meta.requiresConfirmation,
    };
    return [flag, state] as const;
  });
  return Object.fromEntries(entries) as FeatureFlagSet;
}

// ── Pure check ─────────────────────────────────────────────────────────────
export function isFlagEnabled(flags: FeatureFlagSet, flag: FeatureFlag): boolean {
  return flags[flag]?.enabled ?? false;
}

// ── Validate a change request before applying ──────────────────────────────
//   • CRITICAL/HIGH danger flags require setBy
//   • requiresConfirmation flags must include confirmedBy distinct from setBy
//   • requiresLive flags can only be ENABLED while LIVE_TRADING_ENABLED is on
//   • LIVE_TRADING_ENABLED cannot be turned OFF while there are dependent
//     flags still enabled (caller must turn those off first)
export function validateFlagChange(
  flags: FeatureFlagSet,
  req: FlagChangeRequest,
): FlagChangeValidation {
  const reasons: string[] = [];
  const meta = FEATURE_FLAG_META[req.flag];

  if (!req.setBy || req.setBy.trim() === "") {
    reasons.push("setBy is required");
  }

  if (meta.requiresConfirmation) {
    if (!req.confirmedBy) {
      reasons.push(`${meta.label} requires multi-step confirmation`);
    } else if (req.confirmedBy === req.setBy) {
      reasons.push("confirmedBy must be a different operator from setBy");
    }
  }

  if (req.enabled && meta.requiresLive && !isFlagEnabled(flags, "LIVE_TRADING_ENABLED")) {
    reasons.push(`${meta.label} can only be enabled while Live Trading is enabled`);
  }

  if (req.flag === "LIVE_TRADING_ENABLED" && req.enabled === false) {
    const dependents = (Object.keys(FEATURE_FLAG_META) as FeatureFlag[])
      .filter((f) => FEATURE_FLAG_META[f].requiresLive && isFlagEnabled(flags, f))
      .map((f) => FEATURE_FLAG_META[f].label);
    if (dependents.length > 0) {
      reasons.push(`Disable dependent flags first: ${dependents.join(", ")}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// ── Apply a change — returns a new set; never mutates ──────────────────────
export interface FlagChangeResult {
  ok: boolean;
  flags: FeatureFlagSet;
  applied: FeatureFlagState | null;
  reasons: string[];
}

export function applyFlagChange(
  flags: FeatureFlagSet,
  req: FlagChangeRequest,
  now: Date = new Date(),
): FlagChangeResult {
  const validation = validateFlagChange(flags, req);
  if (!validation.ok) {
    return { ok: false, flags, applied: null, reasons: validation.reasons };
  }
  const meta = FEATURE_FLAG_META[req.flag];
  const next: FeatureFlagState = {
    flag: req.flag,
    enabled: req.enabled,
    setBy: req.setBy,
    setAt: now.toISOString(),
    reason: req.reason,
    requiresConfirmation: meta.requiresConfirmation,
  };
  return {
    ok: true,
    flags: { ...flags, [req.flag]: next },
    applied: next,
    reasons: [],
  };
}

// ── Strategy registry filtering driven by flags ────────────────────────────
// Reusable shape — the strategies subdomain's Strategy satisfies this.
export interface StrategyRef {
  name: string;
  experimental?: boolean;
}

export function filterStrategiesByFlags<T extends StrategyRef>(
  strategies: T[],
  flags: FeatureFlagSet,
): { included: T[]; excluded: Array<{ strategy: T; reason: string }> } {
  const included: T[] = [];
  const excluded: Array<{ strategy: T; reason: string }> = [];

  const sniperOnly = isFlagEnabled(flags, "SNIPER_MODE_ENABLED");
  const allowExperimental = isFlagEnabled(flags, "EXPERIMENTAL_STRATEGIES_ENABLED");
  const newsLockout = isFlagEnabled(flags, "NEWS_LOCKOUT_ENABLED");

  for (const s of strategies) {
    if (sniperOnly && s.name !== "sniper-entry") {
      excluded.push({ strategy: s, reason: "Sniper Mode active — only sniper-entry runs" });
      continue;
    }
    if (s.experimental && !allowExperimental) {
      excluded.push({ strategy: s, reason: "Experimental strategies disabled" });
      continue;
    }
    if (s.name === "news-avoidance" && !newsLockout) {
      excluded.push({ strategy: s, reason: "News Lockout disabled" });
      continue;
    }
    included.push(s);
  }
  return { included, excluded };
}

// ── Quick predicate for the PLACE stage ────────────────────────────────────
// Returns true when a signal may be auto-executed without human approval.
export function mayAutoExecute(flags: FeatureFlagSet): boolean {
  return isFlagEnabled(flags, "LIVE_TRADING_ENABLED")
      && isFlagEnabled(flags, "AI_AUTO_EXECUTION_ENABLED");
}

// ── Aggregate operating mode for the UI banner ─────────────────────────────
export type OperatingMode = "MOCK" | "LIVE_MANUAL" | "LIVE_AUTO";

export function operatingMode(flags: FeatureFlagSet): OperatingMode {
  if (!isFlagEnabled(flags, "LIVE_TRADING_ENABLED")) return "MOCK";
  if (isFlagEnabled(flags, "AI_AUTO_EXECUTION_ENABLED")) return "LIVE_AUTO";
  return "LIVE_MANUAL";
}
