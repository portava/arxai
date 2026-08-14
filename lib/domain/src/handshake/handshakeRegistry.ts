// ── ARX Handshake System — registry (pure) ──────────────────────────────────
//
// Declares which layers each handshake type depends on, whether each layer is
// required, and whether the handshake is implemented (has real adapters) or is
// a planned scaffold for a downstream phase. No IO.

import {
  EXECUTION_CRITICAL_HANDSHAKE_TYPES,
  INVESTOR_SCOPED_HANDSHAKE_TYPES,
  type HandshakeLayerKey,
  type HandshakePermissions,
  type HandshakeType,
} from "./handshake.types";

export interface HandshakeLayerRequirement {
  layer: HandshakeLayerKey;
  required: boolean;
}

export interface HandshakeDefinition {
  type: HandshakeType;
  // Operator-facing label (admin monitor). Not user-facing trading copy.
  label: string;
  // Layers this handshake aggregates.
  layers: HandshakeLayerRequirement[];
  // False = planned scaffold for a downstream phase (no adapters yet → UNKNOWN).
  implemented: boolean;
}

export const HANDSHAKE_DEFINITIONS: Record<HandshakeType, HandshakeDefinition> = {
  MARKET_DATA: {
    type: "MARKET_DATA",
    label: "Market Data Readiness",
    layers: [{ layer: "MARKET_DATA", required: true }],
    implemented: true,
  },
  BROKER_BRIDGE: {
    type: "BROKER_BRIDGE",
    label: "Broker / Bridge Readiness",
    layers: [
      { layer: "BROKER_BRIDGE", required: true },
      { layer: "KILL_SWITCH", required: true },
    ],
    implemented: true,
  },
  NEWS: {
    type: "NEWS",
    label: "News Intelligence Readiness",
    layers: [{ layer: "NEWS", required: true }],
    implemented: true,
  },
  INVESTOR_VALUE: {
    type: "INVESTOR_VALUE",
    label: "Investor Value Readiness",
    layers: [
      { layer: "INVESTOR_FUND_BOOK", required: true },
      { layer: "MARKET_DATA", required: false },
    ],
    implemented: true,
  },
  WEEKLY_REPORT: {
    type: "WEEKLY_REPORT",
    label: "Weekly Report Readiness",
    layers: [{ layer: "INVESTOR_FUND_BOOK", required: true }],
    implemented: true,
  },
  ADMIN_FUND_CONTROL: {
    type: "ADMIN_FUND_CONTROL",
    label: "Admin Fund Control Readiness",
    layers: [
      { layer: "INVESTOR_FUND_BOOK", required: true },
      { layer: "ADMIN_CONTROL", required: true },
    ],
    implemented: true,
  },

  // ── Signal Intelligence Core (Task #194) — Ruby Market Edge ──
  SIGNAL_INTELLIGENCE: {
    type: "SIGNAL_INTELLIGENCE",
    label: "Signal Intelligence Readiness",
    layers: [
      { layer: "MARKET_DATA", required: true },
      { layer: "SCANNER", required: true },
    ],
    implemented: true,
  },

  // ── Scanner Explanation (Task #195) — Ruby Market Read explanation engine ──
  SCANNER_EXPLANATION: {
    type: "SCANNER_EXPLANATION",
    label: "Scanner Explanation Readiness",
    layers: [
      { layer: "MARKET_DATA", required: true },
      { layer: "SCANNER", required: true },
      { layer: "RUBY_EXPLANATION", required: false },
    ],
    implemented: true,
  },
  // ── Execution Cost & Survivability (Task #196) — pre-trade economics ──
  // Advisory-only readiness. Reuses the existing layer adapters: market data
  // (spread/ATR), the broker bridge (per-user symbol spec truth), and the
  // kill switch (suppress the estimate when trading is halted). Touches no
  // safety surface and is never an execution gate.
  EXECUTION_COST: {
    type: "EXECUTION_COST",
    label: "Execution Cost Readiness",
    layers: [
      { layer: "MARKET_DATA", required: true },
      { layer: "BROKER_BRIDGE", required: true },
      { layer: "KILL_SWITCH", required: true },
    ],
    implemented: true,
  },
  // ── News Radar & Smart Chart Layers (Task #197) — Market Impact Radar ──
  // Advisory-only visual readiness for the Smart Chart overlays + the Market
  // Impact Radar. Reuses the news layer (provider connection + economic
  // calendar) and the scanner layer (the signal that drives the drawn zones).
  // Never an execution gate.
  NEWS_RADAR: {
    type: "NEWS_RADAR",
    label: "News Radar Readiness",
    layers: [
      { layer: "NEWS", required: true },
      { layer: "SCANNER", required: false },
    ],
    implemented: true,
  },
  TRADE_HEALTH: {
    type: "TRADE_HEALTH",
    label: "Trade Health Readiness",
    layers: [
      { layer: "BROKER_BRIDGE", required: true },
      { layer: "MARKET_DATA", required: true },
      { layer: "SCANNER", required: false },
    ],
    implemented: true,
  },

  // ── Smart Chart Overlay (named surface) — Market Impact Radar + chart draw ──
  // Advisory readiness for the chart overlay drawing surface. Reuses the chart
  // overlay data source (chart intelligence / radar) plus market data; news and
  // scanner enrich the overlay but are optional. Never an execution gate.
  SMART_CHART_OVERLAY: {
    type: "SMART_CHART_OVERLAY",
    label: "Smart Chart Overlay Readiness",
    layers: [
      { layer: "MARKET_DATA", required: true },
      { layer: "CHART_OVERLAY", required: true },
      { layer: "NEWS", required: false },
      { layer: "SCANNER", required: false },
    ],
    implemented: true,
  },

  // ── Trade Preview (named surface) — pre-trade ticket readiness ──
  // Advisory readiness for the trade ticket prefill + economics preview. The
  // per-user layers (RISK_PREVIEW, TRADE_MODAL_PREFILL) report SKIPPED without a
  // user context (system/admin monitor view). EXECUTION-CRITICAL: a BLOCKED
  // verdict is only a surfaced hint — the 16-gate live pipeline is the authority.
  TRADE_PREVIEW: {
    type: "TRADE_PREVIEW",
    label: "Trade Preview Readiness",
    layers: [
      { layer: "MARKET_DATA", required: true },
      { layer: "BROKER_BRIDGE", required: true },
      { layer: "KILL_SWITCH", required: true },
      { layer: "RISK_PREVIEW", required: true },
      { layer: "TRADE_MODAL_PREFILL", required: true },
    ],
    implemented: true,
  },

  // ── Ruby Execution (named surface) — Ruby's pre-execution readiness view ──
  // Advisory readiness Ruby surfaces before an execution-critical action. The
  // per-user RISK_PREVIEW layer is optional context. EXECUTION-CRITICAL: a
  // BLOCKED verdict is advisory only; Ruby is read-only and CANNOT place a trade,
  // and the 16-gate live pipeline remains the sole authority.
  RUBY_EXECUTION: {
    type: "RUBY_EXECUTION",
    label: "Ruby Execution Readiness",
    layers: [
      { layer: "MARKET_DATA", required: true },
      { layer: "BROKER_BRIDGE", required: true },
      { layer: "KILL_SWITCH", required: true },
      { layer: "RISK_PREVIEW", required: false },
    ],
    implemented: true,
  },
};

// Advisory capability descriptor per handshake type. Purely informational — it
// describes WHAT KIND of surface the handshake informs (admin-only, investor-
// scoped, execution-critical). It NEVER grants or denies anything; authority
// stays with the real role checks and the 16-gate live pipeline.
export function getHandshakePermissions(type: HandshakeType): HandshakePermissions {
  return {
    adminOnly: type === "ADMIN_FUND_CONTROL",
    investorScoped: INVESTOR_SCOPED_HANDSHAKE_TYPES.includes(type),
    executionCritical: EXECUTION_CRITICAL_HANDSHAKE_TYPES.includes(type),
  };
}

export function getHandshakeDefinition(type: HandshakeType): HandshakeDefinition {
  return HANDSHAKE_DEFINITIONS[type];
}

export function listImplementedHandshakeTypes(): HandshakeType[] {
  return (Object.keys(HANDSHAKE_DEFINITIONS) as HandshakeType[]).filter(
    (t) => HANDSHAKE_DEFINITIONS[t].implemented,
  );
}
