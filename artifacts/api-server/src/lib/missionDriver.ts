// ── Profit Mission F-build — the mission driver worker (gated autonomy) ───────
//
// WHY THIS EXISTS: every mission surface below this file already existed —
// scan (missionAgents), draft + approval (missionDrafts), gated dispatch
// (missionExecution → executeInstant → 18-gate live pipeline), protective exits
// (missionExitManager), progress/goal-stop (refreshMissionProtection), risk
// (missionRiskService), promotion governance (missionPromotionService) — but
// every step needed a user press and nothing advanced a mission unattended.
// This worker is the missing loop: per tick it advances ACTIVE missions by
// composing those EXISTING services, exactly as the user's own presses would.
//
// SAFETY (inviolable):
//   * NO new execution path. The driver NEVER touches a broker, a command
//     table, or anything below `dispatchApprovedDraft` / `manageMissionTradeExit`
//     — the same seams user-pressed dispatches use, which re-run the additive
//     mission gate + Phase 7 + the per-user governor + 18-gate dispatch + the
//     env/db live master switch on EVERY call. If any gate says no, the mission
//     journals the block honestly and waits; the driver never retries around a
//     refusal and can never relax anything.
//   * Auto-approval is decided by the PURE ladder planner (`decideAutoApproval`)
//     from the CURRENT row state, re-read every tick — level 3 auto-runs only a
//     non-live mission; levels 4–6 on a live mission additionally require the
//     explicit live-auto opt-in + accepted certificate + a passing promotion
//     re-check + the platform live gates, all re-verified AT ACT TIME. Level 2
//     (default) is never auto-approved: the user's press remains the approval.
//   * FAIL SAFE. Every mission is ticked inside its own try/catch: a crash
//     skips that mission (positions untouched, no orphaned auto-approvals — an
//     approved-but-undispatched draft simply expires on read), logs the error,
//     and the next tick retries from honest persisted state. Non-overlapping
//     pass + per-mission mutex so the driver can never race itself or stack.
//   * Every driver decision is auditable: transitions/approvals/dispatches all
//     journal through the existing services; driver-level blocks journal a
//     `driver_auto_blocked` event (change-only, so a standing block never spams
//     the journal) and the latest tick verdict is merged into
//     `progressJson.driver` for the dashboard.
//   * Opt-out via ARX_MISSION_DRIVER_ENABLED (default enabled — the ladder
//     itself is what gates autonomy per mission; a level-2 mission is never
//     advanced into a trade by this worker). Disabling is logged loudly.
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionTradeDraftsTable,
  missionEventsTable,
} from "@workspace/db";
import {
  planMissionTick,
  isMissionStatus,
  type MissionTickPlan,
  type AutoApprovalInput,
  type DriftSeverity,
} from "@workspace/domain/profit-mission";
import { logger } from "./logger.js";
import { runMissionScan, type MissionScanResult } from "./missionAgents.js";
import { approveProposalDraft } from "./missionDrafts.js";
import {
  dispatchApprovedDraft,
  type MissionExecutor,
  type MissionSimulatedExecutor,
} from "./missionExecution.js";
import {
  manageMissionTradeExit,
  refreshMissionProtection,
} from "./missionExitManager.js";
import { refreshMissionRisk, type MissionLiveSignals } from "./missionRiskService.js";
import {
  assembleMissionExitSignals,
  type AssembledMissionExitSignals,
  type MissionExitSignalKey,
  type MissionExitSignalResolver,
} from "./missionExitSignals.js";
import { resolveMissionPromotionStatus } from "./missionPromotionService.js";
import { applyMissionTransition } from "./profitMissionJournal.js";
import type { Phase7Evaluator } from "./missionExecutionQuality.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

/** Tick cadence. One minute mirrors the reconciler; every dispatch decision is
 *  re-gated downstream, so a faster tick would add noise, not safety. */
export const MISSION_DRIVER_INTERVAL_MS = 60 * 1000;

/** Statuses the driver may act on (all others are left untouched). */
const DRIVER_ACTIONABLE_STATUSES = ["running", "paused", "protect_mode"] as const;

