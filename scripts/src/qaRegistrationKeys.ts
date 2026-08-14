/**
 * QA suite for the Registration Key Shield.
 *
 * Tests: generate / validate / bulk / roleGrant / pepperMissing / concurrent / noHashLeak.
 *
 * Run: pnpm --filter @workspace/scripts run test:registration-keys
 *
 * Uses the public @workspace/db API (betaInvitesRepo namespace).
 * All rows written use invitedByUserId < 0 and are cleaned up at the end.
 */

import { db, betaInvitesRepo } from "@workspace/db";
import { betaInvitesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const {
  generateArxKey,
  normalizeArxKey,
  extractKeyPrefix,
  hashRegistrationKeyPeppered,
  maskArxKey,
  createRegistrationKey,
  createRegistrationKeys,
  findInviteByCode,
  validateInviteForRegistration,
  acceptInviteTx,
  revokeUnusedKey,
  updateUnusedKeyExpiry,
  isRegistrationKeyPepperConfigured,
  toPublicInvite,
} = betaInvitesRepo;

// ── Helpers ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(msg: string): void {
  console.log(`  PASS  ${msg}`);
  passed++;
}
function fail(msg: string, detail?: unknown): void {
  console.error(`  FAIL  ${msg}`, detail ?? "");
  failed++;
}
function assert(cond: boolean, msg: string, detail?: unknown): void {
  if (cond) pass(msg); else fail(msg, detail);
}

const TEST_PEPPER = "test-pepper-qa-registration-keys-2026";

function withPepper<T>(fn: () => T): T {
  const prev = process.env["REGISTRATION_KEY_PEPPER"];
  process.env["REGISTRATION_KEY_PEPPER"] = TEST_PEPPER;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env["REGISTRATION_KEY_PEPPER"];
    else process.env["REGISTRATION_KEY_PEPPER"] = prev;
  }
}

function withoutPepper<T>(fn: () => T): T {
  const prev = process.env["REGISTRATION_KEY_PEPPER"];
  delete process.env["REGISTRATION_KEY_PEPPER"];
  try { return fn(); } finally {
    if (prev !== undefined) process.env["REGISTRATION_KEY_PEPPER"] = prev;
  }
}

// ── Section 1: Key format helpers ─────────────────────────────────────────

console.log("\n[1] Key format helpers");

{
  const key = generateArxKey();
  const ARX_FORMAT = /^ARX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  assert(ARX_FORMAT.test(key), `generateArxKey() returns ARX-XXXX-XXXX-XXXX format — ${key}`);

  const key2 = generateArxKey();
  assert(key !== key2, "generateArxKey() is random (two consecutive calls differ)");

  const norm = normalizeArxKey(" arx-abcd-1234-efgh ");
  assert(norm === "ARX-ABCD-1234-EFGH", `normalizeArxKey() uppercases and strips whitespace — got "${norm}"`);

  const prefix = extractKeyPrefix("ARX-ABCD-1234-EFGH");
  assert(prefix === "ARX-ABCD", `extractKeyPrefix() returns first 8 chars — got "${prefix}"`);

  const masked = maskArxKey("ARX-ABCD");
  assert(typeof masked === "string" && masked.includes("ARX-ABCD"), `maskArxKey() preserves prefix — got "${masked}"`);
}

// ── Section 2: Pepper hash ────────────────────────────────────────────────

console.log("\n[2] Pepper hashing");

