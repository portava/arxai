// Deriv diagnostics honesty — `authorized` is the session's REAL authorize
// state, never inferred from feed health.
//
// The defect: admin market-data diagnostics reported `authorized: true`
// whenever ticks were flowing (healthSummary === "healthy") — so a Ruling-15
// public-data-only session (which deliberately NEVER sends `authorize`)
// presented as an authorized session, and a genuinely authorized session with
// no recent tick presented as unauthorized. This suite locks:
//   1. getDerivFeedStatus().authorized mirrors client.isAuthorized() exactly,
//      independent of tick flow.
//   2. `publicDataOnly` flags the deliberate credential-free session so the
//      operator can read "public data, unauthorized by design" truthfully.
//   3. Source anchor: the router diagnostics pass the REAL flag through and no
//      longer derive `authorized` from healthSummary.
//
// Determinism: same stubbed-singleton idiom as derivSymbolFeedStatus.test.ts —
// ensureConnection is a no-op, no socket opens, no DB or network is touched.
//
// Run: node --import tsx --test src/lib/data/providers/__qa__/derivAuthorizedDiagnostics.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getDerivWsClient, DERIV_PUBLIC_DATA_ONLY } from "../derivWsClient.js";
import { getDerivFeedStatus } from "../derivProvider.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Force "configured"; no token so the AUTH_FAILED branch stays out of play.
const ORIGINAL_APP_ID = process.env.DERIV_APP_ID;
process.env.DERIV_APP_ID = ORIGINAL_APP_ID && ORIGINAL_APP_ID.trim() ? ORIGINAL_APP_ID : "test-app-id";
delete process.env.DERIV_API_TOKEN;

// Seed a deterministic, fully-connected client with NO real socket.
const client = getDerivWsClient() as unknown as {
  ensureConnection: () => void;
  connected: boolean;
  activeSymbolsCount: number | null;
  authorized: boolean;
  lastAuthorizeError: string | null;
  lastTickAt: number | null;
};
client.ensureConnection = () => {};
client.connected = true;
client.activeSymbolsCount = 14;

test("ticks flowing on a public-data-only session: authorized=false, publicDataOnly=true, still healthy", () => {
  client.authorized = false;
  client.lastAuthorizeError = DERIV_PUBLIC_DATA_ONLY; // Ruling 15 sentinel
  client.lastTickAt = Date.now(); // live ticks streaming

  const s = getDerivFeedStatus();
  assert.equal(s.healthSummary, "healthy", "streaming ticks keep the feed healthy");
  assert.equal(s.authorized, false, "feed health must NEVER imply an authorize happened");
  assert.equal(s.publicDataOnly, true, "the deliberate credential-free session says so explicitly");
});

test("an authorized session with NO recent tick still reports authorized=true", () => {
  client.authorized = true;
  client.lastAuthorizeError = null;
  client.lastTickAt = null; // no tick yet — warming, not unauthorized

  const s = getDerivFeedStatus();
  assert.notEqual(s.healthSummary, "healthy", "no recent tick ⇒ not healthy");
  assert.equal(s.authorized, true, "a real authorize is not erased by a quiet feed");
  assert.equal(s.publicDataOnly, false);
});

test("source anchor: router diagnostics pass the real flag through (no health-derived authorized)", () => {
  const src = readFileSync(resolve(HERE, "../../marketDataRouter.ts"), "utf8");
  assert.ok(
    /authorized: deriv\.authorized,/.test(src),
    "getRouterDiagnostics must emit the client's real authorize state",
  );
  assert.ok(
    /publicDataOnly: deriv\.publicDataOnly,/.test(src),
    "getRouterDiagnostics must emit the publicDataOnly companion flag",
  );
  assert.ok(
    !/authorized: deriv\.healthSummary/.test(src),
    "authorized must never be derived from feed health again",
  );
});