/** Cap of executed-open drafts whose exits are managed per mission per tick. */
const MAX_EXIT_MANAGED_DRAFTS_PER_TICK = 5;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the mission driver enabled? Absent env = ENABLED. */
export function missionDriverEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

/** Conservative signals for unattended ticks: no observed anomaly is claimed —
 * this is the NEUTRAL element of the additive stricter-only mission gate (see
 * missionExecution.ts DEFAULT_SIGNALS); the real live pipeline re-derives every
 * safety signal server-side. */
const DRIVER_SIGNALS: MissionLiveSignals = {
  killSwitchActive: false,
  brokerConnected: true,
  feedStatus: "live",
  quoteFresh: true,
};

/** Every exit signal the assembler can observe — used to report TOTAL blindness
 *  honestly when the assembly itself fails, instead of an empty bundle that
 *  would read downstream as "nothing observed and nothing wrong". */
const ALL_EXIT_SIGNAL_KEYS: readonly MissionExitSignalKey[] = [
  "invalidation",
  "structureBreak",
  "orderFlowReversal",
  "highImpactNewsImminent",
  "unstableSpread",
  "agentDisagreement",
  "atr",
];

export interface MissionDriverPassOpts {
  /** Injectable seams — tests only; production always uses the real services. */
  executor?: MissionExecutor;
  simulatedExecutor?: MissionSimulatedExecutor;
  phase7Evaluator?: Phase7Evaluator;
  scan?: (args: {
    userId: number;
    missionId: number;
    settings: Record<string, unknown> | null | undefined;
  }) => Promise<Pick<MissionScanResult, "selectedProposalId">>;
  signals?: MissionLiveSignals;
  nowMs?: number;
  /** Restrict the pass to one mission (tests / targeted re-runs). */
  onlyMissionId?: number;
  /** Injectable exit-signal assembler (tests only; production reads the real
   *  news / quote / candle / agent-stance sources). */
  exitSignals?: MissionExitSignalResolver;
  /** Injectable exit-management seam (tests only). */
  exitManager?: typeof manageMissionTradeExit;
  /** Injectable open-draft read (tests only). */
  loadOpenExitDrafts?: (mission: MissionRow) => Promise<OpenExitDraft[]>;
}

export interface MissionTickOutcome {
  missionId: number;
  plan: MissionTickPlan;
  transitioned: string | null;
  exitsManaged: number;
  autoApproved: boolean;
  dispatched: boolean;
  dispatchResult: string | null;
  blockReasons: string[];
  error: string | null;
}

export interface MissionDriverPassResult {
  scanned: number;
  outcomes: MissionTickOutcome[];
}

// Change-only journal memory: missionId → last journaled block signature. Keeps
// a standing block from writing an identical journal row every minute.
const lastBlockSignature = new Map<number, string>();
// Per-mission tick mutex so a slow tick is never re-entered by the next pass.
const ticking = new Set<number>();

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Latest drift severity from the persisted promotion read (honest UNKNOWN). */
function readDriftSeverity(mission: MissionRow): DriftSeverity {
  const promotion = asRecord(mission.promotionJson);
  const s = promotion.driftSeverity;
  return s === "NONE" || s === "MINOR" || s === "MAJOR" || s === "SEVERE" ? s : "UNKNOWN";
}

/** Merge the latest driver verdict into progressJson.driver (observability). */
async function persistDriverVerdict(
  mission: MissionRow,
  verdict: Record<string, unknown>,
): Promise<void> {
  const rows = await db
    .select({ progressJson: profitMissionsTable.progressJson })
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.id, mission.id))
    .limit(1);
  const progress = asRecord(rows[0]?.progressJson);
  await db
    .update(profitMissionsTable)
    .set({ progressJson: { ...progress, driver: verdict } })
    .where(and(eq(profitMissionsTable.id, mission.id), eq(profitMissionsTable.userId, mission.userId)));
}

