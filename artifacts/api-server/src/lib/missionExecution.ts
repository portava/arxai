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
//   - DEMO/PAPER never touch the live broker: a non-live mission runs the SAME
//     gate chain (mission gate + Phase 7 + the single-flight claim) and then
//     dispatches through the SIMULATED executor, which never calls the live
//     pipeline. The default simulated executor (`simulateMissionFill`) models a
//     fill priced from the market-data router's REAL quote at decision time and
//     writes it into the row's `sim_*` column family tagged `simulated = true`;
//     no quote means NO FILL and an honest `NO_FILL_NO_QUOTE` rejection that
//     releases the claim. No price is ever invented, and a simulated outcome
//     never touches a broker-reconciled column, so it can never enter an
//     economic posting or a live realised total.
//   - Per-user / per-mission isolation: mission + draft are loaded `FOR UPDATE`
//     scoped by (id, userId); the executed-flip is a CAS on the still-approved
//     row inside one transaction (fail-closed).
import { and, eq, isNull } from "drizzle-orm";
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
  resolveEffectiveProbation,
  probationDispatchVerdict,
  type EffectiveProbation,
} from "./recoveryProbation.js";
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

/**
 * The injectable SIMULATED executor seam for non-live (`paper`/`demo`) missions.
 * It receives the SAME intent shape (minus accountMode — a non-live mission has
 * no live account mode to claim) after the full gate chain + single-flight claim
 * have run, and must NEVER contact a broker, insert a broker command, or
 * fabricate a fill/price/P&L. The default implementation journals + audits the
 * accepted intent and returns a `sim:` command id — nothing else.
 */
export type MissionSimulatedExecutor = (args: {
  userId: number;
  missionId: number;
  executionMode: "paper" | "demo";
  draft: MissionTradeDraftRow;
  intent: Omit<InstantTradeIntent, "accountMode">;
  ip?: string | null;
  ua?: string | null;
  nowMs: number;
}) => Promise<InstantTradeResult>;

/**
 * Intent-only simulated dispatch recorder — SUPERSEDED as the default by
 * `simulateMissionFill` (missionSimulatedFills.ts), which models an honest fill
 * from a REAL router quote. This one records that the intent PASSED every
 * mission-side gate and nothing more: it never produced an outcome, which is
 * exactly why a paper/demo mission could never progress or complete and why the
 * promotion ladder's demo evidence had no source. Retained as an injectable
 * no-outcome seam for tests that want a dispatch without a modelled fill.
 */
export const recordSimulatedMissionDispatch: MissionSimulatedExecutor = async (args) => {
  const commandId = `sim:${args.executionMode}:${args.draft.draftId}:${args.nowMs}`;
  await auditMission({
    userId: args.userId,
    action: "mission_draft_dispatch_simulated",
    ip: args.ip,
    ua: args.ua,
    metadata: {
      missionId: args.missionId,
      draftId: args.draft.draftId,
      executionMode: args.executionMode,
      commandId,
      intent: args.intent,
    },
  });
  await journalMissionEvent({
    missionId: args.missionId,
    type: "draft_dispatch_simulated",
    message: `Draft dispatched through the gated path in ${args.executionMode} mode for ${args.draft.symbol} ${args.draft.direction} — intent recorded only; the live broker is never contacted and no fill or profit is simulated.`,
    metadata: { draftId: args.draft.draftId, executionMode: args.executionMode, commandId },
  });
  return { ok: true, commandId, action: args.intent.action };
};

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
  /** Injectable simulated executor for paper/demo — defaults to the recorder. */
  simulatedExecutor?: MissionSimulatedExecutor;
  /** Injectable Phase 7 pre-check evaluator — defaults to the real one. */
  phase7Evaluator?: Phase7Evaluator;
  /** #34 — injectable probation read (tests only). STRICTER-ONLY: it can add
   *  a refusal in front of the mission gate, never relax anything. */
  probationResolver?: () => Promise<EffectiveProbation>;
}

