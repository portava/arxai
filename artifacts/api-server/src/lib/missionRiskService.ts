// ── Profit Mission Phase 6 — Mission risk service (state + persistence + journal) ─
//
// SAFETY / SCOPE:
//   - ADDITIVE + STRICTER-ONLY. This service COMPOSES the Risk Governor's
//     history aggregation (`aggregateHistory`, never re-derived) — fed with the
//     mission's own executed trades — with the pure mission-risk
//     and blow-up engines (`@workspace/domain/profit-mission`). It can only make a
//     mission stricter (reduce risk / cooldown / pause / stop); it never relaxes a
//     gate and never places a trade. Execution lives in `missionExecution.ts`.
//   - PERSISTENCE + JOURNALING ONLY. It writes the computed risk read to
//     `profit_missions.riskJson` and appends an append-only `mission_events` row
//     when the mission's protective mode ESCALATES (stricter-only) — both inside
//     ONE `db.transaction` loaded `FOR UPDATE` scoped by (id, userId), fail-closed.
//   - Strictly per-user / per-mission: the mission row and the mission's own
//     trade history are both filtered by (missionId, userId); a mission/trade of
//     another user — or of another mission — is never read.
//   - THE RISK BOOK IS THE MISSION'S OWN EXECUTED TRADES (mission_trade_drafts),
//     NOT the user's manual paper-trade journal. A paper/demo mission's closes
//     live in the sim_* column family; a live mission's in the broker-reconciled
//     columns. Reading the manual journal here made every counter a dead gauge:
//     a mission on a real losing streak showed "Consecutive losses: 0" and its
//     cooldown/stop ladder never fired.
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionEventsTable,
  missionTradeDraftsTable,
  type MissionTradeDraftRow,
  type PaperTrade,
} from "@workspace/db";
import {
  computeMissionMath,
  resolveMissionMode,
  consecutiveLossProtocol,
  computeBlowupRisk,
  detectBehavioralRisk,
  evaluateEmergencyStop,
  DEFAULT_MISSION_RISK_BUDGET,
  type MissionRiskBudget,
  type MissionMode,
  type MissionPace,
  type LadderAction,
  type BlowupRiskResult,
  type EmergencyStopResult,
} from "@workspace/domain/profit-mission";
import { aggregateHistory, type AggregatedHistory } from "./riskGovernorEngine.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

/** Least → most strict ordering, used to detect a journal-worthy escalation. */
const MODE_RANK: Record<MissionMode, number> = {
  attack: 0,
  normal: 1,
  protect: 2,
  recovery: 3,
  cooldown: 4,
  stop: 5,
};

/**
 * Live runtime signals the pure engines cannot derive on their own. All optional
 * fields default to the SAFE value (no anomaly) so a caller that cannot observe a
 * signal never accidentally relaxes protection — fail-safe toward stricter.
 */
export interface MissionLiveSignals {
  killSwitchActive: boolean;
  brokerConnected: boolean;
  feedStatus: "live" | "delayed" | "stale" | "unknown";
  quoteFresh: boolean;
  ghostPosition?: boolean;
  equityMismatch?: boolean;
  spread?: "normal" | "wide" | "extreme";
  slippageAbnormal?: boolean;
  executionFailures?: number;
  severeDrift?: boolean;
  highImpactNews?: boolean;
  userEmergencyStop?: boolean;
  marginUsedPct?: number | null;
}

