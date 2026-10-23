// Live-evidence harness safety boundaries.
//
// This instrument contacts a real venue with a real credential. Almost every
// test here is a REFUSAL: the value of the harness is not that it can capture
// evidence, but that it cannot do anything else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  captureVenueEvidence, assertNoOrderPossible, READ_ONLY_PROBES, summarizeQuestions,
} from "../evidenceCapture.js";
import {
  EVIDENCE_AUTHORIZATION, EVIDENCE_TIERS, EvidenceRefusal, redactFrame,
  assertNoSecrets, serializeArtifact, type EvidenceArtifact,
} from "../liveEvidence.js";
import { generateFixtures, renderFixtureModule } from "../evidenceToFixture.js";

const CONFIG = { appId: "arx-app-XYZ", token: "pat-SUPER-SECRET-VALUE" };
const DEMO = { accounts: [{ account_id: "VRTC9001", account_type: "demo", currency: "USD", status: "active" }] };
const REAL = { accounts: [{ account_id: "CR5001", account_type: "real", currency: "USD", status: "active" }] };
const fetchOf = (b: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(b), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

function envOn<T>(fn: () => T): T {
  const prev = { ...process.env };
  process.env["DERIV_API_MODE"] = "new";
  process.env["DERIV_APP_ID"] = CONFIG.appId;
  process.env["DERIV_API_TOKEN"] = CONFIG.token;
  try { return fn(); } finally {
    for (const k of ["DERIV_API_MODE", "DERIV_APP_ID", "DERIV_API_TOKEN"]) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

/** A transport that answers probes and records frames, without a network. */
function fakeTransport(answers: Record<string, unknown>, sink: string[]) {
  return (_c: unknown, onFrame: (d: "out" | "in", raw: string, m: { reqId: number | null; op: string | null; atMs: number }) => void) => {
    let id = 0;
    return {
      connect: async () => {},
      reconnect: async () => {},
      getState: () => "WS_READY",
      close: () => {},
      send: async (p: Record<string, unknown>) => {
        id += 1;
        const op = Object.keys(p)[0]!;
        sink.push(op);
        onFrame("out", JSON.stringify({ ...p, req_id: id }), { reqId: id, op, atMs: 1 });
        const a = answers[op];
        if (a === undefined) throw new Error(`no answer for ${op}`);
        onFrame("in", JSON.stringify({ ...(a as object), req_id: id }), { reqId: id, op, atMs: 2 });
        return { ...(a as Record<string, unknown>), req_id: id };
      },
    } as never;
  };
}

const ANSWERS = {
  ping: { ping: "pong" },
  proposal: { proposal: { id: "q1", ask_price: 1, spot: 617 } },
  contracts_for: { contracts_for: { available: [] } },
  this_operation_does_not_exist: { ok: 1 },
  proposal_open_contract: { proposal_open_contract: { contract_id: 1 } },
};

// ── Authorization and tier gating ──────────────────────────────────────────

test("missing or wrong authorization refuses, and contacts nothing", async () => {
  const sink: string[] = [];
  for (const authorization of [undefined, "", "yes", "true",
    EVIDENCE_AUTHORIZATION.READ_ONLY.toLowerCase(), EVIDENCE_AUTHORIZATION.DEMO_EXECUTION]) {
    await assert.rejects(
      () => envOn(() => captureVenueEvidence({
        authorization, fetchImpl: fetchOf(DEMO), transportFactory: fakeTransport(ANSWERS, sink),
      })),
      EvidenceRefusal, `accepted authorization ${JSON.stringify(authorization)}`);
  }
  assert.equal(sink.length, 0, "the venue was contacted without authorization");
});

test("the DEMO_EXECUTION tier is NOT IMPLEMENTED and cannot run", async () => {
  // The tier exists so the capability is named and reviewable. It has no
  // executable path, which is what keeps this change incapable of ordering.
  const sink: string[] = [];
  await assert.rejects(
    () => envOn(() => captureVenueEvidence({
      tier: EVIDENCE_TIERS.DEMO_EXECUTION,
      authorization: EVIDENCE_AUTHORIZATION.DEMO_EXECUTION,
      fetchImpl: fetchOf(DEMO), transportFactory: fakeTransport(ANSWERS, sink),
    })),
    (e: Error) => {
      assert.ok(e instanceof EvidenceRefusal);
      assert.match(e.message, /CAPABILITY_NOT_IMPLEMENTED/);
      return true;
    });
  assert.equal(sink.length, 0);
});

test("an unknown tier refuses rather than defaulting to anything", async () => {
  await assert.rejects(
    () => envOn(() => captureVenueEvidence({
      tier: "SOMETHING_ELSE" as never, authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
      fetchImpl: fetchOf(DEMO), transportFactory: fakeTransport(ANSWERS, []),
    })), EvidenceRefusal);
});

// ── Account safety ─────────────────────────────────────────────────────────

test("a REAL account refuses before any probe is sent", async () => {
  const sink: string[] = [];
  await assert.rejects(
    () => envOn(() => captureVenueEvidence({
      authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
      fetchImpl: fetchOf(REAL), transportFactory: fakeTransport(ANSWERS, sink),
    })), EvidenceRefusal);
  assert.equal(sink.length, 0, "probed a real-money account");
});

test("an account of UNKNOWN type refuses — not-real is not enough", async () => {
  const sink: string[] = [];
  await assert.rejects(
    () => envOn(() => captureVenueEvidence({
      authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
      fetchImpl: fetchOf({ accounts: [{ account_id: "X1", status: "active" }] }),
      transportFactory: fakeTransport(ANSWERS, sink),
    })), EvidenceRefusal);
  assert.equal(sink.length, 0);
});

// ── No order is possible ───────────────────────────────────────────────────

test("every capital-committing operation is refused by the harness gate", () => {
  for (const op of ["buy", "sell", "buy_contract_for_multiple_accounts",
    "sell_expired", "cashier", "transfer_between_accounts", "topup_virtual"]) {
    assert.throws(() => assertNoOrderPossible({ [op]: 1 }), EvidenceRefusal, `${op} allowed`);
  }
});

test("no built-in probe can create or close a position", () => {
  for (const spec of READ_ONLY_PROBES) {
    assert.doesNotThrow(() => assertNoOrderPossible(spec.payload), `probe ${spec.name}`);
  }
});

test("the harness imports no trade mapper — there is no path to an order", () => {
  const code = readFileSync(new URL("../evidenceCapture.ts", import.meta.url), "utf8")
    // Comments discuss buy/sell at length; matching prose would be a false
    // failure, the mirror of the comment-trap seen earlier in this workstream.
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["mapBuyRequest", "mapSellRequest", "normalizePurchase", "normalizeSale"]) {
    assert.ok(!code.includes(forbidden), `evidenceCapture imports ${forbidden}`);
  }
});

test("EXACTLY ONE non-test file imports the evidence harness: its own CLI", () => {
  const SOLE = "src/scripts/derivCaptureEvidence.ts";
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        walk(full); continue;
      }
      if (!e.name.endsWith(".ts")) continue;
      scanned += 1;
      if (full.endsWith("/evidenceCapture.ts") || full.endsWith("/liveEvidence.ts")
        || full.endsWith("/evidenceToFixture.ts") || full.endsWith(SOLE)
        || full.includes("/__qa__/")) continue;
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/evidenceCapture|liveEvidence|evidenceToFixture/.test(code)) offenders.push(full);
    }
  };
  walk(`${process.cwd()}/src`);
  assert.ok(scanned > 500, `walk covered only ${scanned} files — it is not scanning the tree`);
  assert.deepEqual(offenders, [], `evidence harness reachable from: ${offenders.join(", ")}`);
});

