// Agent Ecosystem — Layer 3 service wiring (orchestration + ecosystem health).
//
// Maps persistent agent registry rows onto the PURE Layer 3 domain engines
// (traffic routing preview, ecosystem-health immune scan, population report,
// family tree) and persists/reads Agent Court disagreement records.
//
// SAFETY / SCOPE:
//   - ADVISORY / OBSERVATION ONLY. Nothing here gates, slows, or blocks any
//     live/demo execution path or the 16-gate live pipeline. The Court records
//     learning evidence; the scans/reports are visibility only.
//   - Disagreement outcome verdicts are fail-closed: a record stays PENDING
//     until real outcome evidence is supplied.

import { randomUUID } from "node:crypto";
import { db, agentsTable, agentDisagreementsTable, type AgentRow } from "@workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  scanEcosystemHealth, type ImmuneAgentSnapshot, type ImmuneScanResult,
  buildFamilyTree, type FamilyAgentSnapshot, type FamilyTree,
  evaluatePopulation, type DepartmentAgentLite, type PopulationReport,
  routeAgents, type TrafficAgentSnapshot, type TrafficMode, type TrafficRoutingResult,
  type DisagreementRecordDraft,
} from "@workspace/domain/agent-system";

// ── Snapshot mapping ─────────────────────────────────────────────────────────
// The registry does not persist every health signal (duplicate rate, child
// count, false-approval/block rates). We derive what we can deterministically
// (speedCostScore from speedScore, childCount from parent links) and leave the
// rest at honest defaults — the engines treat absent signals as "no anomaly".

/** speedCostScore proxy: a high speedScore means LOW cost, and vice-versa. */
function speedCostFromScore(speedScore: number): number {
  return +Math.max(0, Math.min(100, 100 - speedScore)).toFixed(2);
}

function buildIdToKey(rows: readonly AgentRow[]): Map<number, string> {
  return new Map(rows.map((r) => [r.id, r.agentKey]));
}

function childCounts(rows: readonly AgentRow[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.parentAgentId != null) {
      counts.set(r.parentAgentId, (counts.get(r.parentAgentId) ?? 0) + 1);
    }
  }
  return counts;
}

function toImmuneSnapshot(rows: readonly AgentRow[]): ImmuneAgentSnapshot[] {
  const idToKey = buildIdToKey(rows);
  const counts = childCounts(rows);
  return rows.map((r) => ({
    agentKey: r.agentKey,
    name: r.name,
    department: r.department,
    parentAgentKey: r.parentAgentId != null ? idToKey.get(r.parentAgentId) ?? null : null,
    currentStatus: r.currentStatus,
    currentRank: r.currentRank,
    authorityWeight: r.authorityWeight,
    liveInfluenceAllowed: r.liveInfluenceAllowed,
    isCore: r.isCore,
    trustScore: r.trustScore,
    qualityScore: r.qualityScore,
    speedScore: r.speedScore,
    protectionScore: r.protectionScore,
    usefulnessScore: r.usefulnessScore,
    speedCostScore: speedCostFromScore(r.speedScore),
    duplicateAnalysisRate: 0,
    childCount: counts.get(r.id) ?? 0,
    learningCampCount: r.learningCampCount,
  }));
}

function toFamilySnapshot(rows: readonly AgentRow[]): FamilyAgentSnapshot[] {
  const idToKey = buildIdToKey(rows);
  return rows.map((r) => ({
    agentKey: r.agentKey,
    name: r.name,
    department: r.department,
    parentAgentKey: r.parentAgentId != null ? idToKey.get(r.parentAgentId) ?? null : null,
    currentRank: r.currentRank,
    currentStatus: r.currentStatus,
    isCore: r.isCore,
    trustScore: r.trustScore,
    usefulnessScore: r.usefulnessScore,
    speedScore: r.speedScore,
    speedCostScore: speedCostFromScore(r.speedScore),
    learningCampCount: r.learningCampCount,
  }));
}

function toDepartmentLite(rows: readonly AgentRow[]): DepartmentAgentLite[] {
  return rows.map((r) => ({
    agentKey: r.agentKey,
    name: r.name,
    department: r.department,
    currentRank: r.currentRank,
    currentStatus: r.currentStatus,
  }));
}

function toTrafficSnapshot(rows: readonly AgentRow[]): TrafficAgentSnapshot[] {
  return rows.map((r) => ({
    agentKey: r.agentKey,
    name: r.name,
    department: r.department,
    currentStatus: r.currentStatus,
    authorityWeight: r.authorityWeight,
  }));
}

async function loadAgents(): Promise<AgentRow[]> {
  return db.select().from(agentsTable).orderBy(asc(agentsTable.id));
}

// ── Public read helpers ──────────────────────────────────────────────────────

