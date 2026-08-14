// MockBrokerProvider — used when no broker secrets are configured. Returns
// clearly-labelled synthetic state so the UI can be developed and tested
// without a real broker. Never reports liveTradingAllowed=true.

import type {
  BrokerProvider, BrokerStatus, BrokerAccount, BrokerSymbol, BrokerPosition, BrokerOrder,
} from "./types.js";

export class MockBrokerProvider implements BrokerProvider {
  readonly kind = "mock" as const;

  async status(): Promise<BrokerStatus> {
    return {
      kind: this.kind,
      connected: false, // honest: no real broker is connected
      health: { connected: false, lastHeartbeatAt: null, staleSeconds: null, reason: "MockBrokerProvider — no real broker is configured. All values below are synthetic." },
      environment: "NOT_CONFIGURED",
      liveTradingAllowed: false,
      canPlaceLiveTrade: false,
      missingSecrets: [],
      notes: [
        "simulated=true. MockBrokerProvider is in use because BROKER_PROVIDER is not set to a real provider.",
        "Set BROKER_PROVIDER=mt5 and configure MT5_BRIDGE_TOKEN to use the real MT5 bridge.",
        "All account/symbols/positions/orders values are synthetic and must not be treated as real broker data.",
      ],
    };
  }

  async account(): Promise<BrokerAccount> {
    return {
      accountIdMasked: "mo•••ck",
      broker: "Mock Broker",
      server: "MockServer-Demo",
      currency: "USD",
      balance: 10000,
      equity: 10000,
      margin: 0,
      freeMargin: 10000,
      marginLevel: null,
      leverage: 500,
      environment: "DEMO",
      serverTime: new Date().toISOString(),
    };
  }

  async symbols(): Promise<BrokerSymbol[]> {
    return [
      { symbol: "Volatility 75 Index", description: "Synthetic V75 (mock)", digits: 4, pipSize: 0.0001, minLot: 0.01, maxLot: 100 },
      { symbol: "Volatility 100 Index", description: "Synthetic V100 (mock)", digits: 4, pipSize: 0.0001, minLot: 0.01, maxLot: 100 },
      { symbol: "Volatility 25 Index", description: "Synthetic V25 (mock)", digits: 4, pipSize: 0.0001, minLot: 0.01, maxLot: 100 },
    ];
  }

  async positions(): Promise<BrokerPosition[]> { return []; }
  async orders(): Promise<BrokerOrder[]> { return []; }
}