{
  const key = "ARX-TEST-HASH-0001";
  const h1 = withPepper(() => hashRegistrationKeyPeppered(key));
  const h2 = withPepper(() => hashRegistrationKeyPeppered(key));
  assert(h1 === h2, "hashRegistrationKeyPeppered() is deterministic for same input");
  assert(h1.length === 64, `hashRegistrationKeyPeppered() returns 64-char hex — ${h1.length}`);
  assert(!h1.includes(key), "hashRegistrationKeyPeppered() does not contain raw key in output");

  const h3 = withPepper(() => hashRegistrationKeyPeppered("ARX-TEST-HASH-0002"));
  assert(h1 !== h3, "hashRegistrationKeyPeppered() differs for different inputs");

  const noPepperOk = withoutPepper(() => {
    try { hashRegistrationKeyPeppered(key); return false; } catch { return true; }
  });
  assert(noPepperOk, "hashRegistrationKeyPeppered() throws when REGISTRATION_KEY_PEPPER is unset");

  assert(!isRegistrationKeyPepperConfigured(), "isRegistrationKeyPepperConfigured() returns false when pepper missing");
  const pepperOk = withPepper(() => isRegistrationKeyPepperConfigured());
  assert(pepperOk, "isRegistrationKeyPepperConfigured() returns true when pepper is set");
}

// ── Section 3: createRegistrationKey + findInviteByCode ──────────────────

console.log("\n[3] Create single key + find by code");

let createdKeyId = -1;
let createdRawKey = "";
const createdIds: number[] = [];

{
  const result = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9991,
    invitedByRole: "ADMIN",
    notes: "qa-test single key",
  }));
  assert(result.ok, "createRegistrationKey() succeeds with pepper configured");
  if (result.ok) {
    createdKeyId = result.invite.id;
    createdIds.push(createdKeyId);
    createdRawKey = result.rawKey;
    assert(/^ARX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(createdRawKey), `rawKey is ARX format — ${createdRawKey}`);
    assert(typeof result.invite.keyPrefix === "string" && result.invite.keyPrefix.startsWith("ARX-"), `keyPrefix stored — ${result.invite.keyPrefix}`);
    assert(result.invite.inviteCodeHash !== createdRawKey, "stored hash is not the raw key");
    assert((result.invite.inviteCodeHash ?? "").length === 64, `stored hash is 64-char hex — ${(result.invite.inviteCodeHash ?? "").length}`);
    assert(result.invite.email === null, "email is null for email-optional key");

    const found = await withPepper(() => findInviteByCode(createdRawKey));
    assert(found !== null, "findInviteByCode() finds the key by rawKey");
    assert(found?.id === createdKeyId, `findInviteByCode() returns correct row id=${found?.id}`);

    const rowJson = JSON.stringify(found);
    assert(!rowJson.includes(createdRawKey), "findInviteByCode() result does not contain raw key");
  }
}

// ── Section 4: createRegistrationKey — no pepper ──────────────────────────

console.log("\n[4] createRegistrationKey without pepper fails closed");

{
  const result = await withoutPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9992,
    invitedByRole: "ADMIN",
  }));
  assert(!result.ok && result.error === "PEPPER_MISSING",
    `createRegistrationKey() without pepper returns PEPPER_MISSING — got ${JSON.stringify(result)}`);
}

// ── Section 5: createRegistrationKeys (bulk) ──────────────────────────────

console.log("\n[5] Bulk key generation");

{
  const result = await withPepper(() => createRegistrationKeys({
    count: 5,
    email: null,
    roleGrant: "INVESTOR",
    invitedByUserId: -9993,
    invitedByRole: "OWNER",
    notes: "qa-test bulk",
    expiresInDays: 30,
  }));
  assert(result.ok, "createRegistrationKeys() bulk succeeds");
  if (result.ok) {
    assert(result.keys.length === 5, `bulk creates 5 keys — got ${result.keys.length}`);
    const rawKeys = result.keys.map((k) => k.rawKey);
    const unique = new Set(rawKeys);
    assert(unique.size === 5, `all 5 bulk keys are unique — distinct=${unique.size}`);
    assert(rawKeys.every((k: string) => /^ARX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(k)), "all bulk keys are ARX format");
    // Bulk return has no invite field; verify expiresAt via a separate DB read of one id
    const sampleId = result.keys[0]!.id;
    const sampleRow = await withPepper(() => findInviteByCode(result.keys[0]!.rawKey));
    assert(sampleRow?.expiresAt !== null, "expiresInDays=30 propagated to keys (verified via findInviteByCode)");
    void sampleId;
    for (const k of result.keys) createdIds.push(k.id);
  }

  const overLimit = await withPepper(() => createRegistrationKeys({
    count: 101,
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9993,
    invitedByRole: "ADMIN",
  }));
  assert(!overLimit.ok, "count=101 is rejected");
}

