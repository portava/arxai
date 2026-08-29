// Capability #28 — Independent Protection Watchdog, PURE assessment core.
//
// The watchdog process (artifacts/api-server/src/watchdog.ts) is a SEPARATE
// entrypoint with its own DB connection; this module is the pure half it
// shares with the offline tests: row-shaped snapshots in, typed findings out.
// No IO, no clock reads (nowMs injected), no imports from the app.
//
// SAFETY CONTRACT:
//   - OBSERVES ONLY. A finding is an alert, never an action: the watchdog
//     holds no execution authority of any kind and cannot close, modify, or
//     place anything (its DB session is read-only and it imports no
//     execution surface — pinned by the source-guard test).
//   - Unverifiable is NOT healthy: a snapshot section that could not be read
//     yields a CANNOT_VERIFY finding at CRITICAL — the one failure mode a
//     protection watchdog must never have is silent optimism.

// ── Thresholds (test-pinned) ────────────────────────────────────────────────

/** Open position not synced for this long → the main app may be blind. */
export const STALE_POSITION_SYNC_MS = 5 * 60 * 1000;
/** Command sitting non-terminal for this long → stuck. */
export const STUCK_COMMAND_MS = 10 * 60 * 1000;
/** No health check AND no audit event for this long → main app silent. */
export const MAIN_APP_SILENT_MS = 10 * 60 * 1000;

/** Non-terminal command statuses (queue → bridge in-flight). */
export const NON_TERMINAL_COMMAND_STATUSES = ["PENDING", "DELIVERED", "claimed", "sent"] as const;

// ── Snapshot shapes (structural; the IO half adapts raw SQL rows) ───────────

export interface WatchdogPositionRow {
  id: number;
  userId: number | null;
  symbol: string;
  direction: string;
  lotSize: number;
  stopLoss: number | null;
  status: string;
  closedAt: Date | null;
  lastSyncedAt: Date | null;
}

export interface WatchdogCommandRow {
  id: number;
  status: string;
  action: string;
  createdAt: Date | null;
}

/** Each section is rows or the typed reason it could not be read. */
export type Section<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface WatchdogSnapshot {
  openPositions: Section<WatchdogPositionRow[]>;
  nonTerminalCommands: Section<WatchdogCommandRow[]>;
  latestHealthCheckAt: Section<Date | null>;
  latestAuditEventAt: Section<Date | null>;
  killSwitchEngaged: Section<boolean | null>;
}

// ── Findings ────────────────────────────────────────────────────────────────

export type WatchdogSeverity = "INFO" | "WARN" | "CRITICAL";

