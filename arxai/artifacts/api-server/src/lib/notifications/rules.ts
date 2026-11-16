// Build LL — Notification rule engine.
//
// Pure functions that translate a typed event from any build (AA..KK) into
// a NotifyInput. Every rule sets a stable dedupe_key so repeated identical
// events fold into a single notification with an incremented repeat_count.
//
// SAFETY: rules NEVER place trades, NEVER expose secrets, NEVER recommend
// live trading. Live-trading-related events always become CRITICAL alerts.

export type NotifType =
  | "SAFETY" | "RISK" | "TRADE" | "LEARNING"
  | "SYSTEM" | "COACH" | "DATA" | "REPLAY" | "BROKER";
export type NotifSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";
export type SourceBuild = "AA"|"BB"|"CC"|"DD"|"EE"|"FF"|"GG"|"HH"|"II"|"JJ"|"KK"|"LL";

export interface NotifyInput {
  type: NotifType;
  severity: NotifSeverity;
  title: string;
  message: string;
  sourceBuild: SourceBuild;
  sourceEventId?: string | null;
  symbol?: string | null;
  relatedTradeId?: string | null;
  relatedDecisionId?: string | null;
  relatedDebriefId?: string | null;
  relatedLearningEventId?: string | null;
  relatedReplayRunId?: string | null;
  actionRequired?: boolean;
  recommendedAction?: string | null;
  actionUrl?: string | null;
  metadata?: Record<string, unknown>;
  dedupeKey: string;
  expiresAtMs?: number | null;
}

// 5-minute time bucket for repeating-by-time events (e.g. wide spread).
function bucket5(ts: Date | string | number): string {
  const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
  return String(Math.floor(ms / (5 * 60_000)));
}

// ── HH Risk Governor ────────────────────────────────────────────────────────
export function ruleGovernorEvaluation(args: {
  governorId: string;
  overallStatus: string;          // OK|WATCH_ONLY|PAPER_PAUSED|PAPER_CAUTION|LOCKED
  liveTradingAllowed?: boolean;
  hardBlocks?: Array<{ code: string; severity: string; message: string }>;
  metrics?: { dailyPnl?: number; dailyLossLimit?: number };
}): NotifyInput | null {
  const status = (args.overallStatus || "").toUpperCase();
  const blocks = args.hardBlocks ?? [];

  // Live-trading-flag detected → CRITICAL (LL hard rule)
  if (args.liveTradingAllowed === true) {
    return {
      type: "SAFETY", severity: "CRITICAL", sourceBuild: "HH",
      sourceEventId: args.governorId,
      title: "LIVE TRADING FLAG DETECTED",
      message: "Risk Governor reported liveTradingAllowed=true. System is paper-only — investigate immediately.",
      actionRequired: true,
      recommendedAction: "Open Risk Governor and verify hard blocks; do not place live trades.",
      actionUrl: "/risk-settings",
      metadata: { hardBlocks: blocks.map(b => b.code) },
      dedupeKey: `HH:LIVE_FLAG:${args.governorId}`,
    };
  }

  if (status === "LOCKED") {
    const codes = blocks.map(b => b.code).join(", ") || "no specific code";
    return {
      type: "SAFETY", severity: "CRITICAL", sourceBuild: "HH",
      sourceEventId: args.governorId,
      title: "Risk Governor LOCKED",
      message: `Trading is LOCKED. Hard blocks: ${codes}.`,
      actionRequired: true,
      recommendedAction: "Resolve hard blocks before resuming. Live trading remains DISABLED.",
      actionUrl: "/risk-settings",
      metadata: { blocks: blocks.map(b => ({ code: b.code, severity: b.severity })) },
      dedupeKey: `HH:LOCKED:${args.governorId}`,
    };
  }
  if (status === "WATCH_ONLY") {
    return {
      type: "RISK", severity: "HIGH", sourceBuild: "HH",
      sourceEventId: args.governorId,
      title: "Risk Governor: Trading paused",
      message: "Conditions have paused trading. New trades are restricted.",
      recommendedAction: "Review risk metrics and warnings before resuming.",
      actionUrl: "/risk-settings",
      dedupeKey: `HH:WATCH_ONLY:${args.governorId}`,
    };
  }
  if (status === "PAPER_PAUSED") {
    return {
      type: "RISK", severity: "HIGH", sourceBuild: "HH",
      sourceEventId: args.governorId,
      title: "Paper trading paused",
      message: "Risk Governor paused paper trading.",
      recommendedAction: "Inspect blocks and metrics, then unpause when safe.",
      actionUrl: "/paper-trading",
      dedupeKey: `HH:PAPER_PAUSED:${args.governorId}`,
    };
  }
  if (status === "PAPER_CAUTION") {
    return {
      type: "RISK", severity: "WARNING", sourceBuild: "HH",
      sourceEventId: args.governorId,
      title: "Paper trading: CAUTION",
      message: "Risk Governor entered CAUTION mode.",
      dedupeKey: `HH:PAPER_CAUTION:${args.governorId}`,
    };
  }

  // Daily-loss-limit advisory
  if (args.metrics?.dailyPnl != null && args.metrics?.dailyLossLimit) {
    const pnl = args.metrics.dailyPnl;
    const limit = args.metrics.dailyLossLimit;
    if (pnl <= -Math.abs(limit)) {
      return {
        type: "RISK", severity: "CRITICAL", sourceBuild: "HH",
        sourceEventId: args.governorId,
        title: "Daily loss limit hit",
        message: `Daily P&L ${pnl} reached loss limit ${limit}.`,
        actionRequired: true,
        recommendedAction: "Stop trading for the session and review.",
        dedupeKey: `HH:DAILY_LOSS_HIT:${new Date().toISOString().slice(0,10)}`,
      };
    }
    if (pnl <= -0.8 * Math.abs(limit)) {
      return {
        type: "RISK", severity: "HIGH", sourceBuild: "HH",
        sourceEventId: args.governorId,
        title: "Approaching daily loss limit",
        message: `Daily P&L ${pnl} is within 20% of limit ${limit}.`,
        dedupeKey: `HH:DAILY_LOSS_NEAR:${new Date().toISOString().slice(0,10)}`,
      };
    }
  }
  return null;
}