// ── Credentials never reach an artifact ────────────────────────────────────

test("redaction removes the token, app id, OTP, Bearer and authorize", () => {
  const hostile = JSON.stringify({
    authorize: CONFIG.token,
    url: `wss://api.derivws.com/trading/v1/options/ws/demo?otp=SECRETOTP&x=1`,
    hdr: `Bearer ${CONFIG.token}`,
    app: CONFIG.appId,
  });
  const red = redactFrame(hostile, CONFIG);
  assert.ok(!red.includes(CONFIG.token), "token survived");
  assert.ok(!red.includes(CONFIG.appId), "app id survived");
  assert.ok(!red.includes("SECRETOTP"), "OTP survived");
});

test("an artifact containing a credential is REFUSED, not written", () => {
  const dirty = {
    artifactVersion: 1, tier: EVIDENCE_TIERS.READ_ONLY, capturedAtMs: 1,
    config: { mode: "new", appIdShape: "alphanumeric", tokenLength: 22 },
    accountSuffix: "9001", accountType: "demo",
    probes: [{ name: "x", op: "ping", outcome: "VENUE_REPLY", derivErrorCode: null,
      arxErrorCode: null, wireWritten: true, replyKeys: [], nestedKeys: [],
      normalizedOk: true, unreadableReason: null, transportStateBefore: "WS_READY",
      transportStateAfter: "WS_READY", reconnectsSoFar: 0, startedAtMs: 1, elapsedMs: 1,
      frames: [{ direction: "in", raw: `leaked ${CONFIG.token}`, reqId: 1, op: "ping", atMs: 1 }] }],
    questions: [],
  } as unknown as EvidenceArtifact;
  assert.throws(() => assertNoSecrets(dirty, CONFIG), EvidenceRefusal);
});

