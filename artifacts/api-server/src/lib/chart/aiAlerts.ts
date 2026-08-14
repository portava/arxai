// Chart Brain v2 — Task 6: AI-aware chart alerts (SLOW BRAIN, read-only).
//
// Detects MEANINGFUL state transitions in the Chart Intelligence State and fires
// them through the EXISTING notification system (upsertAlertOnce — hourly-bucket
// deduped). When a condition CLEARS, the matching alert is auto-dismissed
// (dismissAlertsByType). Transitions covered:
//   • setup became ready / setup advanced from watchlist → active (triggered)
//   • retest holds (setup reached confirmation)
//   • setup went stale  /  setup invalidated  (split, distinct alerts)
//   • "no-trade" stand-aside cleared
//   • Risk-AI veto on / off
//   • agents fell into conflict  →  agents reached agreement
//   • feed went stale / unusable
//   • scalp flame ignited  /  entry went late (chasing)  /  entry timing cleaned up
//   • an OPEN position entered danger near its stop  /  reached its partial-TP zone
//   • user price-alert annotation crossings
//
// HARD RULES:
//  - strictly per-user (every read/write scoped by userId);
//  - NEVER places, modifies, or closes a trade — alerts are informational only;
//  - role-aware: EVERY trade-oriented alert is suppressed for INVESTOR; investors
//    only ever receive the non-trade "feed degraded" alert;
//  - fail-open: any storage error degrades to "no alerts" rather than throwing;
//  - transitions are detected by comparing against the per-user stored snapshot
//    in `chart_alert_state` — only a CHANGE fires, so a steady state is silent;
//  - flame & position signals are honest: a blind/insufficient flame read fires
//    nothing, and position danger/partial-TP only fire from a real open position.