// ── DD Market Data ──────────────────────────────────────────────────────────
export function ruleMarketData(args: {
  symbol: string;
  event: "STALE_QUOTE"|"WIDE_SPREAD"|"PROVIDER_DEGRADED"|"MISSING_CANDLES"|"EXTREME_VOLATILITY"|"FALLBACK_MODE";
  spread?: number; ts?: Date | string;
}): NotifyInput {
  const map: Record<string, { sev: NotifSeverity; title: string }> = {
    STALE_QUOTE:        { sev: "HIGH",    title: "Stale market quote" },
    WIDE_SPREAD:        { sev: "WARNING", title: "Wide spread detected" },
    PROVIDER_DEGRADED:  { sev: "WARNING", title: "Market data provider degraded" },
    MISSING_CANDLES:    { sev: "WARNING", title: "Missing candles in feed" },
    EXTREME_VOLATILITY: { sev: "HIGH",    title: "Extreme volatility detected" },
    FALLBACK_MODE:      { sev: "WARNING", title: "Market data fallback active" },
  };
  const m = map[args.event];
  return {
    type: "DATA", severity: m.sev, sourceBuild: "DD",
    title: `${m.title} on ${args.symbol}`,
    message: `${m.title} on ${args.symbol}${args.spread != null ? ` (spread=${args.spread})` : ""}.`,
    symbol: args.symbol,
    metadata: { spread: args.spread ?? null, event: args.event },
    dedupeKey: `DD:${args.event}:${args.symbol}:${bucket5(args.ts ?? Date.now())}`,
  };
}

