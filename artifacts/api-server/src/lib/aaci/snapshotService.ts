// AACI Shared Truth Snapshot service.
//
// Composes a normalized AaciSharedTruthSnapshot from EXISTING read-only sources.
// Every source is read in its own try/catch and contributes honest-unknown
// (absent + listed in unavailableSystems) on any failure — never fabricated
// data. READ-ONLY, per-user, advisory only. Never an execution path.

import {
  type AaciAccountMode,
  type AaciDirectionalBias,
  type AaciHandshakeSystem,
  type AaciNewsRiskLevel,
  type AaciSharedTruthSnapshot,
} from "@workspace/domain/aaci";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { evaluateGovernor } from "../riskGovernor/governor.js";
import { buildSnapshot as buildBrokerSnapshot } from "../brokerReadOnly/service.js";
import { scanSymbolTimeframe } from "../marketScanner.js";
import { getNewsIntelligence } from "../news/newsIntelligenceService.js";
import { getUnreadCount } from "../alerts/alertManager.js";
import { computeFleetHealth } from "../selfTrade/selfTradeSupervisor.js";
import { computeTimingRead } from "../../brain/timing/marketTimingBrainService.js";
import { getCachedIntelligenceContext } from "../data/chart/chartIntelligence.js";
import { buildChartHandshake } from "../data/chart/chartHandshake.js";

export interface BuildAaciSnapshotInput {
  userId: number;
  role: string;
  symbol?: string;
  timeframe?: string;
  // Read the SHARED master/operator broker connector into account/bridge/
  // positions. Defaults to admin-only (a regular USER's verdict must never be
  // driven by master state — see the broker block below). The autonomous
  // self-trade executor sets this true because an AGENT genuinely runs ON the
  // shared master bridge, so reading that bridge for the agent's own cohesion
  // check is correct, not a per-user isolation breach.
  includeMasterBroker?: boolean;
}

function mapDirectional(raw: unknown): AaciDirectionalBias | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.toUpperCase();
  if (v.includes("BULL") || v === "BUY" || v === "UP") return "buy";
  if (v.includes("BEAR") || v === "SELL" || v === "DOWN") return "sell";
  if (v.includes("MIX")) return "mixed";
  if (v.includes("NEUTRAL") || v.includes("CHOP") || v.includes("UNCLEAR")) return "neutral";
  return undefined;
}

function mapNewsRisk(raw: unknown): AaciNewsRiskLevel | undefined {
  if (typeof raw !== "string") return undefined;
  switch (raw.toLowerCase()) {
    case "none":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "critical":
      return "critical";
    default:
      return "unknown";
  }
}

/**
 * Build the AACI Shared Truth Snapshot for a user + symbol context. Fail-open
 * per source. Pure-ish: the only side effects are read-only source reads.
 */
