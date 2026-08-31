// Profit Mission Phase 9 — Automation levels (0–6) + user-type guardrails.
//
// PLANNING / GOVERNANCE ONLY. This module DESCRIBES the automation ladder and the
// per-role / per-account-type ceiling that caps how far a mission may be promoted.
// It is pure, deterministic, and IO-free. It NEVER executes, relaxes, or bypasses
// any live gate. A higher automation level only changes whether the EXISTING
// instant-trade → live-pipeline → 23-gate dispatch is reached after approval; the
// gates themselves are untouched. Live auto is opt-in, last, and never silent.
//
// LABEL HONESTY — these `description` strings are user-facing product copy, so
// they must describe what the CODE does, not what the ladder was designed to do.
// Two corrections are baked in below and must not be reverted without the
// behaviour landing first:
//   * Level 3 does not execute anywhere. A non-live mission's dispatch stops at
//     the simulated recorder in `missionExecution.ts`; there is no demo broker
//     behind this level.
//   * Level 4 has no execution behaviour distinct from levels 5–6 in the
//     mission path. Its "micro-size / tight caps" wording described an intent
//     that is not implemented as a distinct code path.
// INTEGRATOR NOTE: the sibling branch `fix/demo-ladder` may implement the demo
// leg. If it does, these labels must be revisited in the same merge.

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
    level: 3, key: "DEMO_AUTO", label: "Demo auto (simulated fills)",
    // HONEST LABEL, twice corrected. "Auto-executes on a DEMO account only" was
    // false — there is no demo broker behind this level. Its replacement,
    // "records intent only", then went stale: the default non-live executor is
    // now `simulateMissionFill` (missionSimulatedFills.ts), which prices an
    // entry from a REAL router quote and closes it against later real quotes,
    // writing the sim_* family. So this level DOES produce fills and outcomes —
    // they are modelled, never money, and never broker-reconciled.
    // NB: each sentence below is kept inside ONE string literal so the copy
    // guard can pin it without matching across a `+` concatenation.
    description:
      "Auto-approves and dispatches to the mission's simulator. "
      + "No broker account is contacted — not a live one and not a demo one — "
      + "so the fill and the profit or loss are SIMULATED: priced from real "
      + "quotes, never money, never added to broker-reconciled results. "
      + "Auto-execution against a real demo broker account is NOT YET AVAILABLE.",
    isAuto: true, reachesLive: false, requiresCertificate: false, requiresExplicitLiveEnable: false,
  },
  4: {
    level: 4, key: "MICRO_LIVE", label: "Live auto — first step",
    // HONEST LABEL. "Supervised micro-size live execution with tight caps"
    // promised a size ceiling this level does not carry: `decideAutoApproval`
    // treats levels 4, 5 and 6 identically, and no per-level lot or notional cap
    // is applied anywhere for level 4. Sizing comes from the mission's own risk
    // settings and the platform caps that apply at every level.
    description:
      "The first level that auto-executes against the live broker. It is not "
      + "size-limited by the level itself — sizing comes from your mission risk "
      + "settings and the platform-wide caps that apply at every level. "
      + "Requires the accepted certificate and explicit live opt-in.",
    isAuto: true, reachesLive: true, requiresCertificate: true, requiresExplicitLiveEnable: true,
  },
  5: {
    level: 5, key: "LIMITED_LIVE_AUTO", label: "Limited live auto",
    // Levels 4–6 share one execution path today; what differs is only how far
    // the promotion gates let a mission climb. Say that rather than implying a
    // per-level throttle that is not implemented.
    description:
      "Automated live execution. Same execution path as level 4 — the "
      + "difference is how much evidence the promotion gates demand to reach it. "
      + "Requires all promotion gates + explicit enablement.",
    isAuto: true, reachesLive: true, requiresCertificate: true, requiresExplicitLiveEnable: true,
  },
  6: {
    level: 6, key: "FULL_LIVE_AUTO", label: "Full live auto",
    description:
      "Automated live execution within your mission caps, at the highest "
      + "evidence bar. Same execution path as levels 4–5. Requires all gates + "
      + "explicit enablement.",
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