export interface MissionRiskState {
  asOf: string;
  mode: MissionMode;
  ladderAction: LadderAction;
  pace: MissionPace;
  drawdownPct: number;
  peakValue: number;
  missionLossPct: number;
  dailyLossPct: number;
  budgetUsedPct: number;
  riskMultiplier: number;
  consecutiveLosses: number;
  tradesToday: number;
  budget: MissionRiskBudget;
  blowup: BlowupRiskResult;
  behavioral: {
    overtrading: boolean;
    revenge: boolean;
    cooldownTriggered: boolean;
    scoreDock: number;
  };
  emergency: EmergencyStopResult;
  reasons: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Map the mission's realised-vs-required pace ratio to a coarse pace band. */
function resolvePace(paceRatio: number): MissionPace {
  if (paceRatio >= 1.1) return "ahead";
  if (paceRatio <= 0.9) return "behind";
  return "on_track";
}

/**
 * Normalize the mission's OWN executed drafts onto the minimal trade shape
 * `aggregateHistory` reads (status / openedAt / closedAt / createdAt / pnl).
 * Pure; exported for the offline QA proof.
 *
 * Each row is read from exactly ONE column family — `sim_*` for a simulated
 * (paper/demo) row, the broker-reconciled columns otherwise — mirroring the
 * forward test aggregator. An executed row with no close timestamp counts as an
 * OPEN position (protective: it raises trade counts, never lowers them). A
 * closed row whose P/L was not derivable keeps `pnl: null` — the engine already
 * tolerates a null P/L on the manual journal and we never invent a number.
 */
export function missionOwnTradeHistory(rows: MissionTradeDraftRow[]): PaperTrade[] {
  return rows.map((r) => {
    const useSim = r.simulated === true;
    const closedAt = useSim ? r.simClosedAt : r.closedAt;
    const pnl = useSim ? r.simPnl : r.pnl;
    const openedAt = useSim ? (r.simOpenedAt ?? r.createdAt) : r.createdAt;
    // aggregateHistory only reads these five fields; the cast documents that.
    return {
      status: closedAt != null ? "closed" : "open",
      openedAt,
      closedAt,
      createdAt: r.createdAt,
      pnl,
    } as PaperTrade;
  });
}

/**
 * Read the mission's risk budget from `settingsJson.riskBudget`, falling back to
 * the conservative defaults. Martingale can ONLY be on when the persisted setting
 * is explicitly `true` — it is never enabled silently.
 */
function readBudget(mission: MissionRow): MissionRiskBudget {
  const settings = (mission.settingsJson as Record<string, unknown> | null) ?? null;
  const raw =
    settings && typeof settings.riskBudget === "object" && settings.riskBudget !== null
      ? (settings.riskBudget as Record<string, unknown>)
      : null;
  if (!raw) return DEFAULT_MISSION_RISK_BUDGET;
  const num = (k: keyof MissionRiskBudget, d: number): number =>
    typeof raw[k] === "number" && Number.isFinite(raw[k] as number) ? (raw[k] as number) : d;
  return {
    maxTradesPerDay: num("maxTradesPerDay", DEFAULT_MISSION_RISK_BUDGET.maxTradesPerDay),
    maxScalpsPerSession: num("maxScalpsPerSession", DEFAULT_MISSION_RISK_BUDGET.maxScalpsPerSession),
    maxLossPerTradePct: num("maxLossPerTradePct", DEFAULT_MISSION_RISK_BUDGET.maxLossPerTradePct),
    maxLossPerDayPct: num("maxLossPerDayPct", DEFAULT_MISSION_RISK_BUDGET.maxLossPerDayPct),
    maxLossPerSessionPct: num("maxLossPerSessionPct", DEFAULT_MISSION_RISK_BUDGET.maxLossPerSessionPct),
    maxMissionDrawdownPct: num("maxMissionDrawdownPct", DEFAULT_MISSION_RISK_BUDGET.maxMissionDrawdownPct),
    maxSameSymbolExposure: num("maxSameSymbolExposure", DEFAULT_MISSION_RISK_BUDGET.maxSameSymbolExposure),
    maxCorrelatedExposure: num("maxCorrelatedExposure", DEFAULT_MISSION_RISK_BUDGET.maxCorrelatedExposure),
    maxConsecutiveLosses: num("maxConsecutiveLosses", DEFAULT_MISSION_RISK_BUDGET.maxConsecutiveLosses),
    cooldownAfterLossMinutes: num("cooldownAfterLossMinutes", DEFAULT_MISSION_RISK_BUDGET.cooldownAfterLossMinutes),
    cooldownAfterStreakMinutes: num("cooldownAfterStreakMinutes", DEFAULT_MISSION_RISK_BUDGET.cooldownAfterStreakMinutes),
    // Never silently enabled — only an explicit `true` turns martingale on.
    martingaleAllowed: raw.martingaleAllowed === true,
  };
}

/**
 * Compose the mission's complete risk read from the mission row, the per-user
 * Risk Governor history, and the live signals. PURE w.r.t. its inputs (no IO);
 * the only clock is the injected `nowMs`. Stricter-only by construction — every
 * sub-engine can only escalate protection.
 */
export function computeMissionRiskState(args: {
  mission: MissionRow;
  history: AggregatedHistory;
  signals: MissionLiveSignals;
  /** High-water mark carried forward from the prior persisted state. */
  priorPeak?: number | null;
  budget?: MissionRiskBudget;
  nowMs?: number;
}): MissionRiskState {
  const { mission, history, signals } = args;
  const budget = args.budget ?? readBudget(mission);
  const nowMs = args.nowMs ?? Date.now();

  const math = computeMissionMath({
    startingAmount: mission.startingAmount,
    targetAmount: mission.targetAmount,
    timeframeStartMs: mission.timeframeStart.getTime(),
    timeframeEndMs: mission.timeframeEnd.getTime(),
    currentValue: mission.currentValue,
    nowMs,
  });
  const pace = resolvePace(math.paceRatio);

  // Drawdown is measured from the high-water mark (peak), so a giveback after a
  // run-up is protected even while the mission is still net positive.
  const capital = mission.currentValue > 0 ? mission.currentValue : mission.startingAmount;
  const peakValue = Math.max(args.priorPeak ?? 0, mission.startingAmount, mission.currentValue);
  const drawdownPct =
    peakValue > 0 ? Math.max(0, ((peakValue - mission.currentValue) / peakValue) * 100) : 0;
  const missionLossPct =
    mission.startingAmount > 0
      ? Math.max(0, ((mission.startingAmount - mission.currentValue) / mission.startingAmount) * 100)
      : 0;
  const dailyLossPct =
    capital > 0 && history.todayPnl < 0 ? (Math.abs(history.todayPnl) / capital) * 100 : 0;

  const tradeBudgetUsed =
    budget.maxTradesPerDay > 0 ? (history.tradesToday / budget.maxTradesPerDay) * 100 : 0;
  const lossBudgetUsed =
    budget.maxLossPerDayPct > 0 ? (dailyLossPct / budget.maxLossPerDayPct) * 100 : 0;
  const budgetUsedPct = Math.min(100, Math.max(0, tradeBudgetUsed, lossBudgetUsed));

  const behavioral = detectBehavioralRisk({
    recentClosesInLastHour: history.recentClosesInLastHour,
    reentriesAfterLossInLastHour: history.reentriesAfterLossInLastHour,
  });

  const blowup = computeBlowupRisk({
    drawdownPct,
    consecutiveLosses: history.consecutiveLosses,
    dailyLossPct,
    maxDailyLossPct: budget.maxLossPerDayPct,
    revengeDetected: behavioral.revenge,
    overtradingDetected: behavioral.overtrading,
    budgetUsedPct,
    marginUsedPct: signals.marginUsedPct ?? null,
  });

  const emergency = evaluateEmergencyStop({
    missionLossPct,
    maxMissionLossPct: budget.maxMissionDrawdownPct,
    dailyLossPct,
    maxDailyLossPct: budget.maxLossPerDayPct,
    killSwitchActive: signals.killSwitchActive,
    brokerConnected: signals.brokerConnected,
    feedStatus: signals.feedStatus,
    quoteFresh: signals.quoteFresh,
    ghostPosition: signals.ghostPosition ?? false,
    equityMismatch: signals.equityMismatch ?? false,
    spread: signals.spread ?? "normal",
    slippageAbnormal: signals.slippageAbnormal ?? false,
    executionFailures: signals.executionFailures ?? 0,
    severeDrift: signals.severeDrift ?? false,
    highImpactNews: signals.highImpactNews ?? false,
    blowupLevel: blowup.level,
    userEmergencyStop: signals.userEmergencyStop ?? false,
  });

  const proto = consecutiveLossProtocol(history.consecutiveLosses, budget.maxConsecutiveLosses);

  const modeResult = resolveMissionMode({
    pace,
    drawdownPct,
    consecutiveLosses: history.consecutiveLosses,
    dailyLossPct,
    budget,
    cooldownActive: behavioral.cooldownTriggered,
    emergencyTriggered: emergency.triggered && emergency.action === "stop",
  });

  return {
    asOf: new Date(nowMs).toISOString(),
    mode: modeResult.mode,
    ladderAction: modeResult.ladderAction,
    pace,
    drawdownPct: round2(drawdownPct),
    peakValue,
    missionLossPct: round2(missionLossPct),
    dailyLossPct: round2(dailyLossPct),
    budgetUsedPct: round2(budgetUsedPct),
    riskMultiplier: proto.riskMultiplier,
    consecutiveLosses: history.consecutiveLosses,
    tradesToday: history.tradesToday,
    budget,
    blowup,
    behavioral: {
      overtrading: behavioral.overtrading,
      revenge: behavioral.revenge,
      cooldownTriggered: behavioral.cooldownTriggered,
      scoreDock: behavioral.scoreDock,
    },
    emergency,
    reasons: modeResult.reasons,
  };
}

export type RefreshMissionRiskResult =
  | { ok: true; state: MissionRiskState }
  | { ok: false; kind: "not_found" };

/**
 * Recompute a mission's risk read and persist it to `profit_missions.riskJson`,
 * appending a journal event when the protective mode ESCALATES (stricter-only) or
 * an emergency newly triggers. The mission is loaded `FOR UPDATE` scoped by
 * (id, userId) and the read history is the MISSION'S OWN executed trades
 * (mission_trade_drafts — sim closes for paper/demo, broker-reconciled for
 * live), never the user's manual paper-trade journal; the update + every
 * journal row land in ONE transaction (fail-closed).
 */
export async function refreshMissionRisk(args: {
  userId: number;
  missionId: number;
  signals: MissionLiveSignals;
  nowMs?: number;
}): Promise<RefreshMissionRiskResult> {
  const nowMs = args.nowMs ?? Date.now();
  return db.transaction(async (tx): Promise<RefreshMissionRiskResult> => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)))
      .for("update")
      .limit(1);
    const mission = rows[0];
    if (!mission) return { ok: false, kind: "not_found" };

    // The mission's OWN book: executed drafts only. `missionOwnTradeHistory`
    // picks the honest column family per row (sim_* vs broker-reconciled).
    const drafts = await tx
      .select()
      .from(missionTradeDraftsTable)
      .where(
        and(
          eq(missionTradeDraftsTable.missionId, args.missionId),
          eq(missionTradeDraftsTable.userId, args.userId),
          eq(missionTradeDraftsTable.status, "executed"),
        ),
      )
      .orderBy(desc(missionTradeDraftsTable.createdAt))
      .limit(500);
    const history = aggregateHistory(
      missionOwnTradeHistory(drafts as MissionTradeDraftRow[]),
      new Date(nowMs),
    );

    const priorRisk = (mission.riskJson as MissionRiskState | null) ?? null;
    const priorPeak =
      priorRisk && typeof priorRisk.peakValue === "number" ? priorRisk.peakValue : null;
    const priorMode: MissionMode | null =
      priorRisk && priorRisk.mode in MODE_RANK ? priorRisk.mode : null;
    const priorEmergency = priorRisk?.emergency?.triggered === true;

    const state = computeMissionRiskState({
      mission,
      history,
      signals: args.signals,
      priorPeak,
      nowMs,
    });

    await tx
      .update(profitMissionsTable)
      .set({ riskJson: state, updatedAt: new Date(nowMs) })
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)));

    // Journal ONLY a stricter escalation (stricter-only). A relaxation back toward
    // `normal`/`attack` updates riskJson silently — it never writes a "we eased
    // protection" event.
    const escalated =
      priorMode == null
        ? MODE_RANK[state.mode] > MODE_RANK.normal
        : MODE_RANK[state.mode] > MODE_RANK[priorMode];
    if (escalated) {
      await tx.insert(missionEventsTable).values({
        missionId: args.missionId,
        type: state.mode === "stop" ? "risk_stop" : "risk_mode_changed",
        message: `Mission risk mode escalated to ${state.mode}.${state.reasons[0] ? ` ${state.reasons[0]}` : ""}`,
        metadataJson: {
          from: priorMode,
          to: state.mode,
          drawdownPct: state.drawdownPct,
          dailyLossPct: state.dailyLossPct,
          blowupLevel: state.blowup.level,
          ladderAction: state.ladderAction,
        },
      });
    }

    // Journal a NEW emergency trigger once (idempotent across repeated refreshes
    // while the same emergency persists).
    if (state.emergency.triggered && !priorEmergency) {
      await tx.insert(missionEventsTable).values({
        missionId: args.missionId,
        type: state.emergency.action === "stop" ? "risk_stop" : "risk_paused",
        message: `Emergency ${state.emergency.action} engaged — ${state.emergency.primary ?? "protective condition"}.`,
        metadataJson: {
          action: state.emergency.action,
          primary: state.emergency.primary,
          conditions: state.emergency.conditions,
        },
      });
    }

    return { ok: true, state };
  });
}
