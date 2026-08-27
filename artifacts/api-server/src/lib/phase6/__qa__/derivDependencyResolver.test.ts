// Phase 6 — per-request Deriv dependency resolution.
//
// The failure this exists to prevent: request A being served with request B's
// account or credentials. That would place a real order on someone else's money,
// which is the worst outcome available to this subsystem.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveDerivDependencies, demoIsProven, looksLikeSecret, assertNoSecretLeak,
  type DerivDepSources, type DemoClassification,
} from "../derivDependencyResolver.js";

const USER = 7;
const CONN = 11;
const ACCOUNT = "VRTC1234";

const VENUE_DEMO: DemoClassification = {
  isDemo: true, source: "VENUE_ACCOUNT_ATTRIBUTE", evidence: "is_virtual=1",
};

function sources(over: Partial<DerivDepSources> = {}): DerivDepSources {
  return {
    authenticatedUserId: USER,
    configuredTier: "TIER_1_DEMO_GUIDED",
    loadConnection: async (uid, cid) => (cid === CONN
      ? { id: CONN, ownerUserId: uid === USER ? USER : 999, venue: "DERIV_DEMO", credentialHandle: "h_abc" }
      : null),
    loadAccount: async (cid, ref) => (ref === ACCOUNT ? { accountRef: ACCOUNT, connectionId: cid } : null),
    classifyAccount: async () => VENUE_DEMO,
    killSwitchEngaged: async () => false,
    hasUnresolvedIntent: async () => false,
    ...over,
  };
}

const resolve = (over: Partial<DerivDepSources> = {}, argsOver: Record<string, unknown> = {}) =>
  resolveDerivDependencies(
    { connectionId: CONN, accountRef: ACCOUNT, requestedVenue: "DERIV_DEMO", ...argsOver } as never,
    sources(over));

test("baseline: a well-formed request resolves", async () => {
  const r = await resolve();
  assert.equal(r.ok, true, r.ok === false ? `${r.refusal}: ${r.detail}` : "");
  assert.equal(r.ok === true && r.deps.userId, USER);
  assert.equal(r.ok === true && r.deps.accountRef, ACCOUNT);
});

// -- authentication and ownership ------------------------------------------
test("an unauthenticated request refuses before anything is loaded", async () => {
  for (const bad of [null, 0, -1, 1.5, "7"] as unknown[]) {
    const r = await resolve({ authenticatedUserId: bad as number | null });
    assert.equal(r.ok, false, `authenticatedUserId=${String(bad)} resolved`);
    assert.equal(r.ok === false && r.refusal, "NO_AUTHENTICATED_USER");
  }
});

