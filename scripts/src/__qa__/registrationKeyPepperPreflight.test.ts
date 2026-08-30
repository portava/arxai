// HOLD 6 — the REGISTRATION_KEY_PEPPER pre-flight must count accurately.
//
// The owner decides whether to press "set the secret" on the number this
// classifier produces. An AT_RISK count that is one too low is an owner told a
// rotation is free when it silently bricks somebody's registration key, with no
// re-hash path to undo it. So the classifier is pinned row-shape by row-shape
// against fixtures, with no database involved.
//
// Run: pnpm --filter @workspace/scripts run test:registration-key-pepper-preflight

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyInviteForPepperChange,
  tallyInvites,
  emptyTally,
  PEPPER_CHANGE_CATEGORY_ORDER,
  type InviteFacts,
} from "../registrationKeyPepperPreflightCore.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const PAST = new Date("2026-08-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");

function arx(status: string, expiresAt: Date | null = null): InviteFacts {
  return { status, isArxKey: true, expiresAt };
}
function legacy(status: string, expiresAt: Date | null = null): InviteFacts {
  return { status, isArxKey: false, expiresAt };
}

describe("pepper pre-flight — AT_RISK is exactly the redeemable ARX keys", () => {
  it("a PENDING ARX key with no expiry is AT_RISK", () => {
    assert.equal(classifyInviteForPepperChange(arx("PENDING", null), NOW), "AT_RISK");
  });

  it("a PENDING ARX key expiring in the future is AT_RISK", () => {
    assert.equal(classifyInviteForPepperChange(arx("PENDING", FUTURE), NOW), "AT_RISK");
  });

  it("a PENDING ARX key whose expiry has lapsed is EXPIRED, not AT_RISK", () => {
    // It cannot be redeemed today, so a rotation costs nothing. Counting it as
    // at-risk would scare an owner off a rotation that is in fact free.
    assert.equal(classifyInviteForPepperChange(arx("PENDING", PAST), NOW), "EXPIRED");
  });

  it("expiry exactly at 'now' counts as lapsed", () => {
    assert.equal(classifyInviteForPepperChange(arx("PENDING", NOW), NOW), "EXPIRED");
  });

  it("a swept EXPIRED ARX key is EXPIRED", () => {
    assert.equal(classifyInviteForPepperChange(arx("EXPIRED", FUTURE), NOW), "EXPIRED");
  });

  it("a PAUSED ARX key is PAUSED — not redeemable today either way", () => {
    assert.equal(classifyInviteForPepperChange(arx("PAUSED", FUTURE), NOW), "PAUSED");
  });

  it("ACCEPTED and REVOKED ARX keys are SETTLED — matched by row, never re-hashed", () => {
    assert.equal(classifyInviteForPepperChange(arx("ACCEPTED"), NOW), "SETTLED");
    assert.equal(classifyInviteForPepperChange(arx("REVOKED"), NOW), "SETTLED");
  });

  it("an unrecognised status does NOT fall into AT_RISK", () => {
    // A status this build has not heard of must not inflate the one number the
    // press is gated on. It settles, and is visible in the SETTLED column.
    assert.equal(classifyInviteForPepperChange(arx("SOME_FUTURE_STATUS"), NOW), "SETTLED");
  });
});

describe("pepper pre-flight — legacy invites are a different question", () => {
  it("a redeemable pre-shield invite is LEGACY_PENDING, never AT_RISK", () => {
    // Its hash is sha256(rawCode) with no pepper, so a pepper CHANGE cannot
    // break it. Calling it at-risk would misreport what a rotation costs.
    assert.equal(classifyInviteForPepperChange(legacy("PENDING", FUTURE), NOW), "LEGACY_PENDING");
    assert.equal(classifyInviteForPepperChange(legacy("PENDING", null), NOW), "LEGACY_PENDING");
  });

  it("a lapsed or terminal pre-shield invite is LEGACY_SETTLED", () => {
    assert.equal(classifyInviteForPepperChange(legacy("PENDING", PAST), NOW), "LEGACY_SETTLED");
    assert.equal(classifyInviteForPepperChange(legacy("ACCEPTED"), NOW), "LEGACY_SETTLED");
    assert.equal(classifyInviteForPepperChange(legacy("REVOKED"), NOW), "LEGACY_SETTLED");
    assert.equal(classifyInviteForPepperChange(legacy("PAUSED"), NOW), "LEGACY_SETTLED");
  });
});

describe("pepper pre-flight — the tally over a mixed fixture", () => {
  const FIXTURE: InviteFacts[] = [
    arx("PENDING", null),            // AT_RISK
    arx("PENDING", FUTURE),          // AT_RISK
    arx("PENDING", FUTURE),          // AT_RISK
    arx("PENDING", PAST),            // EXPIRED (lapsed)
    arx("EXPIRED", PAST),            // EXPIRED (swept)
    arx("PAUSED", FUTURE),           // PAUSED
    arx("ACCEPTED", null),           // SETTLED
    arx("REVOKED", null),            // SETTLED
    arx("ACCEPTED", PAST),           // SETTLED
    legacy("PENDING", FUTURE),       // LEGACY_PENDING
    legacy("PENDING", PAST),         // LEGACY_SETTLED
    legacy("ACCEPTED", null),        // LEGACY_SETTLED
  ];

  it("counts each category exactly", () => {
    assert.deepEqual(tallyInvites(FIXTURE, NOW), {
      AT_RISK: 3,
      EXPIRED: 2,
      PAUSED: 1,
      SETTLED: 3,
      LEGACY_PENDING: 1,
      LEGACY_SETTLED: 2,
    });
  });

  it("every row lands in exactly one bucket — the totals reconcile", () => {
    // A classifier that dropped or double-counted a row would still look
    // plausible per-category; only the sum catches it.
    const t = tallyInvites(FIXTURE, NOW);
    const sum = PEPPER_CHANGE_CATEGORY_ORDER.reduce((n, c) => n + t[c], 0);
    assert.equal(sum, FIXTURE.length);
  });

  it("an empty table tallies to all zeroes, not to nothing", () => {
    assert.deepEqual(tallyInvites([], NOW), emptyTally());
  });

  it("AT_RISK is stable as time passes only through expiry", () => {
    // Same fixture, evaluated after every FUTURE expiry has lapsed: the two
    // future-dated at-risk keys must drop out, the no-expiry one must not.
    const later = new Date("2027-01-01T00:00:00.000Z");
    assert.equal(tallyInvites(FIXTURE, later).AT_RISK, 1);
  });
});
