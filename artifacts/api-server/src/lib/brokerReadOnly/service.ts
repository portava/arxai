// Build KK — Broker Read-Only Connector.
//
// HARD SAFETY:
//   - mode is always "READ_ONLY"
//   - liveTradingAllowed is always false
//   - canPlaceLiveTrade is always false
//   - if BROKER_MODE env is set to anything other than "read_only", the
//     connector REFUSES to construct and emits a CRITICAL event. The
//     refusal is also surfaced to Build HH (Risk Governor).
//   - secrets are NEVER returned in responses or logged.
//   - this module imports zero execution code paths.

import { randomUUID } from "node:crypto";
import { db, brokerReadonlySnapshotsTable, brokerReadonlyLogsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

export type Severity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

export interface BrokerSafetyCheck {
  safe: boolean;
  brokerModeEnv: string;
  reason: string;
  severity: Severity;
}

export interface ReadOnlyAccount {
  accountIdMasked: string;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  serverTime: string;
}

export interface ReadOnlySymbol {
  symbol: string; description: string; digits: number; pipSize: number; minLot: number; maxLot: number;
}

export interface ReadOnlyPosition {
  ticket: string; symbol: string; side: "BUY" | "SELL"; volume: number;
  openPrice: number; currentPrice: number; pnl: number; openedAt: string;
}

export interface ReadOnlyQuote { symbol: string; bid: number; ask: number; spread: number; ts: string; }

export interface DataQualityRO {
  status: "GOOD" | "DEGRADED" | "MISSING";
  latencyMs: number;
  warnings: string[];
  errors: string[];
}

export interface ConnectorSnapshot {
  connector_id: string;
  mode: "READ_ONLY";
  provider: string;
  connected: boolean;
  account: ReadOnlyAccount | null;
  symbols: ReadOnlySymbol[];
  openPositions: ReadOnlyPosition[];
  latestQuotes: ReadOnlyQuote[];
  dataQuality: DataQualityRO;
  // Set by placeholder providers (e.g. DEMO_PLACEHOLDER) so no consumer can
  // mistake their output for a real broker connection.
  providerState?: string;
  safetyNote?: string;
  liveTradingAllowed: false;
  canPlaceLiveTrade: false;
  generatedAt: string;
}

const SAFE_MODE = "read_only" as const;

export function checkBrokerSafety(): BrokerSafetyCheck {
  const env = (process.env.BROKER_MODE ?? "").trim().toLowerCase();
  if (env === "" || env === SAFE_MODE) {
    return { safe: true, brokerModeEnv: env || "(unset → defaulted to read_only)", reason: "BROKER_MODE is read_only", severity: "INFO" };
  }
  return {
    safe: false, brokerModeEnv: env,
    reason: `BROKER_MODE=${env} is NOT read_only — connector refused. Set BROKER_MODE=read_only to enable read-only snapshots.`,
    severity: "CRITICAL",
  };
}

function maskAccountId(id: string): string {
  if (!id) return "•••";
  if (id.length <= 4) return "•".repeat(id.length);
  return `${id.slice(0, 2)}${"•".repeat(Math.max(3, id.length - 4))}${id.slice(-2)}`;
}

async function logRO(connectorId: string, eventType: string, severity: Severity, message: string, details: Record<string, unknown> = {}) {
  try { await db.insert(brokerReadonlyLogsTable).values({ connectorId, eventType, severity, message, details }); } catch { /* swallow */ }
}

// Provider registry. Each provider produces a read-only snapshot only.
type Provider = (connectorId: string) => Promise<{
  connected: boolean; account: ReadOnlyAccount | null; symbols: ReadOnlySymbol[];
  openPositions: ReadOnlyPosition[]; latestQuotes: ReadOnlyQuote[]; dataQuality: DataQualityRO;
  providerState?: string; safetyNote?: string;
}>;

// The default provider is a PLACEHOLDER, not a broker. It must never report
// connected=true or fabricate account/symbol/quote figures (it used to invent
// a connected $10k account with GOOD data quality, which consumers like AACI
// then had to special-case-distrust).
const demoProvider: Provider = async () => ({
  connected: false,
  account: null,
  symbols: [],
  openPositions: [],
  latestQuotes: [],
  dataQuality: {
    status: "MISSING", latencyMs: 0,
    warnings: ["DEMO_PLACEHOLDER provider — no broker adapter is connected. No account, symbol, or quote data is available."],
    errors: [],
  },
  providerState: "DEMO_PLACEHOLDER",
  safetyNote: "Placeholder provider: connected=false and all data empty until a real read-only adapter is configured. Nothing here is a real account figure.",
});

const mt5StubProvider: Provider = async () => ({
  connected: false, account: null, symbols: [], openPositions: [], latestQuotes: [],
  dataQuality: { status: "MISSING", latencyMs: 0, warnings: ["MT5 read-only adapter not configured (no live bridge)."], errors: [] },
});

const derivStubProvider: Provider = async () => ({
  connected: false, account: null, symbols: [], openPositions: [], latestQuotes: [],
  dataQuality: { status: "MISSING", latencyMs: 0, warnings: ["Deriv read-only adapter not configured."], errors: [] },
});

const PROVIDERS: Record<string, Provider> = { demo: demoProvider, mt5: mt5StubProvider, deriv: derivStubProvider };

export interface ConnectorOptions { provider?: string; persist?: boolean; }

export async function buildSnapshot(opts: ConnectorOptions = {}): Promise<{ snapshot: ConnectorSnapshot; safety: BrokerSafetyCheck; rejected: boolean; }> {
  const connectorId = `bcon_${randomUUID()}`;
  const safety = checkBrokerSafety();
  const provider = (opts.provider ?? process.env.BROKER_PROVIDER ?? "demo").toLowerCase();

  await logRO(connectorId, "HEALTH_CHECK", safety.safe ? "INFO" : "CRITICAL", safety.reason, { brokerModeEnv: safety.brokerModeEnv });
  await logRO(connectorId, "PROVIDER_SELECTED", "INFO", `Provider=${provider}`);

  if (!safety.safe) {
    await logRO(connectorId, "UNSAFE_MODE_REJECTED", "CRITICAL", `Refusing connector: ${safety.reason}`);
    const snap: ConnectorSnapshot = {
      connector_id: connectorId, mode: "READ_ONLY", provider, connected: false,
      account: null, symbols: [], openPositions: [], latestQuotes: [],
      dataQuality: { status: "MISSING", latencyMs: 0, warnings: [], errors: [safety.reason] },
      liveTradingAllowed: false, canPlaceLiveTrade: false, generatedAt: new Date().toISOString(),
    };
    return { snapshot: snap, safety, rejected: true };
  }

  const fn = PROVIDERS[provider] ?? demoProvider;
  let result;
  try {
    result = await fn(connectorId);
    await logRO(connectorId, "READ_ONLY_VERIFIED", "INFO", "mode=READ_ONLY verified");
    if (result.account) await logRO(connectorId, "ACCOUNT_MASKED", "INFO", `Masked account ${result.account.accountIdMasked}`);
    await logRO(connectorId, "SYMBOLS_READ", "INFO", `Read ${result.symbols.length} symbols`);
    await logRO(connectorId, "POSITIONS_READ", "INFO", `Read ${result.openPositions.length} positions (read-only)`);
    await logRO(connectorId, "QUOTES_READ", "INFO", `Read ${result.latestQuotes.length} quotes`);
  } catch (err) {
    await logRO(connectorId, "PROVIDER_ERROR", "ERROR", `Provider failed: ${String(err).slice(0, 200)}`);
    result = { connected: false, account: null, symbols: [], openPositions: [], latestQuotes: [],
      dataQuality: { status: "MISSING" as const, latencyMs: 0, warnings: [], errors: [String(err).slice(0, 200)] } };
  }

  const snapshot: ConnectorSnapshot = {
    connector_id: connectorId, mode: "READ_ONLY", provider, connected: result.connected,
    account: result.account, symbols: result.symbols, openPositions: result.openPositions, latestQuotes: result.latestQuotes,
    dataQuality: result.dataQuality, liveTradingAllowed: false, canPlaceLiveTrade: false,
    generatedAt: new Date().toISOString(),
    ...(result.providerState ? { providerState: result.providerState, safetyNote: result.safetyNote } : {}),
  };

  if (opts.persist) {
    const snapshotId = `bsnp_${randomUUID()}`;
    await db.insert(brokerReadonlySnapshotsTable).values({
      snapshotId, provider, mode: "READ_ONLY", connected: snapshot.connected,
      accountMasked: snapshot.account ?? {}, symbols: snapshot.symbols,
      openPositions: snapshot.openPositions, latestQuotes: snapshot.latestQuotes,
      dataQuality: snapshot.dataQuality, liveTradingAllowed: false, canPlaceLiveTrade: false,
    });
    await logRO(connectorId, "SNAPSHOT_CREATED", "INFO", `Snapshot ${snapshotId} persisted`);
    (snapshot as ConnectorSnapshot & { snapshot_id: string }).snapshot_id = snapshotId;
  }

  return { snapshot, safety, rejected: false };
}

export async function listSnapshots(limit = 20) {
  return db.select().from(brokerReadonlySnapshotsTable).orderBy(desc(brokerReadonlySnapshotsTable.id)).limit(limit);
}

export async function listLogs(limit = 50) {
  return db.select().from(brokerReadonlyLogsTable).orderBy(desc(brokerReadonlyLogsTable.id)).limit(limit);
}

// Read-only summary for HH/GG to consume.
export async function brokerStatusForGovernance() {
  const safety = checkBrokerSafety();
  const lastList = await db.select().from(brokerReadonlySnapshotsTable).orderBy(desc(brokerReadonlySnapshotsTable.id)).limit(1);
  const last = lastList[0] ?? null;
  return {
    mode: "READ_ONLY" as const,
    safety,
    liveTradingAllowed: false as const,
    canPlaceLiveTrade: false as const,
    lastSnapshotAt: last?.createdAt ?? null,
    lastProvider: last?.provider ?? null,
    lastConnected: last?.connected ?? false,
  };
}
