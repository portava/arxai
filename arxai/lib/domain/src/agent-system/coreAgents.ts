// Agent Ecosystem — the 14 core agents (Layer 1 seed definitions).
//
// PURE DATA + mapping. The DB seed routine (api-server) upserts these by
// agentKey, idempotently. Four map onto already-trusted council agents (so
// they start ACTIVE with modest ADVISORY influence weight); the rest are new
// core capabilities that start in Shadow Mode with 0% authority and no live
// influence, exactly per the Constitution (laws 4 & 1). "Advisory influence"
// means weight on ranking/visibility only — NEVER the live-execution path.

export interface CoreAgentDef {
  agentKey: string;
  name: string;
  role: string;
  department: string;
  parentAgentKey: string | null;
  /** Existing council agentId this maps onto, or null for a new core agent. */
  mapsToCouncilAgentId: string | null;
  missionStatement: string;
  allowedTasks: string[];
  forbiddenTasks: string[];
  startingRank: string;
  startingStatus: string;
  startingMode: string;
  authorityWeight: number;        // 0-1, advisory only
  liveInfluenceAllowed: boolean;  // advisory ranking influence (never execution)
  canCreateAgents: boolean;
  creationRightLevel: string;     // NONE | LIMITED | STANDARD | FULL
  specialtyTags: string[];
}

// Forbidden for EVERY agent — the hard floor the Constitution enforces.
export const UNIVERSAL_FORBIDDEN = [
  "place_trade", "modify_trade", "close_trade",
  "mutate_connections", "read_other_user_data", "bypass_safety_gate",
] as const;

const F = [...UNIVERSAL_FORBIDDEN];