test("REQUEST A CANNOT CONSUME REQUEST B'S CONNECTION", async () => {
  // The connection exists, and the caller knows its id — but it belongs to
  // someone else. Ownership is checked against the AUTHENTICATED user, never
  // against an id supplied in the request.
  const r = await resolve({
    loadConnection: async () => ({ id: CONN, ownerUserId: 999, venue: "DERIV_DEMO", credentialHandle: "h_other" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal, "CONNECTION_NOT_OWNED_BY_USER");
});

test("an account belonging to a DIFFERENT connection refuses", async () => {
  // Second ownership hop. One check alone would let a caller who knows an
  // account reference borrow a connection they do own for an account they don't.
  const r = await resolve({
    loadAccount: async () => ({ accountRef: ACCOUNT, connectionId: CONN + 500 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal, "ACCOUNT_NOT_OWNED_BY_CONNECTION");
});

test("a missing connection, account or credential handle refuses", async () => {
  assert.equal((await resolve({ loadConnection: async () => null })).ok, false);
  assert.equal((await resolve({ loadAccount: async () => null })).ok, false);
  const noCred = await resolve({
    loadConnection: async () => ({ id: CONN, ownerUserId: USER, venue: "DERIV_DEMO", credentialHandle: null }),
  });
  assert.equal(noCred.ok === false && noCred.refusal, "NO_CREDENTIAL_HANDLE");
  const blankCred = await resolve({
    loadConnection: async () => ({ id: CONN, ownerUserId: USER, venue: "DERIV_DEMO", credentialHandle: "   " }),
  });
  assert.equal(blankCred.ok === false && blankCred.refusal, "NO_CREDENTIAL_HANDLE");
});

// -- DEMO must be proven by the VENUE --------------------------------------
test("DEMO status inferred from NAMING is refused, not accepted", async () => {
  // The owner's rule: not token naming, not env naming, not a UI label, not the
  // adapter's URL allow-list. Only venue evidence.
  const r = await resolve({
    classifyAccount: async () => ({ isDemo: true, source: "INFERRED_FROM_NAMING", evidence: "loginid starts VRTC" }),
  });
  assert.equal(r.ok, false, "a naming-based DEMO inference was accepted as proof");
  assert.equal(r.ok === false && r.refusal, "ACCOUNT_DEMO_STATUS_UNPROVEN");
});

test("an unclassified account refuses rather than defaulting to demo", async () => {
  const r = await resolve({ classifyAccount: async () => null });
  assert.equal(r.ok === false && r.refusal, "ACCOUNT_DEMO_STATUS_UNPROVEN");
});

test("a venue-classified LIVE account refuses distinctly", async () => {
  const r = await resolve({
    classifyAccount: async () => ({ isDemo: false, source: "VENUE_ACCOUNT_ATTRIBUTE", evidence: "is_virtual=0" }),
  });
  assert.equal(r.ok === false && r.refusal, "ACCOUNT_IS_LIVE_MONEY");
});

test("demoIsProven accepts only venue-sourced evidence", () => {
  assert.equal(demoIsProven({ isDemo: true, source: "VENUE_ACCOUNT_ATTRIBUTE", evidence: "x" }), true);
  assert.equal(demoIsProven({ isDemo: true, source: "VENUE_ACCOUNT_LIST", evidence: "x" }), true);
  assert.equal(demoIsProven({ isDemo: true, source: "INFERRED_FROM_NAMING", evidence: "x" }), false);
  assert.equal(demoIsProven({ isDemo: false, source: "VENUE_ACCOUNT_ATTRIBUTE", evidence: "x" }), false);
  for (const bad of [null, undefined, {}, "true"] as unknown[]) {
    assert.equal(demoIsProven(bad as never), false);
  }
});

// -- venue, kill switch, tier, unresolved intent ---------------------------
test("a non-Deriv or unrecognised venue refuses before credentials are touched", async () => {
  let credentialsTouched = false;
  for (const v of [null, "", "MT5_EA_BRIDGE", "deriv", "DERIV_REAL", 42] as unknown[]) {
    const r = await resolveDerivDependencies(
      { connectionId: CONN, accountRef: ACCOUNT, requestedVenue: v as string | null },
      sources({ loadConnection: async () => { credentialsTouched = true; return null; } }));
    assert.equal(r.ok, false, `venue ${String(v)} resolved`);
    assert.equal(r.ok === false && r.refusal, "VENUE_NOT_DERIV");
  }
  assert.equal(credentialsTouched, false, "a bad venue reached the credential lookup");
});

test("a connection whose own venue is not Deriv refuses", async () => {
  const r = await resolve({
    loadConnection: async () => ({ id: CONN, ownerUserId: USER, venue: "MT5_EA_BRIDGE", credentialHandle: "h" }),
  });
  assert.equal(r.ok === false && r.refusal, "VENUE_NOT_DERIV");
});

test("the kill switch refuses", async () => {
  const r = await resolve({ killSwitchEngaged: async () => true });
  assert.equal(r.ok === false && r.refusal, "KILL_SWITCH_ENGAGED");
});

test("an outstanding unresolved intent refuses", async () => {
  const r = await resolve({ hasUnresolvedIntent: async () => true });
  assert.equal(r.ok === false && r.refusal, "UNRESOLVED_INTENT_OUTSTANDING");
});

test("a tier that forbids sending refuses at resolution, not only at deliver()", async () => {
  for (const t of [null, "", "TIER_0_DRY_RUN", "TIER_3_LIVE_GUIDED", "TIER_4_AUTONOMOUS", "1", "true"]) {
    const r = await resolve({ configuredTier: t });
    assert.equal(r.ok, false, `tier ${JSON.stringify(t)} resolved a sendable adapter`);
    assert.equal(r.ok === false && r.refusal, "TIER_FORBIDS_SEND");
  }
});

// -- secrets never leave the resolver --------------------------------------
test("the resolver returns a HANDLE, never a token", async () => {
  const r = await resolve();
  assert.equal(r.ok, true);
  const deps = r.ok === true ? r.deps : null;
  assert.equal(deps?.credentialHandle, "h_abc");
  // The resolved shape must carry no field that could hold a raw credential.
  const keys = Object.keys(deps ?? {});
  assert.ok(!keys.some((k) => /token|secret|password|pepper/i.test(k)),
    `resolved dependencies expose a credential-shaped field: ${keys.join(",")}`);
});

test("looksLikeSecret catches credential SHAPES, not just known names", () => {
  // A token renamed on its way into a payload is still a token.
  assert.equal(looksLikeSecret("Bearer abc123def456"), true);
  assert.equal(looksLikeSecret("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"), true, "a long opaque token passed");
  assert.equal(looksLikeSecret("DERIV_API_TOKEN"), true);
  assert.equal(looksLikeSecret("Authorization: x"), true);
  // Ordinary values must not trip it.
  assert.equal(looksLikeSecret("R_100"), false);
  assert.equal(looksLikeSecret("VRTC1234"), false);
  assert.equal(looksLikeSecret("BUY"), false);
  assert.equal(looksLikeSecret(42), false);
  assert.equal(looksLikeSecret(null), false);
});

test("assertNoSecretLeak refuses a credential ANYWHERE in a payload", () => {
  assert.doesNotThrow(() => assertNoSecretLeak(
    { symbol: "R_100", side: "BUY", stake: 1, note: "scanner setup" }, "journal"));

  // Nested three levels down.
  assert.throws(() => assertNoSecretLeak(
    { meta: { transport: { detail: "Bearer sk_live_abcdefghijklmnop" } } }, "journal"),
    /SECRET_LEAK_REFUSED/, "a nested token was written");

  // A credential-NAMED key is a leak even when the value is redacted, because
  // the shape of the record tells an attacker where to look next time.
  assert.throws(() => assertNoSecretLeak({ derivApiToken: "[redacted]" }, "audit"),
    /SECRET_LEAK_REFUSED/, "a credential-named field was written");
  assert.throws(() => assertNoSecretLeak({ headers: { authorization: "x" } }, "audit"),
    /SECRET_LEAK_REFUSED/);

  // Arrays are walked too.
  assert.throws(() => assertNoSecretLeak({ events: [{ d: "ok" }, { d: "Bearer zzzzzzzzzzzzzzzz" }] }, "audit"),
    /SECRET_LEAK_REFUSED/);

  // And a cyclic payload must not hang.
  const cyc: Record<string, unknown> = { a: 1 };
  cyc["self"] = cyc;
  assert.doesNotThrow(() => assertNoSecretLeak(cyc, "audit"));
});

// -- no ambient state ------------------------------------------------------
test("the resolver holds NO module-level mutable state", () => {
  // Module-scope mutable state is how one request ends up serving another
  // request's account. Asserted structurally because it cannot be observed
  // behaviourally from a single call.
  const src = readFileSync(new URL("../derivDependencyResolver.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const topLevelMutable = src.match(/^\s*(let|var)\s+\w+/gm) ?? [];
  assert.deepEqual(topLevelMutable, [],
    `module-level mutable bindings found: ${topLevelMutable.join(", ")}`);
  assert.ok(!/^\s*const\s+\w*[Cc]ache\w*\s*=/m.test(src), "a module-level cache was introduced");
});