export async function runImmuneScan(opts?: {
  riskFlaggedAgentKeys?: readonly string[];
}): Promise<ImmuneScanResult> {
  const rows = await loadAgents();
  return scanEcosystemHealth({
    agents: toImmuneSnapshot(rows),
    riskFlaggedAgentKeys: opts?.riskFlaggedAgentKeys,
  });
}

export async function getFamilyTree(): Promise<FamilyTree> {
  const rows = await loadAgents();
  return buildFamilyTree(toFamilySnapshot(rows));
}

export async function getPopulationReport(): Promise<PopulationReport> {
  const rows = await loadAgents();
  return evaluatePopulation(toDepartmentLite(rows));
}

const VALID_MODES: ReadonlySet<string> = new Set([
  "LIVE_EXECUTION", "SCALP", "SCANNER", "RUBY_EXPLANATION",
  "LEARNING", "AGENT_CREATION", "DEEP_REVIEW",
]);

export function isTrafficMode(v: string): v is TrafficMode {
  return VALID_MODES.has(v);
}

export async function previewTrafficRouting(input: {
  mode: TrafficMode;
  tradeActionInvolved?: boolean;
  emergency?: boolean;
  requested?: readonly string[];
  newsRelevant?: boolean;
}): Promise<TrafficRoutingResult> {
  const rows = await loadAgents();
  return routeAgents({ ...input, agents: toTrafficSnapshot(rows) });
}

// ── Agent Court disagreement persistence ─────────────────────────────────────

export interface RecordDisagreementResult {
  ok: boolean;
  disagreementId?: string;
  id?: number;
}

/** Persist a Court resolution draft as a learning record. Append-on-resolve. */
export async function recordDisagreement(
  draft: DisagreementRecordDraft,
): Promise<RecordDisagreementResult> {
  const disagreementId = randomUUID();
  const [row] = await db.insert(agentDisagreementsTable).values({
    disagreementId,
    symbol: draft.symbol,
    timeframe: draft.timeframe,
    tradeType: draft.tradeType,
    condition: draft.condition,
    positions: JSON.stringify(draft.positions),
    resolvedOutcome: draft.resolvedOutcome,
    winningDecision: draft.winningDecision,
    winningAgentKeys: JSON.stringify(draft.winningAgentKeys),
    riskVetoApplied: draft.riskVetoApplied,
    reasoning: draft.reasoning,
    outcomeStatus: "PENDING",
  }).returning({ id: agentDisagreementsTable.id });
  return { ok: true, disagreementId, id: row?.id };
}

export async function listDisagreements(opts?: {
  status?: "PENDING" | "RESOLVED";
  limit?: number;
}) {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const base = db.select().from(agentDisagreementsTable);
  const rows = await (opts?.status
    ? base.where(eq(agentDisagreementsTable.outcomeStatus, opts.status))
    : base)
    .orderBy(desc(agentDisagreementsTable.createdAt))
    .limit(limit);
  return rows;
}

export interface ResolveDisagreementOutcomeArgs {
  disagreementId: string;
  whoWasRightAgentKeys: string[];
  actualOutcome: string;
}

/**
 * Fill in the later who-was-right verdict ONLY on supplied real outcome
 * evidence (fail-closed). Idempotent: a non-PENDING record is left unchanged.
 */
export async function resolveDisagreementOutcome(
  args: ResolveDisagreementOutcomeArgs,
): Promise<{ ok: boolean; error?: string; alreadyResolved?: boolean }> {
  const id = args.disagreementId.trim();
  if (!id) return { ok: false, error: "DISAGREEMENT_ID_REQUIRED" };
  if (!args.actualOutcome.trim()) return { ok: false, error: "ACTUAL_OUTCOME_REQUIRED" };

  // CAS claim: only flip a row that is still PENDING. This prevents a second
  // (or concurrent) call from overwriting an already-RESOLVED verdict — the
  // first real-evidence resolution wins and is never silently clobbered.
  const result = await db.update(agentDisagreementsTable)
    .set({
      outcomeStatus: "RESOLVED",
      whoWasRightAgentKeys: JSON.stringify(args.whoWasRightAgentKeys),
      actualOutcome: args.actualOutcome.trim(),
      resolvedAt: new Date(),
    })
    .where(and(
      eq(agentDisagreementsTable.disagreementId, id),
      eq(agentDisagreementsTable.outcomeStatus, "PENDING"),
    ))
    .returning({ id: agentDisagreementsTable.id });

  if (result.length > 0) return { ok: true };

  // No PENDING row was claimed — distinguish "never existed" from "already
  // resolved" (idempotent: a non-PENDING record is left unchanged).
  const [existing] = await db
    .select({ outcomeStatus: agentDisagreementsTable.outcomeStatus })
    .from(agentDisagreementsTable)
    .where(eq(agentDisagreementsTable.disagreementId, id))
    .limit(1);
  if (!existing) return { ok: false, error: "DISAGREEMENT_NOT_FOUND" };
  return { ok: true, alreadyResolved: true };
}