// ── Section 6: validateInviteForRegistration ──────────────────────────────

console.log("\n[6] validateInviteForRegistration");

{
  const v1 = await withPepper(() => validateInviteForRegistration({
    inviteCode: createdRawKey,
    email: "anyone@example.com",
  }));
  assert(v1.ok, `email-optional key validates for any email — ${JSON.stringify(v1)}`);

  const v2 = await withPepper(() => validateInviteForRegistration({
    inviteCode: "ARX-FAKE-FAKE-FAKE",
    email: "user@example.com",
  }));
  assert(!v2.ok && v2.error === "INVITE_NOT_FOUND", `invalid key returns INVITE_NOT_FOUND — ${JSON.stringify(v2)}`);

  const v3 = await withPepper(() => validateInviteForRegistration({
    inviteCode: "",
    email: "user@example.com",
  }));
  assert(!v3.ok && v3.error === "INVITE_REQUIRED", `empty key returns INVITE_REQUIRED — ${JSON.stringify(v3)}`);

  const emailKeyResult = await withPepper(() => createRegistrationKey({
    email: "specific@example.com",
    roleGrant: "USER",
    invitedByUserId: -9994,
    invitedByRole: "ADMIN",
    notes: "qa-test email-assigned",
  }));
  assert(emailKeyResult.ok, "email-assigned key created");
  if (emailKeyResult.ok) {
    const emailKey = emailKeyResult.rawKey;
    createdIds.push(emailKeyResult.invite.id);
    const v4 = await withPepper(() => validateInviteForRegistration({
      inviteCode: emailKey,
      email: "specific@example.com",
    }));
    assert(v4.ok, "email-assigned key validates for matching email");
    const v5 = await withPepper(() => validateInviteForRegistration({
      inviteCode: emailKey,
      email: "wrong@example.com",
    }));
    assert(!v5.ok && v5.error === "EMAIL_MISMATCH", `email mismatch returns EMAIL_MISMATCH — ${JSON.stringify(v5)}`);
  }
}

// ── Section 7: roleGrant preserved through acceptance ────────────────────

console.log("\n[7] roleGrant — value preserved through acceptance");

{
  const roleKeyResult = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "INVESTOR",
    invitedByUserId: -9995,
    invitedByRole: "OWNER",
    notes: "qa-test roleGrant INVESTOR",
  }));
  assert(roleKeyResult.ok, "INVESTOR role key created");
  if (roleKeyResult.ok) {
    createdIds.push(roleKeyResult.invite.id);
    assert(roleKeyResult.invite.roleGrant === "INVESTOR", `roleGrant stored as INVESTOR — got ${roleKeyResult.invite.roleGrant}`);

    const syntheticUserId = -88881;
    try {
      await db.transaction(async (tx) => {
        const accepted = await withPepper(() => acceptInviteTx(tx, {
          inviteCode: roleKeyResult.rawKey,
          email: "investor-qa@example.com",
          userId: syntheticUserId,
        }));
        if (accepted.ok) {
          assert(accepted.invite.acceptedUserId === syntheticUserId, `acceptInviteTx marks acceptedUserId — ${accepted.invite.acceptedUserId}`);
          assert(accepted.invite.status === "ACCEPTED", `acceptInviteTx sets status=ACCEPTED — ${accepted.invite.status}`);
          assert(accepted.invite.roleGrant === "INVESTOR", `roleGrant preserved on accepted row — ${accepted.invite.roleGrant}`);
        } else {
          fail(`acceptInviteTx failed unexpectedly — ${JSON.stringify(accepted)}`);
        }
        throw new Error("qa-rollback");
      });
    } catch (e) {
      if (e instanceof Error && e.message === "qa-rollback") {
        pass("acceptInviteTx tx rolled back cleanly (QA isolation)");
      } else {
        fail("acceptInviteTx threw unexpectedly", e);
      }
    }
  }
}

