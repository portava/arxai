// Deriv NEW API transport (spec Phases 3, 4, 9, 12, 13).
// Deterministic: injected socket + injected fetch. No network, no real timers
// beyond the ones under test.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NewDerivTransport, canSendTradingRequest, DERIV_PUBLIC_WS_URL,
  type DerivSocket,
} from "../transport.js";
import { DerivNewApiError } from "../errors.js";

const src = readFileSync(new URL("../transport.ts", import.meta.url), "utf8");
const CONFIG = { appId: "abc123XYZ", token: "pat-SECRET" };
const DEMO_WS = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=OTP1";

/** Fake socket that records what it was dialled with and what it sent. */
function fakeSocket(record: { url?: string; sent: string[]; sockets: number }) {
  return (url: string): DerivSocket => {
    record.url = url;
    record.sockets += 1;
    const handlers: Record<string, (a?: unknown) => void> = {};
    const sock: DerivSocket = {
      send: (d) => {
        record.sent.push(d);
        // Echo a correlated reply so send() resolves.
        const parsed = JSON.parse(d) as { req_id: number };
        queueMicrotask(() => handlers["message"]?.(JSON.stringify({ req_id: parsed.req_id, ok: true })));
      },
      close: () => handlers["close"]?.(),
      on: (e, cb) => { handlers[e] = cb; },
    };
    queueMicrotask(() => handlers["open"]?.());
    return sock;
  };
}

