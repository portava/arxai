// Agent Ecosystem — Layer 3 Agent Traffic Controller / Speed Governor (§10). PURE.
//
// PURPOSE
//   Decide WHICH agents run in the current operating mode, keep the system fast,
//   and protect the live-execution path. For each mode it routes every agent to a
//   run-mode (RUN / FAST_CHECK / SILENT_SUPPORT / ON_DEMAND / SLEEPING /
//   BACKGROUND), enforces a latency budget, lets urgent execution bypass deep
//   analysis, wakes sleeping agents only when needed, and suppresses duplicate
//   analysis within a department.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY / ORCHESTRATION ONLY. This NEVER gates, slows, or blocks the
//     16-gate live pipeline, kill switch, allocation, or dispatch. Execution
//     actions always get priority and never wait on a nonessential agent.
//   - In LIVE_EXECUTION mode (and on any emergency) only execution-critical
//     agents run; everything else is put to sleep and deep analysis is bypassed.
//   - PURE: deterministic, no I/O, no clock, no DB.

export type TrafficMode =
  | "LIVE_EXECUTION"
  | "SCALP"
  | "SCANNER"
  | "RUBY_EXPLANATION"
  | "LEARNING"
  | "AGENT_CREATION"
  | "DEEP_REVIEW";

/** How an agent is routed for the current cycle. */
export type AgentRunMode =
  | "RUN"            // full participation
  | "FAST_CHECK"     // quick, bounded contribution only
  | "SILENT_SUPPORT" // observes, may speak only if asked
  | "ON_DEMAND"      // dormant unless explicitly woken
  | "SLEEPING"       // fully dormant this cycle
  | "BACKGROUND";    // background/ops work, never on the hot path

/** Minimal agent view the controller routes on (a slice of the registry row). */
export interface TrafficAgentSnapshot {
  agentKey: string;
  name: string;
  department: string;
  currentStatus: string;   // ACTIVE | SHADOW | WARNING | ... (lifecycle status)
  authorityWeight: number; // 0-1, advisory only — used as a dedupe tie-breaker
}

export interface TrafficRoutingInput {
  mode: TrafficMode;
  agents: readonly TrafficAgentSnapshot[];
  /** A live trade action (open/close/modify) is in flight this cycle. */
  tradeActionInvolved?: boolean;
  /** Emergency open/close — highest priority, bypasses ALL deep analysis. */
  emergency?: boolean;
  /** Departments/agentKeys explicitly requested (wakes ON_DEMAND agents). */
  requested?: readonly string[];
  /** Whether news is currently relevant (otherwise News stays background). */
  newsRelevant?: boolean;
}

export interface AgentRoutingDecision {
  agentKey: string;
  name: string;
  department: string;
  runMode: AgentRunMode;
  /** True when this agent will actually contribute (RUN or FAST_CHECK). */
  participating: boolean;
  /** Neutral machine reason; Ruby/UI humanize it. */
  reason: string;
  /** Set when suppressed because another agent already covers its department. */
  duplicateOfAgentKey?: string;
  /** Set when an ON_DEMAND/SLEEPING agent was woken because it was requested. */
  woken?: boolean;
}

export interface TrafficRoutingResult {
  mode: TrafficMode;
  latencyBudgetMs: number;
  /** Execution actions never wait on nonessential agents. */
  executionPriority: boolean;
  /** True when deep analysis is skipped (live/emergency hot path). */
  bypassDeepAnalysis: boolean;
  decisions: AgentRoutingDecision[];
  participatingCount: number;
  /** agentKeys put to sleep/background this cycle. */
  sleepingAgentKeys: string[];
  /** agentKeys suppressed as duplicate analysis. */
  suppressedDuplicateAgentKeys: string[];
  /** agentKeys woken on demand because they were requested. */
  wokenAgentKeys: string[];
}

// ── Latency budgets (guideline ceilings, ms) ───────────────────────────────
// Live/emergency are intentionally tiny: the controller must never let the
// ecosystem add meaningful latency to the proven execution path.
const LATENCY_BUDGET_MS: Record<TrafficMode, number> = {
  LIVE_EXECUTION: 50,
  SCALP: 150,
  SCANNER: 400,
  RUBY_EXPLANATION: 1500,
  LEARNING: 0, // background — off the hot path entirely
  AGENT_CREATION: 0, // background — never during active execution
  DEEP_REVIEW: 3000,
};

