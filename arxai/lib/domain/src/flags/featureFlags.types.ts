import { z } from "zod/v4";

// ── The 5 flags ─────────────────────────────────────────────────────────────
export const FeatureFlagSchema = z.enum([
  "LIVE_TRADING_ENABLED",          // master kill switch: real money vs demo
  "AI_AUTO_EXECUTION_ENABLED",     // AI may execute without human approval
  "SNIPER_MODE_ENABLED",           // only sniper-entry strategy runs
  "NEWS_LOCKOUT_ENABLED",          // news-avoidance suppresses other strategies
  "EXPERIMENTAL_STRATEGIES_ENABLED", // gates strategies marked experimental
]);
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

// ── Per-flag state with full audit ──────────────────────────────────────────
export const FeatureFlagStateSchema = z.object({
  flag: FeatureFlagSchema,
  enabled: z.boolean(),
  setBy: z.string().nullable(),               // operator id / "system" / "default"
  setAt: z.union([z.date(), z.string()]),     // ISO
  reason: z.string().nullable(),
  requiresConfirmation: z.boolean(),          // last change required multi-step confirm
});
export type FeatureFlagState = z.infer<typeof FeatureFlagStateSchema>;

// ── Set of all flags, keyed by name ─────────────────────────────────────────
export type FeatureFlagSet = Record<FeatureFlag, FeatureFlagState>;

// ── Static metadata per flag ────────────────────────────────────────────────
// Drives UI rendering, confirmation flows, and dependency checks.
export interface FeatureFlagMetadata {
  flag: FeatureFlag;
  label: string;
  description: string;
  defaultEnabled: boolean;
  danger: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requiresConfirmation: boolean;              // UI must require multi-step toggle
  requiresLive: boolean;                      // toggle only meaningful when LIVE_TRADING_ENABLED
  affects: string[];                          // human-readable: what this flag controls
}

export const FEATURE_FLAG_META: Record<FeatureFlag, FeatureFlagMetadata> = {
  LIVE_TRADING_ENABLED: {
    flag: "LIVE_TRADING_ENABLED",
    label: "Live Trading",
    description: "Master switch. When OFF the bot runs in MOCK mode and no real broker calls are made.",
    defaultEnabled: false,                    // safe default: demo mode
    danger: "CRITICAL",
    requiresConfirmation: true,
    requiresLive: false,
    affects: ["broker execution", "all order placement"],
  },
  AI_AUTO_EXECUTION_ENABLED: {
    flag: "AI_AUTO_EXECUTION_ENABLED",
    label: "AI Auto-Execution",
    description: "Allow AI-approved signals to be sent to the broker without human approval.",
    defaultEnabled: false,
    danger: "HIGH",
    requiresConfirmation: true,
    requiresLive: true,
    affects: ["pipeline PLACE stage", "operator queue bypass"],
  },
  SNIPER_MODE_ENABLED: {
    flag: "SNIPER_MODE_ENABLED",
    label: "Sniper Mode",
    description: "Run only the sniper-entry strategy. All other strategies are disabled.",
    defaultEnabled: false,
    danger: "MEDIUM",
    requiresConfirmation: false,
    requiresLive: false,
    affects: ["strategy registry filtering"],
  },
  NEWS_LOCKOUT_ENABLED: {
    flag: "NEWS_LOCKOUT_ENABLED",
    label: "News Lockout",
    description: "Block all signals during HIGH/MEDIUM news windows.",
    defaultEnabled: true,
    danger: "LOW",
    requiresConfirmation: false,
    requiresLive: false,
    affects: ["news-avoidance strategy", "NEWS_LOCKOUT risk gate"],
  },
  EXPERIMENTAL_STRATEGIES_ENABLED: {
    flag: "EXPERIMENTAL_STRATEGIES_ENABLED",
    label: "Experimental Strategies",
    description: "Permit strategies tagged 'experimental' to run.",
    defaultEnabled: false,
    danger: "MEDIUM",
    requiresConfirmation: true,
    requiresLive: false,
    affects: ["strategy registry filtering"],
  },
};

// ── Flag change validation ──────────────────────────────────────────────────
export interface FlagChangeRequest {
  flag: FeatureFlag;
  enabled: boolean;
  setBy: string;
  reason: string | null;
  confirmedBy?: string;             // present when multi-step confirm satisfied
}

export interface FlagChangeValidation {
  ok: boolean;
  reasons: string[];
}
