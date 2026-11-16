// ── Profit Mission Phase 7 — Broker/Feed Execution-Health Gate (pure, BLOCK) ──
//
// PLANNING / PRE-EXECUTION PRE-CHECK ONLY. Composes the existing broker-health
// and feed-truth seams into a single pre-execution block: broker connected, feed
// fresh, quote↔candle aligned, normal spread, no ghost positions, equity
// reconciled, route healthy. It BLOCKS EXECUTION ONLY — analyze/watch is always
// allowed, and it can never upgrade a setup or relax a gate.
//
// HONESTY CONTRACT:
//   - Every "healthy" judgement requires a POSITIVELY OBSERVED signal. An unknown
//     signal fails CLOSED (blocks execution) and is surfaced honestly — it never
//     reads as "good".
//
// PURE + DETERMINISTIC + IO-FREE.

export type ExecHealthBrokerSeverity = "ok" | "warn" | "danger" | "unknown";
export type ExecHealthFeedStatus =
  | "live"
  | "delayed"
  | "stale"
  | "awaiting"
  | "simulator"
  | "unknown";
export type ExecHealthSpread = "normal" | "wide" | "extreme" | "unknown";

export interface ExecutionHealthInput {
  /** Composed broker-health severity (from getBrokerHealthVerdict). */
  brokerSeverity: ExecHealthBrokerSeverity;
  /** Is the broker bridge connected? null = unknown. */
  brokerConnected?: boolean | null;
  /** Feed-truth verdict for the symbol. */
  feedStatus: ExecHealthFeedStatus;
  /** Latest quote aligned with the latest candle? null = unknown. */
  quoteCandleAligned?: boolean | null;
  spread: ExecHealthSpread;
  /** A position exists with no matching broker ticket. null = unknown. */
  ghostPosition?: boolean | null;
  /** Account equity reconciled against the broker. null = unknown. */
  equityReconciled?: boolean | null;
  /** Market-data route healthy. null = unknown. */
  routeHealthy?: boolean | null;
}

export interface ExecutionHealthVerdict {
  /** False blocks EXECUTION. */
  executionAllowed: boolean;
  /** Analyze / watch is ALWAYS allowed regardless of execution health. */
  analyzeAllowed: true;
  blockers: string[];
  warnings: string[];
  reason: string;
}

/**
 * Compose a broker/feed execution-health verdict. Pure, block-execution-only.
 */
export function composeExecutionHealthGate(input: ExecutionHealthInput): ExecutionHealthVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // ── Broker connectivity + health severity. ─────────────────────────────────
  if (input.brokerConnected === false) {
    blockers.push("BROKER_DISCONNECTED");
    warnings.push("Broker bridge is disconnected — execution refused.");
  } else if (input.brokerConnected == null) {
    blockers.push("BROKER_STATUS_UNKNOWN");
    warnings.push("Broker connection is unconfirmed — execution refused (no fabricated health).");
  }
  if (input.brokerSeverity === "danger") {
    blockers.push("BROKER_HEALTH_DANGER");
    warnings.push("Broker health is in a danger state — execution refused.");
  } else if (input.brokerSeverity === "unknown") {
    blockers.push("BROKER_HEALTH_UNKNOWN");
    warnings.push("Broker health is unconfirmed — execution refused.");
  } else if (input.brokerSeverity === "warn") {
    warnings.push("Broker health is degraded — proceed with caution.");
  }

  // ── Feed truth — only a live feed is execution-grade. ──────────────────────
  switch (input.feedStatus) {
    case "live":
      break;
    case "delayed":
      blockers.push("FEED_DELAYED");
      warnings.push("Feed is delayed — execution refused until a confirmed live tick.");
      break;
    case "stale":
      blockers.push("FEED_STALE");
      warnings.push("Feed is stale — execution refused.");
      break;
    case "awaiting":
      blockers.push("FEED_AWAITING");
      warnings.push("Awaiting a confirmed live feed — execution refused.");
      break;
    case "simulator":
      blockers.push("FEED_SIMULATOR");
      warnings.push("Simulator data — execution refused (never trades simulator data).");
      break;
    case "unknown":
      blockers.push("FEED_UNKNOWN");
      warnings.push("Feed status is unconfirmed — execution refused.");
      break;
  }

  // ── Quote ↔ candle alignment. ──────────────────────────────────────────────
  if (input.quoteCandleAligned === false) {
    blockers.push("QUOTE_CANDLE_MISMATCH");
    warnings.push("Latest quote and candle disagree — execution refused until they reconcile.");
  } else if (input.quoteCandleAligned == null) {
    blockers.push("QUOTE_CANDLE_UNVERIFIED");
    warnings.push("Quote/candle alignment is unconfirmed — execution refused.");
  }

  // ── Spread regime. ─────────────────────────────────────────────────────────
  if (input.spread === "extreme") {
    blockers.push("SPREAD_EXTREME");
    warnings.push("Spread is extreme — execution refused.");
  } else if (input.spread === "wide") {
    warnings.push("Spread is wide — proceed with caution.");
  } else if (input.spread === "unknown") {
    warnings.push("Spread is unconfirmed — treat fill quality as unverified.");
  }

  // ── Ghost position / equity reconciliation / route health. ─────────────────
  if (input.ghostPosition === true) {
    blockers.push("GHOST_POSITION");
    warnings.push("A position with no matching broker ticket exists — execution refused until reconciled.");
  }
  if (input.equityReconciled === false) {
    blockers.push("EQUITY_MISMATCH");
    warnings.push("Account equity does not reconcile with the broker — execution refused.");
  } else if (input.equityReconciled == null) {
    warnings.push("Equity reconciliation is unconfirmed.");
  }
  if (input.routeHealthy === false) {
    blockers.push("ROUTE_UNHEALTHY");
    warnings.push("Market-data route is unhealthy — execution refused.");
  } else if (input.routeHealthy == null) {
    warnings.push("Market-data route health is unconfirmed.");
  }

  const executionAllowed = blockers.length === 0;
  return {
    executionAllowed,
    analyzeAllowed: true,
    blockers,
    warnings,
    reason: executionAllowed
      ? "Broker/feed health OK for execution."
      : `Execution health blocked: ${blockers.join(", ")}.`,
  };
}
