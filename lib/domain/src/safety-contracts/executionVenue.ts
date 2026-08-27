// Phase 6 - execution venue routing.
//
// Replaces the compile-time-fixed MT5 adapter literal with an explicit,
// fail-closed router. The rule that matters:
//
//     THERE IS NO DEFAULT VENUE.
//
// Not to MT5, not to Deriv. An absent, empty, unrecognised or malformed venue
// REFUSES. That is the opposite of the usual resolver, and deliberately so: a
// default here would mean an order whose venue nobody established still reaching
// a real broker. "Which venue is this order for?" is not a question worth
// guessing at.
//
// SERVER AUTHORITY. This function takes the venue the SERVER persisted on the
// command row. It must never be handed a value that came from a client request
// body: a client naming its own venue could otherwise select a more privileged
// execution path than the server intended.
//
// Contract-only: importing this dispatches nothing and selects no adapter.

export const EXECUTION_VENUES = [
  /** The v1.5x MT5 Expert Advisor mailbox. Delivery is a local INSERT. */
  "MT5_EA_BRIDGE",
  /** Deriv demo over the certified Phase 5 WebSocket transport. */
  "DERIV_DEMO",
] as const;
export type ExecutionVenue = (typeof EXECUTION_VENUES)[number];

export const VENUE_ROUTING_REFUSALS = [
  "VENUE_ABSENT",
  "VENUE_UNRECOGNISED",
  "VENUE_MALFORMED",
] as const;
export type VenueRoutingRefusal = (typeof VENUE_ROUTING_REFUSALS)[number];

export type VenueRouteVerdict =
  | { ok: true; venue: ExecutionVenue }
  | { ok: false; refusal: VenueRoutingRefusal; detail: string };

/**
 * Resolve the venue for a live command. Total, pure and default-deny.
 *
 * Exact match only - no case-folding, no trimming-then-aliasing, no prefix
 * matching. A value that is nearly a venue is not a venue, and the cost of
 * guessing wrong is an order at the wrong broker.
 */
export function routeExecutionVenue(raw: unknown): VenueRouteVerdict {
  if (raw === null || raw === undefined) {
    return { ok: false, refusal: "VENUE_ABSENT", detail: "no execution venue recorded on the command" };
  }
  if (typeof raw !== "string") {
    return { ok: false, refusal: "VENUE_MALFORMED", detail: `venue is ${typeof raw}, not a string` };
  }
  if (raw === "") {
    return { ok: false, refusal: "VENUE_ABSENT", detail: "execution venue is empty" };
  }
  if (!(EXECUTION_VENUES as readonly string[]).includes(raw)) {
    return {
      ok: false, refusal: "VENUE_UNRECOGNISED",
      detail: `unrecognised execution venue ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, venue: raw as ExecutionVenue };
}

/**
 * The venue every command created before the venue column existed belongs to.
 *
 * This is a BACKFILL FACT, not a runtime fallback. Every historical
 * arx_live_commands row was bound to an mt5_connection by construction - the
 * dispatch path had no other venue - so recording them as MT5_EA_BRIDGE states
 * something already true rather than assuming anything.
 *
 * It is exported for the schema column default and for that reason ONLY.
 * `routeExecutionVenue` does not consult it: a NEW command that reaches
 * dispatch without an explicit venue must refuse, not inherit history. A CI
 * guard asserts every writer sets the venue explicitly so the column default
 * cannot become a back door to the default this router refuses to have.
 */
export const HISTORICAL_BACKFILL_VENUE: ExecutionVenue = "MT5_EA_BRIDGE";

/** Does this venue's delivery reach a network, where a write may be ambiguous? */
export function venueDeliveryCanBeIndeterminate(venue: ExecutionVenue): boolean {
  // MT5's deliver() is an INSERT into a local mailbox table: it either happened
  // or it did not, so a failure there is provably pre-transmission. A network
  // venue has a third possibility and must be allowed to express it.
  return venue !== "MT5_EA_BRIDGE";
}
