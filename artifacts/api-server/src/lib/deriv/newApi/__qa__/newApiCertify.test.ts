// Read-only certification (spec Phase 14).
//
// The interesting assertions are the REFUSALS. A certification that passes
// when it should not is worse than none: it converts an unproven transport
// into a documented green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertReadOnly, CAPITAL_COMMITTING_KEYS, READ_ONLY_KEYS,
  DerivCertificationRefusal, runReadOnlyCertification,
} from "../certify.js";

// ── The gate ────────────────────────────────────────────────────────────────

test("every capital-committing operation is refused", () => {
  for (const key of CAPITAL_COMMITTING_KEYS) {
    assert.throws(
      () => assertReadOnly({ [key]: 1 }),
      DerivCertificationRefusal,
      `${key} was NOT refused`,
    );
  }
});

test("the gate is an allow-list: an unknown operation is refused by default", () => {
  // This is the property that matters as Deriv adds operations. A deny-list
  // would silently permit anything invented after this file was written.
  assert.throws(() => assertReadOnly({ some_future_trade_op: 1 }), DerivCertificationRefusal);
  for (const key of READ_ONLY_KEYS) {
    assert.doesNotThrow(() => assertReadOnly({ [key]: 1 }), `${key} should be permitted`);
  }
});

test("parameters travel alongside an operation without being mistaken for one", () => {
  // The first version of this gate treated every top-level key as an
  // operation and refused a legal contracts_for for carrying `currency`.
  assert.doesNotThrow(() => assertReadOnly({ ping: 1, req_id: 4, subscribe: 1 }));
  assert.doesNotThrow(() => assertReadOnly(
    { contracts_for: "R_100", currency: "USD", contract_type: "multiplier" }));
  assert.doesNotThrow(() => assertReadOnly({
    proposal: 1, underlying_symbol: "R_100", contract_type: "MULTUP",
    amount: 1, basis: "stake", currency: "USD", multiplier: 100,
  }));
});

test("a payload naming two operations is refused as ambiguous", () => {
  assert.throws(() => assertReadOnly({ ping: 1, portfolio: 1 }), DerivCertificationRefusal);
});

test("an unrecognised parameter is refused even beside a legal operation", () => {
  assert.throws(() => assertReadOnly({ ping: 1, mystery_param: 1 }), DerivCertificationRefusal);
});

test("a buy hidden alongside a legal read is still refused", () => {
  // Catches the shape where an operation is smuggled in beside a permitted
  // one rather than sent on its own.
  assert.throws(() => assertReadOnly({ ping: 1, buy: "p1" }), DerivCertificationRefusal);
});

// ── Fake venue ──────────────────────────────────────────────────────────────

const ACCOUNTS_OK = {
  accounts: [{ account_id: "VRTC9001", account_type: "demo", currency: "USD", status: "active" }],
};
const ACCOUNTS_REAL_ONLY = {
  accounts: [{ account_id: "CR5001", account_type: "real", currency: "USD", status: "active" }],
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

/** A transport that answers from a canned table and RECORDS what was sent. */
function fakeTransport(overrides: Record<string, unknown> = {}, sentSink?: string[]) {
  const answers: Record<string, unknown> = {
    ping: { ping: "pong" },
    time: { time: Math.floor(Date.now() / 1000) },
    active_symbols: { active_symbols: [{ symbol: "R_100" }] },
    contracts_for: { contracts_for: { available: [{ contract_type: "MULTUP" }, { contract_type: "MULTDOWN" }] } },
    proposal: { proposal: { id: "quote-1", ask_price: 1 } },
    balance: { balance: { balance: 10000, currency: "USD" } },
    portfolio: { portfolio: { contracts: [] } },
    ...overrides,
  };
  return () => ({
    connect: async () => {},
    getState: () => "WS_READY",
    getAccountId: () => "VRTC9001",
    close: () => {},
    send: async (p: Record<string, unknown>) => {
      const op = Object.keys(p).find((k) => k !== "req_id" && k !== "subscribe")!;
      sentSink?.push(op);
      if (!(op in answers)) throw new Error(`unexpected op ${op}`);
      return answers[op] as Record<string, unknown>;
    },
  }) as never;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// A syntactically-valid alphanumeric app id + PAT. NOT a real credential:
// these are fixtures, and no real token is ever read by the test suite.
const NEW_ENV = {
  DERIV_API_MODE: "new",
  DERIV_APP_ID: "arx-test-app",
  DERIV_API_TOKEN: "fixture-pat-value-not-a-real-token",
  DERIV_DEMO_ACCOUNT_ID: undefined,
};

// ── Sequence behaviour ──────────────────────────────────────────────────────

test("a full read-only run passes and NEVER sends a capital-committing op", async () => {
  const sent: string[] = [];
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_OK),
    transportFactory: fakeTransport({}, sent),
  }));
  assert.equal(report.passed, true, JSON.stringify(report.steps.filter((s) => s.status === "FAIL")));
  assert.equal(report.haltedAt, null);
  assert.equal(report.steps.length, 13);
  for (const key of CAPITAL_COMMITTING_KEYS) {
    assert.ok(!sent.includes(key), `certification sent ${key}`);
  }
  // A quote WAS taken — that is the point — but never followed by a buy.
  assert.ok(sent.includes("proposal"));
  assert.ok(!sent.includes("buy"));
});

test("a real-only account list HALTS before any session is opened", async () => {
  const sent: string[] = [];
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_REAL_ONLY),
    transportFactory: fakeTransport({}, sent),
  }));
  assert.equal(report.passed, false);
  assert.equal(report.haltedAt, 3, "must halt at demo selection");
  // Nothing was sent at all — the refusal precedes the socket.
  assert.equal(sent.length, 0);
});

