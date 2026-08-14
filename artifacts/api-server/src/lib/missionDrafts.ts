// ── Profit Mission Phase 5 — Trade Draft service (reviewable / approvable) ───
//
// SAFETY / SCOPE:
//   - APPROVAL ARTIFACTS ONLY. This service turns the best-debated proposal into
//     a reviewable mission_trade_drafts row and lets the owner approve / reject
//     it. APPROVING A DRAFT FLIPS ITS STATUS TO `approved` AND WRITES A JOURNAL
//     EVENT — IT NEVER PLACES A LIVE/DEMO ORDER. Nothing here imports or calls
//     the instant-trade router, the live command pipeline, or the MT5 bridge; the
//     `executed` draft state is reserved for later phases (6–9).
//   - The edge read is ADVISORY and capped honestly upstream (Edge Engine). A
//     draft is NEVER created from a blocked (extreme-spread / too-late) or
//     context-only edge, nor from an expired proposal. Edge can only lower a
//     setup's standing — it can never raise it over a safety block.
//   - Strictly per-user / per-mission: the CALLER verifies the mission belongs to
//     the requester (ownMission gate); every query here additionally filters by
//     userId AND missionId, and every mutation + journal row lands in ONE
//     transaction (fail-closed).
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionProposalsTable,
  missionTradeDraftsTable,
  missionEventsTable,
  type MissionProposalRow,
  type MissionTradeDraftRow,
} from "@workspace/db";
import {
  resolveDraftAction,
  resolveEffectiveDraftStatus,
  computeMissionImpact,
  type TradeDraftStatus,
  type TradeDraftAction,
  type EdgeScore,
  type MissionImpact,
} from "@workspace/domain/profit-mission";
import { calculatePositionSize } from "./positionSizing.js";
import {
  resolveMissionRealisedStats,
  resolveMissionCompounding,
  resolveMissionMilestones,
} from "./missionExitManager.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

// Default reviewable window when a proposal carries no explicit expiry. Drafts
// expire on read so a stale setup can never be approved into an executable plan.
const DEFAULT_DRAFT_TTL_MS = 15 * 60 * 1000;

const RISK_PERCENT_BY_PROFILE: Record<string, number> = {
  conservative: 0.5,
  balanced: 1,
  aggressive: 2,
  extreme: 3,
};

export type DraftServiceResult =
  | { ok: true; draft: MissionTradeDraftRow }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "not_approvable"; reason: string }
  | { ok: false; kind: "expired" }
  | { ok: false; kind: "illegal"; reason: string };

export interface TradeDraftDto {
  id: number;
  draftId: string;
  missionId: number;
  proposalId: string;
  agentKey: string;
  symbol: string;
  timeframe: string;
  direction: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lot: number | null;
  riskAmount: number | null;
  expectedR: number | null;
  edgeScore: number | null;
  edgeTier: string | null;
  edge: Record<string, unknown> | null;
  missionImpact: Record<string, unknown> | null;
  reason: string | null;
  approvalReason: string | null;
  rejectionReason: string | null;
  /** Stored status (raw). */
  status: TradeDraftStatus;
  /** Status after applying expiry-on-read (what the user acts against). */
  effectiveStatus: TradeDraftStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
}

function isDraftStatus(s: string): s is TradeDraftStatus {
  return (
    s === "proposed" ||
    s === "waiting_confirmation" ||
    s === "approved" ||
    s === "rejected" ||
    s === "expired" ||
    s === "executed" ||
    s === "cancelled"
  );
}