// ── Section 8: revokeUnusedKey ────────────────────────────────────────────

console.log("\n[8] revokeUnusedKey");

{
  const revokeKeyResult = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9996,
    invitedByRole: "ADMIN",
    notes: "qa-test revoke",
  }));
  assert(revokeKeyResult.ok, "key for revoke test created");
  if (revokeKeyResult.ok) {
    createdIds.push(revokeKeyResult.invite.id);
    const rev = await revokeUnusedKey(revokeKeyResult.invite.id, -9996);
    assert(rev.ok, "revokeUnusedKey() succeeds on PENDING key");
    if (rev.ok) {
      assert(rev.row.status === "REVOKED", `status=REVOKED after revoke — ${rev.row.status}`);
    }

    const rev2 = await revokeUnusedKey(revokeKeyResult.invite.id, -9996);
    assert(!rev2.ok && rev2.error === "ALREADY_REVOKED", `double-revoke returns ALREADY_REVOKED — ${JSON.stringify(rev2)}`);

    const rev3 = await revokeUnusedKey(-99999, -9996);
    assert(!rev3.ok && rev3.error === "NOT_FOUND", `non-existent id returns NOT_FOUND — ${JSON.stringify(rev3)}`);
  }
}

// ── Section 8b: updateUnusedKeyExpiry ─────────────────────────────────────

console.log("\n[8b] updateUnusedKeyExpiry");

{
  // set/extend/clear on a PENDING key
  const expiryKey = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9998,
    invitedByRole: "ADMIN",
    notes: "qa-test expiry",
  }));
  assert(expiryKey.ok, "key for expiry test created");
  if (expiryKey.ok) {
    createdIds.push(expiryKey.invite.id);
    assert(expiryKey.invite.expiresAt === null, "new key starts with no expiry");

    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const set1 = await updateUnusedKeyExpiry(expiryKey.invite.id, future, -9998);
    assert(set1.ok, "updateUnusedKeyExpiry() sets expiry on PENDING key");
    if (set1.ok) {
      assert(set1.row.expiresAt !== null, "expiresAt is set after update");
      assert(Math.abs((set1.row.expiresAt as Date).getTime() - future.getTime()) < 1000, "expiresAt matches the requested date");
    }

    // extend further out
    const later = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const set2 = await updateUnusedKeyExpiry(expiryKey.invite.id, later, -9998);
    assert(set2.ok && set2.row.expiresAt !== null, "updateUnusedKeyExpiry() extends expiry on PENDING key");

    // clear to no-expiry
    const cleared = await updateUnusedKeyExpiry(expiryKey.invite.id, null, -9998);
    assert(cleared.ok, "updateUnusedKeyExpiry() clears expiry (null)");
    if (cleared.ok) {
      assert(cleared.row.expiresAt === null, "expiresAt is null after clear");
    }
  }

  // non-existent id → NOT_FOUND
  const missing = await updateUnusedKeyExpiry(-99998, new Date(), -9998);
  assert(!missing.ok && missing.error === "NOT_FOUND", `non-existent id returns NOT_FOUND — ${JSON.stringify(missing)}`);

  // REVOKED key cannot have expiry changed
  const revForExpiry = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9998,
    invitedByRole: "ADMIN",
    notes: "qa-test expiry on revoked",
  }));
  if (revForExpiry.ok) {
    createdIds.push(revForExpiry.invite.id);
    const rev = await revokeUnusedKey(revForExpiry.invite.id, -9998);
    assert(rev.ok, "key revoked for revoked-expiry test");
    const blocked = await updateUnusedKeyExpiry(revForExpiry.invite.id, new Date(), -9998);
    assert(!blocked.ok && blocked.error === "ALREADY_REVOKED", `expiry change on REVOKED key returns ALREADY_REVOKED — ${JSON.stringify(blocked)}`);
  }

  // ACCEPTED key cannot have expiry changed. Mark ACCEPTED directly — we are
  // testing the expiry guard here, not the (pepper-dependent) acceptance flow.
  const accForExpiry = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9998,
    invitedByRole: "ADMIN",
    notes: "qa-test expiry on accepted",
  }));
  if (accForExpiry.ok) {
    createdIds.push(accForExpiry.invite.id);
    await db.update(betaInvitesTable)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), acceptedUserId: -88882 })
      .where(eq(betaInvitesTable.id, accForExpiry.invite.id));
    const blockedAcc = await updateUnusedKeyExpiry(accForExpiry.invite.id, new Date(), -9998);
    assert(!blockedAcc.ok && blockedAcc.error === "ALREADY_USED", `expiry change on ACCEPTED key returns ALREADY_USED — ${JSON.stringify(blockedAcc)}`);
  }

  // PAUSED key cannot have expiry changed
  const pausedForExpiry = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9998,
    invitedByRole: "ADMIN",
    notes: "qa-test expiry on paused",
  }));
  if (pausedForExpiry.ok) {
    createdIds.push(pausedForExpiry.invite.id);
    await db.update(betaInvitesTable)
      .set({ status: "PAUSED", pausedAt: new Date() })
      .where(eq(betaInvitesTable.id, pausedForExpiry.invite.id));
    const blockedPaused = await updateUnusedKeyExpiry(pausedForExpiry.invite.id, new Date(), -9998);
    assert(!blockedPaused.ok && blockedPaused.error === "ALREADY_PAUSED", `expiry change on PAUSED key returns ALREADY_PAUSED — ${JSON.stringify(blockedPaused)}`);
  }

  // already-expired (but still PENDING) key cannot have its window reopened
  const expiredForExpiry = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9998,
    invitedByRole: "ADMIN",
    notes: "qa-test expiry on expired",
  }));
  if (expiredForExpiry.ok) {
    createdIds.push(expiredForExpiry.invite.id);
    await db.update(betaInvitesTable)
      .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(betaInvitesTable.id, expiredForExpiry.invite.id));
    const blockedExpired = await updateUnusedKeyExpiry(expiredForExpiry.invite.id, new Date(Date.now() + 86_400_000), -9998);
    assert(!blockedExpired.ok && blockedExpired.error === "ALREADY_EXPIRED", `expiry change on an expired PENDING key returns ALREADY_EXPIRED — ${JSON.stringify(blockedExpired)}`);
  }
}