function otpFetch(wsUrl = DEMO_WS, calls = { n: 0 }): typeof fetch {
  return (async () => {
    calls.n += 1;
    return { ok: true, status: 200, json: async () => ({ ws_url: wsUrl }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ── Phase 9: state machine ──────────────────────────────────────────────────

test("ONLY WS_READY may send a trading request", () => {
  assert.equal(canSendTradingRequest("WS_READY"), true);
  for (const s of ["DISCONNECTED", "REST_AUTHENTICATING", "ACCOUNT_RESOLVED",
    "OTP_REQUESTING", "WS_CONNECTING", "RECONNECTING", "FAILED"] as const) {
    assert.equal(canSendTradingRequest(s), false, `${s} must not send`);
  }
});

test("a request before WS_READY is refused, not queued or dropped silently", async () => {
  const t = new NewDerivTransport(CONFIG, fakeSocket({ sent: [], sockets: 0 }), otpFetch());
  assert.equal(t.getState(), "DISCONNECTED");
  await assert.rejects(() => t.send({ proposal: 1 }), (e: DerivNewApiError) => {
    assert.equal(e.code, "DERIV_NEW_API_WS_CONNECT_FAILED");
    return true;
  });
});

test("connect reaches WS_READY and dials the URL the OTP endpoint returned", async () => {
  const rec: { url?: string; sent: string[]; sockets: number } = { sent: [], sockets: 0 };
  const t = new NewDerivTransport(CONFIG, fakeSocket(rec), otpFetch());
  await t.connect("ACC-D1");
  assert.equal(t.getState(), "WS_READY");
  assert.equal(rec.url, DEMO_WS, "the OTP URL is authoritative and dialled as-is");
  assert.equal(t.getAccountId(), "ACC-D1");
});

// ── Phase 3: no authorize, ever ─────────────────────────────────────────────

test("NO authorize message is sent after the socket opens", async () => {
  const rec = { sent: [] as string[], sockets: 0 };
  const t = new NewDerivTransport(CONFIG, fakeSocket(rec), otpFetch());
  await t.connect("ACC-D1");
  assert.deepEqual(rec.sent, [], "the OTP established the session; authorize would be the legacy flow leaking in");
});

test("the transport module can never reach the legacy path (source invariants)", () => {
  // Match the legacy MESSAGE SHAPE, not the bare word: the error-code name
  // DERIV_NEW_API_UNAUTHORIZED contains "authorize", and a loose regex would
  // fail on correct code while proving nothing.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(!/\bauthorize\s*:/.test(code), "no `authorize:` message key may be constructed");
  assert.ok(!/\{\s*authorize\b/.test(code), "no legacy authorize payload may be built");
  // All of these check CODE, never prose: the comments in this module
  // necessarily NAME the legacy artefacts they forbid, and matching raw source
  // has produced a false failure every time it has been tried here.
  assert.ok(!/1089/.test(code), "no bootstrap app id in code");
  assert.ok(!/derivWsClient/.test(code), "must not import the legacy client");
  assert.ok(!/ws\.derivws\.com/.test(code), "must not reference the legacy host");
});

// ── Phase 2/9: OTP freshness ────────────────────────────────────────────────

test("reconnect obtains a FRESH OTP — an old ticket is never re-dialled", async () => {
  const calls = { n: 0 };
  const rec = { sent: [] as string[], sockets: 0 };
  const t = new NewDerivTransport(CONFIG, fakeSocket(rec), otpFetch(DEMO_WS, calls));
  await t.connect("ACC-D1");
  assert.equal(calls.n, 1);
  await t.reconnect();
  assert.equal(calls.n, 2, "a reconnect must request a new OTP");
  assert.equal(rec.sockets, 2);
  assert.equal(t.getState(), "WS_READY");
});

test("a credential failure during OTP is NOT retried", async () => {
  const calls = { n: 0 };
  const failing = (async () => {
    calls.n += 1;
    return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const t = new NewDerivTransport(CONFIG, fakeSocket({ sent: [], sockets: 0 }), failing);
  await assert.rejects(() => t.connect("ACC-D1"), (e: DerivNewApiError) => {
    assert.equal(e.code, "DERIV_NEW_API_UNAUTHORIZED");
    return true;
  });
  assert.equal(calls.n, 1, "a bad credential will not improve on retry");
  assert.equal(t.getState(), "FAILED");
});

// ── Phase 9: correlation + disconnect ───────────────────────────────────────

test("requests correlate by req_id and resolve independently", async () => {
  const rec = { sent: [] as string[], sockets: 0 };
  const t = new NewDerivTransport(CONFIG, fakeSocket(rec), otpFetch());
  await t.connect("ACC-D1");
  const [a, b] = await Promise.all([t.send({ x: 1 }), t.send({ y: 2 })]);
  assert.equal((a as { req_id: number }).req_id, 1);
  assert.equal((b as { req_id: number }).req_id, 2);
  assert.equal(rec.sent.length, 2);
  assert.ok(JSON.parse(rec.sent[0]!).req_id !== JSON.parse(rec.sent[1]!).req_id);
});

test("a close REJECTS in-flight requests rather than leaving them hanging", async () => {
  const handlers: Record<string, (a?: unknown) => void> = {};
  const silentSocket = (): DerivSocket => {
    const s: DerivSocket = {
      send: () => { /* never replies */ },
      close: () => handlers["close"]?.(),
      on: (e, cb) => { handlers[e] = cb; },
    };
    queueMicrotask(() => handlers["open"]?.());
    return s;
  };
  const t = new NewDerivTransport(CONFIG, silentSocket, otpFetch());
  await t.connect("ACC-D1");
  const inflight = t.send({ proposal: 1 });
  t.close();
  await assert.rejects(() => inflight, (e: DerivNewApiError) => {
    assert.equal(e.code, "DERIV_NEW_API_WS_CONNECT_FAILED");
    return true;
  });
});

test("a venue error is TRADING_REJECTED, never a credential verdict", async () => {
  const handlers: Record<string, (a?: unknown) => void> = {};
  const errSocket = (): DerivSocket => {
    const s: DerivSocket = {
      send: (d) => {
        const { req_id } = JSON.parse(d) as { req_id: number };
        queueMicrotask(() => handlers["message"]?.(
          JSON.stringify({ req_id, error: { code: "ContractBuyValidationError" } }),
        ));
      },
      close: () => handlers["close"]?.(),
      on: (e, cb) => { handlers[e] = cb; },
    };
    queueMicrotask(() => handlers["open"]?.());
    return s;
  };
  const t = new NewDerivTransport(CONFIG, errSocket, otpFetch());
  await t.connect("ACC-D1");
  await assert.rejects(() => t.send({ buy: "x" }), (e: DerivNewApiError) => {
    assert.equal(e.code, "DERIV_NEW_API_TRADING_REJECTED");
    assert.equal(e.derivCode, "ContractBuyValidationError");
    return true;
  });
});

// ── Phase 4 + 11 ────────────────────────────────────────────────────────────

test("the public endpoint is separate and is NOT the authenticated one", () => {
  assert.equal(DERIV_PUBLIC_WS_URL, "wss://api.derivws.com/trading/v1/options/ws/public");
  assert.ok(!DERIV_PUBLIC_WS_URL.includes("otp"), "the public socket carries no OTP");
});

test("neither the PAT nor the OTP is ever logged", () => {
  // The real property: wherever the OTP URL appears near a log call it must be
  // wrapped in the redactor. A naive "does the substring appear" check would
  // flag describeOtpUrlForLog(ticket.wsUrl) — which is the FIX, not the leak.
  const bareWsUrlInLog = /logger\.\w+\([\s\S]{0,200}?(?<!describeOtpUrlForLog\()ticket\.wsUrl/;
  assert.ok(!bareWsUrlInLog.test(src), "an OTP URL may only be logged through describeOtpUrlForLog");
  assert.match(src, /endpoint: describeOtpUrlForLog\(/, "the redactor must actually be used");

  // The PAT must never be referenced anywhere near a log call.
  const logRegions = src.match(/logger\.\w+\([\s\S]{0,200}/g) ?? [];
  assert.ok(logRegions.length > 0, "the transport must log its lifecycle");
  for (const region of logRegions) {
    assert.ok(!/\.token\b/.test(region), "the PAT must never appear in a log call");
    assert.ok(!/Bearer/.test(region), "no Authorization material in logs");
  }
});