export interface WatchdogFinding {
  /** Stable key for repeat-suppression (same key = same ongoing condition). */
  key: string;
  severity: WatchdogSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

export interface WatchdogAssessment {
  findings: WatchdogFinding[];
  criticalCount: number;
  cannotVerifyCount: number;
  /** True only when every section was readable AND produced no CRITICAL. */
  verifiedHealthy: boolean;
}

function cannotVerify(section: string, reason: string): WatchdogFinding {
  return {
    key: `cannot_verify:${section}`,
    severity: "CRITICAL",
    message: `CANNOT VERIFY ${section} — a protection watchdog that cannot read is not a green light (${reason})`,
    evidence: { section, reason },
  };
}

// ── Assessment ──────────────────────────────────────────────────────────────

export function assessSnapshot(snapshot: WatchdogSnapshot, nowMs: number): WatchdogAssessment {
  const findings: WatchdogFinding[] = [];

  // 1. Open positions: protective-order presence + sync freshness.
  if (!snapshot.openPositions.ok) {
    findings.push(cannotVerify("open_positions", snapshot.openPositions.reason));
  } else {
    for (const p of snapshot.openPositions.value) {
      if (p.closedAt !== null) continue; // defensively skip closed rows
      if (p.stopLoss === null) {
        findings.push({
          key: `unprotected_position:${p.id}`,
          severity: "CRITICAL",
          message: `open position ${p.symbol} ${p.direction} ${p.lotSize} (id ${p.id}) has NO stop loss recorded — verify protection at the broker NOW`,
          evidence: { positionId: p.id, userId: p.userId, symbol: p.symbol, direction: p.direction, lotSize: p.lotSize },
        });
      }
      if (p.lastSyncedAt !== null && nowMs - p.lastSyncedAt.getTime() > STALE_POSITION_SYNC_MS) {
        findings.push({
          key: `stale_position_sync:${p.id}`,
          severity: "WARN",
          message: `open position id ${p.id} (${p.symbol}) not synced for ${Math.round((nowMs - p.lastSyncedAt.getTime()) / 60000)}m — the main app may be blind to it`,
          evidence: { positionId: p.id, lastSyncedAtIso: p.lastSyncedAt.toISOString() },
        });
      }
      if (p.lastSyncedAt === null) {
        findings.push({
          key: `never_synced_position:${p.id}`,
          severity: "WARN",
          message: `open position id ${p.id} (${p.symbol}) has never recorded a sync`,
          evidence: { positionId: p.id },
        });
      }
    }
  }

  // 2. Stuck commands.
  if (!snapshot.nonTerminalCommands.ok) {
    findings.push(cannotVerify("mt5_commands", snapshot.nonTerminalCommands.reason));
  } else {
    for (const c of snapshot.nonTerminalCommands.value) {
      if (c.createdAt === null) continue;
      const age = nowMs - c.createdAt.getTime();
      if (age > STUCK_COMMAND_MS) {
        findings.push({
          key: `stuck_command:${c.id}`,
          severity: "WARN",
          message: `command id ${c.id} (${c.action}) has been ${c.status} for ${Math.round(age / 60000)}m — bridge may be down or the command lost`,
          evidence: { commandId: c.id, status: c.status, action: c.action, ageMs: age },
        });
      }
    }
  }

  // 3. Main-app liveness (health checks and audit activity are both
  //    app-written; silence on BOTH means the app is down or wedged).
  if (!snapshot.latestHealthCheckAt.ok && !snapshot.latestAuditEventAt.ok) {
    findings.push(cannotVerify("main_app_liveness", `${snapshot.latestHealthCheckAt.reason}; ${snapshot.latestAuditEventAt.reason}`));
  } else {
    const stamps: number[] = [];
    if (snapshot.latestHealthCheckAt.ok && snapshot.latestHealthCheckAt.value) stamps.push(snapshot.latestHealthCheckAt.value.getTime());
    if (snapshot.latestAuditEventAt.ok && snapshot.latestAuditEventAt.value) stamps.push(snapshot.latestAuditEventAt.value.getTime());
    if (stamps.length === 0) {
      findings.push({
        key: "main_app_no_liveness_evidence",
        severity: "WARN",
        message: "no health checks and no audit events exist — main-app liveness cannot be established from DB evidence (fresh database, or the app has never run)",
        evidence: {},
      });
    } else {
      const newest = Math.max(...stamps);
      const silenceMs = nowMs - newest;
      if (silenceMs > MAIN_APP_SILENT_MS) {
        findings.push({
          key: "main_app_silent",
          severity: "CRITICAL",
          message: `main app has written no health check or audit event for ${Math.round(silenceMs / 60000)}m — it may be down while positions are open`,
          evidence: { newestActivityIso: new Date(newest).toISOString(), silenceMs },
        });
      }
    }
  }

  // 4. Kill switch visibility (context for the operator, not a judgment).
  if (!snapshot.killSwitchEngaged.ok) {
    findings.push(cannotVerify("safety_core", snapshot.killSwitchEngaged.reason));
  } else if (snapshot.killSwitchEngaged.value === true) {
    const openCount = snapshot.openPositions.ok ? snapshot.openPositions.value.filter((p) => p.closedAt === null).length : null;
    findings.push({
      key: "kill_switch_engaged",
      severity: openCount !== null && openCount > 0 ? "WARN" : "INFO",
      message: openCount !== null && openCount > 0
        ? `kill switch is ENGAGED with ${openCount} open position(s) — verify their broker-side protection independently`
        : "kill switch is ENGAGED (no open positions visible)",
      evidence: { openPositions: openCount },
    });
  }

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const cannotVerifyCount = findings.filter((f) => f.key.startsWith("cannot_verify:")).length;
  return {
    findings,
    criticalCount,
    cannotVerifyCount,
    verifiedHealthy: criticalCount === 0 && cannotVerifyCount === 0,
  };
}

// ── Repeat suppression (pure) ───────────────────────────────────────────────

export interface AlertDelta {
  newFindings: WatchdogFinding[];
  resolvedKeys: string[];
  activeKeys: string[];
}

/** Diff this pass's findings against the previously-alerted keys so an
 *  ongoing condition alerts once and its resolution is announced once. */
export function diffFindings(previousKeys: readonly string[], findings: readonly WatchdogFinding[]): AlertDelta {
  const currentKeys = new Set(findings.map((f) => f.key));
  const prev = new Set(previousKeys);
  return {
    newFindings: findings.filter((f) => !prev.has(f.key)),
    resolvedKeys: previousKeys.filter((k) => !currentKeys.has(k)),
    activeKeys: [...currentKeys],
  };
}
