export type BrokerVenue = "MT5" | "DERIV" | "OANDA" | "UNKNOWN";

export type BrokerEnvironment = "UNKNOWN" | "DEMO" | "LIVE";

export type BrokerConnectionStatus =
  | "NOT_IMPLEMENTED"
  | "ONBOARDING_REQUIRED"
  | "DISABLED"
  | "DISCOVERY_REQUIRED"
  | "DISCONNECTED"
  | "CONNECTED"
  | "DEGRADED"
  | "FROZEN"
  | "REAUTH_REQUIRED"
  | "STALE"
  | "REVOKED";

export type BrokerUnavailableReason =
  | "NOT_IMPLEMENTED"
  | "ONBOARDING_REQUIRED"
  | "DISABLED"
  | "CONNECTION_NOT_FOUND"
  | "HEALTH_UNAVAILABLE"
  | "DISCOVERY_REQUIRED"
  | "DISCOVERY_STALE"
  | "MARKET_DATA_STALE"
  | "MARKET_DATA_UNAVAILABLE";

export interface BrokerConnectionIdentity {
  readonly venue: BrokerVenue;
  readonly userId: number;
  readonly nativeConnectionRef: string;
}

export interface BrokerHealthSnapshot {
  readonly identity: BrokerConnectionIdentity;
  readonly status: BrokerConnectionStatus;
  readonly nativeStatus: string | null;
  readonly connected: boolean;
  readonly observedAt: string | null;
  readonly staleSeconds: number | null;
  readonly reason: string;
}

export interface BrokerReadCapabilities {
  readonly accountSnapshot: boolean;
  readonly positionSnapshot: boolean;
  readonly openOrderSnapshot: boolean;
  readonly instrumentDiscovery: boolean;
  readonly marketDataSnapshot: boolean;
}

export interface BrokerCapabilitySnapshot {
  readonly identity: BrokerConnectionIdentity;
  readonly observedAt: string | null;
  readonly capabilities: BrokerReadCapabilities;
}

export interface BrokerAccountSnapshot {
  readonly identity: BrokerConnectionIdentity;
  readonly accountRefMasked: string | null;
  readonly brokerName: string | null;
  readonly serverName: string | null;
  readonly environment: BrokerEnvironment;
  readonly currency: string | null;
  readonly balance: number | null;
  readonly equity: number | null;
  readonly margin: number | null;
  readonly freeMargin: number | null;
  readonly leverage: number | null;
  readonly observedAt: string | null;
  readonly snapshotStatus: "FRESH" | "STALE" | "MISSING";
}

export interface BrokerDiscoveryEvidence {
  readonly observedAt: string;
  readonly exactBrokerSymbol: string;
  readonly nativeConnectionRef: string;
}

export interface BrokerInstrumentSnapshot {
  readonly identity: BrokerConnectionIdentity;
  readonly symbol: string;
  readonly displayName: string | null;
  readonly exactBrokerSymbol: string;
  readonly brokerReportsTradeAllowed: boolean;
  readonly discoveryStatus: "FRESH" | "STALE";
  readonly digits: number | null;
  readonly point: number | null;
  readonly minVolume: number | null;
  readonly maxVolume: number | null;
  readonly volumeStep: number | null;
  readonly evidence: BrokerDiscoveryEvidence;
}

export interface BrokerMarketDataRequest {
  readonly exactBrokerSymbol: string;
  readonly timeframe: string;
  readonly limit?: number;
}

export interface BrokerMarketDataProvenance {
  readonly venue: BrokerVenue;
  readonly userId: number;
  readonly nativeConnectionRef: string;
  readonly exactBrokerSymbol: string;
  readonly source: string;
  readonly terminalRef: string | null;
}

export interface BrokerCandleSnapshot {
  readonly openTime: string;
  readonly closeTime: string | null;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number | null;
  readonly closed: boolean;
  readonly receivedAt: string;
}

export type BrokerMarketDataSnapshot =
  | {
      readonly available: true;
      readonly identity: BrokerConnectionIdentity;
      readonly timeframe: string;
      readonly provenance: BrokerMarketDataProvenance;
      readonly candles: readonly BrokerCandleSnapshot[];
    }
  | {
      readonly available: false;
      readonly identity: BrokerConnectionIdentity;
      readonly timeframe: string;
      readonly reason: Extract<
        BrokerUnavailableReason,
        | "CONNECTION_NOT_FOUND"
        | "HEALTH_UNAVAILABLE"
        | "DISCOVERY_REQUIRED"
        | "DISCOVERY_STALE"
        | "MARKET_DATA_STALE"
        | "MARKET_DATA_UNAVAILABLE"
      >;
      readonly provenance: null;
      readonly candles: readonly [];
    };

export interface BrokerUnavailableCatalogEntry {
  readonly venue: Exclude<BrokerVenue, "MT5">;
  readonly status: Extract<
    BrokerConnectionStatus,
    "NOT_IMPLEMENTED" | "ONBOARDING_REQUIRED" | "DISABLED"
  >;
  readonly reason: Extract<
    BrokerUnavailableReason,
    "NOT_IMPLEMENTED" | "ONBOARDING_REQUIRED" | "DISABLED"
  >;
  readonly connected: false;
  readonly credentialRequirements: readonly never[];
  readonly capabilities: BrokerReadCapabilities;
}

/** Phase 0B metadata projection. It is descriptive, read-only, and never a trade permission. */
export interface BrokerConnectionMetadata {
  readonly id: string | null;
  readonly identity: BrokerConnectionIdentity;
  readonly environment: BrokerEnvironment;
  readonly status: BrokerConnectionStatus;
  readonly adapterNativeStatus: string | null;
  readonly accountRefMasked: string | null;
  readonly discoveryObservedAt: string | null;
  readonly metadataEnabled: false;
  readonly tradingEnabled: false;
  readonly automationEnabled: false;
  readonly canPlaceLiveTrade: false;
}