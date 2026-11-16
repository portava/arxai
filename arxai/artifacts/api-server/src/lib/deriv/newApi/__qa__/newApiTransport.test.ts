// Deriv NEW API transport (spec Phases 3, 4, 9, 12, 13).
// Deterministic: injected socket + injected fetch. No network, no real timers
// beyond the ones under test.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NewDerivTransport, canSendTradingRequest, DERIV_PUBLIC_WS_URL,
  DERIV_WS_REQUEST_TIMEOUT_MS, type DerivSocket,
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
    // A REAL Response: the cast-object fixture had no headers and no text(),
    // so client code touching either crashed inside a catch and surfaced as
    // the wrong error code.
    return new Response(JSON.stringify({ ws_url: wsUrl }), {
      status: 200, headers: { "content-type": "application/json" },
    });
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
    return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
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

// ── Ruling 15a separation, tree-wide (spec Phase 12) ────────────────────────
//
// The original pin covered transport.ts alone. Every module added since —
// wire, certify, apiMode — could have reintroduced the fall-through the ruling
// exists to prevent, and no test would have noticed. This scans the whole
// new-API tree instead of one file, so a NEW module is covered the moment it
// is created rather than whenever someone remembers to extend a list.

test("NO module in the new-API tree reaches the legacy generation", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 6, `expected the new-API tree, found ${files.length} file(s)`);

  for (const file of files) {
    const code = readFileSync(new URL(file, dir), "utf8")
      // Comments in this tree DISCUSS the legacy path constantly — that is
      // the point of the ruling. Matching prose would be a false failure,
      // the mirror of the comment-trap that produced false passes.
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    assert.ok(!/derivWsClient/.test(code),
      `${file} imports the legacy client — new mode must not fall through to it`);
    assert.ok(!/ws\.derivws\.com|\/websockets\/v3/.test(code),
      `${file} names the legacy WebSocket host`);
    assert.ok(!/\b1089\b/.test(code),
      `${file} references the bootstrap app id`);
    // An `authorize` PAYLOAD is the legacy handshake. The word appears in
    // error codes (DERIV_NEW_API_UNAUTHORIZED) and in prose, so match the
    // message shape a real handshake would build.
    assert.ok(!/\bauthorize\s*:/.test(code),
      `${file} builds an authorize payload`);
  }
});

// ── Rejection classification (the live step-9 InputValidationFailed) ────────

/** A socket that answers every request with one Deriv error object. */
function rejectingSocket(error: Record<string, unknown>) {
  const handlers: Record<string, (a?: unknown) => void> = {};
  const factory = (): DerivSocket => {
    const s: DerivSocket = {
      send: (d) => {
        const { req_id } = JSON.parse(d) as { req_id: number };
        queueMicrotask(() => handlers["message"]?.(JSON.stringify({ req_id, error })));
      },
      close: () => handlers["close"]?.(),
      on: (e, cb) => { handlers[e] = cb; },
    };
    queueMicrotask(() => handlers["open"]?.());
    return s;
  };
  return factory;
}

test("a rejected READ-ONLY query is not reported as a rejected TRADE", async () => {
  // The live run reported contracts_for failing as DERIV_NEW_API_TRADING_REJECTED.
  // Nothing was traded. Saying a trade was refused when none was attempted is
  // the kind of claim this system exists to never make.
  const t = new NewDerivTransport(CONFIG, rejectingSocket({ code: "InputValidationFailed" }), otpFetch());
  await t.connect("ACC-D1");
  await assert.rejects(() => t.send({ contracts_for: "R_100", currency: "USD" }),
    (e: DerivNewApiError) => {
      assert.equal(e.code, "DERIV_NEW_API_REQUEST_REJECTED");
      assert.notEqual(e.code, "DERIV_NEW_API_TRADING_REJECTED");
      assert.equal(e.derivCode, "InputValidationFailed");
      assert.match(e.detail!, /op=contracts_for/);
      return true;
    });
});