/** Journal a driver-level auto block, but only when the reasons CHANGED. */
async function journalBlockOnce(missionId: number, blockReasons: string[]): Promise<void> {
  const signature = blockReasons.join("|");
  if (lastBlockSignature.get(missionId) === signature) return;
  lastBlockSignature.set(missionId, signature);
  if (blockReasons.length === 0) return;
  await db.insert(missionEventsTable).values({
    missionId,
    type: "driver_auto_blocked",
    message: `Mission driver is holding: ${blockReasons[0]}${blockReasons.length > 1 ? ` (+${blockReasons.length - 1} more)` : ""}. The mission waits — no gate is ever bypassed.`,
    metadataJson: { blockReasons },
  });
}

/** Re-resolve the auto-approval evidence from the CURRENT row + a fresh
 * promotion re-check. Fail-closed on any error — an unreachable promotion read
 * never grants autonomy. The pure planner turns this into the decision. */
async function resolveAutoInputs(mission: MissionRow): Promise<AutoApprovalInput> {
  let promotionApproved = false;
  let liveGatesEnabled = false;
  let driftSeverity: DriftSeverity = readDriftSeverity(mission);
  try {
    const status = await resolveMissionPromotionStatus({
      userId: mission.userId,
      missionId: mission.id,
      ctx: { role: "USER", isNewUser: false },
    });
    if (status.ok) {
      promotionApproved = status.status.decision.approved;
      driftSeverity = status.status.driftSeverity;
      // The promotion evidence already consulted the live master switch; the
      // pure planner re-requires it explicitly for live-auto, so resolve it
      // from the decision's live gate rather than trusting a cached flag.
      const liveGate = status.status.decision.gates.find((g) => g.name === "live_gates_enabled");
      liveGatesEnabled = liveGate?.passed === true;
    }
  } catch {
    promotionApproved = false;
  }
  return {
    automationLevel: mission.automationLevel,
    executionMode: mission.executionMode,
    liveAutoEnabled: mission.liveAutoEnabled,
    certificateAccepted: mission.certificateAcceptedAt != null,
    promotionApproved,
    driftSeverity,
    liveGatesEnabled,
  };
}

/** One executed-open draft the driver may manage exits for. */
interface OpenExitDraft {
  draftId: string;
  symbol: string;
  timeframe: string;
  direction: string;
  stopLoss: number | null;
}

/** The default open-draft read (per-user + per-mission scoped). */
async function loadOpenExitDrafts(mission: MissionRow): Promise<OpenExitDraft[]> {
  const rows = await db
    .select({
      draftId: missionTradeDraftsTable.draftId,
      symbol: missionTradeDraftsTable.symbol,
      timeframe: missionTradeDraftsTable.timeframe,
      direction: missionTradeDraftsTable.direction,
      stopLoss: missionTradeDraftsTable.stopLoss,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, mission.id),
        eq(missionTradeDraftsTable.userId, mission.userId),
        eq(missionTradeDraftsTable.status, "executed"),
        isNull(missionTradeDraftsTable.closedAt),
      ),
    )
    .limit(MAX_EXIT_MANAGED_DRAFTS_PER_TICK);
  return rows.map((r) => ({
    draftId: r.draftId,
    symbol: r.symbol,
    timeframe: r.timeframe,
    direction: String(r.direction ?? "NONE"),
    stopLoss: typeof r.stopLoss === "number" && Number.isFinite(r.stopLoss) ? r.stopLoss : null,
  }));
}

/**
 * Manage protective exits for this mission's executed, still-open drafts.
 *
 * SIGNALS: an unattended tick reads the REAL exit signals for each position's
 * own symbol (news risk, live spread vs broker truth, chart structure, order
 * flow, the mission's own agent stances) via `assembleMissionExitSignals`. It
 * used to pass `{}`, which left invalidation / structure-break / order-flow /
 * news / spread undefined on every unattended tick — the automated exit
 * manager could only ever see price-based triggers. Anything the assembler
 * cannot read stays ABSENT and is reported as an explicit unavailability, so
 * the exit decision records that it was blind on that axis instead of behaving
 * as though the axis were calm. A signal read that fails outright never blocks
 * exit management: the tick proceeds with whatever was honestly observed, plus
 * the unavailability record.
 *
 * The invalidation reference is the mission's own planned protective level
 * (the draft's recorded stopLoss) — the thesis level the setup was taken on —
 * not a later trailed stop, which is protection rather than invalidation.
 */
