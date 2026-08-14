// Agent Ecosystem — Layer 4: daily Household Report generator (§17).
//
// Aggregates a point-in-time picture of what the advisory ecosystem did:
//   - registry standing (best / weakest agent, totals, department performance,
//     bloat / speed warnings, new agents)
//   - today's lifecycle activity (promotions / demotions / Learning-Camp in-out /
//     shutdown recommended) from the durable lifecycle + camp tables
//   - today's creation-request activity (proposed / approved / rejected)
//   - surface activity from the in-memory governance traces (bad trades blocked,
//     quality setups found, no-trade wins, scanner noise filtered, step-backs that
//     saved speed, agents that slowed the system) — best-effort, honestly empty
//     after a restart, never fabricated
//   - recommended admin actions (deduped lifecycle recommendations)
//
// SAFETY / SCOPE: OBSERVATION ONLY. Reads the advisory registry + traces and
// persists a report row. NOTHING here trades, gates, slows, or blocks any
// live/demo path or touches the 16-gate live pipeline. The plain-English
// `rubySummary` deliberately uses NO internal agent codes / table / route names.

import {
  db,
  agentsTable,
  agentLifecycleEventsTable,
  agentLearningCampRecordsTable,
  agentCreationRequestsTable,
  agentHouseholdReportsTable,
  type AgentRow,
  type AgentHouseholdReportRow,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getGovernanceTraces } from "./governance.js";

// ── Report body shape (persisted as JSON text in `summary`) ──────────────────

export interface HouseholdReportAgentRef {
  agentKey: string;
  name: string;
  department: string;
  composite: number;
}

export interface HouseholdDepartmentPerf {
  department: string;
  agentCount: number;
  avgQuality: number;
  avgTrust: number;
  avgSpeed: number;
}

export interface HouseholdLifecycleEntry {
  agentName: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
}

export interface HouseholdCreationEntry {
  proposedName: string;
  proposedDepartment: string;
  status: string;
  purpose: string;
}

export interface HouseholdSurfaceFinding {
  symbol: string;
  surface: string;
  detail: string;
}

export interface HouseholdRecommendedAction {
  agentKey: string;
  name: string;
  action: string;
  reason: string;
}

export interface HouseholdReportBody {
  reportDate: string;
  totals: {
    totalAgents: number;
    active: number;
    shadow: number;
    learningCamp: number;
    restricted: number;
    shutdownRecommended: number;
    avgTrust: number;
    avgQuality: number;
    avgSpeed: number;
  };
  bestAgent: HouseholdReportAgentRef | null;
  weakestAgent: HouseholdReportAgentRef | null;
  newAgents: HouseholdReportAgentRef[];
  promotions: HouseholdLifecycleEntry[];
  demotions: HouseholdLifecycleEntry[];
  learningCampIn: HouseholdLifecycleEntry[];
  learningCampOut: { agentName: string; returnStatus: string }[];
  creationRequests: HouseholdCreationEntry[];
  stepBacksSavedSpeed: HouseholdSurfaceFinding[];
  agentsThatSlowedSystem: HouseholdSurfaceFinding[];
  badTradesBlocked: HouseholdSurfaceFinding[];
  qualityTradesFound: HouseholdSurfaceFinding[];
  noTradeWins: HouseholdSurfaceFinding[];
  scannerNoiseFiltered: HouseholdSurfaceFinding[];
  departmentPerformance: HouseholdDepartmentPerf[];
  bloatWarnings: string[];
  speedWarnings: string[];
  whatTheSystemLearned: string[];
  recommendedAdminActions: HouseholdRecommendedAction[];
}

function composite(a: AgentRow): number {
  return Math.round(
    (a.trustScore + a.qualityScore + a.usefulnessScore + a.protectionScore + a.calibrationScore) / 5,
  );
}

function agentRef(a: AgentRow): HouseholdReportAgentRef {
  return { agentKey: a.agentKey, name: a.name, department: a.department, composite: composite(a) };
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
}