test("a rejected BUY is still TRADING_REJECTED", async () => {
  // The distinction must not erase the category that matters.
  const t = new NewDerivTransport(CONFIG, rejectingSocket({ code: "InsufficientBalance" }), otpFetch());
  await t.connect("ACC-D1");
  await assert.rejects(() => t.send({ buy: "quote-1", price: 10 }),
    (e: DerivNewApiError) => {
      assert.equal(e.code, "DERIV_NEW_API_TRADING_REJECTED");
      assert.equal(e.derivCode, "InsufficientBalance");
      return true;
    });
});

test("a validation failure names the offending FIELDS, never their values", async () => {
  // InputValidationFailed alone says only that something in the payload was
  // wrong. The field names are what identify which part; the values are not
  // reported and could echo request content.
  const t = new NewDerivTransport(CONFIG, rejectingSocket({
    code: "InputValidationFailed",
    details: { contract_type: "SECRET-VALUE-HERE", currency: "also-secret" },
  }), otpFetch());
  await t.connect("ACC-D1");
  await assert.rejects(() => t.send({ contracts_for: "R_100" }),
    (e: DerivNewApiError) => {
      assert.match(e.detail!, /fields:\[contract_type,currency\]/);
      assert.ok(!e.detail!.includes("SECRET-VALUE-HERE"), "a details VALUE leaked");
      assert.ok(!`${e.message}`.includes("also-secret"), "a details VALUE leaked into the message");
      return true;
    });
});

// ── Late / orphan replies (audit priority 1) ───────────────────────────────
//
// A reply arriving after ARX gave up is still the venue's answer to a question
// ARX asked. Discarding it turns a recoverable UNKNOWN into a position nobody
// can find. Adopting one whose ownership cannot be proven would be invention.
// req_id separates the two: it is per-instance and never reused.

/** A socket whose replies the test releases by hand. */
function manualSocket() {
  const h: Record<string, (a?: unknown) => void> = {};
  const frames: Array<Record<string, unknown>> = [];
  const factory = (): DerivSocket => {
    const s: DerivSocket = {
      send: (d) => { frames.push(JSON.parse(d) as Record<string, unknown>); },
      close: () => h["close"]?.(),
      on: (e, cb) => { h[e] = cb; },
    };
    queueMicrotask(() => h["open"]?.());
    return s;
  };
  return {
    factory, frames,
    deliver: (m: Record<string, unknown>) => h["message"]?.(JSON.stringify(m)),
    error: () => h["error"]?.(new Error("post-open")),
    lastReqId: () => frames[frames.length - 1]?.["req_id"] as number,
  };
}

test("req_id is MONOTONIC across reconnect — a late reply is attributable", async () => {
  // The whole orphan design rests on this. If ids reset, a reply could be
  // attributed to the wrong request and resolving an UNKNOWN from one would
  // be fabrication rather than evidence.
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  const p1 = t.send({ ping: 1 }); m.deliver({ req_id: m.lastReqId(), ping: "pong" }); await p1;
  const before = m.lastReqId();
  await t.reconnect();
  const p2 = t.send({ ping: 1 }); m.deliver({ req_id: m.lastReqId(), ping: "pong" }); await p2;
  assert.ok(m.lastReqId() > before, `req_id went ${before} -> ${m.lastReqId()}; ids could collide`);
});

test("a LATE reply for a timed-out request is RETAINED, not discarded", async () => {
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  const inflight = t.send({ buy: "q", price: 1 }).catch((e: DerivNewApiError) => e.code);
  const id = m.lastReqId();
  // Force the give-up path the same way a timeout does.
  t.close();
  assert.equal(await inflight, "DERIV_NEW_API_WS_CONNECT_FAILED");

  // The venue answers afterwards, carrying a real receipt.
  m.deliver({ req_id: id, buy: { contract_id: 4242, buy_price: 1 } });
  const orphans = t.takeOrphanReplies();
  assert.equal(orphans.length, 1, "authoritative late evidence was dropped");
  assert.equal(orphans[0]!.op, "buy", "the op must come from what ARX ISSUED, not the reply");
  assert.equal((orphans[0]!.body["buy"] as { contract_id: number }).contract_id, 4242);
});

