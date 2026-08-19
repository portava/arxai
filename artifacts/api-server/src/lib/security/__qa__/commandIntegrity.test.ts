// ═══════════════════════════════════════════════════════════════════════════
// commandIntegrity.test.ts — pure command-integrity evaluator + crypto primitives
// (AACI Security Phase 3: Command Integrity & Live Execution Protection).
//
// Exercises the IO-free domain layer (no DB): canonicalization stability, the
// HMAC signature, constant-time compare, and every branch of the pure verdict —
// happy path, payload tamper, missing/legacy payload, signature tamper, actor
// invalid, route-not-allowed, decision mismatch, and benign staleness (expired).
// Proves DEFAULT-DENY on the unverifiable and that a FAIL only ever surfaces a
// block (never an enable).
// ═══════════════════════════════════════════════════════════════════════════

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeCommandParams,
  computePayloadHash,
  computeIntegrityHash,
  safeHexEqual,
  evaluateCommandIntegrity,
  isCommandActorType,
  TAMPER_REASONS,
  COMMAND_INTEGRITY_KEY_VERSION,
  type CanonicalCommandParams,
  type CommandIntegrityEnvelope,
  type CommandIntegrityVerifyInput,
} from "@workspace/domain/security";
import { isRouteAllowed } from "../commandIntegrity.js";

const KEY = createHash("sha256").update("test-integrity-key").digest();

const BASE_PARAMS: CanonicalCommandParams = {
  commandType: "PLACE_LIVE_MARKET_ORDER",
  symbol: "EURUSD",
  side: "BUY",
  orderType: "MARKET",
  requestedVolume: 0.1,
  stopLoss: 1.05,
  takeProfit: 1.1,
  meaningfulPayload: { referencePrice: 1.075 },
};

function envFor(payloadHash: string): CommandIntegrityEnvelope {
  return {
    commandId: "lvcmd_test",
    userId: 42,
    actorId: 42,
    actorType: "USER",
    actionType: "LIVE_TRADE_EXECUTION",
    payloadHash,
    keyVersion: COMMAND_INTEGRITY_KEY_VERSION,
  };
}

// A fully-valid, signed verify input (the happy path) that individual tests mutate.
function validInput(): CommandIntegrityVerifyInput {
  const payloadHash = computePayloadHash(BASE_PARAMS);
  const sig = computeIntegrityHash(envFor(payloadHash), KEY);
  return {
    storedPayloadHash: payloadHash,
    recomputedPayloadHash: payloadHash,
    signed: true,
    storedIntegrityHash: sig,
    recomputedIntegrityHash: sig,
    routeAllowed: true,
    actorValid: true,
    decisionMatch: null,
    fresh: true,
  };
}

// ── Canonicalization + hashing primitives ───────────────────────────────────

test("payload hash is deterministic and order-insensitive on payload keys", () => {
  const a = computePayloadHash({ ...BASE_PARAMS, meaningfulPayload: { referencePrice: 1.075, brokerTicket: "9" } });
  const b = computePayloadHash({ ...BASE_PARAMS, meaningfulPayload: { brokerTicket: "9", referencePrice: 1.075 } });
  assert.equal(a, b, "key order in payload must not change the hash");
});

test("numeric normalization: 0.1 == 0.1000 and 1.05 == 1.05000", () => {
  const a = computePayloadHash(BASE_PARAMS);
  const b = computePayloadHash({ ...BASE_PARAMS, requestedVolume: 0.1000, stopLoss: 1.05000 });
  assert.equal(a, b);
});

test("symbol/side/orderType are case-normalized", () => {
  const a = canonicalizeCommandParams(BASE_PARAMS);
  const b = canonicalizeCommandParams({ ...BASE_PARAMS, symbol: "eurusd", side: "buy", orderType: "market" });
  assert.equal(a, b);
});

test("changing any trade-critical field changes the payload hash", () => {
  const base = computePayloadHash(BASE_PARAMS);
  assert.notEqual(base, computePayloadHash({ ...BASE_PARAMS, requestedVolume: 0.2 }));
  assert.notEqual(base, computePayloadHash({ ...BASE_PARAMS, side: "SELL" }));
  assert.notEqual(base, computePayloadHash({ ...BASE_PARAMS, stopLoss: 1.06 }));
  assert.notEqual(base, computePayloadHash({ ...BASE_PARAMS, symbol: "GBPUSD" }));
});

