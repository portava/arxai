// Agent Ecosystem — Layer 3 Governance service (wiring).
//
// Bridges the PURE Governance Court / Traffic Controller into the real read-side
// surfaces (Scanner ranking, Ruby wording, Scalp scoring, Risk grading). It takes
// the AdvisoryResult a surface ALREADY computed (no second registry read on the
// hot path), runs the Court to produce a bounded, protective governance outcome,
// records an in-memory admin trace, and projects a plain-English summary for users.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY / SHADOW ONLY. Adjusts ranking / wording / caution surfaces. NEVER
//     calls the 16-gate live pipeline, kill switch, allocation, or dispatch. It
//     cannot place, modify, or block a trade, and never gates live/demo execution.
//   - Governance can only LOWER a ranking score vs advisory, never inflate it.
//   - FAIL-OPEN: if anything is missing the surface is returned unchanged.
//   - The Court itself is PURE; only the cached registry snapshot (shared with the
//     advisory service) and the in-memory trace touch process state — no DB on the
//     hot path. The registry is GLOBAL system state, not per-user data.
//   - User projection strips every internal key, department, weight, and raw
//     outcome code — users see plain English only.

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, agentGovernanceTracesTable } from "@workspace/db";
import {
  buildDisagreementDraftFromReview,
  computeGovernanceReview,
  selectParticipants,
  statusInfluenceMultiplier,
  type AdvisoryAgentSnapshot,
  type AdvisoryDirection,
  type AdvisoryResult,
  type DisagreementDraftContext,
  type GovernanceAgentPosition,
  type GovernanceContext,
  type GovernanceImportance,
  type GovernanceOutcome,
  type GovernanceReview,
  type TrafficSelectionSummary,
} from "@workspace/domain/agent-system";
import { getAgentRegistrySnapshot } from "./advisoryInfluence";
import { recordDisagreement } from "./layer3";

export type GovernanceSurface = "SCANNER" | "RISK" | "SCALP" | "RUBY";

function effectiveInfluence(a: AdvisoryAgentSnapshot): number {
  const authority = Math.max(0, Math.min(1, a.authorityWeight));
  return authority * statusInfluenceMultiplier(a.currentStatus);
}

// ── Traffic Controller wrapper ─────────────────────────────────────────────

/**
 * Ask the Traffic Controller which agents should participate for a surface +
 * importance, using the cached registry snapshot (fail-open to a permissive
 * summary). Surfaces may use the participant set to bound work and always pass
 * the summary to the Court so the trace can show whether review was limited.
 */
export async function runTrafficSelection(
  surface: GovernanceSurface,
  importance: GovernanceImportance,
): Promise<{
  participants: AdvisoryAgentSnapshot[];
  summary: TrafficSelectionSummary;
  /** Every agentKey the Traffic Controller considered (allowed ∪ blocked). */
  consideredKeys: string[];
}> {
  try {
    const agents = await getAgentRegistrySnapshot();
    const sel = selectParticipants({ surface, importance, agents, effectiveInfluence });
    return { ...sel, consideredKeys: agents.map((a) => a.agentKey) };
  } catch {
    return {
      participants: [],
      summary: {
        limited: false,
        consideredCount: 0,
        participatedCount: 0,
        reason: "traffic_unavailable_fail_open",
      },
      consideredKeys: [],
    };
  }
}

// ── Surface governance ─────────────────────────────────────────────────────

export interface SurfaceGovernanceInput {
  surface: GovernanceSurface;
  direction: AdvisoryDirection;
  importance: GovernanceImportance;
  /** The advisory result the surface already computed for this exact decision. */
  advisory: AdvisoryResult;
  context?: GovernanceContext;
  traffic?: TrafficSelectionSummary;
  /**
   * Agent keys the Traffic Controller selected for this review. Forwarded to the
   * Court so non-selected agents step back (no vote / no challenge). Fail-open when
   * omitted. Enforcement can only REMOVE influence, never add it.
   */
  allowedAgentKeys?: readonly string[];
}

/**
 * Pure call into the Court. Returns null only when there is no advisory to govern
 * (so the surface stays unchanged — fail-open).
 */