// ── EE Paper Execution ──────────────────────────────────────────────────────
export function rulePaperExecution(args: {
  paperOrderId: number | string;
  event: "OPENED"|"REJECTED"|"DUPLICATE_BLOCKED"|"TP_HIT"|"SL_HIT"|"MANUAL_CLOSE";
  symbol?: string; pnl?: number | null; reason?: string | null;
}): NotifyInput {
  const map: Record<string, { type: NotifType; sev: NotifSeverity; title: string }> = {
    OPENED:             { type: "TRADE",  sev: "INFO",    title: "Paper trade opened" },
    REJECTED:           { type: "TRADE",  sev: "WARNING", title: "Paper trade rejected" },
    DUPLICATE_BLOCKED:  { type: "SYSTEM", sev: "INFO",    title: "Duplicate decision blocked" },
    TP_HIT:             { type: "TRADE",  sev: "INFO",    title: "Take-profit hit" },
    SL_HIT:             { type: "TRADE",  sev: "WARNING", title: "Stop-loss hit" },
    MANUAL_CLOSE:       { type: "TRADE",  sev: "INFO",    title: "Manual close" },
  };
  const m = map[args.event];
  return {
    type: m.type, severity: m.sev, sourceBuild: "EE",
    sourceEventId: String(args.paperOrderId),
    title: m.title,
    message: `${m.title}${args.symbol ? ` on ${args.symbol}` : ""}${args.pnl != null ? ` (P&L ${args.pnl})` : ""}${args.reason ? ` — ${args.reason}` : ""}.`,
    symbol: args.symbol ?? null,
    relatedTradeId: String(args.paperOrderId),
    metadata: { event: args.event, pnl: args.pnl ?? null },
    dedupeKey: `EE:${args.event}:${args.paperOrderId}`,
  };
}

// ── FF Autopilot ────────────────────────────────────────────────────────────
export function ruleAutopilot(args: {
  cycleId: string;
  event: "STARTED"|"STOPPED"|"PAUSED_BY_GOVERNOR"|"COOLDOWN_ACTIVE"|"SAME_SYMBOL_CONFLICT"|"DAILY_LOSS_STOP";
  symbol?: string; reason?: string;
}): NotifyInput {
  const map: Record<string, { sev: NotifSeverity; title: string; type: NotifType }> = {
    STARTED:              { sev: "INFO",    title: "Autopilot started",          type: "SYSTEM" },
    STOPPED:              { sev: "INFO",    title: "Autopilot stopped",          type: "SYSTEM" },
    PAUSED_BY_GOVERNOR:   { sev: "HIGH",    title: "Autopilot paused by governor", type: "SAFETY" },
    COOLDOWN_ACTIVE:      { sev: "WARNING", title: "Cooldown active",            type: "SYSTEM" },
    SAME_SYMBOL_CONFLICT: { sev: "WARNING", title: "Same-symbol conflict",       type: "SYSTEM" },
    DAILY_LOSS_STOP:      { sev: "HIGH",    title: "Daily loss stop triggered",  type: "RISK"   },
  };
  const m = map[args.event];
  return {
    type: m.type, severity: m.sev, sourceBuild: "FF",
    sourceEventId: args.cycleId,
    title: m.title,
    message: `${m.title}${args.symbol ? ` (${args.symbol})` : ""}${args.reason ? ` — ${args.reason}` : ""}.`,
    symbol: args.symbol ?? null,
    metadata: { event: args.event, reason: args.reason ?? null },
    dedupeKey: `FF:${args.event}:${args.cycleId}${args.symbol ? `:${args.symbol}` : ""}`,
  };
}

// ── BB Auto-Debrief ─────────────────────────────────────────────────────────
export function ruleDebrief(args: {
  debriefId: string | number;
  event: "CREATED"|"FAILED"|"DUPLICATE_SKIPPED";
  tradeId?: string | number;
}): NotifyInput {
  const map = {
    CREATED:           { sev: "INFO" as NotifSeverity,    title: "Auto-debrief created" },
    FAILED:            { sev: "WARNING" as NotifSeverity, title: "Auto-debrief failed" },
    DUPLICATE_SKIPPED: { sev: "INFO" as NotifSeverity,    title: "Duplicate debrief skipped" },
  } as const;
  const m = map[args.event];
  return {
    type: "LEARNING", severity: m.sev, sourceBuild: "BB",
    sourceEventId: String(args.debriefId),
    title: m.title,
    message: `${m.title} for trade ${args.tradeId ?? "?"}.`,
    relatedDebriefId: String(args.debriefId),
    relatedTradeId: args.tradeId != null ? String(args.tradeId) : null,
    actionUrl: "/post-trade-debriefs",
    dedupeKey: `BB:${args.event}:${args.debriefId}`,
  };
}

