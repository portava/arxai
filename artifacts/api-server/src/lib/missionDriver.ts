// ── Profit Mission F-build — the mission driver worker (gated autonomy) ───────
//
// WHY THIS EXISTS: every mission surface below this file already existed —
// scan (missionAgents), draft + approval (missionDrafts), gated dispatch
// (missionExecution → executeInstant → 23-gate live pipeline), protective exits
// (missionExitManager), progress/goal-stop (refreshMissionProtection), risk
// (missionRiskService), promotion governance (missionPromotionService) — but
// every step needed a user press and nothing advanced a mission unattended.
// This worker is the missing loop: per tick it advances ACTIVE missions by
// composing those EXISTING services, exactly as the user's own presses would.
//
// SAFETY (inviolable):
//   * NO new execution path. The driver NEVER touches a broker, a command
//     table, or anything below `dispatchApprovedDraft` / `manageMissionTradeExit`
//     — the same seams user-pressed dispatches use. Those seams re-run the
//     additive mission gate + Phase 7 on EVERY call for every mode; for a LIVE
//     mission they additionally reach the per-user governor + the 23-gate
//     dispatch + the env/db live master switch. A paper/demo mission stops at
//     the simulated recorder and never reaches those three, so do not read this
//     as "the driver is 23-gate checked in every mode" — it is not. If any gate
//     that DOES run says no, the mission journals the block honestly and waits;
//     the driver never retries around a refusal and can never relax anything.
//   * The risk/emergency read on every tick is fed the REAL platform signals
//     (`resolveMissionLiveSignals`: safety-core kill switch + broker-health
//     verdict), never neutral constants — an unattended loop whose kill-switch
//     gauge cannot fire is the worst place to have one. See
//     `BROKER_PATH_ONLY_EMERGENCY_CONDITIONS` for the one narrow rule about
//     which of those conditions bind a simulated mission.
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
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
import {
  runMissionSimulatedExitPass,
  type MissionQuoteReader,
} from "./missionSimulatedFills.js";
import { refreshMissionRisk, type MissionLiveSignals } from "./missionRiskService.js";
import {
  assembleMissionExitSignals,
  type AssembledMissionExitSignals,
  type MissionExitSignalKey,
  type MissionExitSignalResolver,
} from "./missionExitSignals.js";
import { resolveMissionPromotionStatus } from "./missionPromotionService.js";
import { applyMissionTransition } from "./profitMissionJournal.js";
import {
  resolveMissionLiveSignals,
  type Phase7Evaluator,
} from "./missionExecutionQuality.js";

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

/** Signals for an unattended tick, RESOLVED from the real platform seams
 * (safety-core kill switch + broker-health verdict) exactly as the mission
 * routes do — never the neutral constants an audit flagged as a dead gauge
 * (killSwitchActive:false / brokerConnected:true / feedStatus:"live" /
 * quoteFresh:true made the risk read's emergency conditions unreachable, and
 * the unattended path is precisely where nobody is watching the gauge).
 * `resolveMissionLiveSignals` is fail-closed on an unreadable switch and
 * fail-safe on an unreadable broker verdict, so this channel can only ADD
 * strictness; the live pipeline still re-derives every safety signal itself. */
async function driverSignals(opts: MissionDriverPassOpts): Promise<MissionLiveSignals> {
  return opts.signals ?? (await resolveMissionLiveSignals());
}

/**
 * Emergency conditions that describe the LIVE BROKER path and nothing else.
 *
 * A paper/demo mission never routes through the broker: its fills come from the
 * simulator, priced off router quotes, and that simulator already refuses a fill
 * per trade when no real quote is available rather than inventing a price. A
 * broker link fault is therefore not that mission's execution fault, and pausing
 * it over one would be a stop nobody could explain.
 *
 * This rule is deliberately NARROW. The observed signals are still resolved
 * honestly and persisted in `riskJson`, so the Risk Control card shows exactly
 * what was seen on every mission; this decides only whether the DRIVER halts a
 * simulated mission over it. Every other condition — kill switch, user emergency
 * stop, loss limits, blowup — binds every mission in every mode.
 */
