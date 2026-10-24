// The Broker Hub's one way to get a venue reader (Tier 1 Broker & Account Hub).
//
// Every venue implements ReadOnlyBrokerAdapter (@workspace/domain/broker-hub).
// Callers ask this factory for one and read through the interface, so the Risk
// Governor, the Broker Hub routes and anything later never construct a venue
// class or depend on how that venue stores its state. CI guard
// broker-read-adapter-single-factory keeps the constructors here.

import type { BrokerVenue, ReadOnlyBrokerAdapter } from "@workspace/domain/broker-hub";
import { Mt5ReadOnlyAdapter } from "./mt5ReadOnlyAdapter.js";
import { mt5ProjectionReader } from "./mt5ProjectionReader.js";
import { DerivReadOnlyAdapter, derivFeedReader } from "./derivReadOnlyAdapter.js";

/** Venues the Hub can read. Each has an adapter below. */
export const BROKER_READ_VENUES = ["MT5", "DERIV"] as const satisfies readonly BrokerVenue[];
export type BrokerReadVenue = (typeof BROKER_READ_VENUES)[number];

export type BrokerReadTarget =
  /** One EA-bridged MT5 connection; the adapter reads only rows the user owns. */
  | { venue: "MT5"; userId: number; connectionId: number }
  /** The platform Deriv feed (market data only; no per-user account). */
  | { venue: "DERIV"; userId: number };

export function brokerReadAdapter(target: BrokerReadTarget): ReadOnlyBrokerAdapter {
  switch (target.venue) {
    case "MT5":
      return new Mt5ReadOnlyAdapter(mt5ProjectionReader, target.userId, target.connectionId);
    case "DERIV":
      return new DerivReadOnlyAdapter(derivFeedReader, target.userId);
  }
}
