// Self-Trade AI — autonomous execution permission (Autonomous Live Execution,
// Task #213). PURE / deterministic. This decides WHETHER a supervisor-APPROVED
// decision may proceed to live execution, and at what action level, BEFORE the
// api-server touches the real executeInstant → 16-gate Phase B pipeline.
//
// SAFETY (inviolable):
// - This module NEVER places, modifies, or closes an order. It only computes a
//   verdict. The real order still rides the existing pipeline + all 16 gates.
// - Default-deny: anything not explicitly permitted resolves to BLOCK/LOG_ONLY.
// - This is an ADDITIONAL pre-gate layered ON TOP of the 16 gates — never a
//   replacement for any of them. A PERMIT here only means "the executor may
//   attempt"; the pipeline can still refuse.

import type {
  GovernorContext,
  HandshakeReadinessContext,
  QuotaContext,
  SelfTradeDecisionOutcome,
  TradeThesis,
} from "./selfTradeDecision.types.js";

export type ExecutionPermissionAction =
  | "EXECUTE"       // L2+ live entry through the existing pipeline
  | "PREPARE_ONLY"  // L1: stage a draft only (human confirm still required)
  | "LOG_ONLY"      // L0 / SHADOW: record the intent, never dispatch
  | "BLOCK";        // a hard pre-condition failed

export interface ExecutionPermissionInput {
  // Agent state.
  agentStatus: string;          // self_trade_agents.status (ACTIVE required)
  agentMode: string;            // SHADOW | LIVE
  autonomyLevel: number;        // 0..4

  // Decision.
  outcome: SelfTradeDecisionOutcome;
  thesis: TradeThesis | null;
  setupExpiresAt: string | null;

  // Funding / risk context.
  funded: boolean;              // allocatedFunds > 0
  quota: QuotaContext;
  governor: GovernorContext;
  handshake: HandshakeReadinessContext;
  killEngaged: boolean;

  // Concurrency.
  openPositionsCount: number;
  maxConcurrentPositions: number;

  // Execution identity.
  executingUserId: number | null;
  hasMasterLiveAccess: boolean;

  /** Epoch ms; injected for deterministic evaluation. */
  now: number;
}

export interface ExecutionPermissionVerdict {
  permitted: boolean;
  action: ExecutionPermissionAction;
  autonomyLevel: number;
  /** Machine-readable hard-block code (null when not blocked). */
  blockCode: string | null;
  /** Human-readable reasons (ordered; first is decisive when blocked). */
  reasons: string[];
}

const APPROVED_OUTCOMES: ReadonlySet<SelfTradeDecisionOutcome> = new Set([
  "APPROVED",
  "APPROVED_REDUCED",
  "PREPARE_ONLY",
]);

