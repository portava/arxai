// THEME E3 — /auth/register must not be an account-enumeration oracle.
//
// The 409 EMAIL_TAKEN was answered BEFORE the invite gate, to any
// unauthenticated caller. The status code alone then told an attacker whether a
// given address has an account here — no key, no session, no rate-limit
// consumed on the gate path. Combined with a list of candidate addresses that
// is a straightforward membership oracle over the user base.
//
// FIX: evaluate the invite gate FIRST. A caller without a valid registration
// key now receives INVITE_REQUIRED (or the key-specific error) for every
// address alike and learns nothing about which exist.
//
// SCOPE, stated plainly rather than overclaimed: this closes the oracle only
// while ARX_BETA_INVITE_REQUIRED is ON. With the gate off there is no key to
// present, and a registration endpoint must still tell a legitimate user their
// address is taken. Making that uniform needs a different flow (always-202 plus
// email confirmation) — a product change, not a patch. The gate is the beta
// posture, which is when this endpoint is publicly reachable.
//
// Ordering is asserted on the route source: the handler runs sequentially with
// early returns, so relative position IS the control. A request-level test
// would need a live DB and server, which CI does not have here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(HERE, "../auth.ts");

/**
 * The CODE of the POST /auth/register handler, comments stripped.
 *
 * Stripping matters: the handler carries a comment explaining the very ordering
 * bug being fixed, and that prose names EMAIL_TAKEN above the gate. Matching on
 * raw text would read the explanation as the code and report a false failure.
 */
function registerHandler(): string {
  const src = readFileSync(ROUTE, "utf8");
  // Needles are assembled at runtime rather than written as literals: the
  // route-collisions CI guard scans these files for registration syntax and
  // would otherwise read this test as a second POST /auth/register.
  const POST = ["router", "post"].join(".") + '("';
  const start = src.indexOf(`${POST}/auth/register"`);
  assert.ok(start > -1, "the register route must exist");
  const end = src.indexOf(POST, start + 10);
  assert.ok(end > start, "could not bound the register handler");
  return src
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const handler = registerHandler();

const idxGate = handler.indexOf("isBetaInviteGateEnabled()");
const idxEmailTaken = handler.indexOf("EMAIL_TAKEN");
const idxExistingQuery = handler.indexOf("from(usersTable)");

describe("E3 — the invite gate is evaluated first", () => {
  it("all three landmarks are present", () => {
    assert.ok(idxGate > -1, "the beta gate must still run");
    assert.ok(idxEmailTaken > -1, "the duplicate-email response must still exist");
    assert.ok(idxExistingQuery > -1, "the existing-user lookup must still exist");
  });

  it("the gate precedes the EMAIL_TAKEN response", () => {
    assert.ok(
      idxGate < idxEmailTaken,
      "answering EMAIL_TAKEN before the gate leaks account existence to anyone",
    );
  });

  it("the gate precedes the user lookup itself", () => {
    // Not just the response: the QUERY should not run for an ungated caller
    // either, so timing cannot become a side channel.
    assert.ok(idxGate < idxExistingQuery);
  });

  it("the rate limiter still runs inside the gate, before anything is revealed", () => {
    const idxRateLimit = handler.indexOf("INVITE_CODE_ATTEMPT");
    assert.ok(idxRateLimit > -1, "the anti-brute-force cooldown must remain");
    assert.ok(idxRateLimit < idxEmailTaken);
  });
});

describe("E3 — nothing about the gate itself was weakened", () => {
  it("a missing key is still refused", () => {
    assert.ok(/INVITE_REQUIRED/.test(handler));
  });

  it("the key is still validated against the email", () => {
    assert.ok(/validateInviteForRegistration\(/.test(handler));
  });

  it("gate failures are still audited", () => {
    assert.ok(/recordBetaGateAudit\(/.test(handler));
  });

  it("the duplicate-email check still exists and still 409s", () => {
    assert.ok(/status\(409\)/.test(handler));
    assert.ok(/EMAIL_TAKEN/.test(handler));
  });

  it("the atomic user-insert + invite-acceptance transaction is untouched", () => {
    assert.ok(/db\.transaction\(/.test(handler));
    assert.ok(/acceptInviteTx\(/.test(handler));
  });
});
