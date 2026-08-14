/**
 * seedArxBeta10Invites.ts
 *
 * One-shot seeder for the ARX_PRIVATE_BETA_10 cohort.
 *
 * Creates exactly 10 invites labelled ARX-BETA-USER-01..10 via the same
 * `createInvite()` repo path the admin endpoint uses (SHA-256 hashing,
 * 14-day TTL, DEMO_TESTER mode, server-side cap, dedupe on email).
 *
 * Raw codes are returned by the repo EXACTLY ONCE (the DB never stores
 * plaintext). This script prints them to stdout for the operator and
 * exits.
 *
 * Idempotent: if an invite with the same placeholder email already
 * exists in ACTIVE status, the seeder skips that slot and reports.
 *
 * Refuses to run in production. Never touches arx_live_commands.
 */

import { betaInvitesRepo } from "@workspace/db";
const { createInvite, listInvites, countActiveInvites } = betaInvitesRepo;

const COHORT = "ARX_PRIVATE_BETA_10";
const LABELS = Array.from({ length: 10 }, (_, i) => `ARX-BETA-USER-${String(i + 1).padStart(2, "0")}`);

function placeholderEmail(label: string): string {
  // Deterministic placeholder email. Admin can update notes/email later
  // via DB or by revoking + re-issuing with the real invitee email.
  return `${label.toLowerCase()}@arx-beta.local`;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("[seedArxBeta10Invites] refused: NODE_ENV=production");
    process.exit(2);
  }

  const before = await countActiveInvites(COHORT);
  console.log(`[seedArxBeta10Invites] cohort=${COHORT} activeBefore=${before}`);

  const existing = await listInvites(COHORT);
  const existingByEmail = new Map(existing.map((r) => [r.email, r] as const));

  const created: Array<{ label: string; email: string; inviteId: number; rawCode: string; expiresAt: Date | null }> = [];
  const skipped: Array<{ label: string; email: string; reason: string }> = [];

  for (const label of LABELS) {
    const email = placeholderEmail(label);
    const prior = existingByEmail.get(email);
    if (prior && ["PENDING", "ACCEPTED", "PAUSED"].includes(prior.status)) {
      skipped.push({ label, email, reason: `already exists status=${prior.status} id=${prior.id}` });
      continue;
    }
    const result = await createInvite({
      email,
      accountMode: "DEMO_TESTER",
      invitedByUserId: null,
      notes: label,
      cohort: COHORT,
      // expiresInDays omitted → repo default (14 days)
    });
    if (!result.ok) {
      skipped.push({ label, email, reason: `createInvite error=${result.error}` });
      continue;
    }
    created.push({
      label,
      email,
      inviteId: result.invite.id,
      rawCode: result.rawCode,
      expiresAt: result.invite.expiresAt,
    });
  }

  const after = await countActiveInvites(COHORT);
  console.log(`[seedArxBeta10Invites] activeAfter=${after}`);
  console.log("");
  console.log("===========================================================");
  console.log("  ARX_PRIVATE_BETA_10 — INVITE CODES (shown ONCE)");
  console.log("  Server stores SHA-256 hashes only. Copy these now.");
  console.log("===========================================================");
  for (const row of created) {
    const exp = row.expiresAt ? row.expiresAt.toISOString() : "never";
    console.log(`  ${row.label}  id=${row.inviteId}  code=${row.rawCode}  expires=${exp}`);
  }
  if (skipped.length) {
    console.log("");
    console.log("--- SKIPPED ---");
    for (const s of skipped) console.log(`  ${s.label}  (${s.reason})`);
  }
  console.log("===========================================================");
  console.log(`  created=${created.length}  skipped=${skipped.length}  activeTotal=${after}/10`);
  console.log("===========================================================");

  // Acceptance contract: end-state must have exactly 10 active invites.
  if (after !== 10) {
    console.error(`[seedArxBeta10Invites] FAIL: expected 10 active invites, got ${after}`);
    process.exit(1);
  }
  console.log("[seedArxBeta10Invites] OK");
}

main().catch((err) => {
  console.error("[seedArxBeta10Invites] error", err);
  process.exit(1);
});