test("a clean capture produces an artifact with no credential in it", async () => {
  const art = await envOn(() => captureVenueEvidence({
    authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
    fetchImpl: fetchOf(DEMO), transportFactory: fakeTransport(ANSWERS, []),
    nowMs: () => 1000,
  }));
  const blob = serializeArtifact(art);
  assert.ok(!blob.includes(CONFIG.token));
  assert.ok(!blob.includes(CONFIG.appId));
  // Only a suffix of the account id, never the whole thing.
  assert.ok(!blob.includes("VRTC9001"));
  assert.equal(art.accountSuffix, "9001");
});

// ── Evidence honesty ───────────────────────────────────────────────────────

test("evidence records wireWritten from the transport, never inferred", async () => {
  const art = await envOn(() => captureVenueEvidence({
    authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
    fetchImpl: fetchOf(DEMO), transportFactory: fakeTransport(ANSWERS, []),
    probes: [{ name: "p", question: "q", payload: { ping: 1 }, expectRejection: false }],
    nowMs: () => 1,
  }));
  assert.equal(art.probes[0]!.wireWritten, true);
});

test("an outbound frame that was never written does not appear as evidence", async () => {
  // The transport records the outbound frame AFTER sock.send() returns, so a
  // throwing write leaves no "out" frame. Evidence must not be able to claim
  // a frame reached the venue when it did not.
  const factory = (_c: unknown, onFrame: (d: "out" | "in", r: string, m: { reqId: number | null; op: string | null; atMs: number }) => void) => ({
    connect: async () => {}, reconnect: async () => {}, getState: () => "WS_READY", close: () => {},
    send: async () => {
      void onFrame;   // deliberately records nothing: the write failed
      throw new (await import("../errors.js")).DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
        detail: "send failed", wireWritten: false,
      });
    },
  }) as never;
  const art = await envOn(() => captureVenueEvidence({
    authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
    fetchImpl: fetchOf(DEMO), transportFactory: factory,
    probes: [{ name: "p", question: "q", payload: { ping: 1 }, expectRejection: false }],
    nowMs: () => 1,
  }));
  assert.equal(art.probes[0]!.outcome, "NOT_SENT");
  assert.equal(art.probes[0]!.wireWritten, false);
  assert.equal(art.probes[0]!.frames.filter((f) => f.direction === "out").length, 0,
    "recorded an outbound frame that was never written");
});

