// Deriv behind the Broker Hub's read contract (Tier 1 Broker & Account Hub).
//
// ReadOnlyBrokerAdapter (@workspace/domain/broker-hub) is the one venue
// interface the Hub reads through. MT5 implements it over the EA projection
// (mt5ReadOnlyAdapter.ts); this file implements it over the platform's Deriv
// feed (lib/data/providers/derivProvider.ts), so both venues answer health,
// capabilities, instruments and market data in the same shape.
//
// What Deriv is to ARX today, and what this adapter therefore reports:
//   - a market-data venue: synthetic-index ticks and candles over the public
//     WebSocket. Health, discovery and candles come from that feed.
//   - not a per-user account: no trader links a Deriv account to ARX, so
//     readAccount() is null and accountSnapshot is false. It never borrows the
//     platform token's account as a trader's.
//   - not a trading venue: brokerReportsTradeAllowed is always false. Deriv
//     orders wait for a certified execution adapter; this module has no write
//     path and imports nothing from lib/deriv (certification and order intent).

import type {
  BrokerAccountSnapshot,
  BrokerCapabilitySnapshot,
  BrokerConnectionIdentity,
  BrokerConnectionStatus,
  BrokerHealthSnapshot,
  BrokerInstrumentSnapshot,
  BrokerMarketDataRequest,
  BrokerMarketDataSnapshot,
  ReadOnlyBrokerAdapter,
} from "@workspace/domain/broker-hub";
import {
  DERIV_SYNTHETIC_SYMBOLS,
  getDerivCandles,
  getDerivFeedStatus,
  toDerivGranularity,
  type DerivFeedStatus,
} from "../data/providers/derivProvider.js";
import { getDerivFeedClient, derivMarketDataSource } from "../data/providers/derivFeedClient.js";
import type { DerivCandle } from "../data/providers/derivWsClient.js";

/** The feed is one platform connection, shared by every reader. */
export const DERIV_PLATFORM_FEED_REF = "platform-feed" as const;

/** The parts of the Deriv feed this adapter reads. Injected so tests need no socket. */
export interface DerivFeedReader {
  feedStatus(): Pick<
    DerivFeedStatus,
    "feedReadinessState" | "connected" | "lastTickAt" | "lastTickAgeMs" | "activeSymbolsLoaded" | "activeSymbolsLoadedAt"
  >;
  isDiscovered?(derivId: string): boolean;
  source?(): string;
  catalog(): ReadonlyArray<{ symbol: string; derivId: string; displayName: string }>;
  candles(symbol: string, timeframe: string, count: number): Promise<{ ok: boolean; reason: string | null; candles: DerivCandle[] }>;
}

export const derivFeedReader: DerivFeedReader = {
  feedStatus: () => getDerivFeedStatus(),
  catalog: () => DERIV_SYNTHETIC_SYMBOLS,
  source: derivMarketDataSource,
  isDiscovered: (id) => {
    const client = getDerivFeedClient();
    return client.isActiveSymbolsLoaded() && client.getLastDiscovery()?.symbols.some(s => s.symbol === id && s.exchangeIsOpen) === true;
  },
  candles: (symbol, timeframe, count) => getDerivCandles(symbol, timeframe, count),
};

type ReadinessState = DerivFeedStatus["feedReadinessState"];

const HEALTH_BY_STATE: Record<ReadinessState, { status: BrokerConnectionStatus; connected: boolean; reason: string }> = {
  UNCONFIGURED: { status: "DISABLED", connected: false, reason: "DERIV_FEED_UNCONFIGURED" },
  CONNECTING: { status: "DISCONNECTED", connected: false, reason: "DERIV_FEED_CONNECTING" },
  // Public synthetic data needs no authorized session, so a failed authorize
  // degrades the feed rather than disconnecting it.
  AUTH_FAILED: { status: "DEGRADED", connected: true, reason: "DERIV_AUTH_FAILED_PUBLIC_DATA_ONLY" },
  CONNECTED_AWAITING_FEED: { status: "DEGRADED", connected: true, reason: "DERIV_AWAITING_FEED" },
  HISTORY_READY_AWAITING_LIVE_TICK: { status: "DEGRADED", connected: true, reason: "DERIV_AWAITING_LIVE_TICK" },
  LIVE_FEED: { status: "CONNECTED", connected: true, reason: "DERIV_LIVE_FEED" },
};

// A candle series is current when its newest bar opened within two bars of now.
const BARS_OF_SLACK = 2;

export class DerivReadOnlyAdapter implements ReadOnlyBrokerAdapter {
  readonly identity: BrokerConnectionIdentity;