test("NO multipliers on the surface is a loud FAIL, not a quiet pass", async () => {
  // The endpoints live under /trading/v1/options/ while ARX trades
  // multipliers. If the surface really is options-only, the transport works
  // and is still useless to ARX — certification must say so.
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_OK),
    transportFactory: fakeTransport({
      contracts_for: { contracts_for: { available: [{ contract_type: "CALL" }] } },
    }),
  }));
  assert.equal(report.passed, false);
  assert.equal(report.haltedAt, 9);
  assert.match(report.steps[8]!.detail, /no MULTUP\/MULTDOWN/);
});

test("a quote with no buyable id fails rather than being reported as a quote", async () => {
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_OK),
    transportFactory: fakeTransport({ proposal: { proposal: { ask_price: 1 } } }),
  }));
  assert.equal(report.passed, false);
  assert.equal(report.haltedAt, 10);
});

test("a partial run is never reported as passed", async () => {
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_OK),
    transportFactory: fakeTransport({ time: { msg_type: "time" } }),
  }));
  assert.equal(report.passed, false);
  assert.equal(report.haltedAt, 7);
  // Halts immediately: later greens after a red invite reading a broken run
  // as a working one.
  assert.equal(report.steps.length, 7);
});

test("legacy mode refuses certification instead of certifying the wrong path", async () => {
  // DERIV_API_MODE must be UNSET here: an explicit mode override wins over
  // detection, and forcing "new" would make this test certify the very
  // fall-through it exists to catch. (It did, on the first run.)
  const report = await withEnv(
    { ...NEW_ENV, DERIV_API_MODE: undefined, DERIV_APP_ID: "1089", DERIV_API_TOKEN: "legacy" },
    () => runReadOnlyCertification({ fetchImpl: fakeFetch(ACCOUNTS_OK), transportFactory: fakeTransport() }));
  assert.equal(report.passed, false);
  assert.equal(report.haltedAt, 1);
});

// ── Output sanitation ───────────────────────────────────────────────────────

test("no step detail carries a token, OTP url, or full account id", async () => {
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_OK), transportFactory: fakeTransport(),
  }));
  const blob = JSON.stringify(report.steps);
  assert.ok(!blob.includes(NEW_ENV.DERIV_API_TOKEN), "PAT leaked into the report");
  assert.ok(!blob.includes("VRTC9001"), "full account id leaked into the report");
  assert.ok(!/otp=/i.test(blob), "an OTP appeared in the report");
  assert.ok(!/authorization/i.test(blob), "a header name appeared in the report");
  // The balance figure is a demo number, but a certification report has no
  // reason to carry an account balance at all.
  assert.ok(!blob.includes("10000"), "an account balance leaked into the report");
});

// ── Source pin ──────────────────────────────────────────────────────────────

test("the certification module contains no buy or sell call site", () => {
  const code = readFileSync(new URL("../certify.ts", import.meta.url), "utf8")
    // Comments discuss buy/sell at length; matching prose would be a false
    // pass, and matching the deny-list literals would be a false failure.
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .replace(/export const CAPITAL_COMMITTING_KEYS[\s\S]*?;\n/, "");
  assert.ok(!/\bmapBuyRequest\b|\bmapSellRequest\b/.test(code),
    "certify.ts references a trade mapper");
  assert.ok(!/send\([^)]*\bbuy\b/.test(code), "certify.ts appears to send a buy");
});

// ── Config coherence (the live "Invalid application" incident) ──────────────

test("a NUMERIC App ID in new mode FAILS step 1 — before any request", async () => {
  // The incident: DERIV_API_MODE=new with a legacy-format App ID. Step 1
  // printed `appId=numeric` and passed anyway; the run then died at step 2 on
  // an HTTP rejection that reads like a credential problem, sending the
  // operator after the token. The token was never implicated.
  const sent: string[] = [];
  const report = await withEnv({ ...NEW_ENV, DERIV_APP_ID: "1089" }, () =>
    runReadOnlyCertification({
      fetchImpl: fakeFetch(ACCOUNTS_OK), transportFactory: fakeTransport({}, sent),
    }));
  assert.equal(report.passed, false);
  assert.equal(report.haltedAt, 1, "must halt at config, not at the venue");
  assert.match(report.steps[0]!.detail, /CONFIGURATION error/);
  assert.match(report.steps[0]!.detail, /not a credential error/);
  // Nothing was sent: the incoherence is detectable without a request.
  assert.equal(sent.length, 0);
});

test("clock skew beyond the OTP freshness margin FAILS step 7", async () => {
  // Step 7 used to compute the skew and pass at any magnitude.
  const stale = Math.floor(Date.now() / 1000) - 600;      // 10 minutes adrift
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_OK),
    transportFactory: fakeTransport({ time: { time: stale } }),
  }));
  assert.equal(report.passed, false);
  assert.equal(report.haltedAt, 7);
  assert.match(report.steps[6]!.detail, /exceeds the .*OTP freshness margin/);
});

test("skew INSIDE the margin still passes — the bound is not a blanket refusal", async () => {
  const slight = Math.floor(Date.now() / 1000) - 3;
  const report = await withEnv(NEW_ENV, () => runReadOnlyCertification({
    fetchImpl: fakeFetch(ACCOUNTS_OK),
    transportFactory: fakeTransport({ time: { time: slight } }),
  }));
  assert.equal(report.passed, true, JSON.stringify(report.steps.filter((s) => s.status === "FAIL")));
});
