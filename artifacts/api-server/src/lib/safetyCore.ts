import { db, safetyCoreTable, vaultEventsTable, stateTransitionsTable, mt5StateTable } from "@workspace/db";
import { and, asc, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import {
  globalState as gs,
  systemIntegration as si,
} from "@workspace/domain";
import { shadowCapture, isVaultDegraded } from "./auditVault.js";
import { logger } from "./logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 — Safety Core service (server side)
//
// Wraps the domain Global State Machine, Risk Governor Integration, Control
// Tower Integration, and Kill Switch into a single object the routes call.
//
// Acceptance criteria covered:
//  - app can switch between OBSERVE_ONLY / SUGGEST_ONLY / PAPER_TRADING /
//    LIVE_TRADING + LOCKDOWN / RECOVERY_MODE / SAFE_SHUTDOWN
//  - no trade can execute unless tradeGate() returns APPROVED
//  - risk governor can hard-block any trade
//  - every decision is logged to vault_events
//  - safe shutdown works (engageKillSwitch + emergency-stop)
//  - MT5 disconnect drives DEGRADED_MODE (or LOCKDOWN if shutdown)
// ═══════════════════════════════════════════════════════════════════════════

export type OperationalMode =
  | "OBSERVE_ONLY"        // pure observation; no signals leave the system
  | "SUGGEST_ONLY"        // signals shown, no orders placed
  | "PAPER_TRADING"       // simulated execution, no real money
  | "LIVE_TRADING";       // real money — requires LIVE unlock and clean state

export const ALL_OPERATIONAL_MODES: ReadonlyArray<OperationalMode> = [
  "OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING", "LIVE_TRADING",
];

const HEARTBEAT_DEGRADED_MS = 15_000;
const HEARTBEAT_LOCKDOWN_MS = 60_000;

// ── Internal helpers ──────────────────────────────────────────────────────

// Deterministic singleton accessor — always returns the canonical (lowest-id) row.
// Concurrent first-time inserts may create extra rows but they are ignored by id ordering,
// so the control-state source never drifts. ensureSafetyCoreInitialized() at boot
// makes the race window effectively zero in practice.
async function loadOrCreate() {
  const rows = await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(safetyCoreTable).values({}).returning();
  return inserted[0]!;
}

// Call once at server startup to avoid the loadOrCreate race entirely.
export async function ensureSafetyCoreInitialized(): Promise<void> {
  await loadOrCreate();
}

async function loadMt5State() {
  const rows = await db.select().from(mt5StateTable).limit(1);
  return rows[0] ?? null;
}

function ageMs(d: Date | null | undefined): number | null {
  return d ? Date.now() - new Date(d).getTime() : null;
}

// ── Vault writer ───────────────────────────────────────────────────────────

export interface EmitArgs {
  kind: string;
  severity?: "INFO" | "WARN" | "DANGER" | "CRITICAL";
  source: string;
  summary: string;
  payload?: Record<string, unknown>;
  reasons?: string[];
  blockers?: string[];
  operationalMode?: string;
  globalState?: string;
}

export async function emit(args: EmitArgs): Promise<void> {
  await db.insert(vaultEventsTable).values({
    kind: args.kind,
    severity: args.severity ?? "INFO",
    source: args.source,
    summary: args.summary,
    payload: args.payload ?? {},
    reasons: args.reasons ?? [],
    blockers: args.blockers ?? [],
    operationalMode: args.operationalMode ?? null,
    globalState: args.globalState ?? null,
    generatedAtIso: new Date().toISOString(),
  });
  // SHADOW mirror — hard fail-safe: any thrown error (import, await, etc.)
  // is swallowed so the main flow keeps running even if the audit vault is
  // completely unavailable.
  try {
    await shadowCapture({
      eventType: args.kind,
      source: args.source,
      severity: args.severity ?? "INFO",
      systemMode: args.operationalMode ?? null,
      globalState: args.globalState ?? null,
      payload: {
        summary: args.summary,
        reasons: args.reasons ?? [],
        blockers: args.blockers ?? [],
        ...(args.payload ?? {}),
      },
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "shadow vault capture threw (swallowed by emit)");
  }
}

// ── Status / mode / kill switch ───────────────────────────────────────────

export interface SafetyCoreStatus {
  operationalMode: OperationalMode;
  globalState: gs.GlobalState;
  effectiveProfile: gs.StateProfile;
  killSwitchEngaged: boolean;
  killSwitchEngagedAt: string | null;
  killSwitchReason: string | null;
  mt5LinkHealth: "OK" | "DEGRADED" | "DOWN";
  lastMt5HeartbeatAt: string | null;
  secondsSinceMt5Heartbeat: number | null;
  lastModeChangeAt: string | null;
  lastModeChangedBy: string | null;
  reasons: string[];
  blockers: string[];
  allowedModes: ReadonlyArray<OperationalMode>;
}

// Compute which modes are currently selectable given live conditions.
// Used by both the dashboard (to disable buttons) and setOperationalMode (to validate).
function computeAllowedModes(
  killSwitchEngaged: boolean,
  globalState: gs.GlobalState,
  mt5LinkHealth: "OK" | "DEGRADED" | "DOWN",
): ReadonlyArray<OperationalMode> {
  if (killSwitchEngaged) return ["OBSERVE_ONLY"];
  const allowed: OperationalMode[] = ["OBSERVE_ONLY", "SUGGEST_ONLY"];
  // PAPER allowed unless system is in SAFE_SHUTDOWN.
  if (globalState !== "SAFE_SHUTDOWN") allowed.push("PAPER_TRADING");
  // LIVE requires healthy link + healthy state.
  const liveStates: ReadonlyArray<gs.GlobalState> = ["NORMAL", "HIGH_VOLATILITY", "TREND_EXPANSION"];
  if (mt5LinkHealth === "OK" && liveStates.includes(globalState)) {
    allowed.push("LIVE_TRADING");
  }
  return allowed;
}

export async function getStatus(): Promise<SafetyCoreStatus> {
  const sc = await loadOrCreate();
  const mt5 = await loadMt5State();
  const age = ageMs(mt5?.lastHeartbeatAt ?? null);
  const link: SafetyCoreStatus["mt5LinkHealth"] =
    age === null ? "DOWN"
    : age < HEARTBEAT_DEGRADED_MS ? "OK"
    : age < HEARTBEAT_LOCKDOWN_MS ? "DEGRADED"
    : "DOWN";

  const globalState = sc.globalState as gs.GlobalState;
  const profile = gs.getStateProfile(globalState);
  return {
    operationalMode: sc.operationalMode as OperationalMode,
    globalState,
    effectiveProfile: profile,
    killSwitchEngaged: sc.killSwitchEngaged,
    killSwitchEngagedAt: sc.killSwitchEngagedAt?.toISOString() ?? null,
    killSwitchReason: sc.killSwitchReason ?? null,
    mt5LinkHealth: link,
    lastMt5HeartbeatAt: mt5?.lastHeartbeatAt?.toISOString() ?? null,
    secondsSinceMt5Heartbeat: age === null ? null : Math.floor(age / 1000),
    lastModeChangeAt: sc.lastModeChangeAt?.toISOString() ?? null,
    lastModeChangedBy: sc.lastModeChangedBy ?? null,
    reasons: [],
    blockers: [],
    allowedModes: computeAllowedModes(sc.killSwitchEngaged, globalState, link),
  };
}

export interface SetModeArgs {
  mode: OperationalMode;
  changedBy: string;
}
export interface SetModeResult {
  ok: boolean;
  mode: OperationalMode;
  previousMode: OperationalMode;
  reasons: string[];
  blockers: string[];
}

export async function setOperationalMode(args: SetModeArgs): Promise<SetModeResult> {
  const sc = await loadOrCreate();
  const previous = sc.operationalMode as OperationalMode;
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Cannot change mode while kill switch is engaged.
  if (sc.killSwitchEngaged && args.mode !== "OBSERVE_ONLY") {
    blockers.push("kill switch engaged — only OBSERVE_ONLY allowed until reset");
    await emit({
      kind: "MODE_CHANGE_BLOCKED", severity: "WARN", source: "SAFETY_CORE",
      summary: `mode change to ${args.mode} blocked (kill switch engaged)`,
      reasons, blockers,
      operationalMode: previous, globalState: sc.globalState,
    });
    return { ok: false, mode: previous, previousMode: previous, reasons, blockers };
  }

  // LIVE_TRADING requires MT5 link OK + global state NORMAL/HIGH_VOLATILITY/TREND_EXPANSION.
  if (args.mode === "LIVE_TRADING") {
    const status = await getStatus();
    const liveStates: ReadonlyArray<gs.GlobalState> = ["NORMAL", "HIGH_VOLATILITY", "TREND_EXPANSION"];
    if (!liveStates.includes(status.globalState)) {
      blockers.push(`LIVE_TRADING requires global state in {NORMAL, HIGH_VOLATILITY, TREND_EXPANSION}; current=${status.globalState}`);
    }
    if (status.mt5LinkHealth !== "OK") {
      blockers.push(`LIVE_TRADING requires MT5 link OK; current=${status.mt5LinkHealth}`);
    }
    if (blockers.length > 0) {
      await emit({
        kind: "MODE_CHANGE_BLOCKED", severity: "WARN", source: "SAFETY_CORE",
        summary: `mode change to LIVE_TRADING blocked`,
        reasons, blockers,
        operationalMode: previous, globalState: sc.globalState,
      });
      return { ok: false, mode: previous, previousMode: previous, reasons, blockers };
    }
  }

  await db.update(safetyCoreTable).set({
    operationalMode: args.mode,
    lastModeChangeAt: new Date(),
    lastModeChangedBy: args.changedBy,
    updatedAt: new Date(),
  }).where(eq(safetyCoreTable.id, sc.id));

  reasons.push(`operational mode ${previous} → ${args.mode} by ${args.changedBy}`);
  await emit({
    kind: "MODE_CHANGE", severity: "INFO", source: "SAFETY_CORE",
    summary: `operational mode ${previous} → ${args.mode}`,
    payload: { previous, next: args.mode, changedBy: args.changedBy },
    reasons, blockers,
    operationalMode: args.mode, globalState: sc.globalState,
  });
  return { ok: true, mode: args.mode, previousMode: previous, reasons, blockers };
}

export interface KillSwitchArgs {
  reason: string;
  triggeredBy: string;
}

export async function engageKillSwitch(args: KillSwitchArgs): Promise<void> {
  const sc = await loadOrCreate();
  const fromState = sc.globalState as gs.GlobalState;
  // Engage kill switch + drop to OBSERVE. Global state is then driven by the state
  // machine in driveGlobalState() below, which records the transition properly.
  await db.update(safetyCoreTable).set({
    killSwitchEngaged: true,
    killSwitchEngagedAt: new Date(),
    killSwitchReason: args.reason,
    operationalMode: "OBSERVE_ONLY",
    updatedAt: new Date(),
  }).where(eq(safetyCoreTable.id, sc.id));
  await emit({
    kind: "KILL_SWITCH", severity: "CRITICAL", source: "KILL_SWITCH",
    summary: `kill switch engaged by ${args.triggeredBy}: ${args.reason}`,
    payload: { triggeredBy: args.triggeredBy, reason: args.reason, fromState },
    reasons: [args.reason],
    blockers: ["all trading halted; SAFE_SHUTDOWN active"],
    operationalMode: "OBSERVE_ONLY", globalState: fromState,
  });
  // Route through the state machine so the SAFE_SHUTDOWN transition is recorded.
  await driveGlobalState();
}

export interface ResetKillSwitchArgs {
  resetBy: string;
  acknowledgement: string;
}
export interface ResetKillSwitchResult {
  ok: boolean;
  reasons: string[];
  blockers: string[];
}

export async function resetKillSwitch(args: ResetKillSwitchArgs): Promise<ResetKillSwitchResult> {
  const sc = await loadOrCreate();
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (!sc.killSwitchEngaged) {
    reasons.push("kill switch already not engaged");
    await emit({
      kind: "KILL_SWITCH_RESET", severity: "INFO", source: "KILL_SWITCH",
      summary: `kill switch reset no-op (already disengaged) by ${args.resetBy}`,
      payload: { resetBy: args.resetBy, noop: true },
      reasons, blockers,
      operationalMode: sc.operationalMode, globalState: sc.globalState,
    });
    return { ok: true, reasons, blockers };
  }
  if (args.acknowledgement !== "I_UNDERSTAND_RISK") {
    blockers.push("reset requires acknowledgement = 'I_UNDERSTAND_RISK'");
    await emit({
      kind: "KILL_SWITCH_RESET_REJECTED", severity: "WARN", source: "KILL_SWITCH",
      summary: `kill switch reset rejected (bad acknowledgement) by ${args.resetBy}`,
      payload: { resetBy: args.resetBy, providedAck: args.acknowledgement.slice(0, 64) },
      reasons, blockers,
      operationalMode: sc.operationalMode, globalState: sc.globalState,
    });
    return { ok: false, reasons, blockers };
  }
  const fromState = sc.globalState as gs.GlobalState;
  await db.update(safetyCoreTable).set({
    killSwitchEngaged: false,
    killSwitchEngagedAt: null,
    killSwitchReason: null,
    globalState: "RECOVERY_MODE",
    operationalMode: "OBSERVE_ONLY",
    updatedAt: new Date(),
  }).where(eq(safetyCoreTable.id, sc.id));
  // Record an explicit state transition into RECOVERY_MODE. This is a Safety Core
  // protocol step (post-incident recovery), not a state-machine-driven transition.
  await db.insert(stateTransitionsTable).values({
    fromState,
    toState: "RECOVERY_MODE",
    fromSubstates: [],
    toSubstates: [],
    changed: fromState !== "RECOVERY_MODE",
    acceptedSources: ["KILL_SWITCH_RESET"],
    rejectedSources: [],
    reasons: [`kill switch reset by ${args.resetBy}`],
    blockers: [],
    generatedAtIso: new Date().toISOString(),
  });
  reasons.push(`kill switch reset by ${args.resetBy}; system entered RECOVERY_MODE`);
  await emit({
    kind: "KILL_SWITCH_RESET", severity: "WARN", source: "KILL_SWITCH",
    summary: `kill switch reset by ${args.resetBy}; entering RECOVERY_MODE`,
    payload: { resetBy: args.resetBy, fromState },
    reasons, blockers,
    operationalMode: "OBSERVE_ONLY", globalState: "RECOVERY_MODE",
  });
  return { ok: true, reasons, blockers };
}

// ── Drive global state from upstream signals (called periodically + on events) ─

export interface DriveStateInputs {
  judgeDisagreement01?: number;
  marketDanger01?: number;
  marketRegime?: "NORMAL" | "TREND" | "CHOP" | "VOLATILE";
  newsRiskActive?: boolean;
  liquidityLow?: boolean;
  executionRiskHigh?: boolean;
  cognitiveFatigueHigh?: boolean;
  cognitiveForcedRecovery?: boolean;
  /** Phase 5: Control Tower consumes recommendedPermissionLevel from
   *  trader-DNA / cognitive engines. COOLDOWN/LOCKDOWN → RECOVERY_MODE.
   *  Pass-through is caller-orchestrated — these engines never call
   *  driveGlobalState directly. */
  recommendedPermissionLevel?: "FULL" | "REDUCED" | "MICRO" | "COOLDOWN" | "LOCKDOWN";
}

export async function driveGlobalState(extra: DriveStateInputs = {}): Promise<gs.StateMachineVerdict> {
  const sc = await loadOrCreate();
  const status = await getStatus();

  // Resilience signals from MT5 link health + kill switch.
  // Heartbeat OK            → no resilience pressure
  // Heartbeat stale (DEGRADED, <60s) → force DEGRADED_MODE
  // Heartbeat dead (DOWN, ≥60s)      → force SAFE_SHUTDOWN (LOCKDOWN)
  // Kill switch engaged              → force SAFE_SHUTDOWN
  const resilienceForcedShutdown =
    sc.killSwitchEngaged || status.mt5LinkHealth === "DOWN";
  // Vault storage outage also forces DEGRADED_MODE (record-only escalation).
  const vaultDegraded = isVaultDegraded();
  const resilienceForcedDegraded =
    !resilienceForcedShutdown && (status.mt5LinkHealth === "DEGRADED" || vaultDegraded);

  const verdict = gs.runStateMachine({
    generatedAtIso: new Date().toISOString(),
    currentState: sc.globalState as gs.GlobalState,
    currentSubstates: [],
    inputs: {
      riskGovernorForcedState: null,
      // Phase 5: Control Tower forces RECOVERY_MODE when trader-DNA /
      // cognitive engines recommend COOLDOWN or LOCKDOWN permission.
      controlTowerForcedState:
        extra.recommendedPermissionLevel === "COOLDOWN" ||
        extra.recommendedPermissionLevel === "LOCKDOWN"
          ? "RECOVERY_MODE"
          : null,
      resilienceForcedShutdown,
      resilienceForcedDegraded,
      cognitiveForcedRecovery: extra.cognitiveForcedRecovery ?? false,
      cognitiveFatigueHigh:    extra.cognitiveFatigueHigh ?? false,
      judgeDisagreement01:     extra.judgeDisagreement01 ?? 0,
      marketDanger01:          extra.marketDanger01 ?? 0,
      marketRegime:            extra.marketRegime ?? "NORMAL",
      newsRiskActive:          extra.newsRiskActive ?? false,
      liquidityLow:            extra.liquidityLow ?? false,
      executionRiskHigh:       extra.executionRiskHigh ?? false,
    },
  });

  if (verdict.transitionRecord.changed) {
    await db.insert(stateTransitionsTable).values({
      fromState: verdict.transitionRecord.fromState,
      toState: verdict.transitionRecord.toState,
      fromSubstates: verdict.transitionRecord.fromSubstates,
      toSubstates: verdict.transitionRecord.toSubstates,
      changed: true,
      acceptedSources: verdict.transitionRecord.acceptedDemands.map((d) => d.source),
      rejectedSources: verdict.transitionRecord.rejectedDemands.map((d) => d.source),
      reasons: verdict.transitionRecord.reasons,
      blockers: verdict.transitionRecord.blockers,
      generatedAtIso: verdict.generatedAtIso,
    });
    await db.update(safetyCoreTable).set({
      globalState: verdict.nextState,
      updatedAt: new Date(),
    }).where(eq(safetyCoreTable.id, sc.id));
    const mapped = gs.toVaultEvent(verdict.transitionRecord);
    await emit({
      kind: "STATE_TRANSITION",
      severity: mapped.severity,
      source: "RESILIENCE",
      summary: mapped.summary,
      payload: mapped.payload,
      reasons: verdict.reasons,
      blockers: verdict.blockers,
      operationalMode: sc.operationalMode,
      globalState: verdict.nextState,
    });
  }
  return verdict;
}

// ── Trade Gate — the choke point ──────────────────────────────────────────

export interface TradeIntent {
  intentId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lot: number;
  strategy: string;
  confidence: number;            // 0..100
  // Optional risk inputs — defaults safe (low) if omitted.
  executionRisk01?: number;
  cognitiveRisk01?: number;
  marketStressRisk01?: number;
  dataIntegrityRisk01?: number;
  liquidityRisk01?: number;
  /** Phase 5: Risk Governor consumes traderRiskScore. Blended into the
   *  cognitiveRisk axis via max() so a single high source still trips the
   *  per-source hard threshold. Pass-through is caller-orchestrated. */
  traderRisk01?: number;
}

export type TradeGateDecision = "APPROVED" | "REDUCE_ONLY" | "HARD_BLOCK";

export interface TradeGateResult {
  decision: TradeGateDecision;
  decisionMode: "OBSERVE" | "SUGGEST" | "PAPER" | "LIVE";
  operationalMode: OperationalMode;
  globalState: gs.GlobalState;
  composite01: number;
  reasons: string[];
  blockers: string[];
  recommendedSizeMultiplier01: number;
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

export async function tradeGate(intent: TradeIntent): Promise<TradeGateResult> {
  // Refresh global state from live signals (MT5 heartbeat freshness, kill switch, etc.)
  // BEFORE making the gate decision. This is what makes "MT5 disconnect → DEGRADED/LOCKDOWN"
  // hold even when nothing else has polled /system/status recently.
  await driveGlobalState();
  const status = await getStatus();
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Hard short-circuit: kill switch.
  if (status.killSwitchEngaged) {
    blockers.push("kill switch engaged — all trades blocked");
  }

  // Block if global state is non-trading.
  const tradingStates: ReadonlyArray<gs.GlobalState> = [
    "NORMAL", "HIGH_VOLATILITY", "TREND_EXPANSION", "CHOP_DANGER",
    "NEWS_RISK", "LOW_LIQUIDITY", "EXECUTION_RISK", "COGNITIVE_FATIGUE",
    "DEFENSIVE_MODE",
  ];
  if (!tradingStates.includes(status.globalState)) {
    blockers.push(`global state ${status.globalState} disallows new trades`);
  }

  // Run risk governor.
  const rg = si.runRiskGovernorIntegration({
    intentId: intent.intentId as unknown as si.TradeIntentId,
    symbol: intent.symbol as unknown as si.SymbolId,
    scores: {
      executionRisk:     clamp01(intent.executionRisk01     ?? 0.1) as unknown as si.Score01,
      // Phase 5: max-blend trader DNA risk into cognitive axis so a single
      // high source (trader-DNA OR cognitive) still trips the per-source
      // hard threshold of the Risk Governor.
      cognitiveRisk:     clamp01(Math.max(
        intent.cognitiveRisk01 ?? 0.1,
        intent.traderRisk01    ?? 0.1,
      )) as unknown as si.Score01,
      marketStressRisk:  clamp01(intent.marketStressRisk01  ?? 0.1) as unknown as si.Score01,
      dataIntegrityRisk: clamp01(intent.dataIntegrityRisk01 ?? 0.1) as unknown as si.Score01,
      liquidityRisk:     clamp01(intent.liquidityRisk01     ?? 0.1) as unknown as si.Score01,
    },
    generatedAtIso: new Date().toISOString(),
  });
  reasons.push(...rg.reasons);
  blockers.push(...rg.blockers);

  // Translate operational mode → execution surface.
  const opMode = status.operationalMode;
  const profile = status.effectiveProfile;
  let decisionMode: TradeGateResult["decisionMode"];
  switch (opMode) {
    case "OBSERVE_ONLY":
      decisionMode = "OBSERVE";
      // Not a blocker — the route handles OBSERVE/SUGGEST as a signal-only
      // success path. blockers[] is reserved for "trade can't happen anywhere".
      reasons.push("operational mode OBSERVE_ONLY — signal recorded only");
      break;
    case "SUGGEST_ONLY":
      decisionMode = "SUGGEST";
      reasons.push("operational mode SUGGEST_ONLY — no orders sent");
      break;
    case "PAPER_TRADING":
      decisionMode = "PAPER";
      reasons.push("operational mode PAPER_TRADING — simulated execution");
      break;
    case "LIVE_TRADING":
      decisionMode = "LIVE";
      reasons.push("operational mode LIVE_TRADING — real money execution");
      break;
  }

  // Profile execution permission overlay.
  if (profile.executionPermission === "NONE") {
    blockers.push(`state profile execution=NONE`);
  } else if (profile.executionPermission === "CLOSE_ONLY") {
    blockers.push(`state profile execution=CLOSE_ONLY — no new entries`);
  }

  let decision: TradeGateDecision;
  if (rg.hardBlock || blockers.length > 0) decision = "HARD_BLOCK";
  else if (rg.decision === "REDUCE_ONLY") decision = "REDUCE_ONLY";
  else decision = "APPROVED";

  // Strategy filter — confidence below state profile aggression-derived gate.
  const minConfidenceForState = Math.max(40, 60 - profile.allowedAggression01 * 20);
  if (decision !== "HARD_BLOCK" && intent.confidence < minConfidenceForState) {
    blockers.push(`confidence ${intent.confidence} < required ${minConfidenceForState} for state ${status.globalState}`);
    decision = "HARD_BLOCK";
  }

  const recommendedSizeMultiplier01 = decision === "HARD_BLOCK"
    ? 0
    : profile.riskMultiplier01 * (decision === "REDUCE_ONLY" ? 0.5 : 1);

  await emit({
    kind: "TRADE_GATE",
    severity: decision === "HARD_BLOCK" ? "WARN" : "INFO",
    source: "RISK_GOVERNOR",
    summary: `${decision} ${intent.direction} ${intent.symbol} ${intent.lot} (${intent.strategy})`,
    payload: {
      intentId: intent.intentId, symbol: intent.symbol, direction: intent.direction,
      lot: intent.lot, strategy: intent.strategy, confidence: intent.confidence,
      composite01: rg.compositeRisk, decisionMode,
    },
    reasons, blockers,
    operationalMode: opMode, globalState: status.globalState,
  });

  return {
    decision, decisionMode, operationalMode: opMode, globalState: status.globalState,
    composite01: rg.compositeRisk as unknown as number,
    reasons, blockers, recommendedSizeMultiplier01,
  };
}

// ── Vault read API ─────────────────────────────────────────────────────────

export interface VaultListFilters {
  limit?: number;
  sinceIso?: string;
  untilIso?: string;
  kind?: string;
  source?: string;
  severity?: string;
  truthDomain?: string;
  symbol?: string;
  linkedTradeId?: string;
  operationalMode?: string;
}

export async function listVaultEvents(filtersOrLimit: VaultListFilters | number = 100, sinceIsoLegacy?: string) {
  // Backwards-compat: old callers passed (limit, sinceIso)
  const f: VaultListFilters = typeof filtersOrLimit === "number"
    ? { limit: filtersOrLimit, sinceIso: sinceIsoLegacy }
    : filtersOrLimit;
  const lim = Math.max(1, Math.min(500, f.limit ?? 100));
  const conds: SQL[] = [];
  if (f.sinceIso)         conds.push(gte(vaultEventsTable.createdAt, new Date(f.sinceIso)));
  if (f.untilIso)         conds.push(lte(vaultEventsTable.createdAt, new Date(f.untilIso)));
  if (f.kind)             conds.push(eq(vaultEventsTable.kind, f.kind));
  if (f.source)           conds.push(eq(vaultEventsTable.source, f.source));
  if (f.severity)         conds.push(eq(vaultEventsTable.severity, f.severity));
  if (f.truthDomain)      conds.push(eq(vaultEventsTable.truthDomain, f.truthDomain));
  if (f.symbol)           conds.push(eq(vaultEventsTable.symbol, f.symbol));
  if (f.linkedTradeId)    conds.push(eq(vaultEventsTable.linkedTradeId, f.linkedTradeId));
  if (f.operationalMode)  conds.push(eq(vaultEventsTable.operationalMode, f.operationalMode));

  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  const baseQuery = db.select().from(vaultEventsTable);
  const rows = where
    ? await baseQuery.where(where).orderBy(desc(vaultEventsTable.createdAt)).limit(lim)
    : await baseQuery.orderBy(desc(vaultEventsTable.createdAt)).limit(lim);
  return rows;
}

export async function listStateTransitions(limit = 100) {
  const lim = Math.max(1, Math.min(500, limit));
  const rows = await db.select().from(stateTransitionsTable)
    .orderBy(desc(stateTransitionsTable.createdAt))
    .limit(lim);
  return rows;
}
