// Multi-broker spec §15/§21 — the venue catalog must never present an
// unimplemented broker as usable, must be read-only at Phase 1, and must
// fail closed on compliance.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../brokerCatalog.ts"), "utf8");
const routesIndex = readFileSync(path.join(here, "../index.ts"), "utf8");

const { listUnavailableVenues } = await import("@workspace/domain/broker-hub");
const { evaluateComplianceGate } = await import("@workspace/domain/compliance-gate");

test("every unimplemented venue carries an explicit disabled state (spec §21)", () => {
  const venues = listUnavailableVenues();
  assert.ok(venues.length > 0, "the domain must enumerate unavailable venues");
  for (const v of venues) {
    assert.ok(
      ["NOT_IMPLEMENTED", "ONBOARDING_REQUIRED", "DISABLED"].includes(v.status),
      `${v.venue} must report an explicit disabled status, got ${v.status}`,
    );
    assert.equal(v.connected, false, `${v.venue} must never report connected`);
    for (const [cap, enabled] of Object.entries(v.capabilities)) {
      assert.equal(enabled, false, `${v.venue} must advertise no capability (${cap})`);
    }
  }
});

test("Phase 1 is read-only: no venue may advertise trading", () => {
  assert.match(src, /tradingEnabled:\s*false as const/);
  assert.match(src, /automationEnabled:\s*false as const/);
  assert.match(src, /canPlaceLiveTrade:\s*false as const/);
  assert.match(src, /orderSubmissionAvailable:\s*false/);
});

test("the router imports no execution, mailbox, or credential writer", () => {
  for (const forbidden of [
    "liveCommandPipeline",
    "enqueueBridgedMt5Command",
    "executionAdapter",
    "encryptCredential",
    "decryptCredential",
  ]) {
    assert.ok(!src.includes(forbidden), `catalog must not import ${forbidden}`);
  }
});

test("an absent eligibility review refuses exactly like COMPLIANCE_HOLD", () => {
  const absent = evaluateComplianceGate({
    eligibilityStatus: null,
    venueRequiresApproval: true,
    outsideClientFunds: false,
  });
  const hold = evaluateComplianceGate({
    eligibilityStatus: "COMPLIANCE_HOLD",
    venueRequiresApproval: true,
    outsideClientFunds: false,
  });
  assert.equal(absent.allowed, false, "no review must not mean no restriction");
  assert.equal(hold.allowed, false);
});

test("a failed eligibility read fails CLOSED and is surfaced, not silently swallowed", () => {
  assert.match(src, /eligibilityReadFailed = true/);
  assert.match(src, /eligibilityReadFailed,/, "the degraded read must be visible in the response");
  // On failure the map stays empty, so every venue takes the absent-review
  // refusal path rather than defaulting to allowed.
  assert.match(src, /eligibilityByVenue\.get\(venue\) \?\? null/);
});

test("venues default to REQUIRING approval — adding one cannot silently widen access", () => {
  assert.match(src, /VENUE_REQUIRES_APPROVAL\[venue\] \?\? true/);
});

test("the catalog route is actually mounted", () => {
  assert.match(routesIndex, /import brokerCatalogRouter from "\.\/brokerCatalog\.js";/);
  assert.match(routesIndex, /router\.use\(brokerCatalogRouter\);/);
});
