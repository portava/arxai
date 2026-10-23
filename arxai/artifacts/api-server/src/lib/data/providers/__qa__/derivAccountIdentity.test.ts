// R5 pure slices — Deriv account identity retention + unsubscribe hygiene.
//
// Proves two audit-deriv.md gaps close the honest way:
//   G2 — the authorize payload is RETAINED (loginid, is_virtual, currency,
//        landing company), timestamped, exposed via getAccountIdentity();
//        a REAL account warns ONCE per connect; DERIV_ENVIRONMENT=demo vs a
//        venue-reported REAL account marks identityMismatch; the token is
//        never logged; the domain virtual gate refuses everything but a
//        proven virtual account.
//   G11 — `forget` exists for real now: subscribe responses' subscription ids
//        are retained, unsubscribeTicks emits a targeted `forget` frame and
//        shrinks the subscription set, forgetAllTicks emits `forget_all`, and
//        the keep-alive universe narrows via ARX_DERIV_UNIVERSE (default: the
//        four-symbol Phase 2 set resolved through the canonical map).
//
// Offline determinism: fixture payloads + a fake in-memory socket only — no
// Deriv network, no DB. The WS client is the process-local singleton; private
// state is driven directly (established __qa__ private-state pattern, see
// derivSymbolDiscovery.test.ts) so no real socket ever opens. logger.warn is
// instance-patched to capture calls.
//
// Importing ../derivKeepAlive.js transitively imports marketScanner →
// @workspace/db, whose module init throws when DATABASE_URL is unset. A dummy
// loopback URL satisfies the init; the pg Pool is lazy and NO query is ever
// issued by these tests (same pattern as emergencyKillSwitchPreGate.test.ts).
// The keep-alive module is dynamically imported AFTER the env is set because
// static imports are hoisted above assignments.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/providers/__qa__/derivAccountIdentity.test.ts
// (--test-force-exit: the pino-pretty transport worker keeps the loop alive.)

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getDerivWsClient, type DerivAccountIdentity } from "../derivWsClient.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "../derivProvider.js";
import { logger } from "../../../logger.js";
import { derivContracts } from "@workspace/domain";

const { resolveConfiguredDerivUniverse, DERIV_PHASE2_UNIVERSE_ARX_LABELS } =
  await import("../derivKeepAlive.js");

// configured() must be true so request() proceeds against the FAKE socket —
// with `connected` forced true, ensureConnection() early-returns and no real
// connection is ever attempted.
const envBefore = {
  DERIV_APP_ID: process.env.DERIV_APP_ID,
  DERIV_API_TOKEN: process.env.DERIV_API_TOKEN,
  DERIV_ENVIRONMENT: process.env.DERIV_ENVIRONMENT,
  ARX_DERIV_UNIVERSE: process.env.ARX_DERIV_UNIVERSE,
};
process.env.DERIV_APP_ID = "qa_offline_app_id";
process.env.DERIV_API_TOKEN = "pat_qa_offline_token_NEVER_LOGGED";
delete process.env.DERIV_ENVIRONMENT;
delete process.env.ARX_DERIV_UNIVERSE;

interface PrivateClient {
  retainAccountIdentity: (raw: unknown) => void;
  realAccountWarnedThisConnect: boolean;
  accountIdentity: DerivAccountIdentity | null;
  connected: boolean;
  connecting: boolean;
  ws: unknown;
  handleMessage: (data: unknown) => void;
  subscribedSymbols: Set<string>;
  eagerWarmupSymbols: Set<string>;
  subscriptionIdBySymbol: Map<string, string>;
}

const client = getDerivWsClient();
const priv = client as unknown as PrivateClient;