// Pure-ops agents that are ALWAYS background (never on a live/scanner hot path).
const BACKGROUND_OPS_KEYS = new Set<string>([
  "AGENT_FACTORY",
  "LEARNING_CAMP",
  "PROMOTION_BOARD",
]);

// Departments that own each mode's hot path. Anything not listed is routed to a
// quieter mode (silent / on-demand / sleeping / background).
//   run:       full participants
//   fastCheck: bounded quick checks only
const MODE_ROUTING: Record<
  TrafficMode,
  { run: ReadonlySet<string>; fastCheck: ReadonlySet<string> }
> = {
  // §10.1 — only execution-critical agents.
  LIVE_EXECUTION: {
    run: new Set(["EXECUTION", "RISK"]),
    fastCheck: new Set(),
  },
  // §10.2 — scalp-critical set (V75 example): Scalp, Risk, Entry, Exit (+Exec on
  // a trade action); Market Structure is a fast check only.
  SCALP: {
    run: new Set(["SCALP", "RISK", "ENTRY", "EXIT"]),
    fastCheck: new Set(["MARKET_STRUCTURE"]),
  },
  // §10.3 — find + rank opportunities quickly.
  SCANNER: {
    run: new Set(["SCANNER", "MARKET_STRUCTURE", "RISK"]),
    fastCheck: new Set(["ENTRY"]),
  },
  // §10.4 — deep user question: Ruby + Structure + Risk + Review + specialists.
  RUBY_EXPLANATION: {
    run: new Set([
      "RUBY_HOUSEHOLD", "MARKET_STRUCTURE", "RISK", "REVIEW",
      "ENTRY", "EXIT", "SCALP", "SCANNER", "EXECUTION",
    ]),
    fastCheck: new Set(),
  },
  // §10.5/§10.6 — background-only modes: nothing on the hot path.
  LEARNING: { run: new Set(), fastCheck: new Set() },
  AGENT_CREATION: { run: new Set(), fastCheck: new Set() },
  // §10.7 — post-trade/post-session: most departments may contribute.
  DEEP_REVIEW: {
    run: new Set([
      "REVIEW", "RISK", "MARKET_STRUCTURE", "ENTRY", "EXIT",
      "SCALP", "SCANNER", "EXECUTION", "AGENT_OPERATIONS",
    ]),
    fastCheck: new Set(),
  },
};

// Lifecycle statuses that can never actively participate (pure shadow / parked).
const NON_PARTICIPATING_STATUSES = new Set<string>([
  "SHADOW", "SILENT_SUPPORT", "RESTRICTED",
  "LEARNING_CAMP", "SHUTDOWN_RECOMMENDED", "ARCHIVED",
]);

function isBackgroundMode(mode: TrafficMode): boolean {
  return mode === "LEARNING" || mode === "AGENT_CREATION";
}

/**
 * Route every agent for the given mode. Deterministic and pure. Emergency and
 * live-execution paths collapse to the execution-critical set so the ecosystem
 * can never slow a real trade action.
 */
