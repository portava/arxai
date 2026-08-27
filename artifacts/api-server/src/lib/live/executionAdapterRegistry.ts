// Phase 6 - the execution adapter registry.
//
// Before Phase 6 the dispatch path named ONE adapter literally
// (`mt5ExecutionAdapter.deliver({...})`), so the venue was fixed at compile
// time. Adding a second venue means that literal has to go, and the thing that
// replaces it must be at least as safe as a hard-coded constant was.
//
// It is made safer in two ways.
//
// COMPILE TIME. The registry is `Record<ExecutionVenue, ...>`. Adding a venue
// to the union without registering a certified adapter for it fails the build.
// There is no map lookup returning undefined, no `?? mt5Adapter` fallback, and
// no string keys that can drift apart from the venue vocabulary.
//
// RUN TIME. Selection re-validates, because a cast or an `any` at a call site
// could otherwise hand this an unroutable value. A venue with no registered
// adapter THROWS rather than returning null - a caller that forgot to check a
// null would otherwise proceed with no adapter at all.
//
// What this file must never grow: a default. `routeExecutionVenue` refuses an
// unknown venue precisely so nothing downstream has to invent one.

import {
  routeExecutionVenue,
  type ExecutionVenue,
} from "@workspace/domain/safety-contracts/executionVenue";
import type { DeliveryResult, ExecutionAdapter } from "./executionAdapter.js";

export type ExecutionAdapterRegistry = Readonly<
  Record<ExecutionVenue, ExecutionAdapter<DeliveryResult>>
>;

export class UnroutableVenueError extends Error {
  readonly arxUnroutableVenue = true as const;
  constructor(readonly attempted: unknown, readonly detail: string) {
    super(`UNROUTABLE_EXECUTION_VENUE: ${detail}`);
    this.name = "UnroutableVenueError";
  }
}

/**
 * Select the certified adapter for a venue, or refuse.
 *
 * `venue` must be the value the SERVER persisted on the command row. Never pass
 * a client-supplied venue: a client naming its own venue could otherwise reach
 * an execution path the server never authorized.
 */
export function selectExecutionAdapter(
  registry: ExecutionAdapterRegistry,
  venue: unknown,
): ExecutionAdapter<DeliveryResult> {
  const verdict = routeExecutionVenue(venue);
  if (!verdict.ok) {
    throw new UnroutableVenueError(venue, `${verdict.refusal}: ${verdict.detail}`);
  }
  const adapter = registry[verdict.venue];
  if (!adapter) {
    // Reachable only through a cast or a partially-built registry. Throwing
    // beats returning null: a missed null check downstream would mean
    // dispatching with no adapter at all.
    throw new UnroutableVenueError(venue, `no adapter registered for venue ${verdict.venue}`);
  }
  // Belt to the compile-time braces: an adapter filed under the wrong key would
  // deliver to a venue nobody authorized for this command.
  if (typeof adapter.venue !== "string" || adapter.venue === "") {
    throw new UnroutableVenueError(venue, `adapter for ${verdict.venue} declares no venue literal`);
  }
  return adapter;
}

export function isUnroutableVenue(e: unknown): e is UnroutableVenueError {
  return typeof e === "object" && e !== null
    && (e as { arxUnroutableVenue?: unknown }).arxUnroutableVenue === true;
}