/** UTC start-of-day for the report window. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/** Build the §17 report body from the durable registry + in-memory traces. */
export async function buildHouseholdReportBody(now: Date = new Date()): Promise<HouseholdReportBody> {
  const dayStart = startOfUtcDay(now);
  const reportDate = dayStart.toISOString().slice(0, 10);

  // ── Registry standing (non-archived agents) ───────────────────────────────
  const agents = await db.select().from(agentsTable).where(isNull(agentsTable.archivedAt));

  const totals = {
    totalAgents: agents.length,
    active: agents.filter((a) => a.currentStatus === "ACTIVE").length,
    shadow: agents.filter((a) => a.currentStatus === "SHADOW").length,
    learningCamp: agents.filter((a) => a.currentStatus === "LEARNING_CAMP").length,
    restricted: agents.filter((a) =>
      a.currentStatus === "RESTRICTED" || a.currentStatus === "PROBATION" ||
      a.currentStatus === "QUARANTINED").length,
    shutdownRecommended: agents.filter((a) => a.currentStatus === "SHUTDOWN_RECOMMENDED").length,
    avgTrust: avg(agents.map((a) => a.trustScore)),
    avgQuality: avg(agents.map((a) => a.qualityScore)),
    avgSpeed: avg(agents.map((a) => a.speedScore)),
  };

  const ranked = [...agents].sort((a, b) => composite(b) - composite(a));
  const bestAgent = ranked.length > 0 ? agentRef(ranked[0]) : null;
  const weakestAgent = ranked.length > 0 ? agentRef(ranked[ranked.length - 1]) : null;

  const newAgents = agents
    .filter((a) => !a.isCore && a.createdAt >= dayStart)
    .map(agentRef);

  // Department performance roll-up.
  const byDept = new Map<string, AgentRow[]>();
  for (const a of agents) {
    const list = byDept.get(a.department) ?? [];
    list.push(a);
    byDept.set(a.department, list);
  }
  const departmentPerformance: HouseholdDepartmentPerf[] = [...byDept.entries()]
    .map(([department, list]) => ({
      department,
      agentCount: list.length,
      avgQuality: avg(list.map((a) => a.qualityScore)),
      avgTrust: avg(list.map((a) => a.trustScore)),
      avgSpeed: avg(list.map((a) => a.speedScore)),
    }))
    .sort((a, b) => b.avgQuality - a.avgQuality);

  // Bloat: departments with more than 8 agents are flagged for review.
  const bloatWarnings = departmentPerformance
    .filter((d) => d.agentCount > 8)
    .map((d) => `${d.department} has ${d.agentCount} agents — review for overlap.`);

  // Speed: any agent whose speed score is below 40 slows the desk.
  const speedWarnings = agents
    .filter((a) => a.speedScore < 40)
    .map((a) => `${a.name} is running slow (speed ${Math.round(a.speedScore)}).`);

  // ── Today's lifecycle activity (durable) ──────────────────────────────────
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const lifeRows = await db
    .select()
    .from(agentLifecycleEventsTable)
    .where(gte(agentLifecycleEventsTable.createdAt, dayStart))
    .orderBy(desc(agentLifecycleEventsTable.createdAt))
    .limit(500);

  const lifeEntry = (r: typeof lifeRows[number]): HouseholdLifecycleEntry => ({
    agentName: agentNameById.get(r.agentId) ?? `agent#${r.agentId}`,
    action: r.action,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    reason: r.reason,
  });
  const isPromotion = (r: typeof lifeRows[number]) =>
    r.action === "PROMOTE" || (r.authorityWeightAfter ?? 0) > (r.authorityWeightBefore ?? 0);
  const isDemotion = (r: typeof lifeRows[number]) =>
    r.action === "DEMOTE" || r.action === "PROBATION" || r.action === "WARN" ||
    r.action === "SHUTDOWN_RECOMMEND" ||
    (r.authorityWeightAfter ?? 0) < (r.authorityWeightBefore ?? 0);

  const promotions = lifeRows.filter(isPromotion).map(lifeEntry);
  const demotions = lifeRows.filter((r) => !isPromotion(r) && isDemotion(r)).map(lifeEntry);
  const learningCampIn = lifeRows.filter((r) => r.action === "LEARNING_CAMP").map(lifeEntry);

  const campRows = await db
    .select()
    .from(agentLearningCampRecordsTable)
    .where(and(
      gte(agentLearningCampRecordsTable.endedAt, dayStart),
      // Terminal "returned" vocabulary is RETURNED_FULL / RETURNED_SUPERVISED
      // (never a bare "RETURNED") — match both or the section is silently empty.
      inArray(agentLearningCampRecordsTable.returnStatus, ["RETURNED_FULL", "RETURNED_SUPERVISED"]),
    ))
    .orderBy(desc(agentLearningCampRecordsTable.endedAt))
    .limit(200);
  const learningCampOut = campRows.map((r) => ({
    agentName: agentNameById.get(r.agentId) ?? `agent#${r.agentId}`,
    returnStatus: r.returnStatus,
  }));

  // ── Today's creation-request activity (durable) ───────────────────────────
  const creationRows = await db
    .select()
    .from(agentCreationRequestsTable)
    .where(gte(agentCreationRequestsTable.createdAt, dayStart))
    .orderBy(desc(agentCreationRequestsTable.createdAt))
    .limit(200);
  const creationRequests: HouseholdCreationEntry[] = creationRows.map((r) => ({
    proposedName: r.proposedName,
    proposedDepartment: r.proposedDepartment,
    status: r.status,
    purpose: r.purpose,
  }));

  // ── Surface activity from in-memory governance traces (best-effort) ────────
  const traces = getGovernanceTraces({ limit: 500 });
  const finding = (t: typeof traces[number], detail: string): HouseholdSurfaceFinding => ({
    symbol: t.symbol,
    surface: t.surface,
    detail,
  });
  const badTradesBlocked: HouseholdSurfaceFinding[] = [];
  const qualityTradesFound: HouseholdSurfaceFinding[] = [];
  const noTradeWins: HouseholdSurfaceFinding[] = [];
  const scannerNoiseFiltered: HouseholdSurfaceFinding[] = [];
  const stepBacksSavedSpeed: HouseholdSurfaceFinding[] = [];
  const agentsThatSlowedSystem: HouseholdSurfaceFinding[] = [];

  for (const t of traces) {
    const r = t.review;
    if (r.outcome === "rejected") {
      badTradesBlocked.push(finding(t, r.winningReasoning || "Setup steered away from."));
    } else if (r.outcome === "downgraded") {
      scannerNoiseFiltered.push(finding(t, r.winningReasoning || "Ranking lowered after review."));
    } else if ((r.outcome === "approved" || r.outcome === "approved_with_caution") && r.governanceScore >= 70) {
      qualityTradesFound.push(finding(t, `Ranked ${Math.round(r.governanceScore)} after review.`));
    }
    if (t.direction === "NEUTRAL") {
      noTradeWins.push(finding(t, "No high-quality setup — stayed flat."));
    }
    // Traffic participant trimming = a step-back that saved speed.
    const considered = r.traffic?.consideredCount ?? r.participatingAgentCount;
    const participating = r.traffic?.participatedCount ?? r.participatingAgentCount;
    if (considered > participating) {
      stepBacksSavedSpeed.push(finding(t, `${considered - participating} agent(s) stepped back to keep the read fast.`));
    }
    if (r.hasUntrustedResponsibleAgent) {
      agentsThatSlowedSystem.push(finding(t, "A low-trust agent weighed in and was discounted."));
    }
  }

  // Recommended admin actions: deduped lifecycle recommendations across traces.
  const recByKey = new Map<string, HouseholdRecommendedAction>();
  for (const t of traces) {
    for (const rec of t.review.lifecycleRecommendations) {
      const k = `${rec.agentKey}:${rec.action}`;
      if (!recByKey.has(k)) {
        recByKey.set(k, { agentKey: rec.agentKey, name: rec.name, action: rec.action, reason: rec.reason });
      }
    }
  }
  const recommendedAdminActions = [...recByKey.values()];

  // ── What the system learned today (durable, derived from real activity) ────
  const whatTheSystemLearned: string[] = [];
  if (promotions.length > 0) whatTheSystemLearned.push(`${promotions.length} agent(s) earned more standing on strong recent calls.`);
  if (demotions.length > 0) whatTheSystemLearned.push(`${demotions.length} agent(s) lost standing after weak recent calls.`);
  if (learningCampIn.length > 0) whatTheSystemLearned.push(`${learningCampIn.length} agent(s) entered correction to fix a repeating mistake.`);
  if (learningCampOut.length > 0) whatTheSystemLearned.push(`${learningCampOut.length} agent(s) graduated correction and returned.`);
  if (badTradesBlocked.length > 0) whatTheSystemLearned.push(`${badTradesBlocked.length} weak setup(s) were steered away from.`);
  if (qualityTradesFound.length > 0) whatTheSystemLearned.push(`${qualityTradesFound.length} high-quality setup(s) were surfaced.`);

  return {
    reportDate,
    totals,
    bestAgent,
    weakestAgent,
    newAgents,
    promotions,
    demotions,
    learningCampIn,
    learningCampOut,
    creationRequests,
    stepBacksSavedSpeed,
    agentsThatSlowedSystem,
    badTradesBlocked,
    qualityTradesFound,
    noTradeWins,
    scannerNoiseFiltered,
    departmentPerformance,
    bloatWarnings,
    speedWarnings,
    whatTheSystemLearned,
    recommendedAdminActions,
  };
}