export async function manageOpenExits(
  mission: MissionRow,
  opts: MissionDriverPassOpts,
): Promise<number> {
  // Positions only exist for a live-mode mission; paper/demo record no fills.
  if (mission.executionMode !== "live") return 0;
  const loadDrafts = opts.loadOpenExitDrafts ?? loadOpenExitDrafts;
  const exitManager = opts.exitManager ?? manageMissionTradeExit;
  const resolveSignals = opts.exitSignals ?? ((ctx) => assembleMissionExitSignals(ctx));
  const nowMs = opts.nowMs ?? Date.now();
  const openDrafts = await loadDrafts(mission);
  let managed = 0;
  for (const d of openDrafts) {
    try {
      const side: "BUY" | "SELL" = d.direction === "SELL" ? "SELL" : "BUY";
      // Honest read; a total failure degrades to "observed nothing, and said so"
      // — never to a fabricated all-clear.
      let assembled: AssembledMissionExitSignals;
      try {
        assembled = await resolveSignals({
          userId: mission.userId,
          missionId: mission.id,
          symbol: d.symbol,
          side,
          timeframe: d.timeframe,
          stopLoss: d.stopLoss,
          nowMs,
        });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), missionId: mission.id, draftId: d.draftId },
          "mission_driver exit-signal assembly failed (all signals reported unavailable)",
        );
        assembled = {
          signals: {},
          unavailable: ALL_EXIT_SIGNAL_KEYS.map((signal) => ({
            signal,
            source: "mission_exit_signals",
            reason: "SIGNAL_ASSEMBLY_FAILED",
          })),
          observedAtMs: nowMs,
        };
      }
      const r = await exitManager(
        {
          userId: mission.userId,
          missionId: mission.id,
          draftId: d.draftId,
          signals: { ...assembled.signals, unavailable: assembled.unavailable },
          nowMs,
        },
        { executor: opts.executor },
      );
      if (r.ok && r.dispatched) managed += 1;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), missionId: mission.id, draftId: d.draftId },
        "mission_driver exit management failed for one draft (non-fatal)",
      );
    }
  }
  return managed;
}

