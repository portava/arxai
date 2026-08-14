// Broker Provider abstraction.
//
// SAFETY: Providers are READ-ONLY in this build. They expose status, account,
// symbols, positions, orders. They do NOT contain order placement code paths.
// Placement is centralized in placeLiveOrderGuarded() and remains rejected at
// the BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED gate.

export type BrokerKind = "mock" | "mt5" | "deriv";

export interface BrokerSecretRequirement {
  key: string;
  required: boolean;
  set: boolean;
  description: string;
}

export interface BrokerHealth {
  connected: boolean;
  lastHeartbeatAt: string | null;
  staleSeconds: number | null;
  reason: string;
}

export interface BrokerAccount {
  accountIdMasked: string;
  broker: string | null;
  server: string | null;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  leverage: number | null;
  environment: "DEMO" | "LIVE" | "UNKNOWN";
  serverTime: string;
}

export interface BrokerSymbol {
  symbol: string;
  description: string;
  digits: number;
  pipSize: number;
  minLot: number;
  maxLot: number;
}

export interface BrokerPosition {
  ticket: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number;
  openedAt: string;
}

export interface BrokerOrder {
  id: string;
  status: string; // PENDING | DELIVERED | EXECUTED | FAILED | REJECTED | BLOCKED
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  lot: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  ticket: number | null;
  detail: string | null;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
}

export interface BrokerStatus {
  kind: BrokerKind;
  connected: boolean;
  health: BrokerHealth;
  environment: "DEMO" | "LIVE" | "UNKNOWN" | "NOT_CONFIGURED";
  liveTradingAllowed: false; // ALWAYS false until placeLiveOrderGuarded ships a real placement layer
  canPlaceLiveTrade: false; // ALWAYS false
  missingSecrets: BrokerSecretRequirement[];
  notes: string[];
}

export interface BrokerProvider {
  readonly kind: BrokerKind;
  status(): Promise<BrokerStatus>;
  account(): Promise<BrokerAccount | null>;
  symbols(): Promise<BrokerSymbol[]>;
  positions(): Promise<BrokerPosition[]>;
  orders(limit?: number): Promise<BrokerOrder[]>;
}
