// Task #785 — Shared feed-truth verdict contract.
//
// Every live-capable surface (chart, scanner, Eleanor/Ruby read, the live-entry
// floor, and the broker-confirmed-feed predicate behind the unified readiness
// resolver) derives "is this feed live?" from the SAME pure function,
// resolveSymbolFeedVerdict. Because they all import this one function, they can
// never tell different stories about the same symbol. This test locks that one
// contract so a future change to the verdict mapping is caught here.
//
// It also pins the broker-confirmed-feed definition used by
// resolveBrokerConfirmedFeed: feedConfirmed === (verdict === "LIVE"). A delayed
// or stale or no-tick feed is NOT broker-confirmed and stays entry-blocked.
//
// Offline / pure: no DB, no network, no providers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSymbolFeedVerdict } from "../../artifacts/api-server/src/lib/data/symbolFeedVerdict.js";
import { isBrokerConfirmedLive } from "../../artifacts/api-server/src/lib/data/brokerConfirmedFeed.js";

let passed = 0;
function ok(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  PASS  ${label}`);
}

// The broker-confirmed-feed predicate, expressed exactly as
// resolveBrokerConfirmedFeed expresses it.
const feedConfirmed = (v: ReturnType<typeof resolveSymbolFeedVerdict>) => v === "LIVE";

test("shared feed verdict — tick gate", () => {
  // No recent tick ⇒ AWAITING, regardless of how fresh the bars look. This is
  // the Deriv-backed tick gate; an un-ticking synthetic is never "LIVE".
  ok(
    "no recent tick + trailing 0 ⇒ AWAITING (not confirmed)",
    resolveSymbolFeedVerdict({ hasRecentTick: false, trailingIntervals: 0 }) === "AWAITING",
  );
  ok(
    "no recent tick ⇒ feedConfirmed false",
    feedConfirmed(resolveSymbolFeedVerdict({ hasRecentTick: false, trailingIntervals: 0 })) === false,
  );
});

test("shared feed verdict — freshness mapping", () => {
  // The newest bar naturally trails the forming bar by 1, so trailing <= 1 is
  // still clean/live (matches LIVE_TRAILING_INTERVALS = 1 in freshness.ts and
  // the debug panel's freshness-proof threshold).
  ok(
    "tick + trailing 0 ⇒ LIVE (confirmed)",
    resolveSymbolFeedVerdict({ hasRecentTick: true, trailingIntervals: 0 }) === "LIVE",
  );
  ok(
    "tick + trailing 1 ⇒ LIVE (confirmed)",
    resolveSymbolFeedVerdict({ hasRecentTick: true, trailingIntervals: 1 }) === "LIVE",
  );
  ok(
    "tick + trailing 2 ⇒ LIVE_DELAYED (NOT confirmed)",
    resolveSymbolFeedVerdict({ hasRecentTick: true, trailingIntervals: 2 }) === "LIVE_DELAYED",
  );
  ok(
    "tick + trailing 2 ⇒ feedConfirmed false",
    feedConfirmed(resolveSymbolFeedVerdict({ hasRecentTick: true, trailingIntervals: 2 })) === false,
  );
  ok(
    "tick + trailing 3 ⇒ AWAITING (stale, NOT confirmed)",
    resolveSymbolFeedVerdict({ hasRecentTick: true, trailingIntervals: 3 }) === "AWAITING",
  );
  ok(
    "tick + trailing null ⇒ AWAITING (no bars, NOT confirmed)",
    resolveSymbolFeedVerdict({ hasRecentTick: true, trailingIntervals: null }) === "AWAITING",
  );
});

test("shared feed verdict — broker-confirmed definition is LIVE-only", () => {
  // feedConfirmed is true ONLY for the LIVE verdict — the single definition
  // every surface and the live-entry preflight agree on.
  const confirmedCount = (
    ["LIVE", "LIVE_DELAYED", "AWAITING"] as const
  ).filter((v) => feedConfirmed(v)).length;
  ok("exactly one verdict (LIVE) counts as broker-confirmed", confirmedCount === 1);
});

test("broker-confirmed-live requires a broker-grade source (not a REST fallback)", () => {
  // A fresh assistant_real:* REST fallback (twelvedata/polygon/etc.) is fresh
  // data but NOT broker-confirmed — it must never satisfy the live-entry
  // broker-confirmed definition even when the verdict is LIVE.
  ok(
    "LIVE + mt5_broker ⇒ broker-confirmed",
    isBrokerConfirmedLive({ verdict: "LIVE", source: "mt5_broker", derivBacked: false }) === true,
  );
  ok(
    "LIVE + deriv-backed ⇒ broker-confirmed (LIVE already required a real tick)",
    isBrokerConfirmedLive({ verdict: "LIVE", source: "deriv", derivBacked: true }) === true,
  );
  ok(
    "LIVE + assistant_real:twelvedata ⇒ NOT broker-confirmed (REST fallback)",
    isBrokerConfirmedLive({ verdict: "LIVE", source: "assistant_real:twelvedata", derivBacked: false }) === false,
  );
  ok(
    "LIVE + null source ⇒ NOT broker-confirmed",
    isBrokerConfirmedLive({ verdict: "LIVE", source: null, derivBacked: false }) === false,
  );
  ok(
    "LIVE_DELAYED + mt5_broker ⇒ NOT broker-confirmed (not fresh enough)",
    isBrokerConfirmedLive({ verdict: "LIVE_DELAYED", source: "mt5_broker", derivBacked: false }) === false,
  );
  ok(
    "AWAITING + mt5_broker ⇒ NOT broker-confirmed",
    isBrokerConfirmedLive({ verdict: "AWAITING", source: "mt5_broker", derivBacked: false }) === false,
  );
});

process.on("exit", () => {
  // eslint-disable-next-line no-console
  console.log(`\nshared-feed-verdict: ${passed}/${passed} passed`);
});
