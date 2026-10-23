import type {
  BrokerAccountSnapshot,
  BrokerCapabilitySnapshot,
  BrokerConnectionIdentity,
  BrokerHealthSnapshot,
  BrokerInstrumentSnapshot,
  BrokerMarketDataRequest,
  BrokerMarketDataSnapshot,
  BrokerReadCapabilities,
  ReadOnlyBrokerAdapter,
} from "@workspace/domain/broker-hub";

const MT5_HEARTBEAT_FRESH_MS = 60_000;
const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 60_000;
const MT5_DISCOVERY_FRESH_MS = 5 * 60_000;
const MT5_MARKET_DATA_FRESH_MS = 60_000;

export interface Mt5OwnedConnection {
  readonly id: number;
  readonly userId: number | null;
  readonly status: string;
  readonly lastHeartbeat: Date | null;
  readonly accountNumber: string | null;
  readonly brokerName: string | null;
  readonly serverName: string | null;
  readonly accountCurrency: string | null;
  readonly accountBalance: number | null;
  readonly accountEquity: number | null;
  readonly margin: number | null;
  readonly freeMargin: number | null;
  readonly accountSyncedAt: Date | null;
  readonly leverage: number | null;
  readonly mode: string;
  readonly accountType: string;
  readonly capabilitiesReportedAt: Date | null;
}

export interface Mt5OwnedInstrument {
  readonly symbol: string;
  readonly brokerSymbol: string | null;
  readonly displaySymbol: string | null;
  readonly tradeAllowed: boolean | null;
  readonly digits: number | null;
  readonly point: number | null;
  readonly minVolume: number | null;
  readonly maxVolume: number | null;
  readonly volumeStep: number | null;
  readonly snapshotAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly reportedAt: Date;
}

export interface Mt5OwnedCandle {
  readonly brokerSymbol: string;
  readonly timeframe: string;
  readonly openTimeUtc: Date;
  readonly closeTimeUtc: Date | null;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tickVolume: number | null;
  readonly realVolume: number | null;
  readonly source: string;
  readonly terminalId: string | null;
  readonly isClosedBar: boolean;
  readonly receivedAt: Date;
}

export interface Mt5ProjectionReader {
  readOwnedConnection(userId: number, connectionId: number): Promise<Mt5OwnedConnection | null>;
  readOwnedInstruments(userId: number, connectionId: number): Promise<readonly Mt5OwnedInstrument[]>;
  readLatestOwnedCandle(userId: number, connectionId: number): Promise<Mt5OwnedCandle | null>;
  readOwnedCandles(
    userId: number,
    connectionId: number,
    exactBrokerSymbol: string,
    timeframe: string,
    limit: number,
  ): Promise<readonly Mt5OwnedCandle[]>;
}

