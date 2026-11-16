// Profit Mission Phase 9 — Automation levels (0–6) + user-type guardrails.
//
// PLANNING / GOVERNANCE ONLY. This module DESCRIBES the automation ladder and the
// per-role / per-account-type ceiling that caps how far a mission may be promoted.
// It is pure, deterministic, and IO-free. It NEVER executes, relaxes, or bypasses
// any live gate. A higher automation level only changes whether the EXISTING
// instant-trade → live-pipeline → 18-gate dispatch is reached after approval; the
// gates themselves are untouched. Live auto is opt-in, last, and never silent.

export const MISSION_AUTOMATION_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;
export type MissionAutomationLevel = (typeof MISSION_AUTOMATION_LEVELS)[number];

export function isMissionAutomationLevel(n: unknown): n is MissionAutomationLevel {
  return typeof n === "number" && (MISSION_AUTOMATION_LEVELS as readonly number[]).includes(n);
}

export interface AutomationLevelMeta {
  level: MissionAutomationLevel;
  key: string;
  label: string;
  description: string;
  /** Whether this level auto-executes (no per-trade user approval). */
  isAuto: boolean;
  /** Whether this level can ever reach the LIVE broker (vs paper/demo only). */
  reachesLive: boolean;
  /** Whether this level requires an accepted Mission Risk Certificate. */
  requiresCertificate: boolean;
  /** Whether this level requires explicit user enablement of live auto. */
  requiresExplicitLiveEnable: boolean;
}

// The ladder. Level 2 (approval) is the safe default for every mission.
export const AUTOMATION_LEVEL_META: Record<MissionAutomationLevel, AutomationLevelMeta> = {
  0: {
    level: 0, key: "OFF", label: "Off",
    description: "Mission is planned only. No suggestions act and nothing is executed.",
    isAuto: false, reachesLive: false, requiresCertificate: false, requiresExplicitLiveEnable: false,
  },
  1: {
    level: 1, key: "ADVISORY", label: "Advisory",
    description: "Agents surface proposals for you to review. Nothing executes automatically.",
    isAuto: false, reachesLive: false, requiresCertificate: false, requiresExplicitLiveEnable: false,
  },
  2: {
    level: 2, key: "APPROVAL", label: "Approval (default)",
    description: "Every trade waits for your explicit approval before it is placed.",
    isAuto: false, reachesLive: true, requiresCertificate: false, requiresExplicitLiveEnable: false,
  },
  3: {
    level: 3, key: "DEMO_AUTO", label: "Demo auto",
    description: "Auto-executes on a DEMO account only. The live broker is never contacted.",
    isAuto: true, reachesLive: false, requiresCertificate: false, requiresExplicitLiveEnable: false,
  },
  4: {
    level: 4, key: "MICRO_LIVE", label: "Supervised micro-live",
    description: "Supervised micro-size live execution with tight caps. Certificate required.",
    isAuto: true, reachesLive: true, requiresCertificate: true, requiresExplicitLiveEnable: true,
  },
  5: {
    level: 5, key: "LIMITED_LIVE_AUTO", label: "Limited live auto",
    description: "Limited automated live execution. Requires all promotion gates + explicit enablement.",
    isAuto: true, reachesLive: true, requiresCertificate: true, requiresExplicitLiveEnable: true,
  },
  6: {
    level: 6, key: "FULL_LIVE_AUTO", label: "Full live auto",
    description: "Full automated live execution within mission caps. Requires all gates + explicit enablement.",
    isAuto: true, reachesLive: true, requiresCertificate: true, requiresExplicitLiveEnable: true,
  },
};

export const DEFAULT_MISSION_AUTOMATION_LEVEL: MissionAutomationLevel = 2;

/** The lowest level that auto-executes against the LIVE broker. */
export const FIRST_LIVE_AUTO_LEVEL: MissionAutomationLevel = 4;

export function metaForLevel(level: MissionAutomationLevel): AutomationLevelMeta {
  return AUTOMATION_LEVEL_META[level];
}

// ── User-type guardrails ────────────────────────────────────────────────────
//
// Each (role, account-type, tenure) tuple maps to a hard ceiling on how far the
// automation level may be raised. These are STRICTER-ONLY caps; the promotion
// gate evaluator can never exceed them. Investor / pool contexts additionally
// require full audit. Owner/admin get a higher ceiling but can NEVER fabricate
// feed/live data — that honesty is enforced elsewhere (this only caps the level).

export type MissionAccountType = "paper" | "demo" | "live";

export interface GuardrailInput {
  /** Normalized product role (e.g. OWNER, ADMIN, TRADER, INVESTOR, VIEWER). */
  role: string;
  accountType: MissionAccountType;
  /** True if the user is new (no proven trading history on the platform). */
  isNewUser: boolean;
}

export interface GuardrailCeiling {
  maxLevel: MissionAutomationLevel;
  /** True when every mission action must be fully audited (investor/pool). */
  auditRequired: boolean;
  reasons: string[];
}

function normalizeRole(role: string): string {
  return (role || "").trim().toUpperCase();
}

/**
 * Resolve the hard automation ceiling for a user. Fail-closed: an unrecognized
 * role gets the strictest non-auto ceiling (APPROVAL).
 */
export function resolveGuardrailCeiling(input: GuardrailInput): GuardrailCeiling {
  const reasons: string[] = [];
  const role = normalizeRole(input.role);

  // Base ceiling by role.
  let maxLevel: MissionAutomationLevel;
  let auditRequired = false;

  switch (role) {
    case "OWNER":
    case "ADMIN":
      maxLevel = 6;
      reasons.push(`role ${role}: full ladder available (still cannot fabricate feed/live data)`);
      break;
    case "TRADER":
    case "USER":
      maxLevel = 6;
      reasons.push(`role ${role}: full ladder available subject to promotion gates`);
      break;
    case "INVESTOR":
    case "POOL":
      maxLevel = 2;
      auditRequired = true;
      reasons.push(`role ${role}: approval-only ceiling + full audit required`);
      break;
    case "VIEWER":
      maxLevel = 1;
      reasons.push(`role ${role}: advisory ceiling (read-only)`);
      break;
    default:
      maxLevel = 2;
      reasons.push(`unrecognized role '${input.role || "(none)"}' — fail-closed to approval ceiling`);
  }

  // New users: never auto, cap at APPROVAL — they must earn promotion with history.
  if (input.isNewUser && maxLevel > DEFAULT_MISSION_AUTOMATION_LEVEL) {
    maxLevel = DEFAULT_MISSION_AUTOMATION_LEVEL;
    reasons.push("new user: capped at approval mode until a proven track record exists");
  }

  // Paper/demo account can never reach a live-auto level — clamp to demo-auto.
  if (input.accountType !== "live" && maxLevel > 3) {
    maxLevel = 3;
    reasons.push(`account type '${input.accountType}': live-auto levels unavailable (clamped to demo auto)`);
  }

  return { maxLevel, auditRequired, reasons };
}