/** Project a draft row → allowlist DTO (no secrets), expiry enforced on read. */
export function projectDraft(row: MissionTradeDraftRow, nowMs: number): TradeDraftDto {
  const rawStatus: TradeDraftStatus = isDraftStatus(row.status) ? row.status : "expired";
  const expiresAtMs = row.expiresAt ? row.expiresAt.getTime() : null;
  const effectiveStatus = resolveEffectiveDraftStatus(rawStatus, expiresAtMs, nowMs);
  return {
    id: row.id,
    draftId: row.draftId,
    missionId: row.missionId,
    proposalId: row.proposalId,
    agentKey: row.agentKey,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    entryPrice: row.entryPrice ?? null,
    stopLoss: row.stopLoss ?? null,
    takeProfit: row.takeProfit ?? null,
    lot: row.lot ?? null,
    riskAmount: row.riskAmount ?? null,
    expectedR: row.expectedR ?? null,
    edgeScore: row.edgeScore ?? null,
    edgeTier: row.edgeTier ?? null,
    edge: (row.edgeJson as Record<string, unknown> | null) ?? null,
    missionImpact: (row.missionImpactJson as Record<string, unknown> | null) ?? null,
    reason: row.reason ?? null,
    approvalReason: row.approvalReason ?? null,
    rejectionReason: row.rejectionReason ?? null,
    status: rawStatus,
    effectiveStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read the persisted advisory edge off a proposal row, if any. */
function edgeOf(proposal: MissionProposalRow): EdgeScore | null {
  const e = proposal.edgeJson as EdgeScore | null;
  if (!e || typeof e !== "object") return null;
  return e;
}

/**
 * Build the reviewable draft plan from a persisted proposal + its mission. Lot
 * is composed from the existing position-sizing engine (fixed-fraction risk,
 * never martingale); the edge + mission-impact reads are reused from the scan
 * (mission impact recomputed only when the proposal did not carry one).
 */
function buildDraftPlan(
  mission: MissionRow,
  proposal: MissionProposalRow,
  nowMs: number,
  /**
   * Combined controlled-compounding × protection-ladder risk multiplier applied
   * ON TOP of the profile's base risk %. Defaults to 1 (no change). The
   * compounding factor is realised-profit-gated and is already forced to 1 during
   * any drawdown by the pure engine; the protection-ladder factor is ≤ 1 (it can
   * only reduce risk after milestones / giveback). Net effect is stricter-or-equal
   * unless honest realised profit + a permitting governor allow a bounded boost.
   */
  sizingMultiplier = 1,
): {
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lot: number | null;
  riskAmount: number | null;
  expectedR: number | null;
  edge: EdgeScore | null;
  missionImpact: MissionImpact | Record<string, unknown> | null;
} {
  const entry = (proposal.entryPlanJson as Record<string, unknown> | null) ?? {};
  const risk = (proposal.riskPlanJson as Record<string, unknown> | null) ?? {};
  const entryPrice = numOrNull(entry.entryPrice);
  const stopLoss = numOrNull(risk.stopLoss);
  const takeProfit = numOrNull(risk.takeProfit);
  const expectedR = numOrNull(risk.expectedR) ?? numOrNull(proposal.expectedR);
  let riskAmount = numOrNull(proposal.riskAmount) ?? numOrNull(risk.riskAmount);
  let lot: number | null = null;

  const accountBalance = mission.currentValue;
  const baseRiskPercent = RISK_PERCENT_BY_PROFILE[mission.riskProfile] ?? 1;
  const mult =
    Number.isFinite(sizingMultiplier) && sizingMultiplier > 0 ? sizingMultiplier : 1;
  const riskPercent = baseRiskPercent * mult;
  if (entryPrice != null && stopLoss != null && accountBalance > 0) {
    const sized = calculatePositionSize({
      accountBalance,
      riskPercent,
      entry: entryPrice,
      stopLoss,
      symbol: proposal.symbol,
    });
    if (sized.stopDistance > 0) {
      lot = sized.finalLot;
      riskAmount = sized.riskAmount;
    }
  }

  // Reuse the scan's mission-impact preview; recompute only if it was absent.
  let missionImpact: MissionImpact | Record<string, unknown> | null =
    (proposal.missionImpactJson as Record<string, unknown> | null) ?? null;
  if (!missionImpact && riskAmount != null && riskAmount > 0 && expectedR != null && expectedR > 0) {
    missionImpact = computeMissionImpact({
      math: {
        startingAmount: mission.startingAmount,
        targetAmount: mission.targetAmount,
        timeframeStartMs: mission.timeframeStart.getTime(),
        timeframeEndMs: mission.timeframeEnd.getTime(),
        currentValue: mission.currentValue,
        nowMs,
      },
      riskAmount,
      expectedR,
      winProbability: proposal.confidence > 0 ? proposal.confidence / 100 : null,
    });
  }

  return {
    entryPrice,
    stopLoss,
    takeProfit,
    lot,
    riskAmount,
    expectedR,
    edge: edgeOf(proposal),
    missionImpact,
  };
}

/** Load a proposal scoped strictly by (proposalId, missionId, userId). */
async function ownProposal(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: number,
  missionId: number,
  proposalId: string,
): Promise<MissionProposalRow | null> {
  const rows = await tx
    .select()
    .from(missionProposalsTable)
    .where(
      and(
        eq(missionProposalsTable.proposalId, proposalId),
        eq(missionProposalsTable.missionId, missionId),
        eq(missionProposalsTable.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reason a proposal cannot become an executable draft, or null when it can. A
 * blocked / context-only edge, a non-actionable tier, a missing direction, or an
 * expired proposal are all refused — the edge can only lower standing, never
 * force a trade.
 */
function proposalDraftBlocker(proposal: MissionProposalRow, nowMs: number): string | null {
  if (proposal.direction === "NONE") return "Proposal has no directional setup — context only.";
  if (proposal.status === "vetoed") return "Proposal was vetoed by the Risk reviewer.";
  if (proposal.status === "context_only") return "Proposal is context only — no actionable setup.";
  if (proposal.status === "expired") return "Proposal has expired.";
  if (proposal.expiresAt && nowMs >= proposal.expiresAt.getTime()) return "Proposal has expired.";
  const edge = edgeOf(proposal);
  if (!edge) return "No advisory edge has been computed for this proposal yet — run a scan first.";
  if (edge.blocked) return `Setup blocked by a safety cap (${edge.capReason ?? "blocked"}).`;
  if (edge.contextOnly) return `Edge is context only (${edge.capReason ?? "no actionable edge"}).`;
  if (!edge.actionable) return `Tier ${edge.tier} edge is below the actionable A/B floor — skip, do not force.`;
  return null;
}

/**
 * Ensure an ACTIVE draft exists for a proposal, creating it at
 * `waiting_confirmation` when absent. Idempotent via the partial unique index on
 * (proposalId) for active statuses. Returns the active draft row.
 */
async function ensureDraft(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: number,
  mission: MissionRow,
  proposal: MissionProposalRow,
  nowMs: number,
  sizingMultiplier = 1,
): Promise<MissionTradeDraftRow> {
  const existing = await tx
    .select()
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.proposalId, proposal.proposalId),
        eq(missionTradeDraftsTable.userId, userId),
      ),
    )
    .orderBy(desc(missionTradeDraftsTable.id))
    .limit(1);
  const active = existing.find((d) =>
    d.status === "proposed" || d.status === "waiting_confirmation" || d.status === "approved",
  );
  if (active) return active;

  const plan = buildDraftPlan(mission, proposal, nowMs, sizingMultiplier);
  const expiresAt = proposal.expiresAt ?? new Date(nowMs + DEFAULT_DRAFT_TTL_MS);
  const draftId = `${mission.id}:${proposal.proposalId}:${nowMs}`;

  const inserted = await tx
    .insert(missionTradeDraftsTable)
    .values({
      draftId,
      missionId: mission.id,
      userId,
      proposalId: proposal.proposalId,
      missionProposalRowId: proposal.id,
      agentKey: proposal.agentKey,
      symbol: proposal.symbol,
      timeframe: proposal.timeframe,
      direction: proposal.direction,
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      lot: plan.lot,
      riskAmount: plan.riskAmount,
      expectedR: plan.expectedR,
      edgeScore: plan.edge?.finalEdgeScore ?? null,
      edgeTier: plan.edge?.tier ?? null,
      edgeJson: plan.edge ?? null,
      missionImpactJson: plan.missionImpact ?? null,
      reason: proposal.reason ?? null,
      status: "waiting_confirmation",
      expiresAt,
    })
    .onConflictDoNothing({
      target: missionTradeDraftsTable.proposalId,
      where: sql`status in ('proposed','waiting_confirmation','approved')`,
    })
    .returning();

  if (inserted[0]) {
    await tx.insert(missionEventsTable).values({
      missionId: mission.id,
      type: "draft_created",
      message: `Trade draft created for ${proposal.symbol} ${proposal.direction} (${proposal.timeframe}).`,
      metadataJson: {
        draftId,
        proposalId: proposal.proposalId,
        agentKey: proposal.agentKey,
        edgeTier: plan.edge?.tier ?? null,
      },
    });
    return inserted[0];
  }

  // Lost the idempotent race — re-read the active draft created concurrently.
  const reread = await tx
    .select()
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.proposalId, proposal.proposalId),
        eq(missionTradeDraftsTable.userId, userId),
      ),
    )
    .orderBy(desc(missionTradeDraftsTable.id))
    .limit(1);
  const reactive = reread.find((d) =>
    d.status === "proposed" || d.status === "waiting_confirmation" || d.status === "approved",
  );
  return reactive ?? reread[0]!;
}

