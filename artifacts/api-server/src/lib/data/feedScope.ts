// Feed scope — WHOSE market data a read is for (Truth banners, 2026-11-04).
//
// The chart route pins its MT5 read to the signed-in trader's own bridge
// (Truth audit T2). Every other read that ends up on a trader's screen — the
// AI chat's structural read, the scanner edge, scalp/flame, the timing brain,
// the execution preview, chart intelligence — used to call routeCandles /
// routeQuote unpinned and so described the platform-wide series: the most
// recently pushing bridge of ANY user. With two bridges connected, the chart
// banner and the AI/scanner banners on the same page could describe two
// different brokers' bars.
//
// A feed scope is bound once per API request (see feedScopeMiddleware) and
// read by the router whenever a caller gives no explicit pin, so every surface
// built inside that request reads the same bridge the chart does. Outside a
// request (background sweeps, health probes) there is no scope and reads stay
// platform-wide, exactly as before. An explicit `bridgeConnectionId` option
// always wins over the scope; `null` means "platform-wide on purpose".
//
// Read side only: no gate, kill switch or risk check reads this.

import { AsyncLocalStorage } from "node:async_hooks";

export interface FeedScope {
  /** The reader, or null for a platform-wide scope. */
  readonly userId: number | null;
  /** The reader's active bridge connection id, resolved once per scope. */
  bridgeConnectionId(): Promise<number | null>;
  /** The resolved bridge when known synchronously; `undefined` until resolved. */
  resolvedBridgeConnectionId(): number | null | undefined;
}

export type FeedScopeBridgeLookup = (userId: number) => Promise<number | null>;

const storage = new AsyncLocalStorage<FeedScope>();

/** A scope for a signed-in reader. The bridge lookup runs at most once. */
export function feedScopeForUser(userId: number | null, lookup: FeedScopeBridgeLookup): FeedScope {
  if (userId == null) return PLATFORM_FEED_SCOPE;
  let pending: Promise<number | null> | null = null;
  let resolved: number | null | undefined = undefined;
  return {
    userId,
    bridgeConnectionId() {
      if (resolved !== undefined) return Promise.resolve(resolved);
      pending ??= lookup(userId)
        .then((id) => (typeof id === "number" && Number.isFinite(id) ? id : null))
        .catch(() => null)
        .then((id) => { resolved = id; return id; });
      return pending;
    },
    resolvedBridgeConnectionId: () => resolved,
  };
}

/** A scope whose bridge is already known (a cached recompute, a test). */
export function fixedFeedScope(bridgeConnectionId: number | null, userId: number | null = null): FeedScope {
  return {
    userId,
    bridgeConnectionId: () => Promise.resolve(bridgeConnectionId),
    resolvedBridgeConnectionId: () => bridgeConnectionId,
  };
}

/** No reader: the platform-wide series, as every read behaved before. */
export const PLATFORM_FEED_SCOPE: FeedScope = fixedFeedScope(null);

export function runWithFeedScope<T>(scope: FeedScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentFeedScope(): FeedScope | null {
  return storage.getStore() ?? null;
}

/** The bound reader's bridge, or null outside a scope / with no bridge. */
export async function currentFeedScopeBridge(): Promise<number | null> {
  const scope = storage.getStore();
  if (!scope) return null;
  return scope.bridgeConnectionId();
}

/**
 * The bound reader's bridge when it is already known, for synchronous cache
 * keys. `undefined` while the lookup is still pending (treat as a miss).
 */
export function currentFeedScopeBridgeSync(): number | null | undefined {
  const scope = storage.getStore();
  if (!scope) return null;
  return scope.resolvedBridgeConnectionId();
}

/** Cache-key fragment so one reader's series is never served from another's cache. */
export function feedScopeCacheKey(bridgeConnectionId: number | null | undefined): string {
  return bridgeConnectionId == null ? "shared" : `bridge:${bridgeConnectionId}`;
}