/** A short headline for list views. */
function buildHeadline(body: HouseholdReportBody): string {
  const t = body.totals;
  return `${t.totalAgents} agents · ${t.active} active · ${body.promotions.length} promoted · ` +
    `${body.demotions.length} stepped back · ${body.badTradesBlocked.length} weak setups filtered`;
}

/** Plain-English summary for the user-facing assistant — NO internal codes. */
export function buildRubySummary(body: HouseholdReportBody): string {
  const parts: string[] = [];
  parts.push(
    `Here's how the trading team did today. There are ${body.totals.totalAgents} specialists on the desk, ` +
    `${body.totals.active} of them fully active.`,
  );
  if (body.bestAgent) {
    parts.push(`The strongest performer was ${body.bestAgent.name}.`);
  }
  if (body.weakestAgent && body.weakestAgent.agentKey !== body.bestAgent?.agentKey) {
    parts.push(`${body.weakestAgent.name} was the weakest and is being watched.`);
  }
  if (body.promotions.length > 0 || body.demotions.length > 0) {
    parts.push(
      `${body.promotions.length} earned more say in the read and ${body.demotions.length} were pulled back.`,
    );
  }
  if (body.badTradesBlocked.length > 0) {
    parts.push(`The team steered away from ${body.badTradesBlocked.length} weak setup(s).`);
  }
  if (body.qualityTradesFound.length > 0) {
    parts.push(`It flagged ${body.qualityTradesFound.length} higher-quality setup(s) worth a look.`);
  }
  if (body.scannerNoiseFiltered.length > 0) {
    parts.push(`It quietened ${body.scannerNoiseFiltered.length} noisy alert(s) so you see less clutter.`);
  }
  if (body.recommendedAdminActions.length > 0) {
    parts.push(`There are ${body.recommendedAdminActions.length} suggestion(s) waiting for an admin to review.`);
  }
  parts.push("This is decision support only — nothing here places or changes a trade.");
  return parts.join(" ");
}