test("an unreadable reply stays UNRESOLVED — it is not coerced into a reading", async () => {
  const art = await envOn(() => captureVenueEvidence({
    authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
    fetchImpl: fetchOf(DEMO),
    transportFactory: fakeTransport({ proposal: { proposal: { no_id_here: 1 } } }, []),
    probes: [{ name: "p", question: "q", payload: { proposal: 1 }, expectRejection: false }],
    nowMs: () => 1,
  }));
  assert.equal(art.probes[0]!.normalizedOk, false);
  assert.ok(art.probes[0]!.unreadableReason, "no reason recorded for an unreadable reply");
});

test("the artifact states plainly which questions it did NOT answer", async () => {
  const qs = summarizeQuestions([]);
  const q1 = qs.find((q) => q.id === "Q1")!;
  const q2 = qs.find((q) => q.id === "Q2")!;
  assert.equal(q1.answered, false);
  assert.match(q1.answer!, /NOT ANSWERABLE READ-ONLY/);
  assert.equal(q2.answered, false);
  assert.match(q2.answer!, /NOT SETTLEABLE BY OBSERVATION/);
});

// ── Fixture generation ─────────────────────────────────────────────────────

test("fixture generation preserves the venue's shape and delivery mode", () => {
  const art = {
    artifactVersion: 1, tier: EVIDENCE_TIERS.READ_ONLY, capturedAtMs: 1,
    config: { mode: "new", appIdShape: "alphanumeric", tokenLength: 4 },
    accountSuffix: "9001", accountType: "demo", questions: [],
    probes: [
      { name: "valid_proposal", op: "proposal", outcome: "VENUE_REPLY", derivErrorCode: null,
        arxErrorCode: null, wireWritten: true, replyKeys: [], nestedKeys: [], normalizedOk: true,
        unreadableReason: null, transportStateBefore: "WS_READY", transportStateAfter: "WS_READY",
        reconnectsSoFar: 0, startedAtMs: 1, elapsedMs: 1,
        frames: [
          { direction: "out", raw: '{"proposal":1,"req_id":7}', reqId: 7, op: "proposal", atMs: 1 },
          { direction: "in", raw: '{"proposal":{"id":"abc","ask_price":1},"req_id":7}', reqId: 7, op: "proposal", atMs: 2 },
        ] },
      { name: "bad_type", op: "proposal", outcome: "VENUE_REJECTION", derivErrorCode: "InputValidationFailed",
        arxErrorCode: "DERIV_NEW_API_REQUEST_REJECTED", wireWritten: true, replyKeys: [], nestedKeys: [],
        normalizedOk: false, unreadableReason: null, transportStateBefore: "WS_READY",
        transportStateAfter: "WS_READY", reconnectsSoFar: 0, startedAtMs: 1, elapsedMs: 1,
        frames: [
          { direction: "out", raw: '{"proposal":1,"req_id":8}', reqId: 8, op: "proposal", atMs: 1 },
          { direction: "in", raw: '{"error":{"code":"InputValidationFailed"},"req_id":8}', reqId: 8, op: "proposal", atMs: 2 },
        ] },
    ],
  } as unknown as EvidenceArtifact;

  const fx = generateFixtures(art);
  assert.equal(fx.length, 2);
  const ok = fx.find((f) => f.probe === "valid_proposal")!;
  assert.equal(ok.delivery, "reply");
  // The venue's body, verbatim — minus req_id, which is ARX's correlation
  // field and not part of the venue's shape.
  assert.deepEqual(ok.body?.["proposal"], { id: "abc", ask_price: 1 });
  assert.ok(!ok.source.includes("req_id"));

  const rej = fx.find((f) => f.probe === "bad_type")!;
  // A venue error frame becomes a THROW, because that is how the transport
  // delivers it. Generating it as a reply would rebuild the exact infidelity
  // that let a suite pass while testing nothing.
  assert.equal(rej.delivery, "throw");
  assert.match(rej.source, /kind: "throw"/);
  assert.match(rej.source, /InputValidationFailed/);
  assert.match(renderFixtureModule(art, fx), /GENERATED from a live evidence capture/);
});

