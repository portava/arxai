// ── Profit Mission Phase 6 — Gated execution hook (approved draft → REAL order) ──
//
// SAFETY / SCOPE:
//   - This is the FIRST time an approved Profit-Mission draft can become a real
//     order, and it routes EXCLUSIVELY through the existing instant-trade router
//     (`executeInstant`, source "mission") → live command pipeline → 18-gate
//     dispatch. There is NO new execution path; nothing here can place an order
//     by itself. `executeInstant` is injectable ONLY so tests can substitute a
//     spy — production always uses the real router.
//   - Per-draft user approval (Level 2) is still required: a draft must already
//     be `approved` (or `waiting_confirmation`→approved) before it can dispatch.
//     This hook never approves; it only dispatches an already-approved draft.
//   - The additive, STRICTER-ONLY mission gate (`composeMissionGate`) runs FIRST.
//     If it blocks, no order is attempted and the draft stays `approved`. The
//     real per-user governor + 18-gate live dispatch still run unconditionally
//     inside `executeInstant` — the mission gate can only ADD strictness.
//   - DEMO never touches the live broker: a non-live mission (`paper`/`demo`)
//     audits + journals the intent and returns without ever calling the live
//     pipeline. Demo stays demo.
//   - Per-user / per-mission isolation: mission + draft are loaded `FOR UPDATE`
//     scoped by (id, userId); the executed-flip is a CAS on the still-approved
//     row inside one transaction (fail-closed).
import { and, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionTradeDraftsTable,
  missionEventsTable,
  oneClickAuditTable,
  type MissionTradeDraftRow,
} from "@workspace/db";
import {
  composeMissionGate,
  type MissionGateResult,
} from "@workspace/domain/profit-mission";
import {
  executeInstant,
  type InstantTradeIntent,
  type InstantTradeResult,
} from "./live/instantTrade.js";
import { refreshMissionRisk, type MissionLiveSignals } from "./missionRiskService.js";
import {
  evaluatePhase7PreChecks,
  exposureBudgetFrom,
  type Phase7Evaluator,
  type Phase7Verdict,
} from "./missionExecutionQuality.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

/** The injectable executor seam — defaults to the real instant-trade router. */
export type MissionExecutor = (args: {
  userId: number;
  intent: InstantTradeIntent;
  ip?: string | null;
  ua?: string | null;
}) => Promise<InstantTradeResult>;

export interface DispatchApprovedDraftArgs {
  userId: number;
  missionId: number;
  /** Either identifier resolves the draft; `draftId` wins when both are given. */
  draftId?: string;
  proposalId?: string;
  ip?: string | null;
  ua?: string | null;
  /** Live runtime signals fed to the mission risk read (fail-safe defaults). */
  signals?: MissionLiveSignals;
  nowMs?: number;
}

export interface DispatchApprovedDraftOpts {
  executor?: MissionExecutor;
  /** Injectable Phase 7 pre-check evaluator — defaults to the real one. */
  phase7Evaluator?: Phase7Evaluator;
}

export type DispatchApprovedDraftResult =
  | { ok: true; commandId?: string; draft: MissionTradeDraftRow }
  | { ok: false; kind: "mission_not_found" }
  | { ok: false; kind: "draft_not_found" }
  | { ok: false; kind: "not_approved"; status: string }
  | { ok: false; kind: "expired" }
  | { ok: false; kind: "no_direction" }
  | { ok: false; kind: "non_live"; executionMode: string }
  | { ok: false; kind: "mission_blocked"; gate: MissionGateResult }
  | { ok: false; kind: "phase7_blocked"; phase7: Phase7Verdict }
  | {
      ok: false;
      kind: "execution_rejected";
      error: string;
      primaryReason?: string;
      httpStatus: number;
    };

/** Conservative defaults: no observed anomaly. `feedStatus`/`quoteFresh` are the
 * NEUTRAL element of the additive mission gate ("no extra degradation observed",
 * NOT a claim the feed is live). The real live pipeline re-derives every safety
 * signal server-side, and Phase 7 resolves real per-symbol feed truth itself from
 * the mt5_broker-aware seam; this channel can solely ADD strictness. */
const DEFAULT_SIGNALS: MissionLiveSignals = {
  killSwitchActive: false,
  brokerConnected: true,
  feedStatus: "live",
  quoteFresh: true,
};