test("a reply for a req_id ARX NEVER issued is discarded, never adopted", async () => {
  // Adopting it would mean inventing an outcome from a message whose
  // ownership cannot be established.
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  m.deliver({ req_id: 999999, buy: { contract_id: 1, buy_price: 1 } });
  assert.deepEqual(t.takeOrphanReplies(), [], "adopted a reply ARX never asked for");
});

test("draining orphans is one-shot — the same evidence cannot resolve twice", async () => {
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  const inflight = t.send({ sell: 555, price: 0 }).catch(() => "gone");
  const id = m.lastReqId();
  t.close();
  await inflight;
  m.deliver({ req_id: id, sell: { contract_id: 555, sold_for: 1.2 } });
  assert.equal(t.takeOrphanReplies().length, 1);
  assert.equal(t.takeOrphanReplies().length, 0, "the same late reply was served twice");
});

// ── Termination (audit priority 2) ─────────────────────────────────────────

test("a POST-OPEN socket error stops the transport claiming WS_READY", async () => {
  // Measured before the fix: the state stayed WS_READY over a broken socket,
  // so canSendTradingRequest() returned true and a BUY could be dispatched
  // into it. Claiming a readiness ARX cannot substantiate is the
  // connection-level form of being falsely certain.
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  assert.equal(t.getState(), "WS_READY");
  m.error();
  assert.notEqual(t.getState(), "WS_READY", "still claims readiness over a broken socket");
  assert.equal(canSendTradingRequest(t.getState()), false, "would still dispatch an order");
});

test("a post-open error REJECTS in-flight requests instead of leaving them pending", async () => {
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  let settledWith: string | null = null;
  const inflight = t.send({ buy: "q", price: 1 })
    .then(() => { settledWith = "resolved"; })
    .catch((e: DerivNewApiError) => { settledWith = e.code; });
  m.error();
  await inflight;
  // Before the fix this sat pending for the full 20s request timeout.
  assert.equal(settledWith, "DERIV_NEW_API_WS_CONNECT_FAILED");
});

test("a pre-transmission refusal is marked NOT WRITTEN; an in-flight loss is WRITTEN", async () => {
  // The distinction the harness needs to tell a provable no-trade from an
  // unknowable one. Its own order counter cannot supply it: the counter
  // records INTENT before the write, so it is >=1 either way.
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");

  // In flight, then the socket dies: the bytes WERE written.
  const inflight = t.send({ buy: "q", price: 1 }).catch((e: DerivNewApiError) => e);
  t.close();
  const written = await inflight as DerivNewApiError;
  assert.equal(written.wireWritten, true);

  // Now the transport is closed: a further send is refused before any write.
  const refused = await t.send({ buy: "q", price: 1 }).catch((e: DerivNewApiError) => e) as DerivNewApiError;
  assert.equal(refused.wireWritten, false, "a pre-transmission refusal claimed the frame was written");
});

test("a TIMED-OUT request is marked WRITTEN — silence is not evidence of non-execution", async (t) => {
  // Must exercise the TIMEOUT path specifically. An earlier version of this
  // test used close(), which takes the onClose path — so the timeout branch
  // was never touched and a mutation flipping it stayed green.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const m = manualSocket();
    const tr = new NewDerivTransport(CONFIG, m.factory, otpFetch());
    const connecting = tr.connect("ACC-D1");
    await Promise.resolve();                 // let the OTP fetch settle
    t.mock.timers.tick(1);
    await connecting;

    const before = m.frames.length;
    const p = tr.send({ buy: "q", price: 1 }).catch((e: DerivNewApiError) => e);
    assert.equal(m.frames.length, before + 1, "precondition: the frame reached the socket");

    t.mock.timers.tick(DERIV_WS_REQUEST_TIMEOUT_MS + 10);
    const e = await p as DerivNewApiError;
    assert.equal(e.code, "DERIV_NEW_API_REQUEST_TIMEOUT");
    // The frame WAS written. Marking it not-written would let the harness
    // report a clean no-trade for an order the venue may have executed.
    assert.equal(e.wireWritten, true, "a written frame was marked not-written");
  } finally {
    t.mock.timers.reset();
  }
});