test("fixture generation REFUSES an artifact version it does not understand", () => {
  const future = { artifactVersion: 99, probes: [] } as unknown as EvidenceArtifact;
  assert.throws(() => generateFixtures(future), EvidenceRefusal);
});

test("a frame that cannot be parsed yields NO fixture rather than a guess", () => {
  const art = {
    artifactVersion: 1, probes: [{
      name: "x", op: "ping", outcome: "VENUE_REPLY", derivErrorCode: null, arxErrorCode: null,
      wireWritten: true, replyKeys: [], nestedKeys: [], normalizedOk: true, unreadableReason: null,
      transportStateBefore: "WS_READY", transportStateAfter: "WS_READY", reconnectsSoFar: 0,
      startedAtMs: 1, elapsedMs: 1,
      frames: [
        { direction: "out", raw: '{"ping":1,"req_id":3}', reqId: 3, op: "ping", atMs: 1 },
        { direction: "in", raw: "<html>not json</html>", reqId: 3, op: "ping", atMs: 2 },
      ],
    }],
  } as unknown as EvidenceArtifact;
  assert.deepEqual(generateFixtures(art), []);
});

test("correlation is by the req_id ARX ISSUED, not by recency", () => {
  // Two probes in flight would otherwise be attributable to each other.
  const art = {
    artifactVersion: 1, probes: [{
      name: "x", op: "ping", outcome: "VENUE_REPLY", derivErrorCode: null, arxErrorCode: null,
      wireWritten: true, replyKeys: [], nestedKeys: [], normalizedOk: true, unreadableReason: null,
      transportStateBefore: "WS_READY", transportStateAfter: "WS_READY", reconnectsSoFar: 0,
      startedAtMs: 1, elapsedMs: 1,
      frames: [
        { direction: "out", raw: '{"ping":1,"req_id":3}', reqId: 3, op: "ping", atMs: 1 },
        { direction: "in", raw: '{"ping":"WRONG","req_id":4}', reqId: 4, op: "ping", atMs: 2 },
        { direction: "in", raw: '{"ping":"RIGHT","req_id":3}', reqId: 3, op: "ping", atMs: 3 },
      ],
    }],
  } as unknown as EvidenceArtifact;
  const fx = generateFixtures(art);
  assert.equal(fx[0]!.body?.["ping"], "RIGHT", "correlated to the wrong frame");
});

test("serialization is key-stable so two captures diff cleanly", () => {
  const a = { artifactVersion: 1, b: 2, a: 1 } as unknown as EvidenceArtifact;
  const b = { a: 1, artifactVersion: 1, b: 2 } as unknown as EvidenceArtifact;
  assert.equal(serializeArtifact(a), serializeArtifact(b));
});

test("assertProvablyDemo refuses a real account and an untyped one, DIRECTLY", async () => {
  // Tested directly because through captureVenueEvidence it is unreachable:
  // selectDemoAccount already filters to demo accounts, so the mutation that
  // disabled this check stayed green. A guard whose failure mode cannot be
  // exercised is not a proven guard.
  const { assertProvablyDemo } = await import("../evidenceCapture.js");
  assert.throws(() => assertProvablyDemo({ accountId: "CR5001", accountType: "real" }),
    EvidenceRefusal, "a real account was accepted");
  assert.throws(() => assertProvablyDemo({ accountId: "X1", accountType: null }),
    EvidenceRefusal, "an account of unstated type was accepted");
  assert.doesNotThrow(() => assertProvablyDemo({ accountId: "VRTC9001", accountType: "demo" }));
  assert.doesNotThrow(() => assertProvablyDemo({ accountId: "VRTC9001", accountType: "virtual" }));
});