import { db, chartAlertStateTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { upsertAlertOnce, dismissAlertsByType } from "../../routes/meAlerts.js";
import type { ChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import type { FlameStage, EntryTiming } from "../scalp/scalpTypes.js";
import {
  listActivePriceAlerts,
  markAnnotationTriggered,
  dismissAnnotation,
} from "./chartAnnotations.js";

export type ChartAlertRole = "USER" | "INVESTOR" | "ADMIN" | "OWNER";

// Lifecycle stage groupings (mirror computeSetupLifecycle stages).
const WATCHLIST_STAGES = new Set(["idea_forming", "watchlist"]);
const ACTIVE_STAGES = new Set(["trigger", "confirmation_needed", "entry_valid"]);
// Flame stages that represent live, still-tradeable momentum.
const FLAME_ALIVE = new Set<FlameStage>(["IGNITING", "ACTIVE", "RUN_ON"]);
const FLAME_FRESH = new Set<FlameStage>(["IGNITING", "ACTIVE"]);
const FLAME_OVEREXTENDED = new Set<FlameStage>(["STRETCH", "EXHAUSTED"]);
const TIMING_LATE = new Set<EntryTiming>(["LATE", "CHASING"]);
const TIMING_CLEAN = new Set<EntryTiming>(["CLEAN", "ACCEPTABLE"]);

// How close (as a fraction of the entry→SL / entry→TP band) price must get to
// the level before the open-position alert fires.
const DANGER_BAND_FRAC = 0.25; // within 25% of the stop (75% of the way there)
const PARTIAL_TP_BAND_FRAC = 0.25; // within 25% of the target

export interface ChartAlertOpenPosition {
  id: number | string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number | null;
  tp: number | null;
}

export interface ChartAlertSignals {
  flame?: { stage: FlameStage; entryTiming: EntryTiming; blind: boolean } | null;
  openPositions?: ChartAlertOpenPosition[];
}

interface AlertSnapshot {
  stage: string | null;
  actionability: string | null;
  vetoed: boolean;
  conflict: boolean;
  feedBad: boolean; // stale OR not aiUsable
  lastClose: number | null;
  flameStage: string | null;
  entryTiming: string | null;
}

export interface FiredAlert {
  alertType: string;
  severity: "info" | "warning" | "critical";
  title: string;
}

export interface ChartAlertScanResult {
  symbol: string;
  timeframe: string;
  fired: FiredAlert[];
  cleared: string[];
  evaluated: boolean;
}

function snapshotOf(
  state: ChartIntelligenceState,
  signals?: ChartAlertSignals,
): AlertSnapshot {
  const flame = signals?.flame && !signals.flame.blind ? signals.flame : null;
  return {
    stage: state.setupState?.stage ?? null,
    actionability: state.decisionState?.actionability ?? null,
    vetoed: !!state.decisionState?.vetoed,
    conflict: !!state.agentConsensus?.conflict,
    feedBad: !!state.stale || state.aiUsable === false,
    lastClose: state.candleStats?.lastClose ?? null,
    flameStage: flame ? flame.stage : null,
    entryTiming: flame ? flame.entryTiming : null,
  };
}

async function loadSnapshot(
  userId: number,
  symbol: string,
  timeframe: string,
): Promise<AlertSnapshot | null> {
  try {
    const rows = await db
      .select()
      .from(chartAlertStateTable)
      .where(
        and(
          eq(chartAlertStateTable.userId, userId),
          eq(chartAlertStateTable.symbol, symbol),
          eq(chartAlertStateTable.timeframe, timeframe),
        ),
      )
      .limit(1);
    const raw = rows[0]?.lastSnapshot;
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    const str = (k: string): string | null =>
      typeof s[k] === "string" ? (s[k] as string) : null;
    return {
      stage: str("stage"),
      actionability: str("actionability"),
      vetoed: s["vetoed"] === true,
      conflict: s["conflict"] === true,
      feedBad: s["feedBad"] === true,
      lastClose: typeof s["lastClose"] === "number" ? (s["lastClose"] as number) : null,
      flameStage: str("flameStage"),
      entryTiming: str("entryTiming"),
    };
  } catch (err) {
    logger.warn({ err, userId, symbol }, "aiAlerts.loadSnapshot failed");
    return null;
  }
}

async function saveSnapshot(
  userId: number,
  symbol: string,
  timeframe: string,
  snap: AlertSnapshot,
): Promise<void> {
  try {
    await db
      .insert(chartAlertStateTable)
      .values({ userId, symbol, timeframe, lastSnapshot: snap, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [
          chartAlertStateTable.userId,
          chartAlertStateTable.symbol,
          chartAlertStateTable.timeframe,
        ],
        set: { lastSnapshot: snap, updatedAt: new Date() },
      });
  } catch (err) {
    logger.warn({ err, userId, symbol }, "aiAlerts.saveSnapshot failed");
  }
}

/**
 * Scan one symbol's Chart Intelligence State for meaningful transitions and fire
 * / clear alerts accordingly. The caller supplies the freshly-built state, the
 * caller's effective role, and (optionally) honest flame + open-position signals.
 * Per-user scoped; fail-open; never trades.
 */
export async function scanChartAlerts(
  userId: number,
  role: ChartAlertRole,
  state: ChartIntelligenceState,
  signals?: ChartAlertSignals,
): Promise<ChartAlertScanResult> {
  const symbol = state.symbol;
  const timeframe = String(state.timeframe);
  const display = state.displaySymbol || symbol;
  const fired: FiredAlert[] = [];
  const cleared: string[] = [];

  const isInvestor = role === "INVESTOR";

  try {
    const now = snapshotOf(state, signals);
    const prev = await loadSnapshot(userId, symbol, timeframe);

    const fireKeyed = async (
      key: string,
      severity: "info" | "warning" | "critical",
      title: string,
      message: string,
    ): Promise<void> => {
      await upsertAlertOnce(userId, {
        alertType: key,
        severity,
        title,
        message,
        source: "chart_brain",
        actionLabel: "View chart",
        actionTarget: `/scanner?symbol=${encodeURIComponent(symbol)}`,
      });
      fired.push({ alertType: key, severity, title });
    };
    const clearKeyed = async (key: string): Promise<void> => {
      const n = await dismissAlertsByType(userId, [key]);
      if (n > 0) cleared.push(key);
    };
    const fire = (
      alertType: string,
      severity: "info" | "warning" | "critical",
      title: string,
      message: string,
    ) => fireKeyed(`${alertType}:${symbol}`, severity, title, message);
    const clear = (alertType: string) => clearKeyed(`${alertType}:${symbol}`);

    // ── 1. Setup became actionable (ready) — trade-oriented ──────────────────
    if (!isInvestor) {
      const becameReady =
        now.actionability === "ready" && prev?.actionability !== "ready";
      if (becameReady) {
        await fire(
          "chart_setup_ready",
          "info",
          `${display} setup is ready`,
          `The chart read on ${display} (${timeframe}) just moved to a ready state.`,
        );
      } else if (prev?.actionability === "ready" && now.actionability !== "ready") {
        await clear("chart_setup_ready");
      }
    }

    // ── 1b. Setup advanced from watchlist → active (triggered) ───────────────
    if (!isInvestor) {
      const nowActive = now.stage != null && ACTIVE_STAGES.has(now.stage);
      const prevActive = prev?.stage != null && ACTIVE_STAGES.has(prev.stage);
      const cameFromWatchlist =
        prev?.stage == null || WATCHLIST_STAGES.has(prev.stage);
      if (nowActive && !prevActive && cameFromWatchlist) {
        await fire(
          "chart_setup_active",
          "info",
          `${display} setup is now active`,
          `${display} (${timeframe}) advanced from watchlist to an active, triggered setup.`,
        );
      } else if (!nowActive && prevActive) {
        await clear("chart_setup_active");
      }
    }

    // ── 1c. Retest holds (setup reached confirmation) ────────────────────────
    if (!isInvestor) {
      const nowConfirm = now.stage === "confirmation_needed";
      const prevConfirm = prev?.stage === "confirmation_needed";
      if (nowConfirm && !prevConfirm) {
        await fire(
          "chart_retest_hold",
          "info",
          `${display} retest is holding`,
          `${display} (${timeframe}) is holding its level on the retest — confirmation forming.`,
        );
      } else if (!nowConfirm && prevConfirm) {
        await clear("chart_retest_hold");
      }
    }

    // ── 2. Setup went stale (distinct from invalid) ─────────────────────────
    if (!isInvestor) {
      const nowStale = now.stage === "stale";
      const prevStale = prev?.stage === "stale";
      if (nowStale && !prevStale) {
        await fire(
          "chart_setup_stale",
          "warning",
          `${display} setup went stale`,
          `The ${display} (${timeframe}) setup decayed — it is no longer fresh, stand aside.`,
        );
      } else if (!nowStale && prevStale) {
        await clear("chart_setup_stale");
      }

      // ── 2b. Setup invalidated (distinct, higher-severity) ──────────────────
      const nowInvalid = now.stage === "invalid";
      const prevInvalid = prev?.stage === "invalid";
      if (nowInvalid && !prevInvalid) {
        await fire(
          "chart_setup_invalid",
          "warning",
          `${display} setup invalidated`,
          `The ${display} (${timeframe}) setup was invalidated — the idea is no longer valid.`,
        );
      } else if (!nowInvalid && prevInvalid) {
        await clear("chart_setup_invalid");
      }
    }

    // ── 2c. "No-trade" stand-aside cleared ──────────────────────────────────
    if (!isInvestor) {
      const wasStandAside = prev?.actionability === "stand_aside";
      const nowClear =
        now.actionability != null && now.actionability !== "stand_aside";
      if (wasStandAside && nowClear) {
        await fire(
          "chart_no_trade_cleared",
          "info",
          `${display} no-trade cleared`,
          `${display} (${timeframe}) is no longer a stand-aside — the read is becoming actionable.`,
        );
      }
      // (no explicit clear: this is a momentary transition notice)
    }

    // ── 3. Risk veto turned on / off ────────────────────────────────────────
    if (!isInvestor) {
      if (now.vetoed && !prev?.vetoed) {
        await fire(
          "chart_risk_veto",
          "warning",
          `Risk veto on ${display}`,
          `Risk AI vetoed the ${display} (${timeframe}) read — do not trade it.`,
        );
      } else if (!now.vetoed && prev?.vetoed) {
        await clear("chart_risk_veto");
      }
    }

    // ── 4. Agents fell into conflict → reached agreement ────────────────────
    if (!isInvestor) {
      if (now.conflict && !prev?.conflict) {
        await fire(
          "chart_agent_conflict",
          "info",
          `Agents disagree on ${display}`,
          `Specialist agents are in genuine conflict on ${display} (${timeframe}).`,
        );
      } else if (!now.conflict && prev?.conflict) {
        await clear("chart_agent_conflict");
        await fire(
          "chart_agent_agreement",
          "info",
          `Agents now agree on ${display}`,
          `Specialist agents resolved their conflict on ${display} (${timeframe}).`,
        );
      }
    }

    // ── 5. Feed went stale / unusable — the ONLY investor-visible alert ──────
    if (now.feedBad && !prev?.feedBad) {
      await fire(
        "chart_feed_stale",
        "warning",
        `${display} feed degraded`,
        `The ${display} (${timeframe}) feed is stale or not AI-usable — reads are paused.`,
      );
    } else if (!now.feedBad && prev?.feedBad) {
      await clear("chart_feed_stale");
    }

    // ── 6. Scalp flame transitions (honest: only when a real flame read) ────
    if (!isInvestor && now.flameStage != null) {
      const nowStage = now.flameStage as FlameStage;
      const prevStage = (prev?.flameStage as FlameStage | null) ?? null;
      const nowTiming = (now.entryTiming as EntryTiming | null) ?? null;
      const prevTiming = (prev?.entryTiming as EntryTiming | null) ?? null;

      // 6a. Flame ignited — fresh momentum just started.
      const nowFresh = FLAME_FRESH.has(nowStage);
      const prevAlive = prevStage != null && FLAME_ALIVE.has(prevStage);
      if (nowFresh && !prevAlive) {
        await fire(
          "chart_scalp_flame",
          "info",
          `${display} momentum igniting`,
          `${display} (${timeframe}) just lit a fresh momentum run (scalp flame).`,
        );
      } else if (prevAlive && !FLAME_ALIVE.has(nowStage)) {
        await clear("chart_scalp_flame");
      }

      // 6b. Entry went late / chasing (over-extended or late timing).
      const nowLate =
        (nowTiming != null && TIMING_LATE.has(nowTiming)) ||
        FLAME_OVEREXTENDED.has(nowStage);
      const prevLate =
        (prevTiming != null && TIMING_LATE.has(prevTiming)) ||
        (prevStage != null && FLAME_OVEREXTENDED.has(prevStage));
      if (nowLate && !prevLate) {
        await fire(
          "chart_scalp_late",
          "warning",
          `${display} entry is late`,
          `${display} (${timeframe}) is over-extended / chasing — entering now is late.`,
        );
      } else if (!nowLate && prevLate) {
        await clear("chart_scalp_late");
      }

      // 6c. Entry timing cleaned up (was late/chasing → now clean).
      if (
        prevTiming != null &&
        TIMING_LATE.has(prevTiming) &&
        nowTiming != null &&
        TIMING_CLEAN.has(nowTiming)
      ) {
        await fire(
          "chart_entry_clean",
          "info",
          `${display} entry timing cleared`,
          `${display} (${timeframe}) pulled back — entry timing is clean again.`,
        );
      }
    }

    // ── 7. Open-position danger / partial-TP (honest: real positions only) ──
    const nowClose = now.lastClose;
    if (!isInvestor && nowClose != null && Array.isArray(signals?.openPositions)) {
      for (const pos of signals!.openPositions!) {
        const dangerKey = `chart_trade_danger:${symbol}:${pos.id}`;
        const tpKey = `chart_partial_tp:${symbol}:${pos.id}`;

        // Danger near stop: price has travelled most of the entry→SL band and is
        // on the losing side of entry.
        let inDanger = false;
        if (pos.sl != null) {
          const band = Math.abs(pos.entry - pos.sl);
          if (band > 0) {
            const distToSl = Math.abs(nowClose - pos.sl);
            const losing =
              pos.side === "BUY" ? nowClose < pos.entry : nowClose > pos.entry;
            inDanger = losing && distToSl <= band * DANGER_BAND_FRAC;
          }
        }
        if (inDanger) {
          await fireKeyed(
            dangerKey,
            "warning",
            `${display} position near stop`,
            `Your open ${pos.side} on ${display} is close to its stop-loss — review it.`,
          );
        } else {
          await clearKeyed(dangerKey);
        }

        // Partial-TP zone: price has travelled most of the entry→TP band on the
        // winning side.
        let inTpZone = false;
        if (pos.tp != null) {
          const band = Math.abs(pos.tp - pos.entry);
          if (band > 0) {
            const distToTp = Math.abs(nowClose - pos.tp);
            const winning =
              pos.side === "BUY" ? nowClose > pos.entry : nowClose < pos.entry;
            inTpZone = winning && distToTp <= band * PARTIAL_TP_BAND_FRAC;
          }
        }
        if (inTpZone) {
          await fireKeyed(
            tpKey,
            "info",
            `${display} near target`,
            `Your open ${pos.side} on ${display} is approaching its take-profit — consider a partial.`,
          );
        } else {
          await clearKeyed(tpKey);
        }
      }
    }

    // ── 8. User price-alert annotation crossings ────────────────────────────
    // Cross detection uses the previous stored close as the "before" price.
    // Expiry cleanup runs for every role (honest soft-delete), but a crossing
    // only ever FIRES for non-investors: the ONLY alert an investor receives is
    // the non-trade "feed degraded" notice (investors cannot set price alerts —
    // the chart command menu is fully suppressed for them).
    const prevClose = prev?.lastClose ?? null;
    if (nowClose !== null) {
      const priceAlerts = await listActivePriceAlerts(userId, symbol);
      const nowMs = Date.now();
      for (const a of priceAlerts) {
        // Expire annotations whose window has passed (honest soft-delete).
        if (a.expiresAt && a.expiresAt.getTime() < nowMs) {
          await dismissAnnotation(userId, a.id);
          continue;
        }
        // A price-alert crossing is never surfaced to an investor.
        if (isInvestor) continue;
        const crossedUp =
          a.direction === "above" &&
          prevClose !== null &&
          prevClose < a.price &&
          nowClose >= a.price;
        const crossedDown =
          a.direction === "below" &&
          prevClose !== null &&
          prevClose > a.price &&
          nowClose <= a.price;
        // First scan (no prevClose): fire only if already on the alerting side.
        const firstSideAbove =
          a.direction === "above" && prevClose === null && nowClose >= a.price;
        const firstSideBelow =
          a.direction === "below" && prevClose === null && nowClose <= a.price;
        if (crossedUp || crossedDown || firstSideAbove || firstSideBelow) {
          await upsertAlertOnce(userId, {
            alertType: `chart_price_alert:${a.id}`,
            severity: "info",
            title: `${display} ${a.direction} ${a.price}`,
            message:
              a.note && a.note.trim().length > 0
                ? a.note
                : `${display} crossed your ${a.direction} price alert at ${a.price}.`,
            source: "chart_brain",
            actionLabel: "View chart",
            actionTarget: `/scanner?symbol=${encodeURIComponent(symbol)}`,
          });
          await markAnnotationTriggered(userId, a.id);
          fired.push({
            alertType: `chart_price_alert:${a.id}`,
            severity: "info",
            title: `${display} ${a.direction} ${a.price}`,
          });
        }
      }
    }

    await saveSnapshot(userId, symbol, timeframe, now);
    return { symbol, timeframe, fired, cleared, evaluated: true };
  } catch (err) {
    logger.warn({ err, userId, symbol }, "scanChartAlerts failed (fail-open)");
    return { symbol, timeframe, fired, cleared, evaluated: false };
  }
}
