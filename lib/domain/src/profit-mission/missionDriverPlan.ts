// Profit Mission F-build — pure driver tick planner (decides, never executes).
//
// SAFETY / SCOPE:
//   - PURE, DETERMINISTIC, IO-FREE. Given a snapshot of one mission's state and
//     the clock, this decides WHAT the driver worker should do this tick:
//     expire, pause on a risk stop, refresh protection, or advance (manage
//     exits → refresh → scan → auto-draft → auto-dispatch). It never touches a
//     gate, an order, or the DB — the api-server driver composes these
//     decisions over the EXISTING gated services, and every one of those
//     services re-runs its own gates regardless of what this plan says.
//   - FAIL-CLOSED. An unknown status, an unknown mode, or any missing evidence
//     resolves to the strictest decision (no auto steps, honest block reasons).
//     Auto-approval is re-decided from CURRENT row state at act time; nothing
//     here is a standing permission.
//   - The auto ladder truth: levels 0–1 never draft; level 2 (default) drafts
//     but ALWAYS waits for the user's press; level 3 auto-runs only a non-live
//     mission; levels 4–6 may auto-run a live mission ONLY when live auto is
//     explicitly enabled, the certificate is accepted, the promotion gate
//     approves, drift is not SEVERE, and the platform live gates are on. A
//     "yes" here still only reaches the broker through dispatchApprovedDraft →
//     executeInstant → 23-gate dispatch, which re-checks everything again.

import {
  isMissionAutomationLevel,
  metaForLevel,
  FIRST_LIVE_AUTO_LEVEL,
  type MissionAutomationLevel,
} from "./missionAutomation.js";
import { isMissionStatus, isTerminalStatus, canTransition } from "./stateMachine.js";
import type { DriftSeverity } from "./missionDriftDetector.js";

/** Execution modes a mission can run in (validated in app code, not a DB enum). */
export type MissionExecutionMode = "paper" | "demo" | "live";

export function isMissionExecutionMode(v: unknown): v is MissionExecutionMode {
  return v === "paper" || v === "demo" || v === "live";
}

/** Evidence the driver must re-resolve from the CURRENT row at act time. */
export interface AutoApprovalInput {
  automationLevel: number;
  executionMode: string;
  /** Explicit user opt-in flag for live auto (mission.liveAutoEnabled). */
  liveAutoEnabled: boolean;
  /** Mission Risk Certificate accepted (mission.certificateAcceptedAt != null). */
  certificateAccepted: boolean;
  /** Promotion gate decision for the CURRENT level, re-evaluated this tick. */
  promotionApproved: boolean;
  /** Latest drift severity (UNKNOWN when either test side is missing). */
  driftSeverity: DriftSeverity;
  /** Platform live master switch (env AND db) — read fresh, never cached. */
  liveGatesEnabled: boolean;
}

export interface AutoApprovalDecision {
  /** True only when the driver may approve a draft WITHOUT a user press. */
  allowed: boolean;
  level: MissionAutomationLevel | null;
  executionMode: MissionExecutionMode | null;
  /** True when an allowed approval would feed a LIVE dispatch. */
  reachesLive: boolean;
  blockReasons: string[];
}

/**
 * Decide whether the driver may create AND approve a draft without a user
 * press, for a mission in its CURRENT state. Fail-closed on every unknown.
 */
export function decideAutoApproval(input: AutoApprovalInput): AutoApprovalDecision {
  const blockReasons: string[] = [];

  const level = isMissionAutomationLevel(input.automationLevel) ? input.automationLevel : null;
  const mode = isMissionExecutionMode(input.executionMode) ? input.executionMode : null;
  if (level == null) blockReasons.push("UNKNOWN_AUTOMATION_LEVEL");
  if (mode == null) blockReasons.push("UNKNOWN_EXECUTION_MODE");
  if (level == null || mode == null) {
    return { allowed: false, level, executionMode: mode, reachesLive: false, blockReasons };
  }

  const meta = metaForLevel(level);
  if (!meta.isAuto) {
    // Levels 0–2: the user's press is the approval. Level 2 still drafts via
    // the normal scan/approve surfaces; the driver never approves for them.
    blockReasons.push("LEVEL_REQUIRES_USER_APPROVAL");
    return { allowed: false, level, executionMode: mode, reachesLive: false, blockReasons };
  }

  const wouldReachLive = mode === "live";

  // Level 3 (demo auto) can NEVER drive a live-mode mission.
  if (level < FIRST_LIVE_AUTO_LEVEL && wouldReachLive) {
    blockReasons.push("DEMO_AUTO_CANNOT_DRIVE_LIVE_MISSION");
    return { allowed: false, level, executionMode: mode, reachesLive: false, blockReasons };
  }

  // SEVERE drift always blocks auto approval (the drift service also demotes;
  // this covers the window between ticks).
  if (input.driftSeverity === "SEVERE") blockReasons.push("SEVERE_DRIFT");

  // The promotion gate for the CURRENT level must still approve at act time.
  if (!input.promotionApproved) blockReasons.push("PROMOTION_GATE_NOT_APPROVED");

  // Live-auto levels on a live-mode mission: every live gate, re-checked now.
  if (wouldReachLive) {
    if (!input.liveAutoEnabled) blockReasons.push("LIVE_AUTO_NOT_ENABLED");
    if (!input.certificateAccepted) blockReasons.push("CERTIFICATE_NOT_ACCEPTED");
    if (!input.liveGatesEnabled) blockReasons.push("LIVE_GATES_DISABLED");
  }

  const allowed = blockReasons.length === 0;
  return {
    allowed,
    level,
    executionMode: mode,
    reachesLive: allowed && wouldReachLive,
    blockReasons,
  };
}