export function computeSurfaceGovernance(inp: SurfaceGovernanceInput): GovernanceReview | null {
  if (!inp.advisory) return null;
  return computeGovernanceReview({
    surface: inp.surface,
    direction: inp.direction,
    importance: inp.importance,
    advisory: inp.advisory,
    context: inp.context,
    traffic: inp.traffic,
    allowedAgentKeys: inp.allowedAgentKeys,
  });
}

// ── User-safe projection (NO internal keys / departments / outcome codes) ───

export interface UserGovernance {
  /** Plain one-line headline of where the team landed. */
  headline: string;
  /** Plain explanation of why (already humanized). */
  detail: string;
  /** Plain cautions from agents that pushed back. */
  cautions: string[];
  /** The governed ranking score (always <= advisory score). */
  rankingScore: number;
  /** True when governance lowered the read (protective). */
  protective: boolean;
}

const USER_HEADLINE: Record<GovernanceOutcome, string> = {
  approved: "The trading team is comfortable with this read.",
  approved_with_caution: "The team is okay with this, with one caution to keep in mind.",
  downgraded: "The team lowered how strongly this is ranked.",
  rejected: "The team is steering away from this setup.",
  escalated: "The team is split on this, so it is flagged for a closer look.",
  needs_more_data: "There is not enough yet to treat this as a strong setup.",
  muted_low_confidence: "Confidence here is low, so this is kept quiet.",
  delayed_speed: "The team kept this read light to stay fast.",
  learning_camp_review: "The trading team is comfortable with this read.",
};

function humanizeChallenge(c: GovernanceReview["challenges"][number], direction: AdvisoryDirection): string | null {
  const dir = direction === "NEUTRAL" ? "this setup" : `this ${direction.toLowerCase()} setup`;
  switch (c.challengeType) {
    case "challenge":
      return `${c.byName} is pushing back on ${dir}.`;
    case "downgrade":
      return `${c.byName} wants this ranked lower.`;
    case "rejection":
      return `${c.byName} is steering away from ${dir}.`;
    // Speed / escalation objections are operational — not surfaced to users.
    case "performance_objection":
    case "escalation":
    default:
      return null;
  }
}

export function toUserGovernance(review: GovernanceReview): UserGovernance {
  const cautions: string[] = [];
  for (const c of review.challenges) {
    const line = humanizeChallenge(c, review.direction);
    if (line) cautions.push(line);
  }
  return {
    headline: USER_HEADLINE[review.outcome] ?? USER_HEADLINE.approved,
    detail: review.winningReasoning,
    cautions,
    rankingScore: review.governanceScore,
    protective: review.governanceScore < review.advisoryScore,
  };
}

// ── Admin-only governance trace (full breakdown incl. internal detail) ──────

export interface GovernanceTraceEntry {
  surface: GovernanceSurface;
  symbol: string;
  timeframe: string | null;
  direction: AdvisoryDirection;
  at: string;
  review: GovernanceReview;
}

const TRACE_CAP = 500;
const traceStore = new Map<string, GovernanceTraceEntry>();

export function recordGovernanceTrace(e: GovernanceTraceEntry): void {
  const key = `${e.surface}:${e.symbol}:${e.timeframe ?? "-"}`;
  traceStore.set(key, e);
  if (traceStore.size > TRACE_CAP) {
    const oldestKey = traceStore.keys().next().value;
    if (oldestKey !== undefined) traceStore.delete(oldestKey);
  }
}