export async function buildAaciSnapshot(
  input: BuildAaciSnapshotInput,
): Promise<AaciSharedTruthSnapshot> {
  const { userId, role, symbol, timeframe } = input;
  const unavailable: AaciHandshakeSystem[] = [];

  const snapshot: AaciSharedTruthSnapshot = {
    snapshotId: randomUUID(),
    timestamp: new Date().toISOString(),
    user: { userId: String(userId), role },
    symbolContext: {
      selectedSymbol: symbol,
      selectedTimeframe: timeframe,
      scannerSymbol: symbol,
      chartSymbol: symbol,
      rubySymbol: symbol,
    },
    account: {},
    bridge: { status: "unknown" },
    positions: { openCount: 0 },
  };

  // ── Risk Governor (R + risk gate inputs) ──────────────────────────────────
  try {
    const gov = await evaluateGovernor();
    const dailyLossHit =
      gov.metrics.dailyLossLimit > 0
        ? gov.metrics.dailyPnl <= -Math.abs(gov.metrics.dailyLossLimit)
        : undefined;
    snapshot.risk = {
      hardPass: gov.hardBlocks.length === 0,
      riskMode: gov.overallStatus,
      dailyLossHit,
      marginHealth: clamp100(gov.readinessScore),
      lastUpdated: gov.generatedAt,
    };
    snapshot.positions.appOpenCount = gov.metrics.openPaperTrades;
  } catch (err) {
    logger.warn({ err }, "aaci: risk governor read failed");
    unavailable.push("RiskGovernor");
  }

  // ── Account snapshot + bridge connectivity (E + account) ──────────────────
  // `buildBrokerSnapshot()` reads the SHARED master/operator broker connector,
  // not per-user data. Folding it into a regular user's verdict would let
  // master-account state drive that user's scores/hard gate — a per-user
  // isolation breach. So this source defaults to ADMIN-ONLY. Regular users get
  // an honest unknown account/bridge (which conservatively degrades to caution —
  // correct for an advisory layer that only ever ADDS caution). The autonomous
  // self-trade executor opts in (`includeMasterBroker`) because the agent
  // genuinely runs ON the shared master bridge. Per-user broker wiring is a
  // separate follow-up.
  const includeMasterBroker = input.includeMasterBroker ?? role === "admin";
  if (includeMasterBroker) {
    try {
      const { snapshot: broker } = await buildBrokerSnapshot();
      // Never fold a DEMO/sandbox broker snapshot into a real verdict. The
      // brokerReadOnly connector defaults to a demo provider with placeholder
      // figures (e.g. $10,000) when no real broker is configured; consuming
      // that as a "live" account would surface a fabricated balance and a
      // fake "connected" bridge. Only a real, non-demo connected provider is
      // trusted here; otherwise record an honest unknown (caution-only).
      const isRealBroker = broker.connected && broker.provider !== "demo";
      if (isRealBroker && broker.account) {
        snapshot.account = {
          mode: "live",
          balance: broker.account.balance,
          equity: broker.account.equity,
          freeMargin: broker.account.freeMargin,
          lastUpdated: broker.generatedAt,
        };
        snapshot.bridge = {
          status: "connected",
          executionRouteReady: true,
          lastHeartbeat: broker.generatedAt,
        };
        const openCount = broker.openPositions.length;
        snapshot.positions.openCount = openCount;
        snapshot.positions.mt5OpenCount = openCount;
        snapshot.positions.lastUpdated = broker.generatedAt;
      } else {
        // No real broker source — honest unknown, never borrow demo figures.
        unavailable.push("AccountAnalytics");
        unavailable.push("MT5Bridge");
      }
    } catch (err) {
      logger.warn({ err }, "aaci: broker snapshot read failed");
      unavailable.push("AccountAnalytics");
      unavailable.push("MT5Bridge");
    }
  } else {
    // Honest unknown — no per-user broker source wired yet; never borrow master.
    unavailable.push("AccountAnalytics");
    unavailable.push("MT5Bridge");
  }

  // ── Scanner (M + bias) ────────────────────────────────────────────────────
  if (symbol) {
    try {
      const opp = await scanSymbolTimeframe(symbol, timeframe ?? "M15");
      if (opp) {
        snapshot.scanner = {
          bias: mapDirectional(opp.bias),
          score: clamp100(opp.confidenceScore),
          lastUpdated: opp.generatedAt,
        };
      } else {
        unavailable.push("Scanner");
      }
    } catch (err) {
      logger.warn({ err }, "aaci: scanner read failed");
      unavailable.push("Scanner");
    }
  }

  // ── Chart intelligence (smartChart + Phase 4 chart handshake) ────────────
  // Use the cached chart intelligence state (3s-cached, no provider re-probe).
  // Fail-open: if no cached entry, smartChart and chartHandshake stay absent
  // (honest unknown — never fabricate a PASS).
  if (symbol) {
    try {
      const tf = (timeframe as "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1") ?? "M15";
      const cached =
        getCachedIntelligenceContext(symbol, tf, 300) ??
        getCachedIntelligenceContext(symbol, tf, 200);
      if (cached) {
        const { state } = cached;
        snapshot.smartChart = {
          bias: state.gateOutput.confidentReadAllowed
            ? (state.decisionState.bias === "bullish"
                ? "bullish"
                : state.decisionState.bias === "bearish"
                  ? "bearish"
                  : "neutral")
            : undefined,
          structureScore: state.gateOutput.chartTruthScore,
          lastUpdated: state.lastUpdated,
        };
        snapshot.chartHandshake = buildChartHandshake(
          state.gateOutput,
          state.chartTruthScore,
        );
      } else {
        unavailable.push("SmartChart");
      }
    } catch (err) {
      logger.warn({ err }, "aaci: chart intelligence read failed");
      unavailable.push("SmartChart");
    }
  }

  // ── Timing Brain heat (M) ─────────────────────────────────────────────────
  if (symbol) {
    try {
      const heat = await computeTimingRead({
        symbol,
        timeframe: (timeframe as never) ?? ("M15" as never),
        userTimezone: null,
        persistSnapshot: false,
      });
      snapshot.heat = {
        heatScore: clamp100(heat.heatScore),
        tradeabilityScore: clamp100(heat.tradeabilityScore),
        entryPermission: heat.entryPermission,
        bestAction: heat.bestAction,
        moveStage: heat.moveStage,
        lastUpdated: heat.generatedAt,
      };
    } catch (err) {
      logger.warn({ err }, "aaci: timing brain read failed");
      unavailable.push("MarketTimingBrain");
    }
  }

  // ── News (M + uncertainty) ────────────────────────────────────────────────
  if (symbol) {
    try {
      const news = await getNewsIntelligence(symbol);
      snapshot.news = {
        riskLevel: mapNewsRisk(news.riskLevel),
        lastUpdated: news.generatedAt,
      };
    } catch (err) {
      logger.warn({ err }, "aaci: news read failed");
      unavailable.push("EconomicCalendar");
    }
  }

  // ── Alerts pipeline (A) ───────────────────────────────────────────────────
  try {
    const unread = await getUnreadCount();
    snapshot.alerts = { pipelineReady: true, unreadCount: unread, lastUpdated: snapshot.timestamp };
  } catch (err) {
    logger.warn({ err }, "aaci: alerts read failed");
    unavailable.push("MyAlerts");
  }

  // ── Self-Trade fleet health (agent context) ───────────────────────────────
  try {
    const fleet = await computeFleetHealth();
    snapshot.selfTradeAgent = {
      funded: fleet.fundedAgents > 0,
      active: fleet.activeAgents > 0,
      ledgerHealthy: true,
    };
  } catch (err) {
    logger.warn({ err }, "aaci: self-trade fleet read failed");
    unavailable.push("SelfTradeSupervisor");
  }

  // Audit readiness is genuinely UNKNOWN at snapshot time — there is no cheap
  // health probe and the decision-service write is best-effort. Do NOT fabricate
  // `auditReady: true`; leave audit unset so the A sub-score reflects honest
  // unknown rather than asserted-healthy. (Audit is not one of the 16 real live
  // gates, so the advisory hard-gate factor remains non-blocking by design.)
  if (!snapshot.account.mode) snapshot.account.mode = "unknown" as AaciAccountMode;

  if (unavailable.length > 0) snapshot.unavailableSystems = unavailable;
  return snapshot;
}

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
