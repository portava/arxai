// Phase 22V Part 4 — seed two fresh test users (unapproved + approved-target)
// with KNOWN passwords so a Playwright UI smoke test can log in. Bypasses
// the beta invite gate by inserting directly into the DB. Cleans nothing —
// the smoke test asserts on these users and a teardown step removes them.
import { db, usersTable, userMasterLiveAccessTable, masterLiveAccessAuditTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { hashPassword } from "../../artifacts/api-server/src/lib/auth/password";

const TS = Date.now();
const UNAPPROVED_EMAIL = `phase22v4_unapp_${TS}@arx.test`;
const APPROVED_EMAIL = `phase22v4_app_${TS}@arx.test`;
const PASSWORD = "Phase22V4SmokePass!";

async function main() {
  // If a stale seed user from a previous run is hanging around, nuke it
  // so we always start clean.
  const stale = await db.select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable);
  const staleIds = stale.filter((u) => u.email.startsWith("phase22v4_")).map((u) => u.id);
  if (staleIds.length) {
    await db.delete(masterLiveAccessAuditTable).where(inArray(masterLiveAccessAuditTable.targetUserId, staleIds));
    await db.delete(userMasterLiveAccessTable).where(inArray(userMasterLiveAccessTable.userId, staleIds));
    await db.delete(usersTable).where(inArray(usersTable.id, staleIds));
  }

  const pwHash = hashPassword(PASSWORD);
  const [unapp] = await db.insert(usersTable).values({
    email: UNAPPROVED_EMAIL, role: "USER", passwordHash: pwHash, name: "Smoke Unapproved",
  }).returning();
  const [appr] = await db.insert(usersTable).values({
    email: APPROVED_EMAIL, role: "USER", passwordHash: pwHash, name: "Smoke Approved",
  }).returning();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    unapprovedUserId: unapp!.id, unapprovedEmail: UNAPPROVED_EMAIL,
    approvedUserId: appr!.id, approvedEmail: APPROVED_EMAIL,
    password: PASSWORD,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