after(() => {
  // Restore singleton + env so co-scheduled suites see pristine state.
  priv.connected = false;
  priv.connecting = false;
  priv.ws = null;
  priv.subscribedSymbols.clear();
  priv.eagerWarmupSymbols.clear();
  priv.subscriptionIdBySymbol.clear();
  priv.accountIdentity = null;
  priv.realAccountWarnedThisConnect = false;
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Instance-patch logger.warn, run fn, restore; returns captured [obj, msg] args. */
function captureWarns(fn: () => void): Array<unknown[]> {
  const calls: Array<unknown[]> = [];
  const original = logger.warn;
  (logger as unknown as { warn: unknown }).warn = (...args: unknown[]) => { calls.push(args); };
  try {
    fn();
  } finally {
    (logger as unknown as { warn: unknown }).warn = original;
  }
  return calls;
}

// Venue-shaped authorize fixtures (snake_case exactly as the venue sends).
const VIRTUAL_AUTHORIZE = {
  loginid: "VRTC9001234",
  is_virtual: 1,
  currency: "USD",
  landing_company_name: "virtual",
  landing_company_fullname: "Deriv Limited",
};
const REAL_AUTHORIZE = {
  loginid: "CR7654321",
  is_virtual: 0,
  currency: "USD",
  landing_company_name: "svg",
};

// ---------------------------------------------------------------------------
// G2 — identity retention
// ---------------------------------------------------------------------------

test("a virtual authorize is retained with timestamps and no warnings", () => {
  priv.accountIdentity = null;
  priv.realAccountWarnedThisConnect = false;
  const before = Date.now();
  const warns = captureWarns(() => priv.retainAccountIdentity(VIRTUAL_AUTHORIZE));
  assert.equal(warns.length, 0, "a virtual account must not warn");
  const id = client.getAccountIdentity();
  assert.ok(id, "identity retained");
  assert.equal(id!.loginid, "VRTC9001234");
  assert.equal(id!.isVirtual, true);
  assert.equal(id!.currency, "USD");
  assert.equal(id!.landingCompany, "virtual");
  assert.equal(id!.declaredEnvironment, null);
  assert.equal(id!.identityMismatch, false);
  assert.equal(new Date(id!.retainedAt).getTime(), id!.retainedAtMs);
  assert.ok(id!.retainedAtMs >= before && id!.retainedAtMs <= Date.now());
});

test("a REAL account warns exactly ONCE per connect, with the demo-only refusal message", () => {
  priv.accountIdentity = null;
  priv.realAccountWarnedThisConnect = false;
  const warns = captureWarns(() => priv.retainAccountIdentity(REAL_AUTHORIZE));
  assert.equal(warns.length, 1);
  assert.match(String(warns[0][1]), /REAL account/);
  assert.match(String(warns[0][1]), /demo-only/);
  const id = client.getAccountIdentity();
  assert.equal(id!.isVirtual, false);
  assert.equal(id!.identityMismatch, false, "no DERIV_ENVIRONMENT declared → no mismatch, just a real account");
  // Same connect session → deduped.
  assert.equal(captureWarns(() => priv.retainAccountIdentity(REAL_AUTHORIZE)).length, 0);
  // A new connect session (open handler resets the flag) may warn once again.
  priv.realAccountWarnedThisConnect = false;
  assert.equal(captureWarns(() => priv.retainAccountIdentity(REAL_AUTHORIZE)).length, 1);
});

test("DERIV_ENVIRONMENT=demo vs venue REAL account marks identityMismatch and adds the contradiction warning", () => {
  priv.accountIdentity = null;
  priv.realAccountWarnedThisConnect = false;
  process.env.DERIV_ENVIRONMENT = "demo";
  try {
    const warns = captureWarns(() => priv.retainAccountIdentity(REAL_AUTHORIZE));
    assert.equal(warns.length, 2, "real-account warn + contradiction warn");
    assert.match(String(warns[1][1]), /DERIV_ENVIRONMENT=demo contradicts/);
    const id = client.getAccountIdentity();
    assert.equal(id!.identityMismatch, true);
    assert.equal(id!.declaredEnvironment, "demo");

    // demo + virtual is consistent: no mismatch, no warning.
    priv.realAccountWarnedThisConnect = false;
    assert.equal(captureWarns(() => priv.retainAccountIdentity(VIRTUAL_AUTHORIZE)).length, 0);
    assert.equal(client.getAccountIdentity()!.identityMismatch, false);
  } finally {
    delete process.env.DERIV_ENVIRONMENT;
  }
});

test("absent fields stay null — is_virtual missing reads UNKNOWN, never demo", () => {
  priv.accountIdentity = null;
  priv.realAccountWarnedThisConnect = false;
  captureWarns(() => priv.retainAccountIdentity({ currency: "USD" }));
  const id = client.getAccountIdentity();
  assert.equal(id!.loginid, null);
  assert.equal(id!.isVirtual, null, "missing is_virtual must be null (UNKNOWN), not false/true");
  assert.equal(id!.landingCompany, null);
  // Boolean form of is_virtual is tolerated; garbage is not coerced.
  captureWarns(() => priv.retainAccountIdentity({ is_virtual: true }));
  assert.equal(client.getAccountIdentity()!.isVirtual, true);
  captureWarns(() => priv.retainAccountIdentity({ is_virtual: "yes" }));
  assert.equal(client.getAccountIdentity()!.isVirtual, null);
});

test("the token NEVER appears in identity or warning payloads", () => {
  priv.accountIdentity = null;
  priv.realAccountWarnedThisConnect = false;
  const warns = captureWarns(() => priv.retainAccountIdentity(REAL_AUTHORIZE));
  const everything = JSON.stringify({ warns, identity: client.getAccountIdentity() });
  assert.ok(!everything.includes("pat_qa_offline_token_NEVER_LOGGED"), "token leaked into logs/identity");
});

test("the domain virtual gate consumes retained identity: real/unknown refuse, virtual allows", () => {
  priv.realAccountWarnedThisConnect = true; // silence warn noise
  captureWarns(() => priv.retainAccountIdentity(REAL_AUTHORIZE));
  const refused = derivContracts.assertVirtualAccountForExecution(client.getAccountIdentity());
  assert.equal(refused.allowed, false);
  assert.equal(
    (refused as { code: string }).code,
    "DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT",
  );
  // Null identity (no authorize this session) refuses too.
  priv.accountIdentity = null;
  assert.equal(derivContracts.assertVirtualAccountForExecution(client.getAccountIdentity()).allowed, false);
  captureWarns(() => priv.retainAccountIdentity(VIRTUAL_AUTHORIZE));
  const allowed = derivContracts.assertVirtualAccountForExecution(client.getAccountIdentity());
  assert.equal(allowed.allowed, true);
});

// ---------------------------------------------------------------------------
// G11 — forget bookkeeping (fixture subscribe/forget flows, fake socket)
// ---------------------------------------------------------------------------

/** Install an in-memory socket: frames the client sends are captured; the test
 *  answers them via handleMessage. connected=true keeps ensureConnection inert. */
function withFakeSocket<T>(fn: (frames: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const frames: Array<Record<string, unknown>> = [];
  priv.connected = true;
  priv.connecting = false;
  priv.ws = {
    send: (raw: string) => { frames.push(JSON.parse(raw) as Record<string, unknown>); },
  };
  return fn(frames).finally(() => {
    priv.connected = false;
    priv.ws = null;
    priv.subscribedSymbols.clear();
    priv.eagerWarmupSymbols.clear();
    priv.subscriptionIdBySymbol.clear();
  });
}

function respond(msg: Record<string, unknown>): void {
  priv.handleMessage(JSON.stringify(msg));
}

test("subscribe retains the venue subscription id from the subscribe response", () =>
  withFakeSocket(async (frames) => {
    const p = client.subscribeTicks("R_75");
    assert.equal(frames.length, 1);
    assert.equal(frames[0].ticks, "R_75");
    assert.equal(frames[0].subscribe, 1);
    respond({
      req_id: frames[0].req_id,
      msg_type: "tick",
      tick: { symbol: "R_75", epoch: Math.floor(Date.now() / 1000), quote: 12345.6 },
      subscription: { id: "sub-qa-r75" },
    });
    const tick = await p;
    assert.ok(tick && tick.quote === 12345.6);
    assert.ok(priv.subscribedSymbols.has("R_75"));
    assert.equal(priv.subscriptionIdBySymbol.get("R_75"), "sub-qa-r75");
  }));

test("unsubscribeTicks emits a targeted forget frame and the subscription set SHRINKS", () =>
  withFakeSocket(async (frames) => {
    // Arrange a subscribed symbol with a retained id.
    const sub = client.subscribeTicks("1HZ25V");
    respond({
      req_id: frames[0].req_id,
      tick: { symbol: "1HZ25V", epoch: Math.floor(Date.now() / 1000), quote: 500.1 },
      subscription: { id: "sub-qa-1hz25v" },
    });
    await sub;
    assert.ok(priv.eagerWarmupSymbols.has("1HZ25V"), "eager set tracks the subscribe");

    const p = client.unsubscribeTicks("1HZ25V");
    const forgetFrame = frames.find((f) => "forget" in f);
    assert.ok(forgetFrame, "a forget frame must be sent");
    assert.equal(forgetFrame!.forget, "sub-qa-1hz25v", "forget must target the RETAINED id");
    respond({ req_id: forgetFrame!.req_id, forget: 1 });
    const result = await p;
    assert.deepEqual(result, { ok: true, forgot: true });
    assert.ok(!priv.subscribedSymbols.has("1HZ25V"), "subscription set shrank");
    assert.ok(!priv.eagerWarmupSymbols.has("1HZ25V"), "eager set shrank — reconnects will NOT resurrect the stream");
    assert.ok(!priv.subscriptionIdBySymbol.has("1HZ25V"));
  }));

test("unsubscribing a never-subscribed symbol is idempotent and sends nothing", () =>
  withFakeSocket(async (frames) => {
    const result = await client.unsubscribeTicks("BOOM1000");
    assert.deepEqual(result, { ok: true, forgot: false, reason: "not_subscribed" });
    assert.equal(frames.length, 0, "no network frame for a no-op");
  }));

test("subscribed but no retained id: local bookkeeping drops, and the result is HONEST that the venue stream may persist", () =>
  withFakeSocket(async (frames) => {
    priv.subscribedSymbols.add("1HZ75V");
    priv.eagerWarmupSymbols.add("1HZ75V");
    const result = await client.unsubscribeTicks("1HZ75V");
    assert.equal(result.ok, true);
    assert.equal(result.forgot, false, "never claim forgotten without venue confirmation");
    assert.match(result.reason!, /no_subscription_id/);
    assert.equal(frames.length, 0, "forget_all must NOT be substituted — it would kill other consumers' streams");
    assert.ok(!priv.subscribedSymbols.has("1HZ75V"));
    assert.ok(!priv.eagerWarmupSymbols.has("1HZ75V"));
  }));

test("venue answering forget:0 is reported, not upgraded to success", () =>
  withFakeSocket(async (frames) => {
    priv.subscribedSymbols.add("R_75");
    priv.subscriptionIdBySymbol.set("R_75", "sub-stale");
    const p = client.unsubscribeTicks("R_75");
    respond({ req_id: frames[0].req_id, forget: 0 });
    const result = await p;
    assert.equal(result.ok, true);
    assert.equal(result.forgot, false);
    assert.equal(result.reason, "venue_reported_subscription_not_found");
  }));

test("forgetAllTicks emits forget_all:ticks and clears every local subscription set", () =>
  withFakeSocket(async (frames) => {
    priv.subscribedSymbols.add("R_75").add("1HZ50V");
    priv.subscriptionIdBySymbol.set("R_75", "a");
    priv.subscriptionIdBySymbol.set("1HZ50V", "b");
    priv.eagerWarmupSymbols.add("R_75").add("1HZ50V");
    const p = client.forgetAllTicks();
    assert.equal(frames[0].forget_all, "ticks");
    respond({ req_id: frames[0].req_id, forget_all: ["a", "b"] });
    const result = await p;
    assert.deepEqual(result, { ok: true, forgottenCount: 2 });
    assert.equal(priv.subscribedSymbols.size, 0);
    assert.equal(priv.subscriptionIdBySymbol.size, 0);
    assert.equal(priv.eagerWarmupSymbols.size, 0);
  }));

// ---------------------------------------------------------------------------
// Keep-alive universe narrowing (audit collision #5 / G8)
// ---------------------------------------------------------------------------

test("the default universe is the four-symbol Phase 2 set, resolved through the canonical map", () => {
  delete process.env.ARX_DERIV_UNIVERSE;
  const u = resolveConfiguredDerivUniverse();
  assert.equal(u.source, "default");
  assert.deepEqual(u.invalidEntries, []);
  // Resolved via the map — verify against DERIV_SYNTHETIC_SYMBOLS, not literals.
  const expected = DERIV_PHASE2_UNIVERSE_ARX_LABELS.map(
    (label) => DERIV_SYNTHETIC_SYMBOLS.find((s) => s.symbol === label)!.derivId,
  );
  assert.deepEqual(u.derivIds, expected);
  assert.equal(u.derivIds.length, 4);
  // …and the resolved set is a strict narrowing of the 22-symbol map.
  assert.ok(u.derivIds.length < DERIV_SYNTHETIC_SYMBOLS.length);
});

test("ARX_DERIV_UNIVERSE accepts ARX labels or Deriv ids, dedupes, and skips-never-guesses invalid entries", () => {
  const u = resolveConfiguredDerivUniverse(" V75 , 1HZ25V, v75, NOT_A_SYMBOL ,, ");
  assert.equal(u.source, "env");
  assert.deepEqual(u.derivIds, ["R_75", "1HZ25V"]);
  assert.deepEqual(u.invalidEntries, ["NOT_A_SYMBOL"]);
});

test("a fully invalid ARX_DERIV_UNIVERSE falls back to the Phase 2 default WITH the invalid entries reported", () => {
  const u = resolveConfiguredDerivUniverse("GARBAGE1,GARBAGE2");
  assert.equal(u.source, "default");
  assert.deepEqual(u.invalidEntries, ["GARBAGE1", "GARBAGE2"]);
  assert.equal(u.derivIds.length, 4);
});

test("SOURCE PROOF: the keep-alive cycle filters by the resolved universe instead of pinning all 22", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../derivKeepAlive.ts", import.meta.url)),
    "utf8",
  );
  const cycleStart = source.indexOf("async function runKeepAliveCycle");
  assert.ok(cycleStart > 0);
  const resolveAt = source.indexOf("resolveConfiguredDerivUniverse()", cycleStart);
  const filterAt = source.indexOf("universeIds.has(s.derivId)", cycleStart);
  const subscribeAt = source.indexOf("subscribeTicks", cycleStart);
  assert.ok(resolveAt > 0, "cycle must resolve the configured universe");
  assert.ok(filterAt > 0, "cycle must filter DERIV_SYNTHETIC_SYMBOLS by the universe");
  assert.ok(resolveAt < subscribeAt && filterAt < subscribeAt, "narrowing must happen BEFORE any subscribe");
});

// ── Authorize error CODE retention (certification follow-up) ────────────────
// A live certification attempt returned is_virtual/currency null. Diagnosing it
// required wrapping this client in temporary instrumentation, because the
// rejection carried only Deriv's prose message and discarded `error.code` —
// the machine-readable half. The answer turned out to be "InvalidToken", which
// the client had received and thrown away.
//
// The code is enum-like and carries no credential material, so it is retained
// and surfaced; the MESSAGE is deliberately not logged, since Deriv error
// messages can echo request context.

test("the Deriv error code is preserved on the rejection and surfaced", () => {
  const src = readFileSync(
    new URL("../derivWsClient.ts", import.meta.url), "utf8",
  );
  assert.match(src, /derivErrorCode\?: string/, "the rejection must carry the code");
  assert.match(src, /rejection\.derivErrorCode = err\.code/, "the code must be copied off the envelope");
  assert.match(src, /getLastAuthorizeErrorCode\(\): string \| null/, "the code must be readable without instrumenting");
});

test("the code is logged but the authorize message and token never are", () => {
  const src = readFileSync(
    new URL("../derivWsClient.ts", import.meta.url), "utf8",
  );
  const start = src.indexOf("deriv_authorize_failed");
  assert.ok(start > -1, "an authorize failure must be logged");
  const around = src.slice(Math.max(0, start - 400), start + 100);
  assert.match(around, /derivErrorCode/, "the log must carry the code");
  assert.ok(
    !/lastAuthorizeError[^C]/.test(around.split("logger.warn")[1] ?? ""),
    "the prose message must not be logged — it can echo request context",
  );
  assert.ok(!/DERIV_API_TOKEN/.test(around), "the token must never appear near the log call");
});

test("a successful authorize clears BOTH the message and the code", () => {
  const src = readFileSync(
    new URL("../derivWsClient.ts", import.meta.url), "utf8",
  );
  const start = src.indexOf("this.authorized = true;");
  const block = src.slice(start, start + 400);
  assert.match(block, /lastAuthorizeError = null/);
  assert.match(block, /lastAuthorizeErrorCode = null/, "a stale code must not survive a later success");
});
