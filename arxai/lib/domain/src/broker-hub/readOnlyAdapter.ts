import type {
  BrokerAccountSnapshot,
  BrokerCapabilitySnapshot,
  BrokerConnectionIdentity,
  BrokerHealthSnapshot,
  BrokerInstrumentSnapshot,
  BrokerMarketDataRequest,
  BrokerMarketDataSnapshot,
} from "./types";

export const READ_ONLY_BROKER_ADAPTER_METHODS = [
  "readHealth",
  "readAccount",
  "readCapabilities",
  "readInstruments",
  "readMarketData",
] as const;

export interface ReadOnlyBrokerAdapter {
  readonly identity: BrokerConnectionIdentity;
  readHealth(): Promise<BrokerHealthSnapshot>;
  readAccount(): Promise<BrokerAccountSnapshot | null>;
  readCapabilities(): Promise<BrokerCapabilitySnapshot>;
  readInstruments(): Promise<readonly BrokerInstrumentSnapshot[]>;
  readMarketData(request: BrokerMarketDataRequest): Promise<BrokerMarketDataSnapshot>;
}