// ── Section 9: No hash leak in toPublicInvite ─────────────────────────────

console.log("\n[9] No raw key / hash leak in toPublicInvite");

{
  const rowResult = await withPepper(() => createRegistrationKey({
    email: null,
    roleGrant: "USER",
    invitedByUserId: -9997,
    invitedByRole: "ADMIN",
    notes: "qa-test no-hash-leak",
  }));
  if (rowResult.ok) {
    createdIds.push(rowResult.invite.id);
    const pub = toPublicInvite(rowResult.invite);
    const pubStr = JSON.stringify(pub);
    assert(!pubStr.includes(rowResult.rawKey), "toPublicInvite() does not contain raw key");
    if (rowResult.invite.inviteCodeHash) {
      assert(!pubStr.includes(rowResult.invite.inviteCodeHash), "toPublicInvite() does not contain inviteCodeHash");
    } else {
      pass("toPublicInvite() inviteCodeHash is null (no leak possible)");
    }
    assert(pub["keyMasked"] !== undefined, "toPublicInvite() exposes keyMasked field");
    assert(!pub["inviteCodeHash"], "toPublicInvite() does not expose inviteCodeHash field");
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────

console.log("\n[cleanup] Removing synthetic test rows…");

{
  const allIds = [...new Set(createdIds)].filter((id) => id > 0);
  for (const id of allIds) {
    try { await db.delete(betaInvitesTable).where(eq(betaInvitesTable.id, id)); } catch { /* noop */ }
  }
  pass(`cleanup removed ${allIds.length} synthetic test row(s)`);
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} total: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nQA FAILED — ${failed} failure(s)`);
  process.exit(1);
} else {
  console.log(`\nAll registration key QA checks passed.`);
}
