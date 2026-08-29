// Capability #35 — as-of reconstruction, PURE core.
//
// Given a historical timestamp and raw rows (already fetched, or typed fetch
// errors), assemble the unified system view AS-OF that instant: global state,
// kill-switch/mode, model/policy versions, health, pending orders, open
// positions, recovery probation, execution-policy promotion.
//
// HONESTY CONTRACT (inviolable):
//   - Every section is either { available: true, ... } with its evidence
//     basis, or { available: false, reason } — a source that cannot be
//     reconstructed as-of says so and says WHY. Nothing is synthesized.
//   - NO LOOKAHEAD: a row whose knowledge timestamp is after the as-of
//     instant NEVER contributes (mirrors the bitemporal PointInTimeReader
//     contract in lib/features). Callers pre-filter in SQL; this core
//     re-filters defensively so a sloppy caller cannot leak the future.
//   - Sources that are NOT append-only (mutable single-row/state tables) are
//     reconstructed from their append-only histories where one exists, and
//     declared UNRECONSTRUCTIBLE where none does — never read-current and
//     passed off as historical.
//   - READ-ONLY by construction: this module is pure; the IO wrapper only
//     SELECTs.

// ── Section wrapper ─────────────────────────────────────────────────────────

export type AsOfSection<T> =
  | { available: true; source: string; basis: string; data: T }
  | { available: false; source: string; reason: string };

export function unavailable<T>(source: string, reason: string): AsOfSection<T> {
  return { available: false, source, reason };
}

/** A raw source hand-off: rows, or the typed reason they could not be read. */
export type SourceRows<Row> =
  | { ok: true; rows: readonly Row[] }
  | { ok: false; reason: string };

// ── Row shapes (structural — no DB import; the IO wrapper adapts) ───────────

export interface StateTransitionLike {
  toState: string;
  fromState: string;
  createdAt: Date | null;
  generatedAtIso: string;
}

export interface VaultEventLike {
  kind: string;
  summary: string;
  operationalMode: string | null;
  globalState: string | null;
  createdAt: Date | null;
  generatedAtIso: string;
  payload: unknown;
}

export interface ModelVersionLike {
  versionId: string;
  versionName: string;
  changeType: string;
  liveAllowed: boolean;
  createdAt: Date | null;
}

export interface HealthCheckLike {
  healthCheckId: string;
  overallStatus: string;
  liveTradingStatus: string;
  mode: string;
  createdAt: Date | null;
}

export interface CommandLike {
  id: number;
  userId: number | null;
  action: string;
  symbol: string | null;
  status: string;
  createdAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  expiresAt: Date | null;
  updatedAt: Date | null;
}

export interface PositionLike {
  id: number;
  userId: number | null;
  symbol: string;
  direction: string;
  lotSize: number;
  stopLoss: number | null;
  takeProfit: number | null;
  status: string;
  openedAt: Date | null;
  closedAt: Date | null;
  lastSyncedAt: Date | null;
}

export interface HistoryCarrierLike {
  status: string;
  stageOrStatus: string;
  historyJson: unknown;
  createdAt: Date | null;
}

export interface RawAsOfSources {
  stateTransitions: SourceRows<StateTransitionLike>;
  vaultEvents: SourceRows<VaultEventLike>;
  modelVersions: SourceRows<ModelVersionLike>;
  healthChecks: SourceRows<HealthCheckLike>;
  commands: SourceRows<CommandLike>;
  positions: SourceRows<PositionLike>;
  probations: SourceRows<HistoryCarrierLike>;
  policyPromotions: SourceRows<HistoryCarrierLike>;
}

// ── Assembled view ──────────────────────────────────────────────────────────

export interface PendingCommandAsOf {
  id: number;
  userId: number | null;
  action: string;
  symbol: string | null;
  /** PENDING_AS_OF: provably not yet terminal at t. INDETERMINATE: terminal
   *  NOW but its terminal transition carries no timestamp, so its state AT t
   *  cannot be established — reported as such, never guessed. */
  verdict: "PENDING_AS_OF" | "INDETERMINATE";
  currentStatus: string;
}