const BROKER_PATH_ONLY_EMERGENCY_CONDITIONS: ReadonlySet<string> = new Set([
  "broker_disconnect",
  "stale_feed",
  "stale_quote",
]);

/** Does this mission's observed emergency bind ITS execution path? */
function emergencyBindsMission(
  mission: MissionRow,
  emergency: { triggered: boolean; conditions: readonly string[] },
): boolean {
  if (!emergency.triggered) return false;
  if ((mission.executionMode ?? "").trim().toLowerCase() === "live") return true;
  return emergency.conditions.some((c) => !BROKER_PATH_ONLY_EMERGENCY_CONDITIONS.has(c));
}

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
  /** Deterministic quote source for the simulated exit sweep (tests only). */
  quoteReader?: MissionQuoteReader;
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

/**
 * The default open-draft read (per-user + per-mission scoped).
 *
 * `simulated = false` is LOAD-BEARING, not hygiene: a simulated draft is flipped
 * to `executed` by the shared CAS and its broker-reconciled `closed_at` stays
 * NULL by design, so without this predicate every simulated row a promoted
 * mission carries would match and permanently occupy all
 * MAX_EXIT_MANAGED_DRAFTS_PER_TICK slots, starving a genuine LIVE open position
 * of protective exit management. Ordering is pinned so slot allocation is
 * deterministic (oldest open first) rather than physical row order.
 */
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
        eq(missionTradeDraftsTable.simulated, false),
        isNull(missionTradeDraftsTable.closedAt),
      ),
    )
    .orderBy(asc(missionTradeDraftsTable.id))
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
          // AUTONOMY PROVENANCE — this exit is the driver's own unattended
          // action, so the resulting CLOSE / MODIFY command is stamped SYSTEM
          // rather than recorded as a command the owner pressed.
          driverOriginated: true,
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

/**
 * Close a paper/demo mission's OPEN SIMULATED positions against REAL current
 * quotes. This is what makes a non-live mission progress at all: before it,
 * nothing ever wrote an outcome for a simulated draft, so a paper/demo mission's
 * value was frozen forever, it could never complete, and the promotion gate's
 * demo evidence had no producible source. Nothing here contacts a broker, and
 * no broker-reconciled column is ever written.
 *
 * Runs BEFORE the protection read so a close lands in the SAME tick's progress
 * (and can complete the mission) instead of a tick later.
 */
async function sweepSimulatedExits(
  mission: MissionRow,
  opts: MissionDriverPassOpts,
): Promise<number> {
  if (mission.executionMode === "live") return 0;
  const nowMs = opts.nowMs ?? Date.now();
  const pass = await runMissionSimulatedExitPass(
    {
      userId: mission.userId,
      missionId: mission.id,
      // A finished mission window marks open simulated positions out at the real
      // current quote rather than stranding them open forever.
      missionEnded: nowMs >= mission.timeframeEnd.getTime(),
      nowMs,
    },
    { quoteReader: opts.quoteReader },
  );
  return pass.closed;
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

  // ── Simulated positions close FIRST so this tick's protection read sees them.
  outcome.exitsManaged = await sweepSimulatedExits(mission, opts);

  // ── Honest risk + protection reads (change-only journaling inside). ────────
  // Resolved ONCE per tick so the risk read and any dispatch in the same tick
  // are judged against the same observed kill-switch / broker / feed truth.
  const signals = await driverSignals(opts);
  const risk = await refreshMissionRisk({
    userId: mission.userId,
    missionId: mission.id,
    signals,
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
    emergencyTriggered: risk.ok && emergencyBindsMission(mission, risk.state.emergency),
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
    outcome.exitsManaged += await manageOpenExits(mission, opts);
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
            signals,
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