// ── CC Learning Engine ──────────────────────────────────────────────────────
export function ruleLearning(args: {
  learningEventId: string | number;
  event: "PROCESSED"|"SKIPPED_IDEMPOTENT"|"REPEATED_MISTAKE_RISING";
  tag?: string; count?: number; symbol?: string;
}): NotifyInput {
  if (args.event === "REPEATED_MISTAKE_RISING") {
    return {
      type: "LEARNING", severity: "WARNING", sourceBuild: "CC",
      sourceEventId: String(args.learningEventId),
      title: `Repeated mistake pattern rising: ${args.tag ?? "(unknown)"}`,
      message: `Pattern ${args.tag} now seen ${args.count ?? "?"} times${args.symbol ? ` on ${args.symbol}` : ""}.`,
      symbol: args.symbol ?? null,
      relatedLearningEventId: String(args.learningEventId),
      actionRequired: true,
      recommendedAction: "Open Trader Coach to review the mistake pattern.",
      actionUrl: "/trader-coach",
      metadata: { tag: args.tag, count: args.count },
      dedupeKey: `CC:REPEATED:${args.tag}:${args.symbol ?? "ALL"}`,
    };
  }
  const sev: NotifSeverity = "INFO";
  const title = args.event === "PROCESSED" ? "Learning event processed" : "Learning skipped (idempotent)";
  return {
    type: "LEARNING", severity: sev, sourceBuild: "CC",
    sourceEventId: String(args.learningEventId),
    title,
    message: `${title}${args.symbol ? ` on ${args.symbol}` : ""}.`,
    symbol: args.symbol ?? null,
    relatedLearningEventId: String(args.learningEventId),
    dedupeKey: `CC:${args.event}:${args.learningEventId}`,
  };
}

// ── II Trader Coach ─────────────────────────────────────────────────────────
export function ruleCoach(args: {
  reportId: string;
  event: "REPORT_READY"|"WEEKLY_PLAN_READY"|"PLAYBOOK_UPDATED"|"REPEATED_MISTAKE_COACHING";
}): NotifyInput {
  const map: Record<string, string> = {
    REPORT_READY: "Trader Coach report ready",
    WEEKLY_PLAN_READY: "Weekly plan ready",
    PLAYBOOK_UPDATED: "Playbook entry updated",
    REPEATED_MISTAKE_COACHING: "Coaching generated for repeated mistake",
  };
  return {
    type: "COACH", severity: "INFO", sourceBuild: "II",
    sourceEventId: args.reportId,
    title: map[args.event],
    message: `${map[args.event]} (id ${args.reportId}).`,
    actionUrl: "/trader-coach",
    dedupeKey: `II:${args.event}:${args.reportId}`,
  };
}

// ── JJ Replay / Strategy Lab ────────────────────────────────────────────────
export function ruleReplay(args: {
  runId: string;
  event: "REPORT_READY"|"EXPERIMENT_COMPLETE"|"FAILED";
  detail?: string;
}): NotifyInput {
  const map: Record<string, { sev: NotifSeverity; title: string }> = {
    REPORT_READY:        { sev: "INFO",    title: "Replay report ready" },
    EXPERIMENT_COMPLETE: { sev: "INFO",    title: "Strategy Lab experiment complete" },
    FAILED:              { sev: "WARNING", title: "Replay failed" },
  };
  const m = map[args.event];
  return {
    type: "REPLAY", severity: m.sev, sourceBuild: "JJ",
    sourceEventId: args.runId,
    title: m.title,
    message: `${m.title} (${args.runId})${args.detail ? ` — ${args.detail}` : ""}.`,
    relatedReplayRunId: args.runId,
    actionUrl: "/replay-simulator",
    dedupeKey: `JJ:${args.event}:${args.runId}`,
  };
}