async function journalMissionEvent(args: {
  missionId: number;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(missionEventsTable).values({
    missionId: args.missionId,
    type: args.type,
    message: args.message,
    metadataJson: args.metadata ?? null,
  });
}

async function auditMission(args: {
  userId: number;
  action: string;
  ip?: string | null;
  ua?: string | null;
  metadata?: unknown;
}): Promise<void> {
  await db.insert(oneClickAuditTable).values({
    userId: args.userId,
    action: args.action,
    ip: args.ip ?? null,
    userAgent: args.ua ?? null,
    metadata: args.metadata != null ? JSON.stringify(args.metadata) : null,
  });
}

/**
 * Dispatch an already-approved mission draft into REAL execution via the existing
 * instant-trade router. Stricter-only mission gate runs first; demo/paper missions
 * never touch the live broker. Every outcome is journaled and audited.
 */
export async function dispatchApprovedDraft(
  args: DispatchApprovedDraftArgs,
  opts: DispatchApprovedDraftOpts = {},
): Promise<DispatchApprovedDraftResult> {
  const executor = opts.executor ?? executeInstant;
  const nowMs = args.nowMs ?? Date.now();

  // ── Load mission + draft, both scoped by userId (per-user isolation) ────────
  const missionRows = await db
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)))
    .limit(1);
  const mission = missionRows[0] as MissionRow | undefined;
  if (!mission) return { ok: false, kind: "mission_not_found" };

  const draftFilter = args.draftId
    ? eq(missionTradeDraftsTable.draftId, args.draftId)
    : args.proposalId
      ? eq(missionTradeDraftsTable.proposalId, args.proposalId)
      : null;
  if (!draftFilter) return { ok: false, kind: "draft_not_found" };

  const draftRows = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(
      and(
        draftFilter,
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
      ),
    )
    .limit(1);
  const draft = draftRows[0] as MissionTradeDraftRow | undefined;
  if (!draft) return { ok: false, kind: "draft_not_found" };

  // ── Level-2 approval is mandatory; an expired draft can never dispatch ───────
  if (draft.status !== "approved") return { ok: false, kind: "not_approved", status: draft.status };
  if (draft.expiresAt && draft.expiresAt.getTime() <= nowMs) {
    return { ok: false, kind: "expired" };
  }
  if (draft.direction !== "BUY" && draft.direction !== "SELL") {
    return { ok: false, kind: "no_direction" };
  }

  // ── Additive, stricter-only mission gate (runs BEFORE any execution) ─────────
  const risk = await refreshMissionRisk({
    userId: args.userId,
    missionId: args.missionId,
    signals: args.signals ?? DEFAULT_SIGNALS,
    nowMs,
  });
  if (!risk.ok) return { ok: false, kind: "mission_not_found" };
  const state = risk.state;

  const gate = composeMissionGate({
    // The real per-user governor + 18-gate run inside executeInstant; this seam
    // starts from "pass" and the mission layer can only escalate strictness.
    governorDecision: "pass",
    mode: state.mode,
    ladderAction: state.ladderAction,
    blowupAction: state.blowup.action,
    budgetExceeded: state.budgetUsedPct >= 100,
    cooldownActive: state.behavioral.cooldownTriggered,
    emergencyTriggered: state.emergency.triggered,
    hasStopLoss: draft.stopLoss != null,
    edgeTier: draft.edgeTier,
  });

  if (!gate.allow) {
    await journalMissionEvent({
      missionId: args.missionId,
      type: "draft_execution_blocked",
      message: `Draft execution blocked by mission risk gate (${state.mode}).${gate.blockReasons[0] ? ` ${gate.blockReasons[0]}` : ""}`,
      metadata: {
        draftId: draft.draftId,
        decision: gate.decision,
        blockReasons: gate.blockReasons,
        mode: state.mode,
        blowupLevel: state.blowup.level,
      },
    });
    await auditMission({
      userId: args.userId,
      action: "mission_draft_execution_blocked",
      ip: args.ip,
      ua: args.ua,
      metadata: { missionId: args.missionId, draftId: draft.draftId, blockReasons: gate.blockReasons },
    });
    return { ok: false, kind: "mission_blocked", gate };
  }

  // ── Demo / paper never touch the live broker (audit + journal only) ──────────
  const executionMode = mission.executionMode;
  if (executionMode !== "live") {
    await auditMission({
      userId: args.userId,
      action: "mission_draft_dispatch_non_live",
      ip: args.ip,
      ua: args.ua,
      metadata: { missionId: args.missionId, draftId: draft.draftId, executionMode },
    });
    await journalMissionEvent({
      missionId: args.missionId,
      type: "draft_dispatch_skipped_non_live",
      message: `Draft approved for ${draft.symbol} ${draft.direction} — mission is ${executionMode}; the live broker is never contacted.`,
      metadata: { draftId: draft.draftId, executionMode },
    });
    return { ok: false, kind: "non_live", executionMode };
  }

  // ── Phase 7 pre-checks (additive, stricter-only) BEFORE the single-flight ────
  // claim. Layered ON TOP of the mission gate + the real per-user governor +
  // 18-gate live dispatch inside executeInstant. Block/downgrade only: it can
  // refuse, never relax a gate or place an order. Honest unknowns never read
  // "good"; a block leaves the draft `approved` (no claim, no broker contact).
  const phase7Evaluator = opts.phase7Evaluator ?? evaluatePhase7PreChecks;
  const phase7 = await phase7Evaluator({
    userId: args.userId,
    missionId: args.missionId,
    draft: {
      symbol: draft.symbol,
      timeframe: draft.timeframe,
      direction: draft.direction,
      entryPrice: draft.entryPrice,
      stopLoss: draft.stopLoss,
      takeProfit: draft.takeProfit,
      lot: draft.lot,
      riskAmount: draft.riskAmount,
      expectedR: draft.expectedR,
    },
    budget: exposureBudgetFrom(state.budget),
    signals: args.signals ?? DEFAULT_SIGNALS,
    nowMs,
  });

  if (phase7.executionBlocked) {
    await journalMissionEvent({
      missionId: args.missionId,
      type: "draft_execution_blocked_phase7",
      message: `Draft execution blocked by Phase 7 pre-checks for ${draft.symbol} ${draft.direction}.${phase7.blockReasons[0] ? ` ${phase7.blockReasons[0]}` : ""} Draft remains approved.`,
      metadata: {
        draftId: draft.draftId,
        blockReasons: phase7.blockReasons,
        warnings: phase7.warnings,
        health: phase7.health.reason,
        exposure: phase7.exposure.blockers,
        netProfit: phase7.netProfit.reason,
        executionQuality: phase7.executionQuality.fillQualityExpected,
      },
    });
    await auditMission({
      userId: args.userId,
      action: "mission_draft_execution_blocked_phase7",
      ip: args.ip,
      ua: args.ua,
      metadata: { missionId: args.missionId, draftId: draft.draftId, blockReasons: phase7.blockReasons },
    });
    return { ok: false, kind: "phase7_blocked", phase7 };
  }

  // ── Live: route through the ONE instant-trade entry (source "mission") ───────
  const intent: InstantTradeIntent = {
    source: "mission",
    missionId: args.missionId,
    action: draft.direction,
    accountMode: "live",
    symbol: draft.symbol,
    volume: draft.lot ?? undefined,
    stopLoss: draft.stopLoss,
    takeProfit: draft.takeProfit,
  };

  await auditMission({
    userId: args.userId,
    action: "mission_draft_dispatch_attempt",
    ip: args.ip,
    ua: args.ua,
    metadata: { missionId: args.missionId, draftId: draft.draftId, symbol: draft.symbol, direction: draft.direction },
  });

  // ── Single-flight claim (atomic CAS approved → executed) BEFORE the broker ───
  // The first caller to flip the still-`approved` row wins and is the ONLY one
  // allowed to contact the executor. A concurrent second call sees a non-approved
  // row (0 rows updated) and bails WITHOUT ever calling live execution, so an
  // approved draft can never be double-dispatched. This is the safety-critical
  // chokepoint for the first real execution path.
  const claimedRows = await db
    .update(missionTradeDraftsTable)
    .set({ status: "executed", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(missionTradeDraftsTable.draftId, draft.draftId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.status, "approved"),
      ),
    )
    .returning();
  const claimed = claimedRows[0] as MissionTradeDraftRow | undefined;
  if (!claimed) {
    // Lost the race: another in-flight dispatch already claimed this draft.
    return { ok: false, kind: "not_approved", status: "executed" };
  }

  const result = await executor({ userId: args.userId, intent, ip: args.ip, ua: args.ua });

  if (!result.ok) {
    // A clean rejection means NO order was sent (executeInstant rejects before
    // dispatch). Release the claim so the user can retry; the draft returns to
    // `approved` exactly as before — no live order, no `executed` row stranded.
    await db
      .update(missionTradeDraftsTable)
      .set({ status: "approved", updatedAt: new Date(nowMs) })
      .where(
        and(
          eq(missionTradeDraftsTable.draftId, draft.draftId),
          eq(missionTradeDraftsTable.userId, args.userId),
          eq(missionTradeDraftsTable.status, "executed"),
        ),
      );
    await journalMissionEvent({
      missionId: args.missionId,
      type: "draft_execution_rejected",
      message: `Live dispatch rejected for ${draft.symbol} ${draft.direction}: ${result.primaryReason ?? result.error}. Draft remains approved.`,
      metadata: {
        draftId: draft.draftId,
        error: result.error,
        primaryReason: result.primaryReason,
        httpStatus: result.httpStatus,
      },
    });
    return {
      ok: false,
      kind: "execution_rejected",
      error: result.error,
      primaryReason: result.primaryReason,
      httpStatus: result.httpStatus,
    };
  }

  // ── Success: the claim already flipped the row to `executed`; journal once. ──
  await journalMissionEvent({
    missionId: args.missionId,
    type: "draft_executed",
    message: `Draft dispatched to live execution for ${draft.symbol} ${draft.direction}.`,
    metadata: { draftId: draft.draftId, commandId: result.commandId ?? null, source: "mission" },
  });
  return { ok: true, commandId: result.commandId, draft: claimed };
}