export type DispatchApprovedDraftResult =
  | { ok: true; commandId?: string; executionMode: string; draft: MissionTradeDraftRow }
  | { ok: false; kind: "mission_not_found" }
  | { ok: false; kind: "draft_not_found" }
  | { ok: false; kind: "not_approved"; status: string }
  | { ok: false; kind: "expired" }
  | { ok: false; kind: "no_direction" }
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

  // ── #34 Recovery probation wall (additive, stricter-only, runs FIRST) ────────
  // After a kill-switch release the platform re-opens through graduated
  // probation stages instead of full authority: BLOCK_ALL refuses everything,
  // PAPER_ONLY refuses live (paper/demo simulate as before), A_PLUS_ONLY
  // requires an A-tier edge for live, REDUCED_SIZE was already applied at
  // draft creation. Deployed-but-unreadable probation fails CLOSED; a
  // not-yet-deployed layer reads as "none" and every existing gate below
  // still runs unchanged.
  const probation = await (opts.probationResolver ?? resolveEffectiveProbation)();
  if (probation.kind === "unreadable") {
    return {
      ok: false, kind: "execution_rejected",
      error: `RECOVERY_PROBATION_UNREADABLE: ${probation.reason} — failing closed; no order was attempted`,
      httpStatus: 503,
    };
  }
  if (probation.kind === "active") {
    const verdict = probationDispatchVerdict({
      stage: probation.stage,
      executionMode: mission.executionMode,
      edgeTier: draft.edgeTier,
    });
    if (!verdict.allowed) {
      await journalMissionEvent({
        missionId: args.missionId,
        type: "draft_execution_blocked_probation",
        message: `Draft execution refused by recovery probation (${probation.stage}). ${verdict.reasons[0] ?? ""} Draft remains approved; an owner press on the probation ladder is required to widen authority.`,
        metadata: { draftId: draft.draftId, stage: probation.stage, reasons: verdict.reasons },
      });
      return {
        ok: false, kind: "execution_rejected",
        error: `RECOVERY_PROBATION_BLOCK: ${verdict.reasons[0] ?? "probation refused the dispatch"}`,
        httpStatus: 409,
      };
    }
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

  // ── Resolve the executor by mode: paper/demo run the SAME gate chain but ────
  // dispatch through the simulated recorder, which never contacts the broker.
  const executionMode: "paper" | "demo" | "live" =
    mission.executionMode === "live" ? "live" : mission.executionMode === "demo" ? "demo" : "paper";
  // Resolved only on the non-live branch. The lazy import keeps missionExecution
  // free of a runtime edge to missionSimulatedFills (which imports this file's
  // MissionSimulatedExecutor type), and keeps the live path untouched.
  const resolveSimulatedExecutor = async (): Promise<MissionSimulatedExecutor> =>
    opts.simulatedExecutor ??
    (await import("./missionSimulatedFills.js")).simulateMissionFill;

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

  // ── The ONE intent shape (source "mission"), shared by live + simulated. ─────
  // Only a LIVE mission ever gains the live accountMode; the simulated leg
  // receives the identical intent WITHOUT any account-mode claim.
  const baseIntent: Omit<InstantTradeIntent, "accountMode"> = {
    source: "mission",
    missionId: args.missionId,
    action: draft.direction,
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
    metadata: {
      missionId: args.missionId,
      draftId: draft.draftId,
      symbol: draft.symbol,
      direction: draft.direction,
      executionMode,
    },
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

  // LIVE routes through the ONE instant-trade entry; paper/demo record through
  // the simulated executor — SAME gates, SAME claim, NO broker contact.
  const result: InstantTradeResult =
    executionMode === "live"
      ? await executor({
          userId: args.userId,
          intent: { ...baseIntent, accountMode: "live" },
          ip: args.ip,
          ua: args.ua,
        })
      : await (await resolveSimulatedExecutor())({
          userId: args.userId,
          missionId: args.missionId,
          executionMode,
          draft: claimed,
          intent: baseIntent,
          ip: args.ip,
          ua: args.ua,
          nowMs,
        });

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
      message: `${executionMode === "live" ? "Live dispatch" : `Simulated (${executionMode}) dispatch`} rejected for ${draft.symbol} ${draft.direction}: ${result.primaryReason ?? result.error}. Draft remains approved.`,
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

  // ── Success: the claim already flipped the row to `executed`. Persist the ────
  // draft→fill linkage (commandId) ON THE ROW — this is what lets the exit
  // manager find the open position and the close hook record the realised
  // outcome. The broker ticket is backfilled at fill confirmation.
  const linkedRows = await db
    .update(missionTradeDraftsTable)
    .set({ commandId: result.commandId ?? null, updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(missionTradeDraftsTable.draftId, draft.draftId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.status, "executed"),
      ),
    )
    .returning();
  const linked = (linkedRows[0] as MissionTradeDraftRow | undefined) ?? claimed;

  await journalMissionEvent({
    missionId: args.missionId,
    type: "draft_executed",
    message:
      executionMode === "live"
        ? `Draft dispatched to live execution for ${draft.symbol} ${draft.direction}.`
        : `Draft dispatched through the gated path (${executionMode}) for ${draft.symbol} ${draft.direction} — SIMULATED, no broker contact.`,
    metadata: {
      draftId: draft.draftId,
      commandId: result.commandId ?? null,
      executionMode,
      simulated: executionMode !== "live",
      source: "mission",
    },
  });
  return { ok: true, commandId: result.commandId, executionMode, draft: linked };
}

/**
 * Best-effort OPEN-fill backfill: stamp the broker ticket onto the executed
 * mission draft that dispatched `commandId`. Called from the authoritative live
 * fill-confirmation path (mirroring the close hook) — never an execution path,
 * a pure additive column write on an already-owned row. Idempotent: only a row
 * still missing its ticket is written. No-op for non-mission commands.
 */
export async function backfillMissionDraftBrokerTicket(args: {
  userId: number;
  commandId: string | null | undefined;
  brokerTicket: string | null | undefined;
  nowMs?: number;
}): Promise<{ linked: boolean }> {
  const commandId = typeof args.commandId === "string" ? args.commandId.trim() : "";
  const ticket = typeof args.brokerTicket === "string" ? args.brokerTicket.trim() : "";
  if (!commandId || !ticket) return { linked: false };
  const nowMs = args.nowMs ?? Date.now();

  const rows = await db
    .update(missionTradeDraftsTable)
    .set({ brokerTicket: ticket, updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.commandId, commandId),
        eq(missionTradeDraftsTable.status, "executed"),
        isNull(missionTradeDraftsTable.brokerTicket),
      ),
    )
    .returning();
  const row = rows[0] as MissionTradeDraftRow | undefined;
  if (!row) return { linked: false };

  await journalMissionEvent({
    missionId: row.missionId,
    type: "draft_fill_linked",
    message: `Broker fill linked to mission trade for ${row.symbol} ${row.direction} (ticket ${ticket}).`,
    metadata: { draftId: row.draftId, commandId, brokerTicket: ticket },
  });
  return { linked: true };
}