test("the REAL transport records an outbound frame only AFTER the write succeeds", async () => {
  // Evidence must never be able to claim a frame reached the venue when the
  // write threw. Exercised against the REAL transport: a fake one cannot prove
  // the ordering, and an earlier version of this test used one — so the
  // mutation that moved the record before the write stayed green.
  const observed: Array<{ dir: string; raw: string }> = [];
  const h: Record<string, (a?: unknown) => void> = {};
  const factory = (): DerivSocket => {
    const s: DerivSocket = {
      send: () => { throw new Error("write failed"); },
      close: () => h["close"]?.(),
      on: (e, cb) => { h[e] = cb; },
    };
    queueMicrotask(() => h["open"]?.());
    return s;
  };
  const t = new NewDerivTransport(CONFIG, factory, otpFetch(),
    (dir, raw) => { observed.push({ dir, raw }); });
  await t.connect("ACC-D1");

  const err = await t.send({ ping: 1 }).catch((e: DerivNewApiError) => e) as DerivNewApiError;
  assert.equal(err.wireWritten, false, "a failed write claimed transmission");
  assert.equal(observed.filter((o) => o.dir === "out").length, 0,
    "recorded an outbound frame for a write that threw");
});

test("the REAL transport records an outbound frame when the write DOES succeed", async () => {
  // The mirror, so the test above cannot pass by the observer never firing.
  const observed: Array<{ dir: string; raw: string }> = [];
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch(),
    (dir, raw) => { observed.push({ dir, raw }); });
  await t.connect("ACC-D1");
  const p = t.send({ ping: 1 });
  m.deliver({ req_id: m.lastReqId(), ping: "pong" });
  await p;
  assert.equal(observed.filter((o) => o.dir === "out").length, 1);
  assert.equal(observed.filter((o) => o.dir === "in").length, 1);
});

test("the REAL transport marks a venue REJECTION as written — the reply proves it", async () => {
  // Exercised against the real transport. The evidence-suite version of this
  // used a fake whose thrown error hardcoded wireWritten:true, so the real
  // rejection path was never touched and the mutation that removed the field
  // stayed green — while the commit message claimed it went red.
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  const p = t.send({ proposal: 1 }).catch((e: DerivNewApiError) => e);
  m.deliver({ req_id: m.lastReqId(), error: { code: "InputValidationFailed" } });
  const e = await p as DerivNewApiError;
  assert.equal(e.code, "DERIV_NEW_API_REQUEST_REJECTED");
  assert.equal(e.derivCode, "InputValidationFailed");
  // The venue answered, so the frame demonstrably reached it.
  assert.equal(e.wireWritten, true, "a venue reply did not prove transmission");
});

test("the REAL transport marks a venue TRADE rejection as written too", async () => {
  const m = manualSocket();
  const t = new NewDerivTransport(CONFIG, m.factory, otpFetch());
  await t.connect("ACC-D1");
  const p = t.send({ buy: "q", price: 1 }).catch((e: DerivNewApiError) => e);
  m.deliver({ req_id: m.lastReqId(), error: { code: "InsufficientBalance" } });
  const e = await p as DerivNewApiError;
  assert.equal(e.code, "DERIV_NEW_API_TRADING_REJECTED");
  assert.equal(e.wireWritten, true);
});
