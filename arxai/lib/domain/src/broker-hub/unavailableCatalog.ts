import type {
  BrokerReadCapabilities,
  BrokerUnavailableCatalogEntry,
  BrokerVenue,
} from "./types";

const NO_READ_CAPABILITIES: BrokerReadCapabilities = Object.freeze({
  accountSnapshot: false,
  positionSnapshot: false,
  openOrderSnapshot: false,
  instrumentDiscovery: false,
  marketDataSnapshot: false,
});

const UNAVAILABLE_VENUES = Object.freeze({
  DERIV: Object.freeze({
    venue: "DERIV",
    status: "NOT_IMPLEMENTED",
    reason: "NOT_IMPLEMENTED",
    connected: false,
    credentialRequirements: Object.freeze([]),
    capabilities: NO_READ_CAPABILITIES,
  }),
  OANDA: Object.freeze({
    venue: "OANDA",
    status: "ONBOARDING_REQUIRED",
    reason: "ONBOARDING_REQUIRED",
    connected: false,
    credentialRequirements: Object.freeze([]),
    capabilities: NO_READ_CAPABILITIES,
  }),
  UNKNOWN: Object.freeze({
    venue: "UNKNOWN",
    status: "DISABLED",
    reason: "DISABLED",
    connected: false,
    credentialRequirements: Object.freeze([]),
    capabilities: NO_READ_CAPABILITIES,
  }),
} satisfies Record<Exclude<BrokerVenue, "MT5">, BrokerUnavailableCatalogEntry>);

export function getUnavailableVenue(
  venue: Exclude<BrokerVenue, "MT5">,
): BrokerUnavailableCatalogEntry {
  return UNAVAILABLE_VENUES[venue];
}

export function listUnavailableVenues(): readonly BrokerUnavailableCatalogEntry[] {
  return Object.values(UNAVAILABLE_VENUES);
}