// ── Findings from the FIRST live capture ───────────────────────────────────

test("a venue REJECTION records wireWritten=true — the reply proves transmission", async () => {
  // The live capture reported "wireWritten: unstated" for all five genuine
  // rejections. The venue answered, so the frame demonstrably reached it.
  const { DerivNewApiError } = await import("../errors.js");
  const factory = (_c: unknown, onFrame: (d: "out" | "in", r: string, m: { reqId: number | null; op: string | null; atMs: number }) => void) => ({
    connect: async () => {}, reconnect: async () => {}, getState: () => "WS_READY", close: () => {},
    send: async (p: Record<string, unknown>) => {
      const op = Object.keys(p)[0]!;
      onFrame("out", JSON.stringify({ ...p, req_id: 1 }), { reqId: 1, op, atMs: 1 });
      onFrame("in", JSON.stringify({ error: { code: "InputValidationFailed", details: { contract_type: "x" } }, req_id: 1 }),
        { reqId: 1, op, atMs: 2 });
      throw new DerivNewApiError("DERIV_NEW_API_REQUEST_REJECTED", {
        derivCode: "InputValidationFailed", wireWritten: true,
      });
    },
  }) as never;
  const art = await envOn(() => captureVenueEvidence({
    authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
    fetchImpl: fetchOf(DEMO), transportFactory: factory,
    probes: [{ name: "r", question: "q", payload: { proposal: 1 }, expectRejection: true }],
    nowMs: () => 1,
  }));
  assert.equal(art.probes[0]!.outcome, "VENUE_REJECTION");
  assert.equal(art.probes[0]!.wireWritten, true, "a venue reply did not prove transmission");
});

test("a REJECTION records the reply's structure, recovered from the frame", async () => {
  // replyKeys came back empty for every rejection: a rejection never resolves,
  // so the success path that fills them never runs. The frame was recorded
  // all along; the structure is now recovered from it.
  const { DerivNewApiError } = await import("../errors.js");
  const factory = (_c: unknown, onFrame: (d: "out" | "in", r: string, m: { reqId: number | null; op: string | null; atMs: number }) => void) => ({
    connect: async () => {}, reconnect: async () => {}, getState: () => "WS_READY", close: () => {},
    send: async (p: Record<string, unknown>) => {
      const op = Object.keys(p)[0]!;
      onFrame("out", JSON.stringify({ ...p, req_id: 1 }), { reqId: 1, op, atMs: 1 });
      onFrame("in", JSON.stringify({
        error: { code: "InputValidationFailed", message: "x", details: { contract_type: "y" } },
        echo_req: {}, msg_type: "proposal", req_id: 1,
      }), { reqId: 1, op, atMs: 2 });
      throw new DerivNewApiError("DERIV_NEW_API_REQUEST_REJECTED", {
        derivCode: "InputValidationFailed", wireWritten: true,
      });
    },
  }) as never;
  const art = await envOn(() => captureVenueEvidence({
    authorization: EVIDENCE_AUTHORIZATION.READ_ONLY,
    fetchImpl: fetchOf(DEMO), transportFactory: factory,
    probes: [{ name: "r", question: "q", payload: { proposal: 1 }, expectRejection: true }],
    nowMs: () => 1,
  }));
  assert.deepEqual(art.probes[0]!.replyKeys, ["echo_req", "error", "msg_type", "req_id"]);
  // The error block's own keys — structure, never the message content.
  assert.deepEqual(art.probes[0]!.nestedKeys, ["code", "details", "message"]);
});