/**
 * Generate (or refresh) the canonical Household Report for the current UTC day
 * and persist it. One report per day is upserted on report_date. Returns the
 * stored row. OBSERVATION ONLY — never trades or gates a path.
 */
export async function generateHouseholdReport(opts: {
  generatedByUserId?: number | null;
  now?: Date;
} = {}): Promise<AgentHouseholdReportRow> {
  const now = opts.now ?? new Date();
  const body = await buildHouseholdReportBody(now);
  const headline = buildHeadline(body);
  const rubySummary = buildRubySummary(body);

  // Atomic upsert keyed on the per-UTC-day unique index (report_date). Two
  // concurrent generates for the same day collapse into one row instead of one
  // of them 500ing on a unique-constraint conflict; the loser refreshes the body.
  const [row] = await db
    .insert(agentHouseholdReportsTable)
    .values({
      reportId: randomUUID(),
      reportDate: body.reportDate,
      summary: JSON.stringify(body),
      rubySummary,
      headline,
      totalAgents: body.totals.totalAgents,
      generatedByUserId: opts.generatedByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentHouseholdReportsTable.reportDate,
      set: {
        summary: JSON.stringify(body),
        rubySummary,
        headline,
        totalAgents: body.totals.totalAgents,
        // Preserve a prior generator attribution if this refresh has none.
        generatedByUserId: opts.generatedByUserId ?? sql`${agentHouseholdReportsTable.generatedByUserId}`,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

/** Parsed view of a stored report row (summary JSON expanded). */
export interface HouseholdReportView {
  id: number;
  reportId: string;
  reportDate: string;
  headline: string;
  totalAgents: number;
  rubySummary: string;
  body: HouseholdReportBody | null;
  generatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

function parseBody(raw: string): HouseholdReportBody | null {
  try {
    return JSON.parse(raw) as HouseholdReportBody;
  } catch {
    return null;
  }
}

export function toReportView(row: AgentHouseholdReportRow): HouseholdReportView {
  return {
    id: row.id,
    reportId: row.reportId,
    reportDate: row.reportDate,
    headline: row.headline,
    totalAgents: row.totalAgents,
    rubySummary: row.rubySummary,
    body: parseBody(row.summary),
    generatedByUserId: row.generatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List recent reports (newest first) with optional headline/date search. */
export async function listHouseholdReports(opts: { search?: string; limit?: number } = {}): Promise<HouseholdReportView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const search = (opts.search ?? "").trim().toLowerCase();
  const rows = await db
    .select()
    .from(agentHouseholdReportsTable)
    .where(
      search
        ? sql`(lower(${agentHouseholdReportsTable.headline}) like ${"%" + search + "%"} or ${agentHouseholdReportsTable.reportDate} like ${"%" + search + "%"})`
        : undefined,
    )
    .orderBy(desc(agentHouseholdReportsTable.reportDate))
    .limit(limit);
  return rows.map(toReportView);
}

export async function getHouseholdReport(reportId: string): Promise<HouseholdReportView | null> {
  const [row] = await db
    .select()
    .from(agentHouseholdReportsTable)
    .where(eq(agentHouseholdReportsTable.reportId, reportId))
    .limit(1);
  return row ? toReportView(row) : null;
}

/**
 * Latest persisted report's plain-English team summary, for the user-facing
 * read-only assistant (Ruby). Returns ONLY the `rubySummary` (produced by
 * `buildRubySummary`, which deliberately carries no internal agent codes,
 * table/route names, or operator/admin numbers) plus its date. Never returns
 * the structured `body`, headline, or registry totals. Null when no report
 * has been generated yet — callers surface an honest empty state, never
 * fabricate a summary.
 */
export async function getLatestRubyTeamSummary(): Promise<{ reportDate: string; rubySummary: string } | null> {
  const [row] = await db
    .select({
      reportDate: agentHouseholdReportsTable.reportDate,
      rubySummary: agentHouseholdReportsTable.rubySummary,
    })
    .from(agentHouseholdReportsTable)
    .orderBy(desc(agentHouseholdReportsTable.reportDate))
    .limit(1);
  return row ? { reportDate: row.reportDate, rubySummary: row.rubySummary } : null;
}