/** One mission's snapshot the worker feeds the tick planner. */
export interface MissionTickInput {
  status: string;
  timeframeEndMs: number;
  nowMs: number;
  /** Target stop+lock already reached (protection read). */
  targetReached: boolean;
  /** Emergency stop triggered in the risk read. */
  emergencyTriggered: boolean;
  /** Blow-up ladder demands a pause/stop, or the governor mode is "stop". */
  riskStopRequired: boolean;
  auto: AutoApprovalInput;
}

export type MissionTickStep =
  | "manage_exits"
  | "refresh_protection"
  | "scan"
  | "auto_approve"
  | "auto_dispatch";

export type MissionTickAction =
  | "none" // terminal / unknown — leave the row untouched
  | "expire" // timeframe over → transition to expired (journaled)
  | "pause" // risk stop → protective pause; exits still managed
  | "advance"; // normal tick

export interface MissionTickPlan {
  action: MissionTickAction;
  /** Ordered steps the worker composes over the existing gated services. */
  steps: MissionTickStep[];
  autoApproval: AutoApprovalDecision;
  reasons: string[];
}

const NO_AUTO: AutoApprovalDecision = {
  allowed: false,
  level: null,
  executionMode: null,
  reachesLive: false,
  blockReasons: ["NOT_EVALUATED"],
};

/**
 * Plan one driver tick for one mission. Protective steps (exit management,
 * protection refresh) always come BEFORE any new-risk step, and new risk is
 * planned only for a running mission whose auto decision passes every check.
 */
export function planMissionTick(input: MissionTickInput): MissionTickPlan {
  const reasons: string[] = [];

  if (!isMissionStatus(input.status)) {
    return { action: "none", steps: [], autoApproval: NO_AUTO, reasons: ["UNKNOWN_STATUS"] };
  }
  if (isTerminalStatus(input.status)) {
    return { action: "none", steps: [], autoApproval: NO_AUTO, reasons: ["TERMINAL_STATUS"] };
  }

  // Timeframe over → expire, when the state machine allows that edge. Protective
  // exit management still runs so an open position is never orphaned unmanaged.
  if (input.timeframeEndMs <= input.nowMs) {
    if (canTransition(input.status, "expired")) {
      return {
        action: "expire",
        steps: ["manage_exits", "refresh_protection"],
        autoApproval: NO_AUTO,
        reasons: ["TIMEFRAME_ENDED"],
      };
    }
    reasons.push("TIMEFRAME_ENDED_NO_EXPIRE_EDGE");
  }

  // Target already reached → refresh only (the protection service performs the
  // completed flip + profit lock itself); never plan new risk past the goal.
  if (input.targetReached) {
    return {
      action: "advance",
      steps: ["manage_exits", "refresh_protection"],
      autoApproval: NO_AUTO,
      reasons: [...reasons, "TARGET_REACHED"],
    };
  }

  // Emergency / blow-up stop → pause the mission (protective steps only).
  if (input.emergencyTriggered || input.riskStopRequired) {
    return {
      action: canTransition(input.status, "paused") ? "pause" : "advance",
      steps: ["manage_exits", "refresh_protection"],
      autoApproval: NO_AUTO,
      reasons: [
        ...reasons,
        input.emergencyTriggered ? "EMERGENCY_STOP" : "RISK_STOP_REQUIRED",
      ],
    };
  }

  // A non-running mission only gets its status/progress kept honest.
  if (input.status !== "running") {
    return {
      action: "advance",
      steps: ["refresh_protection"],
      autoApproval: NO_AUTO,
      reasons: [...reasons, `STATUS_${input.status.toUpperCase()}_NO_NEW_RISK`],
    };
  }

  const autoApproval = decideAutoApproval(input.auto);
  const steps: MissionTickStep[] = ["manage_exits", "refresh_protection"];
  if (autoApproval.allowed) {
    steps.push("scan", "auto_approve", "auto_dispatch");
  } else {
    reasons.push(...autoApproval.blockReasons);
  }
  return { action: "advance", steps, autoApproval, reasons };
}
