/**
 * Typed provenance envelope — the seed for gate #19.
 *
 * ARX's standing failure mode is a number that LOOKS like a market reading but
 * was invented, interpolated, or is hours stale. Once such a number is a bare
 * `number` in a function signature, nothing downstream can tell it apart from a
 * real tick, and it can size a live position.
 *
 * The remedy is to stop passing bare numbers: a value that could influence a
 * trade travels inside a `Provenanced<T>` that names WHERE it came from
 * (`source`), WHEN it was true (`asOf`) and WHICH feed produced it
 * (`sourceId`). A single predicate — `isTradeable` — decides whether that
 * origin is good enough to size from.
 *
 * SCOPE — read this carefully, it has changed. Gate #19 PROVENANCE_UNPROVEN
 * now EXISTS and is enforced by the 23-gate evaluator; the "later work order"
 * this comment used to describe has been done. What is still true is narrower:
 * the dispatch path does not import THIS file. The gate's origin taxonomy and
 * its tradeable-origin predicate are structurally MIRRORED in
 * `lib/domain/src/safety-contracts/foundationGates.ts`
 * (`CommandProvenanceSource` / `isTradeableProvenanceSource`), because
 * `lib/domain` cannot import from `api-server` without inverting the dependency
 * direction. The two are pinned against each other by `test:foundation-gates`
 * so they cannot drift silently. The envelope actually carried on a live
 * command is parsed by the sibling module `./commandProvenance.ts`, which IS
 * on the dispatch path via `../live/foundationGateInputs.ts`.
 *
 * So: this file is the canonical taxonomy definition and is unit-tested
 * (`scripts/src/provenanceEnvelopeTest.ts`); it is not itself a runtime
 * dependency of the evaluator.
 *
 * This file deliberately imports nothing, so it can be pulled into any layer
 * (including the DB and domain packages) without dragging a dependency graph
 * along.
 */

/**
 * Where a value came from.
 *
 * - `LIVE_TICK`  — a fresh reading straight off a broker/exchange feed.
 * - `DERIVED`    — computed deterministically from LIVE_TICK inputs (a mid
 *                  price, a spread, a bar aggregated from ticks). Trustworthy
 *                  exactly as far as its inputs are.
 * - `MODEL`      — the output of a fitted/learned model. May be excellent; is
 *                  still not an observation, and must never be displayed or
 *                  sized as if it were one.
 * - `SYNTHETIC`  — generated for simulation, backtest or demo purposes.
 * - `UNKNOWN`    — origin could not be established. The honest default.
 * - `STALE`      — was a real reading, but is now too old to act on.
 */
export type ProvenanceSource =
  | "LIVE_TICK"
  | "DERIVED"
  | "MODEL"
  | "SYNTHETIC"
  | "UNKNOWN"
  | "STALE";

/** A value together with the facts needed to judge whether to trust it. */
export interface Provenanced<T> {
  /** The value itself. */
  value: T;
  /** Where it came from. */
  source: ProvenanceSource;
  /** ISO-8601 instant the value was true as of. */
  asOf: string;
  /** Stable identifier of the producing feed, e.g. `"mt5:EURUSD"`. */
  sourceId: string;
}

/**
 * Sentinel for "there is no value".
 *
 * A unique (non-registered) symbol, so it can never be confused with `0`,
 * `-0`, `NaN`, `null`, `undefined`, `""` or `false` — the values a missing
 * reading most often decays into, every one of which is silently arithmetic-
 * compatible and therefore silently wrong.
 */
export const NO_DATA = Symbol("NO_DATA");

/**
 * The only origins that may size a live position.
 *
 * Written as an explicit ALLOW-list, never as a deny-list: an origin this
 * function does not recognise — including a `ProvenanceSource` member added
 * later without revisiting this predicate — is refused. Fail closed.
 */
export function isTradeable(p: Pick<Provenanced<unknown>, "source">): boolean {
  return p.source === "LIVE_TICK" || p.source === "DERIVED";
}
