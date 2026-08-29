// @vitest-environment node
// Capability #46 — escape-route page honesty (source-text scan, node env).
//
// The escape route is a safety surface: what it CLAIMS about the user's broker
// matters as much as what it renders. These assertions treat wording and data
// flow as behaviour, on STRIPPED source so the page's own comments (which name
// the forbidden patterns) cannot satisfy a match.

import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const RAW = readFileSync(new URL("./escape-route.tsx", import.meta.url), "utf8");
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const APP = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

test("the page is registered as a route — an unreachable escape route helps nobody", () => {
  expect(APP).toMatch(/EscapeRoutePage/);
  expect(APP).toMatch(/path="\/escape-route"/);
});

test("all content comes from the API, none is invented client-side", () => {
  // The single data source is the /api/me/escape-route endpoint.
  expect(SRC).toMatch(/fetch\("\/api\/me\/escape-route"/);
  // No hard-coded broker identities: the page must not carry a fallback broker,
  // server, or account value that could masquerade as real connection data.
  expect(/Deriv|MetaQuotes|ICMarkets|Exness/i.test(SRC)).toBe(false);
  // Unsourced fields render an explicit admission, not a guess.
  expect(SRC).toMatch(/"Not reported"/);
});

test("unavailable reasons and unknown-value steps are surfaced, not hidden", () => {
  expect(SRC).toMatch(/unavailableReason/);
  expect(SRC).toMatch(/usesUnknownValue/);
  expect(SRC).toMatch(/connectionsUnavailableReason/);
});

test("staleness is explicit and the broker is named as the truth", () => {
  expect(SRC).toMatch(/STALE/);
  expect(SRC).toMatch(/broker's own Trade tab is the truth|broker.+is the truth/i);
});

test("the page is read-only: no POST/mutation and no order verbs", () => {
  expect(/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(SRC)).toBe(false);
  expect(/placeOrder|closePosition|submitTrade/i.test(SRC)).toBe(false);
});

test("the non-custody statement is rendered from the API payload", () => {
  expect(SRC).toMatch(/nonCustodyStatement/);
});

test("errors are honest errors — no fabricated fallback page on fetch failure", () => {
  expect(SRC).toMatch(/Failed to load the escape route/);
  // On error, connections are never rendered from a default object.
  expect(/catch[^}]*setPage\(/.test(SRC)).toBe(false);
});