/** One mission's tick. Composes the plan over the existing gated services. */
async function tickMission(
  mission: MissionRow,
  opts: MissionDriverPassOpts,
): Promise<MissionTickOutcome> {
  const nowMs = opts.nowMs ?? Date.now();
  const outcome: MissionTickOutcome = {
    missionId: mission.id,
    plan: { action: "none", steps: [], autoApproval: { allowed: false, level: null, executionMode: null, reachesLive: false, blockReasons: [] }, reasons: [] },
    transitioned: null,
    exitsManaged: 0,
    autoApproved: false,
    dispatched: false,
    dispatchResult: null,
    blockReasons: [],
    error: null,
  };

  // ── Honest risk + protection reads (change-only journaling inside). ────────
  const risk = await refreshMissionRisk({
    userId: mission.userId,
    missionId: mission.id,
    signals: opts.signals ?? DRIVER_SIGNALS,
    nowMs,
  });
  const protection = await refreshMissionProtection({
    userId: mission.userId,
    missionId: mission.id,
    nowMs,
  });
  const targetReached =
    protection.ok &&
    (protection.snapshot.missionCompleted || protection.snapshot.milestone.stopAndLock);

  const auto = await resolveAutoInputs(mission);
  const plan = planMissionTick({
    status: mission.status,
    timeframeEndMs: mission.timeframeEnd.getTime(),
    nowMs,
    targetReached,
    emergencyTriggered: risk.ok && risk.state.emergency.triggered,
    riskStopRequired:
      risk.ok &&
      (risk.state.mode === "stop" ||
        risk.state.blowup.action === "pause" ||
        risk.state.blowup.action === "stop_mission"),
    auto,
  });
  outcome.plan = plan;

  // ── Protective steps always run first. ─────────────────────────────────────
  if (plan.steps.includes("manage_exits")) {
    outcome.exitsManaged = await manageOpenExits(mission, opts);
  }
  // refresh_protection already ran above (it is the honest read the plan used);
  // a target stop+lock flipped the mission to `completed` inside that call.

  // ── Timeframe expiry / risk-stop transitions (state machine + journal). ────
  if (plan.action === "expire") {
    const r = await applyMissionTransition({
      userId: mission.userId,
      missionId: mission.id,
      toStatus: "expired",
      eventType: "expired",
      message: "Mission timeframe ended — marked expired by the mission driver. No trades were placed by this transition.",
      metadata: { driver: true },
      snapshot: { status: "expired", asOf: new Date(nowMs).toISOString() },
    });
    outcome.transitioned = r.ok ? "expired" : null;
  } else if (plan.action === "pause") {
    const r = await applyMissionTransition({
      userId: mission.userId,
      missionId: mission.id,
      toStatus: "paused",
      eventType: "risk_stop",
      message: `Mission paused by the driver on a protective risk stop (${plan.reasons[0] ?? "risk stop"}). Open positions were left untouched; protective exits remain available.`,
      metadata: { driver: true, reasons: plan.reasons },
      snapshot: { status: "paused", asOf: new Date(nowMs).toISOString() },
    });
    outcome.transitioned = r.ok ? "paused" : null;
  }

  // ── Auto steps: scan → auto-approve → dispatch (every gate re-runs inside). ─
  if (plan.autoApproval.allowed && plan.steps.includes("scan")) {
    const scan = opts.scan ?? runMissionScan;
    const scanResult = await scan({
      userId: mission.userId,
      missionId: mission.id,
      settings: (mission.settingsJson as Record<string, unknown> | null) ?? null,
    });
    const proposalId = scanResult.selectedProposalId;
    if (proposalId) {
      const approval = await approveProposalDraft({
        userId: mission.userId,
        missionId: mission.id,
        proposalId,
        reason: `Auto-approved by the mission driver (level ${plan.autoApproval.level}, ${mission.executionMode} mode) — every dispatch gate is re-checked before any order.`,
      });
      if (approval.ok) {
        outcome.autoApproved = true;
        const dispatch = await dispatchApprovedDraft(
          {
            userId: mission.userId,
            missionId: mission.id,
            proposalId,
            signals: opts.signals ?? DRIVER_SIGNALS,
            nowMs,
            // AUTONOMY PROVENANCE — this dispatch is reached on an unattended
            // tick with no human press anywhere in the chain, so the live
            // command is stamped SYSTEM and foundation gates #20 (owner-promoted
            // edge) and #23 (recorded edge capacity) BIND on it. This TIGHTENS
            // live dispatch on purpose: an unattended entry now refuses without
            // a promoted edge + a capacity estimate, and the refusal is
            // journaled with AUTONOMOUS_ENTRY_REFUSAL_NOTE so the owner can see
            // why. A trade the owner presses themself is unaffected.
            driverOriginated: true,
          },
          {
            executor: opts.executor,
            simulatedExecutor: opts.simulatedExecutor,
            phase7Evaluator: opts.phase7Evaluator,
          },
        );
        outcome.dispatched = dispatch.ok;
        outcome.dispatchResult = dispatch.ok ? "ok" : dispatch.kind;
        if (!dispatch.ok && (dispatch.kind === "mission_blocked" || dispatch.kind === "phase7_blocked" || dispatch.kind === "execution_rejected")) {
          // The block was already journaled by the dispatch hook; the driver
          // records nothing extra and simply waits for the next tick.
          outcome.blockReasons.push(dispatch.kind);
        }
      } else {
        outcome.blockReasons.push(`draft_${approval.kind}`);
      }
    } else {
      outcome.blockReasons.push("NO_ACTIONABLE_EDGE");
    }
  } else if (!plan.autoApproval.allowed && mission.status === "running") {
    outcome.blockReasons.push(...plan.autoApproval.blockReasons);
    await journalBlockOnce(mission.id, plan.autoApproval.blockReasons);
  }

  // ── Observability: the latest verdict, merged into progressJson.driver. ────
  await persistDriverVerdict(mission, {
    lastTickAt: new Date(nowMs).toISOString(),
    action: plan.action,
    steps: plan.steps,
    autoAllowed: plan.autoApproval.allowed,
    blockReasons: outcome.blockReasons,
    transitioned: outcome.transitioned,
    exitsManaged: outcome.exitsManaged,
    dispatched: outcome.dispatched,
  });

  return outcome;
}