function maskAccountRef(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return "•".repeat(value.length);
  return `${value.slice(0, 2)}${"•".repeat(Math.max(3, value.length - 4))}${value.slice(-2)}`;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function environmentOf(connection: Mt5OwnedConnection): "UNKNOWN" | "DEMO" | "LIVE" {
  const mode = connection.mode.trim().toUpperCase();
  const accountType = connection.accountType.trim().toLowerCase();
  if (mode === "LIVE" || accountType === "live" || accountType === "real") return "LIVE";
  if (mode === "DEMO" || accountType === "demo") return "DEMO";
  return "UNKNOWN";
}

function noReadCapabilities(): BrokerReadCapabilities {
  return {
    accountSnapshot: false,
    positionSnapshot: false,
    openOrderSnapshot: false,
    instrumentDiscovery: false,
    marketDataSnapshot: false,
  };
}

function isFresh(value: Date | null, now: number, windowMs: number): boolean {
  if (!value) return false;
  const ageMs = now - value.getTime();
  return ageMs >= 0 && ageMs <= windowMs;
}

function healthOf(
  identity: BrokerConnectionIdentity,
  connection: Mt5OwnedConnection,
  now: number,
): BrokerHealthSnapshot {
  const nativeStatus = connection.status.trim().toLowerCase();
  const heartbeatMs = connection.lastHeartbeat?.getTime() ?? null;
  const ageMs = heartbeatMs == null ? null : Math.max(0, now - heartbeatMs);
  const staleSeconds = ageMs == null ? null : Math.floor(ageMs / 1000);
  const heartbeatFresh = isFresh(connection.lastHeartbeat, now, MT5_HEARTBEAT_FRESH_MS);

  if (nativeStatus === "revoked") {
    return {
      identity,
      status: "REVOKED",
      nativeStatus: connection.status,
      connected: false,
      observedAt: iso(connection.lastHeartbeat),
      staleSeconds,
      reason: "BRIDGE_REVOKED",
    };
  }

  if (!heartbeatFresh || nativeStatus === "stale") {
    return {
      identity,
      status: connection.lastHeartbeat ? "STALE" : "DISCONNECTED",
      nativeStatus: connection.status,
      connected: false,
      observedAt: iso(connection.lastHeartbeat),
      staleSeconds,
      reason: connection.lastHeartbeat ? "HEARTBEAT_STALE" : "HEARTBEAT_MISSING",
    };
  }

  const connected = nativeStatus === "connected";
  return {
    identity,
    status: connected ? "CONNECTED" : "DISCONNECTED",
    nativeStatus: connection.status,
    connected,
    observedAt: iso(connection.lastHeartbeat),
    staleSeconds,
    reason: connected ? "HEARTBEAT_FRESH" : "NATIVE_STATUS_DISCONNECTED",
  };
}

function instrumentObservedAt(instrument: Mt5OwnedInstrument): Date {
  return instrument.lastSeenAt ?? instrument.snapshotAt ?? instrument.reportedAt;
}

export class Mt5ReadOnlyAdapter implements ReadOnlyBrokerAdapter {
  readonly identity: BrokerConnectionIdentity;

  constructor(
    private readonly reader: Mt5ProjectionReader,
    userId: number,
    connectionId: number,
    private readonly now: () => number = Date.now,
  ) {
    this.identity = {
      venue: "MT5",
      userId,
      nativeConnectionRef: String(connectionId),
    };
  }

  private get userId(): number {
    return this.identity.userId;
  }

  private get connectionId(): number {
    return Number(this.identity.nativeConnectionRef);
  }

  private readConnection(): Promise<Mt5OwnedConnection | null> {
    return this.reader.readOwnedConnection(this.userId, this.connectionId);
  }

  async readHealth(): Promise<BrokerHealthSnapshot> {
    const connection = await this.readConnection();
    if (!connection) {
      return {
        identity: this.identity,
        status: "DISCONNECTED",
        nativeStatus: null,
        connected: false,
        observedAt: null,
        staleSeconds: null,
        reason: "CONNECTION_NOT_FOUND",
      };
    }

    return healthOf(this.identity, connection, this.now());
  }

  async readAccount(): Promise<BrokerAccountSnapshot | null> {
    const connection = await this.readConnection();
    if (!connection) return null;
    return {
      identity: this.identity,
      accountRefMasked: maskAccountRef(connection.accountNumber),
      brokerName: connection.brokerName,
      serverName: connection.serverName,
      environment: environmentOf(connection),
      currency: connection.accountCurrency,
      balance: connection.accountSyncedAt ? connection.accountBalance : null,
      equity: connection.accountSyncedAt ? connection.accountEquity : null,
      margin: connection.accountSyncedAt ? connection.margin : null,
      freeMargin: connection.accountSyncedAt ? connection.freeMargin : null,
      leverage: connection.leverage,
      observedAt: iso(connection.accountSyncedAt),
      snapshotStatus: connection.accountSyncedAt == null
        ? "MISSING"
        : isFresh(
            connection.accountSyncedAt,
            this.now(),
            MT5_ACCOUNT_SNAPSHOT_FRESH_MS,
          )
          ? "FRESH"
          : "STALE",
    };
  }

  async readCapabilities(): Promise<BrokerCapabilitySnapshot> {
    const [connection, instruments, latestCandle] = await Promise.all([
      this.readConnection(),
      this.reader.readOwnedInstruments(this.userId, this.connectionId),
      this.reader.readLatestOwnedCandle(this.userId, this.connectionId),
    ]);
    if (!connection) {
      return {
        identity: this.identity,
        observedAt: null,
        capabilities: noReadCapabilities(),
      };
    }
    const now = this.now();
    const healthy = healthOf(this.identity, connection, now).connected;
    const hasFreshDiscovery = instruments.some((instrument) =>
      Boolean(instrument.brokerSymbol?.trim()) &&
      isFresh(instrumentObservedAt(instrument), now, MT5_DISCOVERY_FRESH_MS)
    );
    const hasFreshMarketData =
      latestCandle != null &&
      isFresh(latestCandle.receivedAt, now, MT5_MARKET_DATA_FRESH_MS);
    return {
      identity: this.identity,
      observedAt: iso(connection.capabilitiesReportedAt),
      capabilities: {
        accountSnapshot:
          healthy &&
          isFresh(connection.accountSyncedAt, now, MT5_ACCOUNT_SNAPSHOT_FRESH_MS),
        positionSnapshot: false,
        openOrderSnapshot: false,
        instrumentDiscovery: healthy && hasFreshDiscovery,
        marketDataSnapshot: healthy && hasFreshMarketData,
      },
    };
  }

  async readInstruments(): Promise<readonly BrokerInstrumentSnapshot[]> {
    const connection = await this.readConnection();
    if (!connection) return [];
    const instruments = await this.reader.readOwnedInstruments(this.userId, this.connectionId);
    const now = this.now();
    const healthy = healthOf(this.identity, connection, now).connected;
    return instruments.flatMap((instrument) => {
      const exactBrokerSymbol = instrument.brokerSymbol?.trim();
      const observedAt = instrumentObservedAt(instrument);
      if (!exactBrokerSymbol) return [];
      const discoveryFresh = isFresh(observedAt, now, MT5_DISCOVERY_FRESH_MS);
      return [{
        identity: this.identity,
        symbol: instrument.symbol,
        displayName: instrument.displaySymbol,
        exactBrokerSymbol,
        brokerReportsTradeAllowed:
          healthy && discoveryFresh && instrument.tradeAllowed === true,
        discoveryStatus: discoveryFresh ? "FRESH" : "STALE",
        digits: instrument.digits,
        point: instrument.point,
        minVolume: instrument.minVolume,
        maxVolume: instrument.maxVolume,
        volumeStep: instrument.volumeStep,
        evidence: {
          observedAt: observedAt.toISOString(),
          exactBrokerSymbol,
          nativeConnectionRef: this.identity.nativeConnectionRef,
        },
      }];
    });
  }

  async readMarketData(request: BrokerMarketDataRequest): Promise<BrokerMarketDataSnapshot> {
    const connection = await this.readConnection();
    const timeframe = request.timeframe.trim().toUpperCase();
    if (!connection) {
      return {
        available: false,
        identity: this.identity,
        timeframe,
        reason: "CONNECTION_NOT_FOUND",
        provenance: null,
        candles: [],
      };
    }

    if (!healthOf(this.identity, connection, this.now()).connected) {
      return {
        available: false,
        identity: this.identity,
        timeframe,
        reason: "HEALTH_UNAVAILABLE",
        provenance: null,
        candles: [],
      };
    }

    const instruments = await this.readInstruments();
    const discovered = instruments.find(
      (instrument) => instrument.exactBrokerSymbol === request.exactBrokerSymbol,
    );
    if (!discovered) {
      return {
        available: false,
        identity: this.identity,
        timeframe,
        reason: "DISCOVERY_REQUIRED",
        provenance: null,
        candles: [],
      };
    }
    if (discovered.discoveryStatus !== "FRESH") {
      return {
        available: false,
        identity: this.identity,
        timeframe,
        reason: "DISCOVERY_STALE",
        provenance: null,
        candles: [],
      };
    }

    const limit = Math.max(1, Math.min(500, Math.trunc(request.limit ?? 200)));
    const candles = await this.reader.readOwnedCandles(
      this.userId,
      this.connectionId,
      request.exactBrokerSymbol,
      timeframe,
      limit,
    );
    if (candles.length === 0) {
      return {
        available: false,
        identity: this.identity,
        timeframe,
        reason: "MARKET_DATA_UNAVAILABLE",
        provenance: null,
        candles: [],
      };
    }

    const first = candles[0];
    const latest = candles[candles.length - 1];
    if (!isFresh(latest.receivedAt, this.now(), MT5_MARKET_DATA_FRESH_MS)) {
      return {
        available: false,
        identity: this.identity,
        timeframe,
        reason: "MARKET_DATA_STALE",
        provenance: null,
        candles: [],
      };
    }
    return {
      available: true,
      identity: this.identity,
      timeframe,
      provenance: {
        venue: "MT5",
        userId: this.userId,
        nativeConnectionRef: this.identity.nativeConnectionRef,
        exactBrokerSymbol: request.exactBrokerSymbol,
        source: first.source,
        terminalRef: first.terminalId,
      },
      candles: candles.map((candle) => ({
        openTime: candle.openTimeUtc.toISOString(),
        closeTime: iso(candle.closeTimeUtc),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.realVolume ?? candle.tickVolume,
        closed: candle.isClosedBar,
        receivedAt: candle.receivedAt.toISOString(),
      })),
    };
  }
}