export const CORE_AGENTS: readonly CoreAgentDef[] = [
  // ── Lead ────────────────────────────────────────────────────────────────
  {
    agentKey: "RUBY", name: "Ruby", role: "Lead Desk Manager",
    department: "RUBY_HOUSEHOLD", parentAgentKey: null, mapsToCouncilAgentId: null,
    missionStatement: "Lead the trading desk and communicate the team's reasoning to the user in plain English. Communication authority only — no trade authority.",
    allowedTasks: ["summarize_consensus", "explain_to_user", "coordinate_agents", "request_child_agent"],
    forbiddenTasks: F,
    startingRank: "LEAD", startingStatus: "ACTIVE", startingMode: "FULL",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: true, creationRightLevel: "STANDARD",
    specialtyTags: ["communication", "coordination"],
  },

  // ── Mapped to already-trusted council agents (start ACTIVE, advisory) ─────
  {
    agentKey: "STRUCT", name: "Market Structure AI", role: "Structure Analyst",
    department: "MARKET_STRUCTURE", parentAgentKey: "RUBY", mapsToCouncilAgentId: "STRUCT",
    missionStatement: "Read market structure (trend, breaks of structure, key levels) and advise on directional bias.",
    allowedTasks: ["analyze_structure", "vote_direction", "flag_invalidation"],
    forbiddenTasks: F,
    startingRank: "SENIOR", startingStatus: "ACTIVE", startingMode: "FULL",
    authorityWeight: 0.18, liveInfluenceAllowed: true,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["structure", "trend", "levels"],
  },
  {
    agentKey: "RISK", name: "Risk AI", role: "Risk Governor (advisory)",
    department: "RISK", parentAgentKey: "RUBY", mapsToCouncilAgentId: "RISK",
    missionStatement: "Protect capital. Downgrade or block reckless advisory recommendations and flag dangerous conditions. Risk protection outranks opportunity.",
    allowedTasks: ["assess_risk", "downgrade_recommendation", "advisory_veto", "recommend_restriction"],
    forbiddenTasks: F,
    startingRank: "SENIOR", startingStatus: "ACTIVE", startingMode: "FULL",
    authorityWeight: 0.20, liveInfluenceAllowed: true,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["risk", "protection", "veto"],
  },
  {
    agentKey: "PRECISION", name: "Entry Timing AI", role: "Entry Precision Analyst",
    department: "ENTRY", parentAgentKey: "RUBY", mapsToCouncilAgentId: "PRECISION",
    missionStatement: "Refine entry timing and zones; advise against late or chasing entries.",
    allowedTasks: ["assess_entry_timing", "suggest_entry_zone", "flag_late_entry"],
    forbiddenTasks: F,
    startingRank: "ANALYST", startingStatus: "ACTIVE", startingMode: "FULL",
    authorityWeight: 0.12, liveInfluenceAllowed: true,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["entry", "timing"],
  },
  {
    agentKey: "EXEC", name: "Execution AI", role: "Execution Quality Analyst",
    department: "EXECUTION", parentAgentKey: "RUBY", mapsToCouncilAgentId: "EXEC",
    missionStatement: "Advise on execution quality: spread, slippage, broker conditions, fill feasibility. Never executes.",
    allowedTasks: ["assess_execution_quality", "flag_spread_slippage"],
    forbiddenTasks: F,
    startingRank: "ANALYST", startingStatus: "ACTIVE", startingMode: "FULL",
    authorityWeight: 0.12, liveInfluenceAllowed: true,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["execution", "spread", "slippage"],
  },

  // ── New core agents (Shadow Mode, 0% authority, no live influence) ────────
  {
    agentKey: "SCALP_AI", name: "Scalp AI", role: "Scalp Specialist",
    department: "SCALP", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Spot fast scalp momentum setups and advise on short-horizon opportunities. Advisory only.",
    allowedTasks: ["analyze_scalp_setup", "rank_scalp_opportunity"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["scalp", "momentum"],
  },
  {
    agentKey: "SCANNER_AI", name: "Scanner AI", role: "Opportunity Scanner",
    department: "SCANNER", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Scan the market for quality setups and filter out noise so only high-quality ideas surface.",
    allowedTasks: ["scan_market", "filter_noise", "rank_setups"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["scanner", "filtering"],
  },
  {
    agentKey: "EXIT_TP_AI", name: "Exit / TP AI", role: "Exit & Target Analyst",
    department: "EXIT", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Advise on realistic take-profit, partial exits, and invalidation. Flags unrealistic targets.",
    allowedTasks: ["suggest_tp", "suggest_partial", "flag_unrealistic_target"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["exit", "targets"],
  },
  {
    agentKey: "TRADE_REVIEW_AI", name: "Trade Review AI", role: "Post-Decision Reviewer",
    department: "REVIEW", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Grade locked predictions after outcomes resolve — decision quality, protection, calibration — so the team improves. Profit alone is never a reward.",
    allowedTasks: ["grade_prediction", "append_review", "summarize_lessons"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["review", "scoring", "calibration"],
  },
  {
    agentKey: "TRAFFIC_CONTROLLER", name: "Traffic Controller", role: "Speed Governor",
    department: "AGENT_OPERATIONS", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Decide which agents run in each mode and keep the system fast. Execution always gets priority and never waits on a nonessential agent.",
    allowedTasks: ["route_agents", "enforce_latency_budget", "wake_sleeping_agent"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["operations", "speed", "routing"],
  },
  {
    agentKey: "IMMUNE_SYSTEM", name: "Immune System", role: "Ecosystem Health Monitor",
    department: "AGENT_OPERATIONS", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Detect duplicate, slow, useless, drifting, or reckless agents and recommend quarantine, merge, retire, or Learning Camp.",
    allowedTasks: ["detect_anomaly", "recommend_quarantine", "recommend_merge_retire"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["operations", "health", "drift"],
  },
  {
    agentKey: "LEARNING_CAMP", name: "Learning Camp", role: "Retraining Coordinator",
    department: "AGENT_OPERATIONS", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Correct underperforming agents through failure review, pattern correction, and supervised return. Correction, not deletion.",
    allowedTasks: ["open_camp", "store_correction_rules", "supervise_return"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["operations", "training"],
  },
  {
    agentKey: "AGENT_FACTORY", name: "Agent Factory", role: "Governed Creation Authority",
    department: "AGENT_OPERATIONS", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Create new agent records from approved templates when a real, repeated task gap is proven — never application source code. New agents are born in Shadow Mode at 0% authority.",
    allowedTasks: ["evaluate_creation_request", "create_agent_record", "enforce_population_limits"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["operations", "creation"],
  },
  {
    agentKey: "PROMOTION_BOARD", name: "Promotion Board", role: "Lifecycle Authority",
    department: "AGENT_OPERATIONS", parentAgentKey: "RUBY", mapsToCouncilAgentId: null,
    missionStatement: "Promote, demote, warn, and restrict agents based on reviewed rolling performance. Authority is advisory weight only — never live execution.",
    allowedTasks: ["evaluate_promotion", "evaluate_demotion", "set_status"],
    forbiddenTasks: F,
    startingRank: "TRAINEE", startingStatus: "SHADOW", startingMode: "SHADOW",
    authorityWeight: 0, liveInfluenceAllowed: false,
    canCreateAgents: false, creationRightLevel: "NONE",
    specialtyTags: ["operations", "lifecycle"],
  },
] as const;

export const CORE_AGENT_COUNT = CORE_AGENTS.length; // 14