export function routeAgents(input: TrafficRoutingInput): TrafficRoutingResult {
  const { mode, agents } = input;
  const requested = new Set((input.requested ?? []).map((r) => r.toUpperCase()));
  const emergency = input.emergency === true;
  const liveHotPath = emergency || mode === "LIVE_EXECUTION";

  const routing = MODE_ROUTING[mode];
  const decisions: AgentRoutingDecision[] = [];

  // First pass: assign a base run-mode per agent.
  for (const a of agents) {
    const dept = a.department.toUpperCase();
    const key = a.agentKey.toUpperCase();
    const wasRequested = requested.has(dept) || requested.has(key);

    // Emergency: ONLY the execution department runs; everything else sleeps.
    if (emergency) {
      const isExec = dept === "EXECUTION";
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: isExec ? "RUN" : "SLEEPING",
        participating: isExec,
        reason: isExec ? "emergency_execution_critical" : "emergency_nonessential_sleeping",
      });
      continue;
    }

    // Background-only ops agents never touch a live/scanner hot path; they may
    // run in their own background modes.
    if (BACKGROUND_OPS_KEYS.has(key)) {
      const allowed = isBackgroundMode(mode) || mode === "DEEP_REVIEW";
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: "BACKGROUND",
        participating: allowed && !liveHotPath,
        reason: allowed ? "ops_background_work" : "ops_background_only_off_hot_path",
      });
      continue;
    }

    // News stays background unless explicitly relevant/requested.
    if (dept === "NEWS" && !input.newsRelevant && !wasRequested) {
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: "BACKGROUND", participating: false,
        reason: "news_not_relevant_background",
      });
      continue;
    }

    // Parked/shadow agents can only be woken on demand; otherwise dormant.
    if (NON_PARTICIPATING_STATUSES.has(a.currentStatus.toUpperCase()) && !wasRequested) {
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: a.currentStatus.toUpperCase() === "ARCHIVED" ? "SLEEPING" : "ON_DEMAND",
        participating: false,
        reason: "agent_parked_or_shadow",
      });
      continue;
    }

    // Execution agent only runs on a trade action in scalp/scanner-style modes.
    if (dept === "EXECUTION" && !routing.run.has("EXECUTION") && input.tradeActionInvolved) {
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: "RUN", participating: true, reason: "execution_for_trade_action",
      });
      continue;
    }

    if (routing.run.has(dept)) {
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: "RUN", participating: true, reason: `mode_${mode.toLowerCase()}_core`,
      });
    } else if (routing.fastCheck.has(dept)) {
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: "FAST_CHECK", participating: true, reason: `mode_${mode.toLowerCase()}_fast_check`,
      });
    } else if (wasRequested) {
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: "ON_DEMAND", participating: true, reason: "woken_on_demand", woken: true,
      });
    } else {
      // Nonessential for this mode: quiet but available.
      decisions.push({
        agentKey: a.agentKey, name: a.name, department: a.department,
        runMode: isBackgroundMode(mode) ? "BACKGROUND" : "SILENT_SUPPORT",
        participating: false,
        reason: "nonessential_for_mode",
      });
    }
  }

  // Second pass: suppress duplicate analysis within a department. When >1 agent
  // is actively participating (RUN/FAST_CHECK) in the same department, keep the
  // highest-authority one and demote the rest to SILENT_SUPPORT (duplicateOf).
  const suppressedDuplicateAgentKeys: string[] = [];
  if (!liveHotPath) {
    const byDept = new Map<string, AgentRoutingDecision[]>();
    for (const d of decisions) {
      if (!d.participating) continue;
      const dept = d.department.toUpperCase();
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept)!.push(d);
    }
    const authority = new Map(agents.map((a) => [a.agentKey, a.authorityWeight]));
    for (const group of byDept.values()) {
      if (group.length <= 1) continue;
      // Deterministic winner: highest authority, then agentKey for tie-break.
      const winner = [...group].sort((x, y) => {
        const aw = (authority.get(y.agentKey) ?? 0) - (authority.get(x.agentKey) ?? 0);
        return aw !== 0 ? aw : x.agentKey.localeCompare(y.agentKey);
      })[0]!;
      for (const d of group) {
        if (d.agentKey === winner.agentKey) continue;
        d.runMode = "SILENT_SUPPORT";
        d.participating = false;
        d.duplicateOfAgentKey = winner.agentKey;
        d.reason = "duplicate_analysis_suppressed";
        suppressedDuplicateAgentKeys.push(d.agentKey);
      }
    }
  }

  const participatingCount = decisions.filter((d) => d.participating).length;
  const sleepingAgentKeys = decisions
    .filter((d) => d.runMode === "SLEEPING" || d.runMode === "ON_DEMAND" || d.runMode === "BACKGROUND")
    .map((d) => d.agentKey);
  const wokenAgentKeys = decisions.filter((d) => d.woken).map((d) => d.agentKey);

  return {
    mode,
    latencyBudgetMs: LATENCY_BUDGET_MS[mode],
    executionPriority: liveHotPath || mode === "SCALP" || !!input.tradeActionInvolved,
    bypassDeepAnalysis: liveHotPath,
    decisions,
    participatingCount,
    sleepingAgentKeys,
    suppressedDuplicateAgentKeys,
    wokenAgentKeys,
  };
}

export { LATENCY_BUDGET_MS };
