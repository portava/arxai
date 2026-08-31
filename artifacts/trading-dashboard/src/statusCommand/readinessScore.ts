/**
 * ARX Readiness Score — 10 sections, each 0..10, total 0..100.
 *
 * IMPORTANT: A high readiness score NEVER implies live trading is available.
 * The "Live Trading" lock is server-enforced and cannot be unlocked from the UI.
 * The score is a setup/clarity indicator only.
 */
import type { RuntimeContext } from "@/assistant/runtimeContextTypes";
import type { ChecklistItem } from "@/knowledge/setupChecklist";

export type ReadinessSectionId =
  | "app-health"
  | "permission"
  | "safety-locks"
  | "paper-simulator"
  | "mt5-bridge"
  | "heartbeat"
  | "broker-mode"
  | "risk-controls"
  | "assistant-knowledge"
  | "runtime-diagnostics";

export type SectionLevel = "ready" | "attention" | "blocked" | "unavailable" | "info";

export interface ReadinessSection {
  id: ReadinessSectionId;
  title: string;
  score: number; // 0..10
  max: number;   // always 10
  level: SectionLevel;
  summary: string;
  evidence: string[];
}

export interface ReadinessScore {
  total: number;          // 0..100
  max: 100;
  sections: ReadinessSection[];
  /** Human-readable mode banner. */
  mode: string;
  /** Always returned — even with score=100, this stays true until server clears the lock. */
  liveTradingStillUnavailable: boolean;
  liveUnavailableReason: string;
}

function clamp(n: number): number { return Math.max(0, Math.min(10, Math.round(n))); }

