// Capability #46 — the broker-native escape route (pure projection).
//
// The promise this surface makes: if ARX disappeared right now, the user can
// reach their money at the broker directly. Everything identity-shaped on the
// page comes from REAL reported connection state; a field with no honest
// source is null with a reason in `unavailable` — the walkthrough never
// pretends to know a server name or account number it was not told.
//
// The PROCEDURE text is instructional content (how to open the broker's own
// terminal), not data — it is the one part that may be static. It is written
// venue-generically for MT5 and parameterized with real values only when they
// exist.
//
// PURE: no DB, no clock beyond injected `now`. The route supplies rows.

import { maskAccountIdentifier, HEARTBEAT_STALE_SECONDS } from "./connectionCard.js";

export interface EscapeRouteConnectionInput {
  connectionId: number;
  connectionName: string | null;
  brokerName: string | null;
  serverName: string | null;
  accountNumber: string | null;
  accountCurrency: string | null;
  mode: string | null;          // DEMO | LIVE | MOCK | null
  accountType: string | null;
  lastHeartbeat: Date | null;
  lastPositionsSnapshotAt: Date | null;
}

export interface EscapeRoutePositionInput {
  brokerTicket: string;
  symbol: string;
  side: string;
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  floatingPl: number | null;
  lastSyncedAt: Date | null;
}

export interface EscapeRouteStep {
  step: number;
  title: string;
  detail: string;
  /** True when the step's detail had to reference an UNKNOWN value. */
  usesUnknownValue: boolean;
}

export interface EscapeRouteConnection {
  connectionId: number;
  venue: "MT5";
  connectionLabel: string | null;
  brokerName: string | null;
  serverName: string | null;
  maskedAccountIdentifier: string | null;
  baseCurrency: string | null;
  environment: "DEMO" | "LIVE" | "MOCK" | "UNKNOWN";
  directAccessInstructions: EscapeRouteStep[];
  /** Last positions CONFIRMED by the broker feed, with explicit staleness. */
  lastConfirmedPositions: {
    asOf: string | null;
    stale: boolean | null;
    positions: Array<{
      brokerTicket: string; symbol: string; side: string; volume: number;
      entryPrice: number; currentPrice: number | null; stopLoss: number | null;
      takeProfit: number | null; floatingPl: number | null; lastSyncedAt: string | null;
    }>;
    /** Present when the list cannot honestly be shown. */
    unavailableReason: string | null;
  };
  unavailable: string[];
}

export interface EscapeRoutePage {
  generatedAt: string;
  nonCustodyStatement: string;
  connections: EscapeRouteConnection[];
  /** Venue-independent emergency procedure. Instructional, not data. */
  emergencyProcedure: EscapeRouteStep[];
  connectionsUnavailableReason: string | null;
}

const NON_CUSTODY =
  "ARX never holds your funds and never stores your broker password. Your money lives at your broker; " +
  "everything below works even if ARX is completely offline.";

function step(step: number, title: string, detail: string, usesUnknownValue = false): EscapeRouteStep {
  return { step, title, detail, usesUnknownValue };
}

function buildDirectAccessSteps(c: EscapeRouteConnectionInput): EscapeRouteStep[] {
  const broker = c.brokerName;
  const server = c.serverName;
  const masked = maskAccountIdentifier(c.accountNumber);
  return [
    step(1, "Open your broker's own MT5 terminal",
      broker
        ? `Launch the MetaTrader 5 terminal provided by ${broker} on any desktop or the official MT5 mobile app. Do not use ARX for this — the whole point is that you don't need it.`
        : "Launch the MetaTrader 5 terminal provided by your broker (the EA reported no broker name for this connection — check the account-opening email from your broker).",
      broker == null),
    step(2, "Log in with YOUR credentials",
      masked
        ? `Use your account (${masked}) and the password your broker gave you. ARX has never had that password, so nothing about ARX can block this login.`
        : "Use the account number and password from your broker's account-opening email. ARX has never had that password. (No account number has been reported for this connection.)",
      masked == null),
    step(3, "Select the trade server",
      server
        ? `When MT5 asks for a server, pick: ${server}.`
        : "When MT5 asks for a server, use the server named in your broker's account-opening email (the EA has not reported a server name for this connection).",
      server == null),
    step(4, "Verify your positions against the list below",
      "Open the Trade tab in the terminal. The broker's list is the truth; the snapshot below is ARX's last confirmed view and may be behind.",
      false),
    step(5, "Manage or close positions directly",
      "From the broker terminal you can modify stops or close any position immediately — no ARX component is in that path.",
      false),
  ];
}