export interface AsOfView {
  asOfIso: string;
  globalState: AsOfSection<{ state: string; enteredVia: string; transitionAtIso: string }>;
  killSwitchAndMode: AsOfSection<{
    lastKnownEventKind: string;
    summary: string;
    operationalMode: string | null;
    globalState: string | null;
    eventAtIso: string;
  }>;
  modelVersions: AsOfSection<{
    caveat: string;
    latestPerChangeType: Array<{ changeType: string; versionId: string; versionName: string; liveAllowedNow: boolean; createdAtIso: string }>;
  }>;
  health: AsOfSection<{ healthCheckId: string; overallStatus: string; liveTradingStatus: string; mode: string; checkedAtIso: string; ageMsAtAsOf: number }>;
  pendingOrders: AsOfSection<{ pending: PendingCommandAsOf[]; indeterminate: number }>;
  openPositions: AsOfSection<{
    caveat: string;
    positions: Array<{ id: number; userId: number | null; symbol: string; direction: string; lotSize: number; hadStopLossNow: boolean; openedAtIso: string | null }>;
  }>;
  recoveryProbation: AsOfSection<{ stage: string; enteredAtIso: string; entryKind: string } | { neverArmedBefore: true }>;
  executionPolicyPromotion: AsOfSection<{ status: string; enteredAtIso: string; entryKind: string } | { neverRecordedBefore: true }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function knownAtOrBefore(d: Date | null, asOfMs: number): boolean {
  return d !== null && d.getTime() <= asOfMs;
}

type HistEntry = { at?: unknown; toStage?: unknown; toStatus?: unknown; direction?: unknown; kind?: unknown };

/** Walk an append-only historyJson: the last entry at/before t wins. */
function latestHistoryEntryAsOf(historyJson: unknown, asOfMs: number): { to: string; atIso: string; kind: string } | null {
  if (!Array.isArray(historyJson)) return null;
  let best: { to: string; atIso: string; kind: string; atMs: number } | null = null;
  for (const raw of historyJson) {
    const e = raw as HistEntry;
    if (typeof e?.at !== "string") continue;
    const atMs = Date.parse(e.at);
    if (!Number.isFinite(atMs) || atMs > asOfMs) continue;
    const to = typeof e.toStage === "string" ? e.toStage : typeof e.toStatus === "string" ? e.toStatus : null;
    if (to === null) continue;
    const kind = typeof e.direction === "string" ? e.direction : typeof e.kind === "string" ? e.kind : "unknown";
    if (!best || atMs >= best.atMs) best = { to, atIso: e.at, kind, atMs };
  }
  return best ? { to: best.to, atIso: best.atIso, kind: best.kind } : null;
}

// ── The assembler ───────────────────────────────────────────────────────────

export function assembleAsOfView(asOfMs: number, raw: RawAsOfSources): AsOfView {
  const asOfIso = new Date(asOfMs).toISOString();

  // Global state — append-only state_transitions; latest ≤ t wins.
  let globalState: AsOfView["globalState"];
  if (!raw.stateTransitions.ok) {
    globalState = unavailable("state_transitions", raw.stateTransitions.reason);
  } else {
    const eligible = raw.stateTransitions.rows.filter((r) => knownAtOrBefore(r.createdAt, asOfMs));
    const latest = eligible.reduce<StateTransitionLike | null>(
      (a, b) => (a === null || b.createdAt!.getTime() >= a.createdAt!.getTime() ? b : a),
      null,
    );
    globalState = latest
      ? {
          available: true,
          source: "state_transitions",
          basis: "append-only transition ledger; latest transition at/before the as-of instant",
          data: { state: latest.toState, enteredVia: `${latest.fromState} → ${latest.toState}`, transitionAtIso: latest.createdAt!.toISOString() },
        }
      : unavailable("state_transitions", "no state transition recorded at/before the as-of instant — state before first record is unknown, not assumed NORMAL");
  }

  // Kill switch + operational mode — safety_core mutates in place, so the
  // reconstruction reads the append-only vault_events mirror instead.
  let killSwitchAndMode: AsOfView["killSwitchAndMode"];
  if (!raw.vaultEvents.ok) {
    killSwitchAndMode = unavailable("vault_events", raw.vaultEvents.reason);
  } else {
    const relevant = raw.vaultEvents.rows.filter(
      (r) => knownAtOrBefore(r.createdAt, asOfMs) && (r.kind === "KILL_SWITCH" || r.kind === "MODE_CHANGE" || r.kind === "STATE_TRANSITION"),
    );
    const latest = relevant.reduce<VaultEventLike | null>(
      (a, b) => (a === null || b.createdAt!.getTime() >= a.createdAt!.getTime() ? b : a),
      null,
    );
    killSwitchAndMode = latest
      ? {
          available: true,
          source: "vault_events",
          basis: "safety_core is a mutable single row (NOT reconstructible as-of); this is the latest append-only KILL_SWITCH/MODE_CHANGE/STATE_TRANSITION vault event at/before t",
          data: {
            lastKnownEventKind: latest.kind,
            summary: latest.summary,
            operationalMode: latest.operationalMode,
            globalState: latest.globalState,
            eventAtIso: latest.createdAt!.toISOString(),
          },
        }
      : unavailable("vault_events", "no KILL_SWITCH/MODE_CHANGE/STATE_TRANSITION vault event at/before the as-of instant — kill-switch state at t cannot be established (safety_core itself mutates in place and is not reconstructible)");
  }

  // Model/policy versions — creation is timestamped; approval flags are NOT
  // bitemporal. Say so.
  let modelVersions: AsOfView["modelVersions"];
  if (!raw.modelVersions.ok) {
    modelVersions = unavailable("learning_model_versions", raw.modelVersions.reason);
  } else {
    const eligible = raw.modelVersions.rows.filter((r) => knownAtOrBefore(r.createdAt, asOfMs));
    const byType = new Map<string, ModelVersionLike>();
    for (const v of eligible) {
      const cur = byType.get(v.changeType);
      if (!cur || v.createdAt!.getTime() >= cur.createdAt!.getTime()) byType.set(v.changeType, v);
    }
    modelVersions = {
      available: true,
      source: "learning_model_versions",
      basis: "versions CREATED at/before t (creation timestamps are trustworthy as-of)",
      data: {
        caveat:
          "liveAllowed/approval flags mutate in place and are shown at their CURRENT values (labeled liveAllowedNow) — whether a version was approved AT t is not reconstructible from this table",
        latestPerChangeType: [...byType.values()]
          .sort((a, b) => a.changeType.localeCompare(b.changeType))
          .map((v) => ({
            changeType: v.changeType,
            versionId: v.versionId,
            versionName: v.versionName,
            liveAllowedNow: v.liveAllowed,
            createdAtIso: v.createdAt!.toISOString(),
          })),
      },
    };
  }

  // Health — append-only system_health_checks; latest ≤ t with its age.
  let health: AsOfView["health"];
  if (!raw.healthChecks.ok) {
    health = unavailable("system_health_checks", raw.healthChecks.reason);
  } else {
    const eligible = raw.healthChecks.rows.filter((r) => knownAtOrBefore(r.createdAt, asOfMs));
    const latest = eligible.reduce<HealthCheckLike | null>(
      (a, b) => (a === null || b.createdAt!.getTime() >= a.createdAt!.getTime() ? b : a),
      null,
    );
    health = latest
      ? {
          available: true,
          source: "system_health_checks",
          basis: "append-only health-check ledger; latest check at/before t (its age at t is reported — a stale check is stale, not current)",
          data: {
            healthCheckId: latest.healthCheckId,
            overallStatus: latest.overallStatus,
            liveTradingStatus: latest.liveTradingStatus,
            mode: latest.mode,
            checkedAtIso: latest.createdAt!.toISOString(),
            ageMsAtAsOf: asOfMs - latest.createdAt!.getTime(),
          },
        }
      : unavailable("system_health_checks", "no health check recorded at/before the as-of instant");
  }

  // Pending orders — reconstructed from creation + terminal-transition
  // timestamps. A command terminal NOW without a terminal timestamp is
  // INDETERMINATE at t, reported as such.
  let pendingOrders: AsOfView["pendingOrders"];
  if (!raw.commands.ok) {
    pendingOrders = unavailable("mt5_commands", raw.commands.reason);
  } else {
    const TERMINAL = new Set(["completed", "failed", "expired", "cancelled", "executed", "rejected", "blocked_demo_mode"]);
    const pending: PendingCommandAsOf[] = [];
    let indeterminate = 0;
    for (const c of raw.commands.rows) {
      if (!knownAtOrBefore(c.createdAt, asOfMs)) continue; // did not exist yet at t
      const terminalAt = c.completedAt ?? c.failedAt ?? null;
      if (terminalAt !== null) {
        if (terminalAt.getTime() > asOfMs) {
          pending.push({ id: c.id, userId: c.userId, action: c.action, symbol: c.symbol, verdict: "PENDING_AS_OF", currentStatus: c.status });
        }
        continue; // terminal at/before t → not pending at t
      }
      if (c.expiresAt !== null && c.expiresAt.getTime() <= asOfMs) continue; // provably expired by t
      const isTerminalNow = TERMINAL.has(c.status.toLowerCase());
      if (isTerminalNow) {
        // Terminal today, but WHEN it became terminal is unrecorded.
        indeterminate += 1;
        pending.push({ id: c.id, userId: c.userId, action: c.action, symbol: c.symbol, verdict: "INDETERMINATE", currentStatus: c.status });
      } else {
        pending.push({ id: c.id, userId: c.userId, action: c.action, symbol: c.symbol, verdict: "PENDING_AS_OF", currentStatus: c.status });
      }
    }
    pendingOrders = {
      available: true,
      source: "mt5_commands",
      basis: "created ≤ t and not provably terminal by t (terminal-transition timestamps: completed_at/failed_at/expires_at); rows terminal NOW with no terminal timestamp are INDETERMINATE, never guessed",
      data: { pending, indeterminate },
    };
  }

  // Open positions — live_positions mutates in place; openedAt/closedAt give
  // an honest interval, per-field values (SL etc.) are current-time only.
  let openPositions: AsOfView["openPositions"];
  if (!raw.positions.ok) {
    openPositions = unavailable("live_positions", raw.positions.reason);
  } else {
    const open = raw.positions.rows.filter(
      (p) => knownAtOrBefore(p.openedAt, asOfMs) && (p.closedAt === null || p.closedAt.getTime() > asOfMs),
    );
    openPositions = {
      available: true,
      source: "live_positions",
      basis: "opened_at ≤ t and (closed_at absent or > t)",
      data: {
        caveat:
          "position rows mutate in place: WHICH positions were open at t is reconstructible from opened_at/closed_at, but field values (stop loss, price) are CURRENT-time (labeled hadStopLossNow) — their values AT t live only in position_events",
        positions: open.map((p) => ({
          id: p.id,
          userId: p.userId,
          symbol: p.symbol,
          direction: p.direction,
          lotSize: p.lotSize,
          hadStopLossNow: p.stopLoss !== null,
          openedAtIso: p.openedAt ? p.openedAt.toISOString() : null,
        })),
      },
    };
  }

  // Recovery probation — append-only historyJson walk.
  let recoveryProbation: AsOfView["recoveryProbation"];
  if (!raw.probations.ok) {
    recoveryProbation = unavailable("recovery_probations", raw.probations.reason);
  } else {
    let best: { to: string; atIso: string; kind: string } | null = null;
    for (const row of raw.probations.rows) {
      const e = latestHistoryEntryAsOf(row.historyJson, asOfMs);
      if (e && (!best || Date.parse(e.atIso) >= Date.parse(best.atIso))) best = e;
    }
    recoveryProbation = best
      ? { available: true, source: "recovery_probations.history_json", basis: "append-only per-row transition history; latest entry ≤ t across rows", data: { stage: best.to, enteredAtIso: best.atIso, entryKind: best.kind } }
      : { available: true, source: "recovery_probations.history_json", basis: "no history entry at/before t", data: { neverArmedBefore: true } };
  }

  // Execution-policy promotion (#27) — same history walk.
  let executionPolicyPromotion: AsOfView["executionPolicyPromotion"];
  if (!raw.policyPromotions.ok) {
    executionPolicyPromotion = unavailable("execution_policy_promotions", raw.policyPromotions.reason);
  } else {
    let best: { to: string; atIso: string; kind: string } | null = null;
    for (const row of raw.policyPromotions.rows) {
      const e = latestHistoryEntryAsOf(row.historyJson, asOfMs);
      if (e && (!best || Date.parse(e.atIso) >= Date.parse(best.atIso))) best = e;
    }
    executionPolicyPromotion = best
      ? { available: true, source: "execution_policy_promotions.history_json", basis: "append-only per-row transition history; latest entry ≤ t across rows", data: { status: best.to, enteredAtIso: best.atIso, entryKind: best.kind } }
      : { available: true, source: "execution_policy_promotions.history_json", basis: "no history entry at/before t", data: { neverRecordedBefore: true } };
  }

  return {
    asOfIso,
    globalState,
    killSwitchAndMode,
    modelVersions,
    health,
    pendingOrders,
    openPositions,
    recoveryProbation,
    executionPolicyPromotion,
  };
}