// ── KK Data Import ──────────────────────────────────────────────────────────
export function ruleImport(args: {
  importId: string;
  status: string; // VALIDATED|IMPORTED|REJECTED|PARTIAL
  warnings?: string[]; errors?: string[];
}): NotifyInput | null {
  const status = args.status.toUpperCase();
  if (status === "REJECTED") {
    return {
      type: "DATA", severity: "HIGH", sourceBuild: "KK",
      sourceEventId: args.importId,
      title: "Data import rejected",
      message: `Import ${args.importId} rejected${args.errors?.length ? `: ${args.errors[0]}` : ""}.`,
      actionUrl: "/data-import",
      metadata: { errors: args.errors ?? [] },
      dedupeKey: `KK:IMPORT_REJECTED:${args.importId}`,
    };
  }
  if (status === "PARTIAL") {
    return {
      type: "DATA", severity: "WARNING", sourceBuild: "KK",
      sourceEventId: args.importId,
      title: "Data import partial — quality issues",
      message: `Import ${args.importId} completed with warnings${args.warnings?.length ? `: ${args.warnings[0]}` : ""}.`,
      actionUrl: "/data-import",
      metadata: { warnings: args.warnings ?? [] },
      dedupeKey: `KK:IMPORT_PARTIAL:${args.importId}`,
    };
  }
  if (status === "IMPORTED" || status === "VALIDATED") {
    return {
      type: "DATA", severity: "INFO", sourceBuild: "KK",
      sourceEventId: args.importId,
      title: `Data import ${status.toLowerCase()}`,
      message: `Import ${args.importId} ${status.toLowerCase()} cleanly.`,
      actionUrl: "/data-import",
      dedupeKey: `KK:IMPORT_${status}:${args.importId}`,
    };
  }
  return null;
}

// ── KK Broker Read-Only ─────────────────────────────────────────────────────
export function ruleBroker(args: {
  event: "UNSAFE_MODE_REJECTED"|"SNAPSHOT_CREATED"|"SECRET_EXPOSURE_ATTEMPT"|"READ_ONLY_VERIFIED";
  snapshotId?: string;
  brokerModeEnv?: string;
  detail?: string;
}): NotifyInput | null {
  if (args.event === "UNSAFE_MODE_REJECTED") {
    return {
      type: "SAFETY", severity: "CRITICAL", sourceBuild: "KK",
      sourceEventId: args.snapshotId ?? null,
      title: "Unsafe BROKER_MODE rejected",
      message: `BROKER_MODE=${args.brokerModeEnv ?? "?"} is NOT read_only. Connector refused.`,
      actionRequired: true,
      recommendedAction: "Set BROKER_MODE=read_only or unset it.",
      actionUrl: "/broker-readonly",
      metadata: { brokerModeEnv: args.brokerModeEnv ?? null },
      dedupeKey: `KK:UNSAFE_BROKER_MODE:${args.brokerModeEnv ?? "unknown"}`,
    };
  }
  if (args.event === "SECRET_EXPOSURE_ATTEMPT") {
    return {
      type: "SAFETY", severity: "HIGH", sourceBuild: "KK",
      title: "Secret exposure attempt detected",
      message: `Possible secret exposure attempt — secrets remain redacted${args.detail ? `: ${args.detail}` : ""}.`,
      actionRequired: true,
      recommendedAction: "Inspect broker logs and rotate any exposed credential.",
      actionUrl: "/broker-readonly",
      dedupeKey: `KK:SECRET_EXPOSURE:${bucket5(Date.now())}`,
    };
  }
  if (args.event === "SNAPSHOT_CREATED" && args.snapshotId) {
    return {
      type: "BROKER", severity: "INFO", sourceBuild: "KK",
      sourceEventId: args.snapshotId,
      title: "Broker read-only snapshot created",
      message: `Snapshot ${args.snapshotId} stored (READ_ONLY).`,
      actionUrl: "/broker-readonly",
      dedupeKey: `KK:SNAPSHOT:${args.snapshotId}`,
    };
  }
  return null;
}