interface DecisionArgs {
  userId: number;
  missionId: number;
  proposalId: string;
  reason?: string | null;
}

/**
 * Apply an approve/reject decision to a proposal's draft (creating the draft if
 * needed) + journal the decision in one transaction. APPROVE writes an
 * `approved` record + journal event — it NEVER places an order. Fail-closed.
 */
async function decide(
  args: DecisionArgs,
  action: Extract<TradeDraftAction, "approve" | "reject">,
): Promise<DraftServiceResult> {
  const { userId, missionId, proposalId } = args;
  const reason = args.reason && args.reason.trim().length > 0 ? args.reason.trim().slice(0, 500) : null;
  return db.transaction(async (tx): Promise<DraftServiceResult> => {
    const missionRows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, missionId), eq(profitMissionsTable.userId, userId)))
      .for("update")
      .limit(1);
    const mission = missionRows[0] ?? null;
    if (!mission) return { ok: false, kind: "not_found" };

    const proposal = await ownProposal(tx, userId, missionId, proposalId);
    if (!proposal) return { ok: false, kind: "not_found" };

    const nowMs = Date.now();
    const blocker = proposalDraftBlocker(proposal, nowMs);
    if (blocker) return { ok: false, kind: "not_approvable", reason: blocker };

    // Controlled-compounding × protection-ladder sizing. Realised stats are
    // resolved once (CLOSED drafts are stable across this tx) and shared by both
    // resolvers. Compounding boosts ONLY on honest realised closed profit and is
    // forced to 1 during any drawdown by the pure engine; the protection ladder's
    // riskMultiplier (≤ 1) can only further reduce risk after milestones/giveback.
    // Net multiplier is stricter-or-equal unless a permitting governor + realised
    // profit allow a bounded boost. Fail-safe: any resolver error falls back to 1.
    let sizingMultiplier = 1;
    try {
      const realised = await resolveMissionRealisedStats({ userId, missionId, nowMs });
      const [compounding, milestone] = await Promise.all([
        resolveMissionCompounding({ userId, mission, realised, nowMs }),
        resolveMissionMilestones({ userId, mission, realised, nowMs }),
      ]);
      const combined = compounding.multiplier * milestone.riskMultiplier;
      sizingMultiplier = Number.isFinite(combined) && combined > 0 ? combined : 1;
    } catch {
      sizingMultiplier = 1;
    }

    const draft = await ensureDraft(tx, userId, mission, proposal, nowMs, sizingMultiplier);

    // Expiry-on-read: a non-terminal draft past its window reads as expired and
    // is flipped to `expired` (never approvable into an executable plan).
    const rawStatus: TradeDraftStatus = isDraftStatus(draft.status) ? draft.status : "expired";
    const expiresAtMs = draft.expiresAt ? draft.expiresAt.getTime() : null;
    const effective = resolveEffectiveDraftStatus(rawStatus, expiresAtMs, nowMs);
    if (effective === "expired" && rawStatus !== "expired") {
      await tx
        .update(missionTradeDraftsTable)
        .set({ status: "expired", updatedAt: new Date(nowMs) })
        .where(eq(missionTradeDraftsTable.id, draft.id));
      await tx.insert(missionEventsTable).values({
        missionId,
        type: "draft_expired",
        message: `Trade draft for ${draft.symbol} expired before approval.`,
        metadataJson: { draftId: draft.draftId, proposalId },
      });
      return { ok: false, kind: "expired" };
    }

    const resolved = resolveDraftAction(effective, action);
    if (!resolved.ok) return { ok: false, kind: "illegal", reason: resolved.reason };

    const now = new Date(nowMs);
    const setFields =
      action === "approve"
        ? { status: resolved.to, approvedAt: now, approvalReason: reason, updatedAt: now }
        : { status: resolved.to, rejectedAt: now, rejectionReason: reason, updatedAt: now };
    const updated = await tx
      .update(missionTradeDraftsTable)
      .set(setFields)
      .where(and(eq(missionTradeDraftsTable.id, draft.id), eq(missionTradeDraftsTable.userId, userId)))
      .returning();

    // Append-only journal row — same transaction (a throw rolls the move back).
    // APPROVAL IS AN `approved` RECORD ONLY — no order is placed here.
    await tx.insert(missionEventsTable).values({
      missionId,
      type: action === "approve" ? "draft_approved" : "draft_rejected",
      message:
        action === "approve"
          ? `Trade draft approved for ${draft.symbol} ${draft.direction} (approved record only — no order placed).${reason ? ` ${reason}` : ""}`
          : `Trade draft rejected for ${draft.symbol} ${draft.direction}.${reason ? ` ${reason}` : ""}`,
      metadataJson: {
        draftId: draft.draftId,
        proposalId,
        agentKey: draft.agentKey,
        from: effective,
        to: resolved.to,
        ...(reason ? { reason } : {}),
      },
    });

    return { ok: true, draft: updated[0]! };
  });
}

export function approveProposalDraft(args: DecisionArgs): Promise<DraftServiceResult> {
  return decide(args, "approve");
}

export function rejectProposalDraft(args: DecisionArgs): Promise<DraftServiceResult> {
  return decide(args, "reject");
}

/**
 * List a mission's trade drafts (newest first), enforcing expiry on read. The
 * CALLER must have verified the mission belongs to the requester (ownMission);
 * this additionally filters by userId + missionId.
 */
export async function listTradeDrafts(
  userId: number,
  missionId: number,
  opts: { limit: number; offset: number },
): Promise<TradeDraftDto[]> {
  const rows = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, missionId),
        eq(missionTradeDraftsTable.userId, userId),
      ),
    )
    .orderBy(desc(missionTradeDraftsTable.createdAt), desc(missionTradeDraftsTable.id))
    .limit(opts.limit)
    .offset(opts.offset);
  const nowMs = Date.now();
  return rows.map((r) => projectDraft(r, nowMs));
}