  constructor(
    private readonly reader: DerivFeedReader,
    userId: number,
    private readonly now: () => number = Date.now,
  ) {
    this.identity = { venue: "DERIV", userId, nativeConnectionRef: DERIV_PLATFORM_FEED_REF };
  }

  async readHealth(): Promise<BrokerHealthSnapshot> {
    const feed = this.reader.feedStatus();
    const mapped = HEALTH_BY_STATE[feed.feedReadinessState];
    return {
      identity: this.identity,
      status: mapped.status,
      nativeStatus: feed.feedReadinessState,
      connected: mapped.connected && feed.connected,
      observedAt: feed.lastTickAt,
      staleSeconds: feed.lastTickAgeMs == null ? null : Math.floor(Math.max(0, feed.lastTickAgeMs) / 1000),
      reason: mapped.reason,
    };
  }

  /** No trader links a Deriv account to ARX, so there is no account to report. */
  async readAccount(): Promise<BrokerAccountSnapshot | null> {
    return null;
  }

  async readCapabilities(): Promise<BrokerCapabilitySnapshot> {
    const feed = this.reader.feedStatus();
    const healthy = (await this.readHealth()).connected;
    return {
      identity: this.identity,
      observedAt: feed.lastTickAt,
      capabilities: {
        accountSnapshot: false,
        positionSnapshot: false,
        openOrderSnapshot: false,
        instrumentDiscovery: healthy && feed.activeSymbolsLoaded,
        marketDataSnapshot: healthy && feed.feedReadinessState === "LIVE_FEED",
      },
    };
  }

  async readInstruments(): Promise<readonly BrokerInstrumentSnapshot[]> {
    const feed = this.reader.feedStatus();
    const observedAt = feed.activeSymbolsLoadedAt ?? new Date(this.now()).toISOString();
    const fresh = feed.connected && feed.activeSymbolsLoaded;
    return this.reader.catalog().map((s) => ({
      identity: this.identity,
      symbol: s.symbol,
      displayName: s.displayName,
      exactBrokerSymbol: s.derivId,
      brokerReportsTradeAllowed: false,
      discoveryStatus: fresh && (this.reader.isDiscovered?.(s.derivId) ?? false) ? "FRESH" : "STALE",
      digits: null,
      point: null,
      minVolume: null,
      maxVolume: null,
      volumeStep: null,
      evidence: { observedAt, exactBrokerSymbol: s.derivId, nativeConnectionRef: DERIV_PLATFORM_FEED_REF },
    }));
  }

  async readMarketData(request: BrokerMarketDataRequest): Promise<BrokerMarketDataSnapshot> {
    const timeframe = request.timeframe.trim().toUpperCase();
    const unavailable = (reason: Extract<BrokerMarketDataSnapshot, { available: false }>["reason"]): BrokerMarketDataSnapshot => ({
      available: false, identity: this.identity, timeframe, reason, provenance: null, candles: [],
    });

    if (!(await this.readHealth()).connected) return unavailable("HEALTH_UNAVAILABLE");
    const instrument = (await this.readInstruments()).find((i) => i.exactBrokerSymbol === request.exactBrokerSymbol);
    if (!instrument) return unavailable("DISCOVERY_REQUIRED");
    if (instrument.discoveryStatus !== "FRESH") return unavailable("DISCOVERY_STALE");
    const granularity = toDerivGranularity(timeframe);
    if (!granularity) return unavailable("MARKET_DATA_UNAVAILABLE");

    const limit = Math.max(1, Math.min(500, Math.trunc(request.limit ?? 200)));
    const res = await this.reader.candles(instrument.symbol, timeframe, limit);
    if (!res.ok || res.candles.length === 0) return unavailable("MARKET_DATA_UNAVAILABLE");

    const nowMs = this.now();
    const latest = res.candles[res.candles.length - 1];
    if (nowMs - latest.epoch * 1000 > granularity * 1000 * BARS_OF_SLACK) return unavailable("MARKET_DATA_STALE");

    const receivedAt = new Date(nowMs).toISOString();
    return {
      available: true,
      identity: this.identity,
      timeframe,
      provenance: {
        venue: "DERIV",
        userId: this.identity.userId,
        nativeConnectionRef: DERIV_PLATFORM_FEED_REF,
        exactBrokerSymbol: request.exactBrokerSymbol,
        source: this.reader.source?.() ?? "deriv_ws",
        terminalRef: null,
      },
      candles: res.candles.map((c) => {
        const closeMs = (c.epoch + granularity) * 1000;
        return {
          openTime: new Date(c.epoch * 1000).toISOString(),
          closeTime: new Date(closeMs).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: null,
          closed: closeMs <= nowMs,
          receivedAt,
        };
      }),
    };
  }
}