export function evaluateExecutionPermission(
  input: ExecutionPermissionInput,
): ExecutionPermissionVerdict {
  const reasons: string[] = [];
  const block = (code: string, reason: string): ExecutionPermissionVerdict => {
    reasons.unshift(reason);
    return {
      permitted: false,
      action: "BLOCK",
      autonomyLevel: input.autonomyLevel,
      blockCode: code,
      reasons,
    };
  };

  // ── Hard pre-conditions (priority order; first failure is decisive) ────────
  if (input.killEngaged) {
    return block("KILL_SWITCH_ENGAGED", "A kill switch is engaged for this scope.");
  }
  if (input.agentStatus !== "ACTIVE") {
    return block("AGENT_NOT_ACTIVE", `Agent is ${input.agentStatus}, not ACTIVE.`);
  }
  if (!input.funded) {
    return block("AGENT_UNFUNDED", "Agent has no allocated capital.");
  }
  if (!APPROVED_OUTCOMES.has(input.outcome)) {
    return block("OUTCOME_NOT_APPROVED", `Decision outcome ${input.outcome} is not executable.`);
  }
  if (input.governor.status === "LOCKED") {
    return block("GOVERNOR_LOCKED", "Risk Governor is LOCKED.");
  }
  if (input.governor.hardBlocks.length > 0) {
    return block("GOVERNOR_HARD_BLOCK", `Governor hard block: ${input.governor.hardBlocks.join(", ")}.`);
  }
  if (input.handshake.blocked.length > 0) {
    return block("HANDSHAKE_BLOCKED", `Handshake blocked: ${input.handshake.blocked.join(", ")}.`);
  }
  if (isExpired(input.setupExpiresAt, input.now)) {
    return block("SETUP_EXPIRED", "The setup window has expired.");
  }
  if (input.quota.hardCapReached) {
    return block("QUOTA_HARD_CAP", "Daily trade hard cap reached.");
  }
  if (
    input.maxConcurrentPositions > 0 &&
    input.openPositionsCount >= input.maxConcurrentPositions
  ) {
    return block(
      "MAX_CONCURRENT_POSITIONS",
      `Max concurrent positions reached (${input.openPositionsCount}/${input.maxConcurrentPositions}).`,
    );
  }
  if (input.thesis == null) {
    return block("NO_THESIS", "No trade thesis (no protective stop / no edge).");
  }

  // ── Action resolution (mode + autonomy + outcome) ──────────────────────────
  // SHADOW agents never reach the live pipeline regardless of autonomy.
  if (input.agentMode !== "LIVE") {
    reasons.push("Agent is in SHADOW mode — logged only, never dispatched.");
    return {
      permitted: false,
      action: "LOG_ONLY",
      autonomyLevel: input.autonomyLevel,
      blockCode: null,
      reasons,
    };
  }

  // AUTONOMY LEVELS, as this function actually implements them:
  //   L0  — LOG_ONLY: suggestion recorded, never dispatched.
  //   L1  — PREPARE_ONLY: a draft is staged; a human still confirms.
  //   L2+ — EXECUTE.
  // L2, L3 and L4 are NOT distinguished here: all three fall through to the
  // same EXECUTE verdict with identical inputs. The only place any L3/L4
  // distinction exists at all is `selfTrade/livePositionManager.ts`, which
  // gates autonomous position MANAGEMENT on `autonomyLevel >= 3` (below that it
  // only alerts). L4 has NO behaviour distinct from L3 anywhere: the
  // "L4 also extend" note on `PositionManagementInput.autonomyLevel` describes
  // a caller-side behaviour that is not implemented, and `autonomyLevel` is
  // never read inside `positionManagement.ts`. Do not document or surface L4 as
  // a stronger authority than L3 until that is built.
  if (input.autonomyLevel <= 0) {
    reasons.push("Autonomy L0 — suggestion only, never dispatched.");
    return {
      permitted: false,
      action: "LOG_ONLY",
      autonomyLevel: input.autonomyLevel,
      blockCode: null,
      reasons,
    };
  }

  // Anything that actually stages/dispatches an order needs a real executing
  // user with master-live access. The pipeline re-checks this; we pre-check so
  // the failure is honest and attributed here rather than surfacing as a raw
  // pipeline block.
  if (input.executingUserId == null) {
    return block("NO_EXECUTING_USER", "No executing user resolved for this agent.");
  }
  if (!input.hasMasterLiveAccess) {
    return block(
      "NO_MASTER_LIVE_ACCESS",
      "Executing user lacks master-live access (approval + toggle + disclosure).",
    );
  }

  // L1 always stops at a staged draft, even on a fully APPROVED decision.
  // PREPARE_ONLY outcomes also stop at a draft regardless of autonomy level.
  if (input.autonomyLevel === 1 || input.outcome === "PREPARE_ONLY") {
    reasons.push(
      input.autonomyLevel === 1
        ? "Autonomy L1 — draft staged for human confirmation."
        : "Decision is PREPARE_ONLY — draft staged for human confirmation.",
    );
    return {
      permitted: true,
      action: "PREPARE_ONLY",
      autonomyLevel: input.autonomyLevel,
      blockCode: null,
      reasons,
    };
  }

  reasons.push("Permitted for autonomous live execution.");
  return {
    permitted: true,
    action: "EXECUTE",
    autonomyLevel: input.autonomyLevel,
    blockCode: null,
    reasons,
  };
}

function isExpired(setupExpiresAt: string | null, now: number): boolean {
  if (!setupExpiresAt) return false;
  const t = Date.parse(setupExpiresAt);
  if (Number.isNaN(t)) return false;
  return now > t;
}