/**
 * One full driver pass over every actionable mission. Fail-soft per mission;
 * injectable seams are for tests only — production uses the real services.
 */
export async function runMissionDriverPass(
  opts: MissionDriverPassOpts = {},
): Promise<MissionDriverPassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const filters = [inArray(profitMissionsTable.status, [...DRIVER_ACTIONABLE_STATUSES])];
  if (opts.onlyMissionId != null) filters.push(eq(profitMissionsTable.id, opts.onlyMissionId));
  const missions = (await db
    .select()
    .from(profitMissionsTable)
    .where(and(...filters))
    .orderBy(profitMissionsTable.id)
    .limit(200)) as MissionRow[];

  const outcomes: MissionTickOutcome[] = [];
  for (const mission of missions) {
    if (!isMissionStatus(mission.status)) continue;
    if (ticking.has(mission.id)) continue; // never race a still-running tick
    ticking.add(mission.id);
    try {
      outcomes.push(await tickMission(mission, { ...opts, nowMs }));
    } catch (err) {
      // FAIL SAFE: this mission is skipped untouched; honest persisted state
      // drives the retry next tick. No partial claim is left behind — the
      // dispatch hook's CAS and expiry-on-read cover the crash windows.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, missionId: mission.id }, "mission_driver tick failed (mission skipped, fail-safe)");
      outcomes.push({
        missionId: mission.id,
        plan: { action: "none", steps: [], autoApproval: { allowed: false, level: null, executionMode: null, reachesLive: false, blockReasons: [] }, reasons: [] },
        transitioned: null,
        exitsManaged: 0,
        autoApproved: false,
        dispatched: false,
        dispatchResult: null,
        blockReasons: ["TICK_ERROR"],
        error: msg,
      });
    } finally {
      ticking.delete(mission.id);
    }
  }
  return { scanned: missions.length, outcomes };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startMissionDriverWorker(): void {
  if (timer) return;

  if (!missionDriverEnabled(process.env["ARX_MISSION_DRIVER_ENABLED"])) {
    logger.warn(
      { flag: "ARX_MISSION_DRIVER_ENABLED" },
      "mission_driver_DISABLED_by_env — active missions will NOT advance unattended; goal/expiry/blowup stops fire only on user-driven reads",
    );
    return;
  }

  timer = setInterval(() => {
    if (running) return;
    running = true;
    runMissionDriverPass()
      .then((r) => {
        // Quiet when nothing happened — an idle minute-tick would bury signal.
        const acted = r.outcomes.filter(
          (o) => o.transitioned || o.autoApproved || o.dispatched || o.exitsManaged > 0 || o.error,
        );
        if (acted.length > 0) {
          logger.info(
            {
              scanned: r.scanned,
              acted: acted.length,
              transitions: acted.filter((o) => o.transitioned).length,
              dispatched: acted.filter((o) => o.dispatched).length,
              errors: acted.filter((o) => o.error).length,
            },
            "mission_driver_pass",
          );
        }
      })
      .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mission_driver_pass_failed"))
      .finally(() => { running = false; });
  }, MISSION_DRIVER_INTERVAL_MS).unref();

  logger.info({ intervalMs: MISSION_DRIVER_INTERVAL_MS }, "mission_driver_started");
}

export function stopMissionDriverWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