export function getGovernanceTraces(
  opts: { surface?: GovernanceSurface; limit?: number } = {},
): GovernanceTraceEntry[] {
  const limit = opts.limit ?? 200;
  let all = [...traceStore.values()];
  if (opts.surface) all = all.filter((e) => e.surface === opts.surface);
  return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// ── Persisted per-action governance trace (Phase 3) ────────────────────────
//
// Durable proof that governance was actually involved in a real app action. The
// ring buffer above stays the fast hot-path record; this writes a richer row to
// `agent_governance_traces` for paginated admin audit. ADVISORY / OBSERVATION
// ONLY — it is written AFTER the surface already produced its (ranking/wording)
// result and can never gate, slow, or block any live/demo path. Writes are
// FAIL-SOFT: a DB error is swallowed so the surface is never affected.

/** Traffic Controller mode for a governance surface (mirrors layer3 modes). */
const SURFACE_TO_MODE: Record<GovernanceSurface, string> = {
  SCANNER: "SCANNER",
  SCALP: "SCALP",
  RUBY: "RUBY_EXPLANATION",
  RISK: "DEEP_REVIEW",
};

export interface GovernancePersistInput {
  /** Stable per-action id; one user action → one row. Generated if omitted. */
  actionId?: string;
  /** Real app action, e.g. SCANNER_REFRESH, RUBY_ANALYSIS, SCALP_SCAN. */
  actionType: string;
  surface: GovernanceSurface;
  /** Override the surface→mode default (e.g. LIVE_EXECUTION bypass traces). */
  activeMode?: string;
  userId?: number | null;
  role?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  tradeId?: string | null;
  scannerSignalId?: string | null;
  rubyMessageId?: string | null;
  review: GovernanceReview;
  /** Allowed participant set the Traffic Controller selected. */
  participants: { agentKey: string }[];
  /** Full considered set (allowed ∪ blocked); from runTrafficSelection. */
  consideredKeys?: string[];
  rubySummaryUsed?: boolean;
  disagreementCourtUsed?: boolean;
  predictionLocked?: boolean;
  reviewCreated?: boolean;
  noTradeRewardCreated?: boolean;
  speedCostMs?: number;
  totalGovernanceRuntimeMs?: number;
  /** Inviolable: stays false on every advisory surface (and on live traces). */
  liveExecutionBlockedByAi?: boolean;
  errorSummary?: string | null;
}

function steppedBack(positions: GovernanceAgentPosition[]): {
  keys: string[];
  reasons: Record<string, string>;
} {
  const keys: string[] = [];
  const reasons: Record<string, string> = {};
  for (const p of positions) {
    // "Stepped back" = chose not to weigh in: abstained, deferred for more data,
    // raised a speed objection, or carried no effective weight (shadow/muted).
    if (p.position === "abstain" || p.position === "needs_more_data" ||
        p.position === "performance_objection" || p.weight <= 0) {
      keys.push(p.agentKey);
      reasons[p.agentKey] = p.reason;
    }
  }
  return { keys, reasons };
}

function riskVetoApplied(review: GovernanceReview): boolean {
  return review.challenges.some(
    (c) => c.byAgentKey === "RISK" &&
      (c.challengeType === "rejection" || c.challengeType === "downgrade"),
  );
}

/**
 * Detect a genuine multi-agent disagreement in a completed review and, when one
 * occurred (a real rejection, risk veto, or escalation between opposing camps),
 * fire-and-forget persist it as a Court learning record. Returns whether a
 * disagreement was detected, so the caller can stamp the governance trace's
 * `disagreementCourtUsed`.
 *
 * Detection is PURE and synchronous (safe on the hot path); the DB write is
 * best-effort and unawaited. This NEVER runs on the live execution path — it is
 * called only from advisory read surfaces (scanner / scalp / Ruby analysis).
 */
export function maybeRecordDisagreement(
  review: GovernanceReview,
  ctx: DisagreementDraftContext,
): boolean {
  const draft = buildDisagreementDraftFromReview(review, ctx);
  if (!draft) return false;
  void recordDisagreement(draft).catch(() => {
    /* fail-soft: a Court learning record never affects the surface */
  });
  return true;
}

/**
 * Persist a per-action governance trace (fail-soft). Call WITHOUT awaiting on the
 * hot path: `void persistGovernanceTrace(input)`. Returns the row id on success.
 */
export async function persistGovernanceTrace(
  inp: GovernancePersistInput,
): Promise<{ ok: boolean; id?: number; actionId: string }> {
  const actionId = inp.actionId ?? randomUUID();
  try {
    const allowed = inp.participants.map((p) => p.agentKey);
    const allowedSet = new Set(allowed);
    const considered = inp.consideredKeys ?? allowed;
    const blocked = considered.filter((k) => !allowedSet.has(k));
    const sb = steppedBack(inp.review.positions);
    const outputs = inp.review.positions.map((p) => ({
      agentKey: p.agentKey, position: p.position, weight: p.weight,
    }));
    const [row] = await db.insert(agentGovernanceTracesTable).values({
      actionId,
      actionType: inp.actionType,
      userId: inp.userId ?? null,
      role: inp.role ?? null,
      symbol: inp.symbol ?? null,
      timeframe: inp.timeframe ?? null,
      tradeId: inp.tradeId ?? null,
      scannerSignalId: inp.scannerSignalId ?? null,
      rubyMessageId: inp.rubyMessageId ?? null,
      activeMode: inp.activeMode ?? SURFACE_TO_MODE[inp.surface],
      agentsRequested: JSON.stringify(considered),
      agentsAllowedToRun: JSON.stringify(allowed),
      agentsBlocked: JSON.stringify(blocked),
      agentsThatSteppedBack: JSON.stringify(sb.keys),
      stepBackReasons: JSON.stringify(sb.reasons),
      agentOutputs: JSON.stringify(outputs),
      finalGovernanceDecision: inp.review.finalDecision,
      rubySummaryUsed: inp.rubySummaryUsed ?? false,
      riskVetoUsed: riskVetoApplied(inp.review),
      disagreementCourtUsed: inp.disagreementCourtUsed ?? false,
      predictionLocked: inp.predictionLocked ?? false,
      reviewCreated: inp.reviewCreated ?? false,
      noTradeRewardCreated: inp.noTradeRewardCreated ?? false,
      speedCostMs: Math.max(0, Math.round(inp.speedCostMs ?? 0)),
      totalGovernanceRuntimeMs: Math.max(0, Math.round(inp.totalGovernanceRuntimeMs ?? 0)),
      liveExecutionBlockedByAi: inp.liveExecutionBlockedByAi ?? false,
      errorSummary: inp.errorSummary ?? null,
    }).returning({ id: agentGovernanceTracesTable.id });
    return { ok: true, id: row?.id, actionId };
  } catch {
    // Fail-soft: governance trace persistence never affects the surface.
    return { ok: false, actionId };
  }
}

/**
 * Live-path BYPASS trace (fail-soft). The live submit/close chokepoint
 * (`dispatchLiveCommand`) never consults the agent governance layer — the
 * 16-gate Phase B evaluator is the sole authority and governance is advisory
 * only. This writes a durable proof row showing governance was NOT involved:
 * empty agent sets and the inviolable `liveExecutionBlockedByAi = false`.
 * Call WITHOUT awaiting on the dispatch hot path: `void persistLiveBypassTrace(input)`.
 */
export async function persistLiveBypassTrace(inp: {
  actionType: string;
  userId?: number | null;
  role?: string | null;
  symbol?: string | null;
  tradeId?: string | null;
}): Promise<{ ok: boolean; id?: number; actionId: string }> {
  const actionId = randomUUID();
  try {
    const empty = JSON.stringify([]);
    const [row] = await db.insert(agentGovernanceTracesTable).values({
      actionId,
      actionType: inp.actionType,
      userId: inp.userId ?? null,
      role: inp.role ?? null,
      symbol: inp.symbol ?? null,
      tradeId: inp.tradeId ?? null,
      activeMode: "LIVE_EXECUTION",
      agentsRequested: empty,
      agentsAllowedToRun: empty,
      agentsBlocked: empty,
      agentsThatSteppedBack: empty,
      stepBackReasons: JSON.stringify({}),
      agentOutputs: empty,
      finalGovernanceDecision: "LIVE_PATH_NOT_AI_GATED",
      rubySummaryUsed: false,
      riskVetoUsed: false,
      disagreementCourtUsed: false,
      predictionLocked: false,
      reviewCreated: false,
      noTradeRewardCreated: false,
      speedCostMs: 0,
      totalGovernanceRuntimeMs: 0,
      // INVIOLABLE: governance can never block the live 16-gate path.
      liveExecutionBlockedByAi: false,
      errorSummary: null,
    }).returning({ id: agentGovernanceTracesTable.id });
    return { ok: true, id: row?.id, actionId };
  } catch {
    return { ok: false, actionId };
  }
}

export async function listPersistedGovernanceTraces(opts: {
  actionType?: string;
  activeMode?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const filters = [];
  if (opts.actionType) filters.push(eq(agentGovernanceTracesTable.actionType, opts.actionType));
  if (opts.activeMode) filters.push(eq(agentGovernanceTracesTable.activeMode, opts.activeMode));
  const where = filters.length === 1 ? filters[0] : filters.length > 1 ? and(...filters) : undefined;
  const base = db.select().from(agentGovernanceTracesTable);
  const rows = await (where ? base.where(where) : base)
    .orderBy(desc(agentGovernanceTracesTable.createdAt))
    .limit(limit)
    .offset(offset);
  return rows;
}