export function computeReadinessScore(
  ctx: RuntimeContext,
  checklist: ChecklistItem[],
  opts?: { knowledgeScore?: number; runtimeFailedEndpoints?: number },
): ReadinessScore {
  const sections: ReadinessSection[] = [];

  // 1. App Health — server, db, feedback reachable
  {
    const h = ctx.health;
    let s = 0;
    const ev: string[] = [];
    if (h?.serverReachable) { s += 4; ev.push("server reachable"); }
    if (h?.databaseReachable) { s += 3; ev.push("database reachable"); }
    if (h?.feedbackHealthy) { s += 3; ev.push("feedback service healthy"); }
    sections.push({
      id: "app-health", title: "App Health", score: clamp(s), max: 10,
      level: !h ? "unavailable" : s >= 8 ? "ready" : s >= 4 ? "attention" : "blocked",
      summary: !h ? "Health probe has not finished yet." : `${ev.length}/3 backend services reachable.`,
      evidence: ev,
    });
  }

  // 2. Permission — known role hint
  {
    const role = ctx.serverRoleHint;
    const known = role !== "unknown";
    sections.push({
      id: "permission", title: "User Permission",
      score: known ? 10 : 5, max: 10,
      level: known ? "info" : "attention",
      summary: known ? `Role hint: ${role}.` : "Server has not provided a role hint yet.",
      evidence: [`serverRoleHint=${role}`],
    });
  }

  // 3. Safety Locks — protective; presence is INFO, absence is attention
  {
    const locks = ctx.activeSafetyLocks;
    const liveLock = ctx.liveTradingDisabled;
    sections.push({
      id: "safety-locks", title: "Safety Locks",
      // Locks are protective — full score whenever LIVE TRADING DISABLED is in place.
      score: liveLock ? 10 : 5, max: 10,
      level: liveLock ? "info" : "attention",
      summary: liveLock
        ? "Server-enforced safety locks are active and working as intended."
        : "Safety locks not detected from the client view; server still gates execution.",
      evidence: locks,
    });
  }

  // 4. Demo / Simulator readiness
  {
    const ok = ctx.paperOnly || ctx.simulatorMode;
    sections.push({
      id: "paper-simulator", title: "Demo / Simulator Readiness",
      score: ok ? 10 : 4, max: 10,
      level: ok ? "ready" : "attention",
      summary: ok ? "Simulator/demo mode is the active execution surface." : "Simulator/demo mode not detected.",
      evidence: [`tradingMode=${ctx.tradingMode}`, `paperOnly=${ctx.paperOnly}`, `simulatorMode=${ctx.simulatorMode}`],
    });
  }

  // 5. MT5 Bridge
  {
    const mode = ctx.bridge?.bridgeMode ?? "unknown";
    const score = mode === "connected" ? 10 : mode === "deferred" ? 7 : mode === "disconnected" ? 3 : 5;
    const level: SectionLevel =
      mode === "connected" ? "ready" :
      mode === "deferred" ? "info" :
      mode === "disconnected" ? "blocked" : "attention";
    sections.push({
      id: "mt5-bridge", title: "MT5 Bridge",
      score, max: 10, level,
      summary:
        mode === "deferred" ? "Bridge intentionally deferred — ARX runs in simulator mode."
        // RANK 4 (review pass) — this asserted "broker remains read-only by
        // default" for every connected bridge, regardless of ctx.brokerReadOnly.
        // On a connected, execution-enabled account the readiness card told the
        // trader the broker was read-only while orders could dispatch.
        : mode === "connected"
          ? ctx.brokerReadOnly
            ? "Bridge connected — this broker connection is read-only right now."
            : "Bridge connected — this broker connection is NOT read-only. Orders can reach the broker once the server-side gates pass."
        : mode === "disconnected" ? "Bridge token configured, but no connection."
        : "Bridge state unknown.",
      evidence: [`bridgeMode=${mode}`],
    });
  }

  // 6. Heartbeat
  {
    const present = ctx.heartbeatPresent;
    const age = ctx.heartbeatAgeSeconds;
    const fresh = present && age !== null && age < 60;
    sections.push({
      id: "heartbeat", title: "Heartbeat",
      score: fresh ? 10 : present ? 6 : ctx.mt5Deferred ? 7 : 2, max: 10,
      level: fresh ? "ready" : present ? "attention" : ctx.mt5Deferred ? "info" : "blocked",
      summary: fresh
        ? `Fresh heartbeat (${age}s ago).`
        : present ? "Heartbeat seen, but stale."
        : ctx.mt5Deferred ? "No heartbeat expected — bridge is deferred."
        : "No recent heartbeat from the EA.",
      evidence: [`heartbeatPresent=${present}`, `ageSeconds=${age ?? "n/a"}`],
    });
  }

  // 7. Broker Mode (read-only is the safe default)
  {
    const ro = ctx.brokerReadOnly;
    sections.push({
      id: "broker-mode", title: "Broker Mode",
      score: ro ? 10 : 5, max: 10,
      level: ro ? "info" : "attention",
      summary: ro ? "Broker is read-only (safe default)." : "Broker is NOT read-only — investigate before any execution.",
      evidence: [`brokerReadOnly=${ro}`, `brokerExecutionDisabled=${ctx.brokerExecutionDisabled}`],
    });
  }

  // 8. Risk Controls — proxied by setup checklist "risk-reviewed"
  {
    const risk = checklist.find((c) => c.id === "risk-reviewed");
    const status = risk?.status ?? "incomplete";
    sections.push({
      id: "risk-controls", title: "Risk Controls",
      score: status === "complete" ? 10 : status === "blocked" ? 3 : 6, max: 10,
      level: status === "complete" ? "ready" : status === "blocked" ? "blocked" : "attention",
      summary: status === "complete" ? "Risk Governor reviewed." : "Risk Governor review pending.",
      evidence: [`risk-reviewed=${status}`],
    });
  }

  // 9. Assistant Knowledge — uses optional knowledgeScore (0..100); maps to 0..10
  {
    const ks = opts?.knowledgeScore ?? 100;
    const s = clamp(ks / 10);
    sections.push({
      id: "assistant-knowledge", title: "Assistant Knowledge",
      score: s, max: 10,
      level: s >= 8 ? "ready" : s >= 5 ? "attention" : "blocked",
      summary: `Knowledge audit score: ${ks}/100.`,
      evidence: [`knowledgeAudit=${ks}`],
    });
  }

  // 10. Runtime Diagnostics — penalize recent error/failure activity
  {
    const errs = ctx.recentErrors.length;
    const fails = opts?.runtimeFailedEndpoints ?? ctx.recentFailedEndpoints.length;
    const penalty = Math.min(8, errs + fails);
    const s = clamp(10 - penalty);
    sections.push({
      id: "runtime-diagnostics", title: "Runtime Diagnostics",
      score: s, max: 10,
      level: s >= 8 ? "ready" : s >= 5 ? "attention" : "blocked",
      summary: errs === 0 && fails === 0
        ? "No recent errors captured."
        : `${errs} error(s) and ${fails} failed API call(s) recently.`,
      evidence: [`recentErrors=${errs}`, `failedEndpoints=${fails}`],
    });
  }

  const total = sections.reduce((acc, s) => acc + s.score, 0);
  const liveUnavailableReason =
    ctx.emergencyStopActive === true ? "Emergency Stop is engaged."
    : !ctx.heartbeatPresent ? "No confirmed MT5 heartbeat."
    : ctx.mt5Deferred ? "MT5 bridge is deferred."
    : ctx.brokerReadOnly ? "Broker is in read-only mode."
    : ctx.liveTradingDisabled ? "Server-enforced LIVE TRADING DISABLED lock."
    : ctx.emergencyStopActive === null ? "Emergency Stop state could not be read (unknown, not off)."
    : "Execution remains server-gated regardless of UI score.";

  return {
    total, max: 100, sections,
    mode: ctx.tradingMode.toUpperCase(),
    liveTradingStillUnavailable: true,
    liveUnavailableReason,
  };
}
