// Heat Alert Emitter — Phase 4.
//
// Maps MarketTimingRead state transitions to user notifications via fireNotify
// (user_notifications table — the same pipeline the /api/me/notifications
// endpoint serves and the Alerts dashboard reads).
//
// ADVISORY ONLY. Never an execution gate, never touches MT5 or live pipeline.
//
// Design invariants:
//   - One notification per (userId, alertType, symbolEntityId, hourly bucket).
//     Dedupe is handled by createNotification's UNIQUE conflict + repeatCount bump.
//   - Per-symbol isolation via a stable djb2 hash → entityId (never collides
//     across symbols for the same alert type).
//   - No alert is ever emitted for "unavailable" quality reads (honest absence).
//   - heat_conflict_with_open_trade is emitted only when the user has a live or
//     demo position open and the heat state is adversarial.
//   - Runs fire-and-forget (caller awaits void, no throw propagation).

import type { MarketTimingRead } from "@workspace/domain/timing-brain";
import { db, arxLivePositionsTable, userNotificationsTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { fireNotify } from "../notificationService.js";
import { logger } from "../logger.js";

// ── Alert type registry ───────────────────────────────────────────────────────
export const HEAT_ALERT_TYPES = [
  "heat_hot_market",
  "heat_danger_window",
  "heat_buy_pressure",
  "heat_sell_pressure",
  "heat_volatility_spike",
  "heat_low_liquidity",
  "heat_session_open",
  "heat_news_danger",
  "heat_wake_up",
  "heat_compression",
  "heat_missed_move",
  "heat_second_chance",
  "heat_institutional_flow_confirmed",
  "heat_institutional_flow_failed",
  "heat_broad_conflict",
  "heat_fakeout_trap",
  "heat_conflict_with_open_trade",
  "heat_too_hot",
  "heat_do_not_trade_yet",
] as const;

export type HeatAlertType = typeof HEAT_ALERT_TYPES[number];

// ── Stable per-symbol entity id (djb2 hash → positive int32) ─────────────────
// Ensures EURUSD and XAUUSD don't collapse into the same dedupe bucket for the
// same alert type within the same hour.
function symbolEntityId(symbol: string): number {
  let h = 5381;
  for (let i = 0; i < symbol.length; i++) {
    h = ((h << 5) + h) ^ symbol.charCodeAt(i);
  }
  return Math.abs(h) % 2_147_483_647;
}

// ── Descriptor shape ──────────────────────────────────────────────────────────
interface HeatAlertDescriptor {
  alertType: HeatAlertType;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  actionLabel?: string;
  actionTarget?: string;
  cooldownMs?: number;
}

// ── Per heat-state descriptors ────────────────────────────────────────────────

function buildDescriptors(
  read: MarketTimingRead,
  hasOpenTrade: boolean,
): HeatAlertDescriptor[] {
  const {
    symbol, heatState, heatScore, entryPermission, bestAction,
    moveStage, broadFlow, newsOverlay, trapProbability,
    dangerScore, edgeScore, buyPressure, sellPressure, session,
  } = read;
  const sym = symbol.toUpperCase();
  const descs: HeatAlertDescriptor[] = [];

  // ── 1. HOT MARKET  (heatScore ≥ 80, clean) ───────────────────────────────
  if (heatScore >= 80 && heatState === "CLEAN_MOMENTUM") {
    descs.push({
      alertType: "heat_hot_market",
      severity: "warning",
      title: `${sym} — Market is running hot`,
      message: `Heat score ${Math.round(heatScore)}/100 on ${sym}. Clean momentum with strong directional energy. High-conviction window — entries must match the direction.`,
      actionLabel: "Open scanner",
      actionTarget: `/scanner?symbol=${sym}`,
    });
  }

  // ── 2. DANGER WINDOW (dangerScore ≥ 70 or STAND_DOWN) ────────────────────
  if (dangerScore >= 70 || entryPermission === "STAND_DOWN") {
    descs.push({
      alertType: "heat_danger_window",
      severity: "critical",
      title: `${sym} — Danger window active`,
      message: `Danger score ${Math.round(dangerScore)}/100 on ${sym}. Conditions hostile — spread, trap risk, or structural breakdown active. ${entryPermission === "STAND_DOWN" ? "Stand down until conditions improve." : "Proceed with maximum caution."}`,
      actionLabel: "View heat map",
      actionTarget: "/market-heat-map",
      cooldownMs: 30 * 60_000,
    });
  }

  // ── 3. BUY PRESSURE ───────────────────────────────────────────────────────
  if (buyPressure >= 70 && buyPressure > sellPressure + 15) {
    descs.push({
      alertType: "heat_buy_pressure",
      severity: "info",
      title: `${sym} — Strong buy pressure`,
      message: `Buy pressure ${Math.round(buyPressure)}/100 vs sell ${Math.round(sellPressure)}/100 on ${sym}. Buyers dominating. Look for BUY setups on pullbacks — don't fight the flow.`,
      actionLabel: "Open scanner",
      actionTarget: `/scanner?symbol=${sym}`,
    });
  }

  // ── 4. SELL PRESSURE ──────────────────────────────────────────────────────
  if (sellPressure >= 70 && sellPressure > buyPressure + 15) {
    descs.push({
      alertType: "heat_sell_pressure",
      severity: "info",
      title: `${sym} — Strong sell pressure`,
      message: `Sell pressure ${Math.round(sellPressure)}/100 vs buy ${Math.round(buyPressure)}/100 on ${sym}. Sellers dominating. Look for SELL setups on bounces — don't fight the flow.`,
      actionLabel: "Open scanner",
      actionTarget: `/scanner?symbol=${sym}`,
    });
  }

  // ── 5. VOLATILITY SPIKE ───────────────────────────────────────────────────
  if (heatScore >= 75 && (heatState === "DIRTY_HEAT" || heatState === "NEWS_HEAT")) {
    descs.push({
      alertType: "heat_volatility_spike",
      severity: "warning",
      title: `${sym} — Volatility spike detected`,
      message: `${sym} heat state is ${heatState === "NEWS_HEAT" ? "news-driven" : "disorganised"} (heat ${Math.round(heatScore)}). Spreads may widen. Avoid market entries — wait for structure to re-establish.`,
    });
  }

  // ── 6. LOW LIQUIDITY / COMPRESSION (very quiet) ───────────────────────────
  if (heatState === "COMPRESSION" && heatScore < 35) {
    descs.push({
      alertType: "heat_low_liquidity",
      severity: "info",
      title: `${sym} — Low liquidity / compression`,
      message: `${sym} compressing with low heat (score ${Math.round(heatScore)}). Market coiling — expect chop until a breakout forms. No quality setups yet.`,
    });
  }

  // ── 7. SESSION / KILL ZONE OPEN ───────────────────────────────────────────
  if (session.isKillZoneActive && heatScore >= 50) {
    descs.push({
      alertType: "heat_session_open",
      severity: "info",
      title: `${sym} — Kill zone active (${session.sessionName})`,
      message: `${session.sessionName} kill zone live. Heat elevated on ${sym} (score ${Math.round(heatScore)}). Higher-probability setup window — stay disciplined.`,
      actionLabel: "View sessions",
      actionTarget: "/market-sessions",
      cooldownMs: 4 * 60 * 60_000,
    });
  }

  // ── 8. NEWS DANGER ────────────────────────────────────────────────────────
  if (newsOverlay.blocksTrade || newsOverlay.phase === "AT_EVENT" || newsOverlay.phase === "PRE_EVENT") {
    descs.push({
      alertType: "heat_news_danger",
      severity: newsOverlay.blocksTrade ? "critical" : "warning",
      title: `${sym} — News risk window`,
      message: `${sym} high-impact event ${newsOverlay.phase === "AT_EVENT" ? "active now" : "approaching"}${newsOverlay.eventName ? ` (${newsOverlay.eventName})` : ""}. Spreads may spike, fills may slip. ${newsOverlay.blocksTrade ? "Trading blocked by news filter." : "Extreme caution advised."}`,
      actionLabel: "View calendar",
      actionTarget: "/calendar",
      cooldownMs: 30 * 60_000,
    });
  }

  // ── 9. WAKE-UP / COMPRESSION BREAKOUT ────────────────────────────────────
  if (heatState === "WAKE_UP") {
    descs.push({
      alertType: "heat_wake_up",
      severity: "warning",
      title: `${sym} — Breaking out of compression`,
      message: `${sym} waking up — compression resolving into directional heat (score ${Math.round(heatScore)}). Early breakout window. Best action: ${bestAction.replace(/_/g, " ").toLowerCase()}. Manage fakeout risk.`,
      actionLabel: "Open scanner",
      actionTarget: `/scanner?symbol=${sym}`,
    });
  }

  // ── 10. COMPRESSION (quiet before storm, moderate heat) ───────────────────
  if (heatState === "COMPRESSION" && heatScore >= 30) {
    descs.push({
      alertType: "heat_compression",
      severity: "info",
      title: `${sym} — Compression forming`,
      message: `${sym} in compression (heat score ${Math.round(heatScore)}). Market coiling for a potential breakout. Mark your range levels and wait for the direction signal.`,
      actionLabel: "View heat map",
      actionTarget: "/market-heat-map",
      cooldownMs: 2 * 60 * 60_000,
    });
  }

  // ── 11. MISSED MOVE (exhausted) ───────────────────────────────────────────
  if (heatState === "EXHAUSTION_HEAT" && moveStage === "EXHAUSTED") {
    descs.push({
      alertType: "heat_missed_move",
      severity: "warning",
      title: `${sym} — Move is exhausted`,
      message: `${sym} showing exhaustion (heat ${Math.round(heatScore)}, stage EXHAUSTED). Chasing here carries high reversal risk. Wait for the next setup.`,
    });
  }

  // ── 12. SECOND CHANCE ─────────────────────────────────────────────────────
  if (moveStage === "DEVELOPING" && edgeScore >= 65 && entryPermission === "GO") {
    descs.push({
      alertType: "heat_second_chance",
      severity: "info",
      title: `${sym} — Second-chance entry window`,
      message: `${sym} still developing with edge score ${Math.round(edgeScore)}/100. Conditions remain supportive — potential second-chance entry if you missed the early move.`,
      actionLabel: "Open scanner",
      actionTarget: `/scanner?symbol=${sym}`,
    });
  }

  // ── 13. INSTITUTIONAL FLOW CONFIRMED ──────────────────────────────────────
  if (broadFlow.verdict === "ALIGNED" && heatScore >= 65) {
    descs.push({
      alertType: "heat_institutional_flow_confirmed",
      severity: "info",
      title: `${sym} — Broad flow aligned`,
      message: `${sym} broad flow ALIGNED — institutional pressure confirms direction (heat ${Math.round(heatScore)}). Higher-quality setup window. Look for entries matching the flow.`,
      actionLabel: "Open scanner",
      actionTarget: `/scanner?symbol=${sym}`,
    });
  }

  // ── 14. INSTITUTIONAL FLOW CONFLICTED / OPPOSING ─────────────────────────
  if (broadFlow.verdict === "CONFLICTED" || broadFlow.verdict === "OPPOSING") {
    descs.push({
      alertType: "heat_institutional_flow_failed",
      severity: "warning",
      title: `${sym} — Broad flow ${broadFlow.verdict.toLowerCase()}`,
      message: `${sym} broad flow is ${broadFlow.verdict} — opposing forces detected across timeframes. Lower-quality setup window. Reduce size or wait for alignment.`,
    });
  }

  // ── 15. BROAD CONFLICT (conflicted + high heat) ───────────────────────────
  if (broadFlow.verdict === "CONFLICTED" && heatScore >= 60) {
    descs.push({
      alertType: "heat_broad_conflict",
      severity: "warning",
      title: `${sym} — High heat with conflicted flow`,
      message: `${sym} has high heat (${Math.round(heatScore)}) but conflicted broad flow. Dangerous combination — price moving fast in uncertain direction. Wait for resolution.`,
    });
  }

  // ── 16. FAKEOUT / TRAP HIGH PROBABILITY ──────────────────────────────────
  if (trapProbability >= 65 || heatState === "TRAP_HEAT") {
    descs.push({
      alertType: "heat_fakeout_trap",
      severity: "warning",
      title: `${sym} — Trap / fakeout signal`,
      message: `Trap probability ${Math.round(trapProbability)}% on ${sym} (state: ${heatState}). False breakout or liquidity sweep may be in progress. Wait for confirmation.`,
    });
  }

  // ── 17. CONFLICT WITH OPEN TRADE ─────────────────────────────────────────
  // Emitted only when the user has an open position AND the market is hostile.
  if (hasOpenTrade && (dangerScore >= 60 || heatState === "TRAP_HEAT" || entryPermission === "STAND_DOWN")) {
    descs.push({
      alertType: "heat_conflict_with_open_trade",
      severity: "critical",
      title: `${sym} — Heat conflicts with your open trade`,
      message: `You have an open position on ${sym} but market heat conditions have turned adversarial (danger ${Math.round(dangerScore)}/100, state: ${heatState}). Review your position and consider your stop-loss.`,
      actionLabel: "View positions",
      actionTarget: "/mt5-setup",
      cooldownMs: 30 * 60_000,
    });
  }

  // ── 18. TOO HOT TO TOUCH ─────────────────────────────────────────────────
  if (heatScore >= 90 && heatState !== "CLEAN_MOMENTUM") {
    descs.push({
      alertType: "heat_too_hot",
      severity: "critical",
      title: `${sym} — Too hot to touch`,
      message: `${sym} heat is extreme (${Math.round(heatScore)}/100) but structure is ${heatState.toLowerCase().replace(/_/g, " ")}. Spread risk, slippage, and reversal all elevated. Stand down.`,
      cooldownMs: 30 * 60_000,
    });
  }

  // ── 19. DO NOT TRADE YET ─────────────────────────────────────────────────
  if (entryPermission === "WAIT_NEWS" || entryPermission === "WAIT_FOR_ENTRY") {
    descs.push({
      alertType: "heat_do_not_trade_yet",
      severity: "info",
      title: `${sym} — Not ready to trade yet`,
      message: `${sym} entry permission is "${entryPermission.replace(/_/g, " ").toLowerCase()}". ${bestAction === "WAIT_FOR_NEWS" ? "Wait for the news event to pass." : "Wait for price to reach your entry zone."}`,
      actionLabel: "View heat map",
      actionTarget: "/market-heat-map",
    });
  }

  return descs;
}

// ── Open LIVE position check (symbol-scoped) ──────────────────────────────────
// Only checks live positions because mt5_demo_commands has no symbol column.
// Demo path is intentionally omitted: a demo command with no symbol FK cannot
// reliably be scoped to the current read's symbol, so we never fire a critical
// "conflict with open trade" alert on a false-positive basis.

async function hasOpenLivePosition(userId: number, symbol: string): Promise<boolean> {
  const sym = symbol.toUpperCase();
  const rows = await db
    .select({ id: arxLivePositionsTable.id })
    .from(arxLivePositionsTable)
    .where(
      and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, sym),
        isNull(arxLivePositionsTable.closedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ── Resolve-on-clear: which alert types are stale for this read ───────────────
// When a condition is no longer present, auto-mark matching UNREAD notifications
// as "read". Respects user-dismissed rows (only transitions "unread" → "read").
// Never fabricates a resolve — conditions must be positively absent, not just
// not triggered in this read.

function resolvedAlertTypes(read: MarketTimingRead): HeatAlertType[] {
  const cleared: HeatAlertType[] = [];
  if (read.dangerScore < 50 && read.entryPermission !== "STAND_DOWN") {
    cleared.push("heat_danger_window");
  }
  if (!read.newsOverlay.blocksTrade && read.newsOverlay.phase === "SETTLED") {
    cleared.push("heat_news_danger", "heat_do_not_trade_yet");
  }
  if (read.heatState !== "EXHAUSTION_HEAT") {
    cleared.push("heat_missed_move");
  }
  if (read.heatState !== "COMPRESSION") {
    cleared.push("heat_low_liquidity", "heat_compression");
  }
  if (read.trapProbability < 40 && read.heatState !== "TRAP_HEAT") {
    cleared.push("heat_fakeout_trap");
  }
  if (read.heatScore < 80 || read.heatState !== "CLEAN_MOMENTUM") {
    cleared.push("heat_hot_market");
  }
  if (read.broadFlow.verdict !== "CONFLICTED" && read.broadFlow.verdict !== "OPPOSING") {
    cleared.push("heat_broad_conflict", "heat_institutional_flow_failed");
  }
  return cleared;
}

async function resolveStaleHeatAlerts(userId: number, symbol: string, read: MarketTimingRead): Promise<void> {
  const toResolve = resolvedAlertTypes(read);
  if (toResolve.length === 0) return;
  const eId = symbolEntityId(symbol);
  await db.update(userNotificationsTable)
    .set({ status: "read", updatedAt: new Date() })
    .where(
      and(
        eq(userNotificationsTable.userId, userId),
        inArray(userNotificationsTable.notificationType, toResolve as string[]),
        eq(userNotificationsTable.entityType, "symbol"),
        eq(userNotificationsTable.entityId, eId),
        eq(userNotificationsTable.status, "unread"),
      ),
    );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Emit heat alerts for a user based on the latest MarketTimingRead.
 * Writes to user_notifications (the same table /api/me/notifications serves).
 * Fire-and-forget: caller should not await the returned promise.
 * Skips emission entirely when data quality is "unavailable".
 */
export async function emitHeatAlerts(userId: number, read: MarketTimingRead): Promise<void> {
  if (read.dataQuality.label === "unavailable") return;

  try {
    const openLive = await hasOpenLivePosition(userId, read.symbol).catch(() => false);
    const descriptors = buildDescriptors(read, openLive);
    const eId = symbolEntityId(read.symbol);

    for (const d of descriptors) {
      fireNotify(userId, {
        notificationType: d.alertType,
        severity: d.severity,
        title: d.title,
        message: d.message,
        source: "ai",
        entityType: "symbol",
        entityId: eId,
        actionLabel: d.actionLabel ?? null,
        actionTarget: d.actionTarget ?? null,
        cooldownMs: d.cooldownMs ?? 60 * 60_000,
      });
    }

    // Resolve (mark read) notifications whose conditions have positively cleared.
    await resolveStaleHeatAlerts(userId, read.symbol, read);
  } catch (err) {
    logger.warn({ err: String(err), userId, symbol: read.symbol }, "heatAlertEmitter: non-fatal error");
  }
}