const EMERGENCY_PROCEDURE: EscapeRouteStep[] = [
  step(1, "Stop new automation first",
    "In ARX: engage the kill switch (Control Tower) or pause your agents/missions. If ARX is unreachable, skip straight to the broker terminal — automation cannot outrun a broker-side close.", false),
  step(2, "Go broker-native",
    "Follow the direct-access steps for the affected connection to open your broker's own MT5 terminal.", false),
  step(3, "Deal with open risk at the broker",
    "In the broker terminal, close or hedge any position you no longer want. Broker-side closes always win; ARX will reconcile to the broker's truth afterwards, never the other way around.", false),
  step(4, "Withdraw through the broker if needed",
    "Withdrawals happen in your broker's client portal, never through ARX — ARX has no withdrawal permission by construction.", false),
  step(5, "Tell ARX afterwards (optional)",
    "When ARX is reachable again, the reconciler will detect broker-side closes automatically. Nothing you did at the broker needs ARX's approval.", false),
];

export function buildEscapeRoutePage(args: {
  connections: EscapeRouteConnectionInput[];
  positionsByConnection: Map<number, EscapeRoutePositionInput[]>;
  now: Date;
  /** Set when the connections read itself failed — page stays honest. */
  connectionsUnavailableReason?: string | null;
}): EscapeRoutePage {
  const connections: EscapeRouteConnection[] = args.connections.map((c) => {
    const unavailable: string[] = [];
    if (c.brokerName == null) unavailable.push("brokerName: the EA has not reported a broker for this connection");
    if (c.serverName == null) unavailable.push("serverName: the EA has not reported a trade server");
    if (c.accountNumber == null) unavailable.push("accountIdentifier: no account number has been reported");

    const environment: EscapeRouteConnection["environment"] =
      c.mode === "DEMO" || c.accountType === "demo" ? "DEMO"
        : c.mode === "LIVE" || c.accountType === "live" || c.accountType === "real" ? "LIVE"
          : c.mode === "MOCK" ? "MOCK"
            : "UNKNOWN";
    if (environment === "UNKNOWN") unavailable.push("environment: neither mode nor accountType has been reported");

    const positions = args.positionsByConnection.get(c.connectionId) ?? [];
    let asOf: Date | null = c.lastPositionsSnapshotAt;
    for (const p of positions) {
      if (p.lastSyncedAt != null && (asOf == null || p.lastSyncedAt.getTime() > asOf.getTime())) asOf = p.lastSyncedAt;
    }
    const stale = asOf == null ? null : (args.now.getTime() - asOf.getTime()) / 1000 > HEARTBEAT_STALE_SECONDS;
    const unavailableReason = asOf == null
      ? "No positions snapshot has ever been confirmed for this connection — the broker terminal is the only truthful list."
      : null;

    return {
      connectionId: c.connectionId,
      venue: "MT5",
      connectionLabel: c.connectionName,
      brokerName: c.brokerName,
      serverName: c.serverName,
      maskedAccountIdentifier: maskAccountIdentifier(c.accountNumber),
      baseCurrency: c.accountCurrency,
      environment,
      directAccessInstructions: buildDirectAccessSteps(c),
      lastConfirmedPositions: {
        asOf: asOf?.toISOString() ?? null,
        stale,
        positions: positions.map((p) => ({
          brokerTicket: p.brokerTicket, symbol: p.symbol, side: p.side, volume: p.volume,
          entryPrice: p.entryPrice, currentPrice: p.currentPrice, stopLoss: p.stopLoss,
          takeProfit: p.takeProfit, floatingPl: p.floatingPl,
          lastSyncedAt: p.lastSyncedAt?.toISOString() ?? null,
        })),
        unavailableReason,
      },
      unavailable,
    };
  });

  return {
    generatedAt: args.now.toISOString(),
    nonCustodyStatement: NON_CUSTODY,
    connections,
    emergencyProcedure: EMERGENCY_PROCEDURE,
    connectionsUnavailableReason: args.connectionsUnavailableReason ?? null,
  };
}
