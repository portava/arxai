// ── ARX Handshake System — read-only layer readiness adapters ───────────────
//
// Each adapter READS one existing subsystem and maps its state to the shared
// per-layer readiness vocabulary (PASS / WARN / FAIL / SKIPPED / NOT_AVAILABLE).
// INVIOLABLE:
// - READ-ONLY. No mutation, no dispatch, no order placement.
// - HONEST. On any read failure or missing signal the verdict is NOT_AVAILABLE
//   (or WARN for stale) — never a fabricated PASS, never sim/mock data.
// - ADVISORY. These feed the coordinator's advisory verdict only; they are not
//   a gate, not part of the 16-gate live pipeline, and never block execution.
// - ISOLATED. The investor-scoped adapter reads ONLY the supplied investor's
//   rows and exposes readiness booleans/counts only — never balances, the ARX
//   60/40 waterfall, trader comp, or another tenant's data.

import { db } from "@workspace/db";
import {
  fundDiscrepanciesTable,
  fundControlFreezesTable,
  globalTradingSettingsTable,
  brokerHealthStateTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type {
  HandshakeContext,
  HandshakeLayerKey,
  HandshakeLayerStatus,
} from "@workspace/domain/handshake";
import { getProviderHealthSnapshot } from "../data/providerHealth.js";
import { getNewsIntelligence } from "../news/newsIntelligenceService.js";
import { scannerStatus } from "../marketScanner.js";
import { getMarketStatus } from "../assistant/marketProvider.js";
import { buildChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import { listSymbolsForUser } from "../mt5/symbolDirectory.js";

export interface LayerReadiness {
  status: HandshakeLayerStatus;
  // Operator-facing detail (never user-facing copy). Short, no secrets.
  detail: string;
  // Age of the underlying signal in ms when known (null = not time-based).
  ageMs: number | null;
}

export type LayerAdapter = (ctx?: HandshakeContext) => Promise<LayerReadiness>;

// Freshness windows (coarse, advisory). Distinct from the authoritative 15s
// dispatch heartbeat gate — these only colour the handshake monitor.
const BROKER_STALE_MS = 120_000;
const SCANNER_STALE_MS = 120_000;

function notAvailable(detail: string): LayerReadiness {
  return { status: "NOT_AVAILABLE", detail, ageMs: null };
}

// ── MARKET_DATA — provider chain health (read-only snapshot) ─────────────────
const marketDataAdapter: LayerAdapter = async () => {
  try {
    const snap = await getProviderHealthSnapshot();
    const { healthy, degraded, failing } = snap.summary;
    if (healthy === 0) {
      return notAvailable(`no healthy provider (degraded=${degraded}, failing=${failing})`);
    }
    if (degraded > 0 || failing > 0) {
      return { status: "WARN", detail: `healthy=${healthy}, degraded=${degraded}, failing=${failing}`, ageMs: null };
    }
    return { status: "PASS", detail: `healthy=${healthy}`, ageMs: null };
  } catch {
    return notAvailable("provider health read failed");
  }
};

// ── BROKER_BRIDGE — broker_health_state singleton (read-only) ────────────────
const brokerBridgeAdapter: LayerAdapter = async () => {
  try {
    const [row] = await db.select().from(brokerHealthStateTable).limit(1);
    if (!row) return notAvailable("no broker health state");
    if (row.maintenanceMode) {
      return { status: "WARN", detail: "maintenance mode", ageMs: null };
    }
    const ageMs = row.lastEvaluatedAt ? Date.now() - new Date(row.lastEvaluatedAt).getTime() : null;
    if (row.lastStatus !== "CONNECTED") {
      return { status: "FAIL", detail: `status=${row.lastStatus}`, ageMs };
    }
    if (ageMs != null && ageMs > BROKER_STALE_MS) {
      return { status: "WARN", detail: `evaluated ${Math.round(ageMs / 1000)}s ago`, ageMs };
    }
    return { status: "PASS", detail: "connected", ageMs };
  } catch {
    return notAvailable("broker health read failed");
  }
};

// ── NEWS — news intelligence provider connectivity (read-only) ──────────────
const newsAdapter: LayerAdapter = async () => {
  try {
    // Representative symbol — we only read the provider connectivity flag.
    const pack = await getNewsIntelligence("EURUSD");
    const connected = pack.dataSources.headlines.connected;
    if (!connected) {
      return notAvailable(`headlines provider disconnected (${pack.dataSources.headlines.provider})`);
    }
    return { status: "PASS", detail: `headlines via ${pack.dataSources.headlines.provider}`, ageMs: null };
  } catch {
    return notAvailable("news read failed");
  }
};

// ── SCANNER — scanner running state + last-scan freshness (read-only) ────────
const scannerAdapter: LayerAdapter = async () => {
  try {
    const s = scannerStatus();
    const ageMs = s.lastScanAt ? Date.now() - new Date(s.lastScanAt).getTime() : null;
    if (!s.lastScanAt) {
      return { status: "WARN", detail: "no scan recorded yet", ageMs: null };
    }
    if (ageMs != null && ageMs > SCANNER_STALE_MS) {
      return { status: "WARN", detail: `last scan ${Math.round(ageMs / 1000)}s ago`, ageMs };
    }
    return {
      status: s.running ? "PASS" : "WARN",
      detail: s.running ? `running, ${s.opportunityCount} opportunities` : "idle (last scan fresh)",
      ageMs,
    };
  } catch {
    return notAvailable("scanner status read failed");
  }
};

// ── INVESTOR_FUND_BOOK — open critical discrepancies + active freezes ────────
// Per-investor ISOLATED: with an investor context, reads ONLY that investor's
// rows. Without it (system/admin monitor view) reads the fund-wide rollup.
// Returns readiness only — never balances or the ARX waterfall.
const investorFundBookAdapter: LayerAdapter = async (ctx) => {
  try {
    const investorUserId = ctx?.investorUserId ?? null;

    const discWhere =
      investorUserId != null
        ? and(
            eq(fundDiscrepanciesTable.status, "OPEN"),
            eq(fundDiscrepanciesTable.severity, "CRITICAL"),
            eq(fundDiscrepanciesTable.userId, investorUserId),
          )
        : and(eq(fundDiscrepanciesTable.status, "OPEN"), eq(fundDiscrepanciesTable.severity, "CRITICAL"));
    const [discRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fundDiscrepanciesTable)
      .where(discWhere);
    const openCritical = discRow?.n ?? 0;
    const scopeLabel = investorUserId != null ? "investor" : "fund-wide";
    if (openCritical > 0) {
      return { status: "FAIL", detail: `${openCritical} open CRITICAL discrepancy(ies) [${scopeLabel}]`, ageMs: null };
    }

    const freezeWhere =
      investorUserId != null
        ? and(eq(fundControlFreezesTable.active, true), eq(fundControlFreezesTable.scopeKey, String(investorUserId)))
        : eq(fundControlFreezesTable.active, true);
    const [freezeRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fundControlFreezesTable)
      .where(freezeWhere);
    const activeFreezes = freezeRow?.n ?? 0;
    if (activeFreezes > 0) {
      return { status: "WARN", detail: `${activeFreezes} active fund freeze(s) [${scopeLabel}]`, ageMs: null };
    }
    return { status: "PASS", detail: `no open critical discrepancy or freeze [${scopeLabel}]`, ageMs: null };
  } catch {
    return notAvailable("fund book read failed");
  }
};

// ── ADMIN_CONTROL — global settings singleton present + platform mode ────────
const adminControlAdapter: LayerAdapter = async () => {
  try {
    const [row] = await db
      .select({ platformMode: globalTradingSettingsTable.platformMode })
      .from(globalTradingSettingsTable)
      .where(eq(globalTradingSettingsTable.id, 1));
    if (!row) return notAvailable("global settings singleton missing");
    return { status: "PASS", detail: `platformMode=${row.platformMode}`, ageMs: null };
  } catch {
    return notAvailable("admin control read failed");
  }
};

// ── KILL_SWITCH — emergency stop state (advisory awareness only) ─────────────
// The real kill switch remains authoritative and independent; this only colours
// the handshake verdict so the monitor reflects the engaged state.
const killSwitchAdapter: LayerAdapter = async () => {
  try {
    const [row] = await db
      .select({ engaged: globalTradingSettingsTable.emergencyKillSwitch })
      .from(globalTradingSettingsTable)
      .where(eq(globalTradingSettingsTable.id, 1));
    if (!row) return notAvailable("global settings singleton missing");
    if (row.engaged) {
      return { status: "FAIL", detail: "emergency kill switch engaged", ageMs: null };
    }
    return { status: "PASS", detail: "kill switch clear", ageMs: null };
  } catch {
    return notAvailable("kill switch read failed");
  }
};

// Per-user layers report SKIPPED (not NOT_AVAILABLE) when there is no user
// context — the system/admin monitor view legitimately has nothing to read, and
// SKIPPED keeps it from showing a perpetual WAITING_FOR_DATA.
function skippedNoUser(): LayerReadiness {
  return { status: "SKIPPED", detail: "no user context", ageMs: null };
}

// ── RUBY_EXPLANATION — assistant market provider connectivity + freshness ────
// Read-only: Ruby's explanations lean on the assistant market provider. PASS
// only when a real provider is connected AND its last successful fetch is fresh;
// stale/error degrades to WARN; nothing configured/connected is NOT_AVAILABLE.
const rubyExplanationAdapter: LayerAdapter = async () => {
  try {
    const s = getMarketStatus();
    if (!s.configured) return notAvailable("no market data provider configured");
    if (!s.connected) return notAvailable(`provider ${s.provider} not connected`);
    const ageMs = s.lastSuccessfulFetchAt
      ? Date.now() - new Date(s.lastSuccessfulFetchAt).getTime()
      : null;
    if (s.freshnessState !== "FRESH") {
      return { status: "WARN", detail: `freshness=${s.freshnessState}`, ageMs };
    }
    return { status: "PASS", detail: `fresh via ${s.provider}`, ageMs };
  } catch {
    return notAvailable("assistant market status read failed");
  }
};

// ── CHART_OVERLAY — chart intelligence feed usability (read-only) ────────────
// Reads the cached chart-intelligence truth for a representative symbol. PASS
// only when the feed is AI-usable and not stale; otherwise WARN (the overlay
// still renders honestly, just with reduced confidence).
const chartOverlayAdapter: LayerAdapter = async () => {
  try {
    const state = await buildChartIntelligenceState("EURUSD", "M5", 150);
    if (state.stale) {
      return { status: "WARN", detail: "chart feed stale", ageMs: null };
    }
    if (!state.aiUsable) {
      return { status: "WARN", detail: `feed not AI-usable (quality ${state.decisionState.quality})`, ageMs: null };
    }
    return { status: "PASS", detail: `AI-usable (quality ${state.decisionState.quality})`, ageMs: null };
  } catch {
    return notAvailable("chart intelligence read failed");
  }
};

// ── RISK_PREVIEW — execution/cost preview input readiness (per-user) ─────────
// The risk/cost preview's dominant input is a fresh live quote. Per-user scoped
// so it only runs with a real user context; the broker symbol directory adds an
// honest WARN when broker specs aren't reported yet (estimate degrades).
const riskPreviewAdapter: LayerAdapter = async (ctx) => {
  const userId = ctx?.userId ?? null;
  if (userId == null) return skippedNoUser();
  try {
    const s = getMarketStatus();
    if (!s.configured) return notAvailable("no market data provider configured");
    if (!s.connected) return notAvailable(`provider ${s.provider} not connected`);
    const ageMs = s.lastSuccessfulFetchAt
      ? Date.now() - new Date(s.lastSuccessfulFetchAt).getTime()
      : null;
    if (s.freshnessState !== "FRESH") {
      return { status: "WARN", detail: `quote freshness=${s.freshnessState}`, ageMs };
    }
    const tradable = await listSymbolsForUser(userId, { tradableOnly: true });
    if (tradable.length === 0) {
      return { status: "WARN", detail: "no broker specs yet — estimate degrades", ageMs };
    }
    return { status: "PASS", detail: `fresh quote + ${tradable.length} tradable spec(s)`, ageMs };
  } catch {
    return notAvailable("risk preview input read failed");
  }
};

// ── TRADE_MODAL_PREFILL — broker symbol directory readiness (per-user) ───────
// The trade ticket prefills from the per-user broker symbol directory. PASS when
// the user has at least one tradable symbol; WARN when only stale/non-tradable
// entries exist; NOT_AVAILABLE when the EA has reported nothing yet.
const tradeModalPrefillAdapter: LayerAdapter = async (ctx) => {
  const userId = ctx?.userId ?? null;
  if (userId == null) return skippedNoUser();
  try {
    const views = await listSymbolsForUser(userId);
    if (views.length === 0) {
      return notAvailable("no broker symbols reported for user yet");
    }
    const tradable = views.filter((v) => v.tradable === true).length;
    if (tradable === 0) {
      return { status: "WARN", detail: `${views.length} symbol(s), none tradable`, ageMs: null };
    }
    return { status: "PASS", detail: `${tradable} tradable symbol(s)`, ageMs: null };
  } catch {
    return notAvailable("symbol directory read failed");
  }
};

export const LAYER_ADAPTERS: Record<HandshakeLayerKey, LayerAdapter> = {
  MARKET_DATA: marketDataAdapter,
  BROKER_BRIDGE: brokerBridgeAdapter,
  NEWS: newsAdapter,
  SCANNER: scannerAdapter,
  INVESTOR_FUND_BOOK: investorFundBookAdapter,
  ADMIN_CONTROL: adminControlAdapter,
  KILL_SWITCH: killSwitchAdapter,
  RUBY_EXPLANATION: rubyExplanationAdapter,
  CHART_OVERLAY: chartOverlayAdapter,
  RISK_PREVIEW: riskPreviewAdapter,
  TRADE_MODAL_PREFILL: tradeModalPrefillAdapter,
};