test("integrity signature changes when any envelope field changes", () => {
  const ph = computePayloadHash(BASE_PARAMS);
  const sig = computeIntegrityHash(envFor(ph), KEY);
  assert.notEqual(sig, computeIntegrityHash({ ...envFor(ph), actorType: "ADMIN" }, KEY));
  assert.notEqual(sig, computeIntegrityHash({ ...envFor(ph), actorId: 43 }, KEY));
  assert.notEqual(sig, computeIntegrityHash({ ...envFor(ph), actionType: "CLOSE_POSITION" }, KEY));
  assert.notEqual(sig, computeIntegrityHash(envFor("deadbeef"), KEY), "signature binds the payload hash");
});

test("integrity signature changes when the key changes", () => {
  const ph = computePayloadHash(BASE_PARAMS);
  const otherKey = createHash("sha256").update("different-key").digest();
  assert.notEqual(computeIntegrityHash(envFor(ph), KEY), computeIntegrityHash(envFor(ph), otherKey));
});

test("safeHexEqual: equal/unequal/length-mismatch/empty", () => {
  const h = computePayloadHash(BASE_PARAMS);
  assert.equal(safeHexEqual(h, h), true);
  assert.equal(safeHexEqual(h, h.slice(0, -2) + "00"), false);
  assert.equal(safeHexEqual(h, h.slice(0, 10)), false);
  assert.equal(safeHexEqual(null, h), false);
  assert.equal(safeHexEqual("", ""), false);
});

test("isCommandActorType accepts the catalog, rejects junk", () => {
  assert.equal(isCommandActorType("USER"), true);
  assert.equal(isCommandActorType("SELF_TRADE_AGENT"), true);
  assert.equal(isCommandActorType("HACKER"), false);
  assert.equal(isCommandActorType(null), false);
});

// ── Pure verdict — every branch ─────────────────────────────────────────────

test("happy path: signed, matching, allowed, fresh ⇒ OK (no tamper)", () => {
  const v = evaluateCommandIntegrity(validInput());
  assert.equal(v.ok, true);
  assert.equal(v.reason, "INTEGRITY_OK");
  assert.equal(v.tamper, false);
});

test("legacy/unstamped command (no stored payload hash) ⇒ default-deny PAYLOAD_MISSING", () => {
  const v = evaluateCommandIntegrity({ ...validInput(), storedPayloadHash: null });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "INTEGRITY_PAYLOAD_MISSING");
  assert.equal(v.tamper, true);
});

test("payload changed after approval ⇒ PAYLOAD_MISMATCH (tamper)", () => {
  const i = validInput();
  i.recomputedPayloadHash = computePayloadHash({ ...BASE_PARAMS, requestedVolume: 5 });
  const v = evaluateCommandIntegrity(i);
  assert.equal(v.reason, "INTEGRITY_PAYLOAD_MISMATCH");
  assert.equal(v.tamper, true);
});

test("signed but signature missing ⇒ SIGNATURE_MISSING (tamper)", () => {
  const v = evaluateCommandIntegrity({ ...validInput(), storedIntegrityHash: null });
  assert.equal(v.reason, "INTEGRITY_SIGNATURE_MISSING");
  assert.equal(v.tamper, true);
});

test("signature recomputed differently ⇒ SIGNATURE_MISMATCH (tamper)", () => {
  const i = validInput();
  i.recomputedIntegrityHash = computeIntegrityHash({ ...envFor(i.storedPayloadHash!), actorType: "OWNER" }, KEY);
  const v = evaluateCommandIntegrity(i);
  assert.equal(v.reason, "INTEGRITY_SIGNATURE_MISMATCH");
  assert.equal(v.tamper, true);
});

test("placeholder (unsigned) command skips the signature branch", () => {
  const i = validInput();
  i.signed = false;
  i.storedIntegrityHash = null;
  i.recomputedIntegrityHash = null;
  const v = evaluateCommandIntegrity(i);
  assert.equal(v.ok, true, "CREATED-mode command verifies on payload hash alone");
});

test("invalid actor ⇒ ACTOR_INVALID (tamper)", () => {
  const v = evaluateCommandIntegrity({ ...validInput(), actorValid: false });
  assert.equal(v.reason, "INTEGRITY_ACTOR_INVALID");
  assert.equal(v.tamper, true);
});

test("unrecognised route ⇒ ROUTE_NOT_ALLOWED (tamper)", () => {
  const v = evaluateCommandIntegrity({ ...validInput(), routeAllowed: false });
  assert.equal(v.reason, "INTEGRITY_ROUTE_NOT_ALLOWED");
  assert.equal(v.tamper, true);
});