// ── AA Trade Decision ───────────────────────────────────────────────────────
export function ruleAADecision(args: {
  decisionId: string | number;
  symbol?: string;
  shouldTrade: boolean;
  reason?: string;
  riskScore?: number;
  hasMarketData?: boolean;
}): NotifyInput | null {
  if (args.shouldTrade === false && args.reason && /missing|stale|degraded|no.?data/i.test(args.reason)) {
    return {
      type: "DATA", severity: "WARNING", sourceBuild: "AA",
      sourceEventId: String(args.decisionId),
      title: "Decision HOLD — missing data",
      message: `${args.symbol ?? "?"}: HOLD due to missing/degraded data — ${args.reason}.`,
      symbol: args.symbol ?? null,
      relatedDecisionId: String(args.decisionId),
      dedupeKey: `AA:HOLD_MISSING_DATA:${args.symbol ?? "?"}:${bucket5(Date.now())}`,
    };
  }
  // High-risk HOLD: accept either 0-1 normalized risk (>= 0.7) or 0-100 (>= 70),
  // OR any HOLD whose reason text mentions risk / blocked / high-risk.
  const rs = args.riskScore ?? 0;
  const riskHigh = rs >= 70 || (rs > 0 && rs <= 1 && rs >= 0.7);
  const reasonRisky = !!args.reason && /risk|block|hold|reject/i.test(args.reason);
  if (args.shouldTrade === false && (riskHigh || reasonRisky)) {
    return {
      type: "RISK", severity: "WARNING", sourceBuild: "AA",
      sourceEventId: String(args.decisionId),
      title: "Decision HOLD — high risk",
      message: `${args.symbol ?? "?"}: HOLD due to high risk${args.reason ? ` — ${args.reason}` : ""}${args.riskScore != null ? ` (score ${args.riskScore})` : ""}.`,
      symbol: args.symbol ?? null,
      relatedDecisionId: String(args.decisionId),
      recommendedAction: "Review the decision context before unblocking. No live trading is allowed.",
      dedupeKey: `AA:HOLD_HIGH_RISK:${args.symbol ?? "?"}:${bucket5(Date.now())}`,
    };
  }
  return null;
}

// ── GG Command Center ───────────────────────────────────────────────────────
export function ruleCommandCenter(args: {
  event: "MAJOR_WARNING"|"PERF_REBUILD_OK"|"PERF_REBUILD_FAILED";
  detail?: string;
  ts?: number;
}): NotifyInput {
  const map: Record<string, { sev: NotifSeverity; title: string }> = {
    MAJOR_WARNING:       { sev: "HIGH",    title: "Command Center major warning" },
    PERF_REBUILD_OK:     { sev: "INFO",    title: "Performance rebuild completed" },
    PERF_REBUILD_FAILED: { sev: "WARNING", title: "Performance rebuild failed" },
  };
  const m = map[args.event];
  return {
    type: "SYSTEM", severity: m.sev, sourceBuild: "GG",
    title: m.title,
    message: `${m.title}${args.detail ? `: ${args.detail}` : ""}.`,
    actionUrl: "/ai-command-center",
    dedupeKey: `GG:${args.event}:${bucket5(args.ts ?? Date.now())}`,
  };
}

// ── System / build errors ───────────────────────────────────────────────────
export function ruleSystemError(args: {
  source: SourceBuild; message: string; ts?: number; severity?: NotifSeverity;
}): NotifyInput {
  return {
    type: "SYSTEM", severity: args.severity ?? "WARNING", sourceBuild: args.source,
    title: `System error in build ${args.source}`,
    message: args.message.slice(0, 300),
    dedupeKey: `SYS:${args.source}:${args.message.slice(0,40)}:${bucket5(args.ts ?? Date.now())}`,
  };
}