test("linked decision mismatch ⇒ DECISION_MISMATCH (tamper); null decision is N/A", () => {
  assert.equal(evaluateCommandIntegrity({ ...validInput(), decisionMatch: false }).reason, "INTEGRITY_DECISION_MISMATCH");
  assert.equal(evaluateCommandIntegrity({ ...validInput(), decisionMatch: true }).ok, true);
  assert.equal(evaluateCommandIntegrity({ ...validInput(), decisionMatch: null }).ok, true);
});

test("stale approval ⇒ EXPIRED (benign, NOT tamper)", () => {
  const v = evaluateCommandIntegrity({ ...validInput(), fresh: false });
  assert.equal(v.reason, "INTEGRITY_EXPIRED");
  assert.equal(v.ok, false);
  assert.equal(v.tamper, false, "expiry is benign staleness, not a forgery");
  assert.equal(TAMPER_REASONS.has("INTEGRITY_EXPIRED"), false);
});

test("tamper-first ordering: payload mismatch wins over a stale+bad-route command", () => {
  const i = validInput();
  i.recomputedPayloadHash = "00";
  i.routeAllowed = false;
  i.fresh = false;
  assert.equal(evaluateCommandIntegrity(i).reason, "INTEGRITY_PAYLOAD_MISMATCH");
});

test("NO-ENABLE invariant: ok is true IFF reason is INTEGRITY_OK", () => {
  const cases: CommandIntegrityVerifyInput[] = [
    validInput(),
    { ...validInput(), storedPayloadHash: null },
    { ...validInput(), fresh: false },
    { ...validInput(), routeAllowed: false },
    { ...validInput(), actorValid: false },
    { ...validInput(), decisionMatch: false },
  ];
  for (const c of cases) {
    const v = evaluateCommandIntegrity(c);
    assert.equal(v.ok, v.reason === "INTEGRITY_OK");
    // Every block carries a clean, token-free user message (no ":" reason separator).
    if (!v.ok) assert.ok(!v.userMessage.includes(":"), `user message must not leak a code: ${v.userMessage}`);
  }
});

// ── Source allowlist contract (regression guard) ────────────────────────────
// Every literal `sourcePage: "..."` stamped anywhere in the api-server MUST be
// accepted by the integrity route allowlist. A new live entrypoint that stamps
// an unregistered source would otherwise be silently blocked at dispatch by the
// integrity pre-gate. This scans the real source so the allowlist can never
// drift behind the draft creators.
test("every stamped sourcePage literal is in the route allowlist", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const found = new Set<string>();
  // Direct stamps: `sourcePage: "FOO"`.
  const DIRECT_RE = /sourcePage:\s*"([A-Z0-9_]+)"/g;
  // Indirect stamps: source passed positionally into a stamping wrapper, e.g.
  // `runEmergencyClose(scope, "ADMIN_ORPHAN_CLOSE")` (may span multiple lines).
  // Any NEW wrapper that forwards a literal source into createLiveDraft/
  // createLiveOpsDraft must be added here so the allowlist can't drift behind it.
  //
  // The source literal is the SECOND positional argument. It must be matched
  // regardless of what follows it, because callers may pass further arguments
  // after it — `runEmergencyClose(scope, "ADMIN_EMERGENCY_CLOSE", { killSwitchBypass })`
  // is the operator emergency-close path. An earlier form of this pattern
  // anchored on `"..."` being the LAST argument (`\s*,?\s*\)`), so it silently
  // stopped matching that call once the options argument was added — which is
  // exactly what the known-source sentinel below exists to catch. Terminate on
  // `,` OR `)` instead, and bound the lazy span so a non-matching call can't
  // scan the rest of the file and latch onto an unrelated literal.
  const RUN_EMERGENCY_RE = /runEmergencyClose\s*\([\s\S]{0,400}?,\s*"([A-Z0-9_]+)"\s*[,)]/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__qa__" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!full.endsWith(".ts")) continue;
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(DIRECT_RE)) found.add(m[1]!);
      for (const m of text.matchAll(RUN_EMERGENCY_RE)) found.add(m[1]!);
    }
  };
  walk(srcRoot);
  assert.ok(found.size > 0, "expected to discover sourcePage literals in api-server source");
  // Sanity: the scan must actually pick up the known indirect operator sources,
  // otherwise the indirect pattern silently stopped matching (false-pass guard).
  for (const known of ["ADMIN_EMERGENCY_CLOSE", "ADMIN_ORPHAN_CLOSE"]) {
    assert.ok(found.has(known), `contract scan failed to discover indirect source ${known}`);
  }
  const offenders = [...found].filter((s) => !isRouteAllowed(s));
  assert.deepEqual(offenders, [], `unregistered sourcePage literals (add to ALLOWED_SOURCE_PREFIXES): ${offenders.join(", ")}`);
});

export {};
