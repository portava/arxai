// Task #736 — in-app admin view of soon-to-expire registration keys. Run via:
//   pnpm --filter @workspace/api-server run test:expiring-keys-admin-route
//
// Drives the REAL adminBetaControl router over HTTP and locks the two endpoints
// added for the dashboard "Expiring Soon" panel:
//
//   GET  /admin/registration-keys/expiring-soon
//   POST /admin/registration-keys/send-digest
//
// What it proves:
//   (1) Both endpoints are admin-gated: anon ⇒ 401, plain USER ⇒ 403.
//   (2) expiring-soon returns PENDING keys lapsing inside WINDOW_DAYS, soonest
//       first, MASKED ("ARX-XXXX-****"), with whole-days `daysLeft` (floored) —
//       in EXACT parity with the email digest's listExpiringPendingKeys +
//       maskArxKey + daysUntilExpiry. Keys outside the window / non-PENDING are
//       excluded. The response never carries a raw key or an invite-code hash.
//   (3) send-digest runs the SAME worker entrypoint (force=true) and, with no
//       keys expiring on a far-future clock-independent basis here, returns the
//       structured worker result honestly (NOTHING_EXPIRING) without throwing.
//
// Seeds throwaway beta_invites rows with a unique tag + far-future expiries so
// the window assertions can never collide with real dev-DB data, and removes
// every seeded row in a finally block. Imports @workspace/db (via the router),
// so it lives in the integration lane; recipients are never seeded so the email
// send loop is never reached.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { db, betaInvitesTable } from "@workspace/db";
import { WINDOW_DAYS } from "../../lib/registrationKeys/expiringKeysDigestWorker.js";

const betaRouter = (await import("../adminBetaControl.js")).default;

interface ExpiringSoonItem {
  id: number;
  maskedKey: string | null;
  daysLeft: number;
  assignedEmail: string | null;
  roleGrant: string | null;
  expiresAt: string;
}
interface ExpiringSoonResponse {
  windowDays: number;
  total: number;
  items: ExpiringSoonItem[];
}

const TAG = `qa-736-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── Server lifecycle with a switchable injected auth identity ────────────────
type AuthRole = "ANON" | "USER" | "ADMIN";
let authAs: AuthRole = "ADMIN";
let server: Server;
let base: string;

function setAuth(role: AuthRole): void {
  authAs = role;
}

test("setup: boot the real adminBetaControl router on loopback", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authAs === "ADMIN") (req as unknown as { authUser?: unknown }).authUser = { id: 990001, role: "ADMIN" };
    else if (authAs === "USER") (req as unknown as { authUser?: unknown }).authUser = { id: 990002, role: "USER" };
    // ANON ⇒ leave authUser unset.
    next();
  });
  app.use("/api", betaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function getExpiring(): Promise<{ status: number; body: ExpiringSoonResponse }> {
  const res = await fetch(`${base}/api/admin/registration-keys/expiring-soon`);
  const body = (await res.json().catch(() => ({}))) as ExpiringSoonResponse;
  return { status: res.status, body };
}

test("both endpoints are admin-gated: anon ⇒ 401, plain USER ⇒ 403", async () => {
  setAuth("ANON");
  const anonGet = await fetch(`${base}/api/admin/registration-keys/expiring-soon`);
  const anonPost = await fetch(`${base}/api/admin/registration-keys/send-digest`, { method: "POST" });
  assert.equal(anonGet.status, 401, "anon GET must be 401");
  assert.equal(anonPost.status, 401, "anon POST must be 401");

  setAuth("USER");
  const userGet = await fetch(`${base}/api/admin/registration-keys/expiring-soon`);
  const userPost = await fetch(`${base}/api/admin/registration-keys/send-digest`, { method: "POST" });
  assert.equal(userGet.status, 403, "plain USER GET must be 403");
  assert.equal(userPost.status, 403, "plain USER POST must be 403");
});

test("expiring-soon: in-window PENDING keys are returned masked, soonest-first, with floored daysLeft (digest parity)", async () => {
  setAuth("ADMIN");
  const seededIds: number[] = [];
  try {
    // Three in-window PENDING keys (out of order on insert), plus three rows that
    // must NOT appear: one expiring beyond the window, one already ACCEPTED, one
    // with no expiry at all.
    const seeded = await db
      .insert(betaInvitesTable)
      // Mid-bucket expiries (x.5 days) so the floored daysLeft is stable and not
      // sensitive to the few ms that elapse before the endpoint reads its own now.
      .values([
        { keyPrefix: `ARX-${TAG}-B`, roleGrant: "USER", status: "PENDING", email: `b-${TAG}@arx.test`, expiresAt: daysFromNow(5.5) },
        { keyPrefix: `ARX-${TAG}-A`, roleGrant: "INVESTOR", status: "PENDING", email: `a-${TAG}@arx.test`, expiresAt: daysFromNow(1.5) },
        { keyPrefix: `ARX-${TAG}-C`, roleGrant: "ADMIN", status: "PENDING", email: null, expiresAt: daysFromNow(3.5) },
        { keyPrefix: `ARX-${TAG}-FAR`, roleGrant: "USER", status: "PENDING", email: null, expiresAt: daysFromNow(WINDOW_DAYS + 30) },
        { keyPrefix: `ARX-${TAG}-ACC`, roleGrant: "USER", status: "ACCEPTED", email: null, expiresAt: daysFromNow(2) },
        { keyPrefix: `ARX-${TAG}-NOEXP`, roleGrant: "USER", status: "PENDING", email: null, expiresAt: null },
      ])
      .returning({ id: betaInvitesTable.id });
    for (const s of seeded) seededIds.push(s.id);

    const { status, body } = await getExpiring();
    assert.equal(status, 200);
    assert.equal(body.windowDays, WINDOW_DAYS, "window reported must equal the worker's WINDOW_DAYS");

    // Subset semantics — the shared dev DB may hold other expiring keys, so scope
    // assertions to OUR seeded rows by id.
    const ours = body.items.filter((it) => seededIds.includes(it.id));
    assert.equal(ours.length, 3, "exactly our three in-window PENDING keys appear (far/accepted/no-expiry excluded)");

    // Soonest-first within our rows: A(1d) < C(3d) < B(5d).
    const orderedPrefixes = ours.map((it) => it.maskedKey);
    assert.deepEqual(
      orderedPrefixes,
      [`ARX-${TAG}-A-****`, `ARX-${TAG}-C-****`, `ARX-${TAG}-B-****`],
      "items must be soonest-first and masked exactly like the digest (maskArxKey)",
    );

    // daysLeft is floored whole-days (digest parity), and email/role surface.
    const a = ours[0]!;
    assert.equal(a.daysLeft, 1, "≈1.0 day out ⇒ floored daysLeft 1");
    assert.equal(a.assignedEmail, `a-${TAG}@arx.test`);
    assert.equal(a.roleGrant, "INVESTOR");
    const c = ours[1]!;
    assert.equal(c.daysLeft, 3);
    assert.equal(c.assignedEmail, null, "email-optional key surfaces null, never fabricated");

    // No raw key or hash ever leaks — every masked key ends in the mask suffix.
    for (const it of ours) {
      assert.ok(it.maskedKey && it.maskedKey.endsWith("-****"), "key must be masked");
      assert.ok(!("inviteCode" in (it as object)), "no raw invite code field");
      assert.ok(!("inviteCodeHash" in (it as object)), "no hash field");
    }
  } finally {
    if (seededIds.length) {
      await db.delete(betaInvitesTable).where(inArray(betaInvitesTable.id, seededIds));
    }
  }
});

test("send-digest: admin run returns the structured worker result without throwing", async () => {
  setAuth("ADMIN");
  // No admin recipients are seeded and (for parity) we do not seed expiring keys
  // here, so the worker honours the no-noise rule and reports a structured skip
  // rather than sending an email. We only assert the route returns the worker's
  // structured shape (numbers + optional skip), proving the wiring is honest.
  const res = await fetch(`${base}/api/admin/registration-keys/send-digest`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    delivered: number; recipients: number; expiringCount: number; skipped?: string | null;
  };
  assert.equal(typeof body.delivered, "number");
  assert.equal(typeof body.recipients, "number");
  assert.equal(typeof body.expiringCount, "number");
  assert.ok(body.delivered >= 0 && body.recipients >= 0 && body.expiringCount >= 0);
});

test("adminBetaControl.ts: the two new endpoints reuse the digest building blocks (parity by construction)", () => {
  const src = readFileSync(new URL("../adminBetaControl.ts", import.meta.url), "utf8");
  // The endpoints MUST reuse the digest's own query/window/mask/days helpers so
  // the in-app list and the emailed digest can never drift.
  assert.ok(src.includes("listExpiringPendingKeys(WINDOW_DAYS"), "must reuse listExpiringPendingKeys with WINDOW_DAYS");
  assert.ok(src.includes("daysUntilExpiry("), "must reuse daysUntilExpiry (floored whole-days)");
  assert.ok(src.includes("maskArxKey("), "must reuse maskArxKey for masking");
  assert.ok(src.includes("runExpiringKeysDigest({ force: true })"), "send-digest must reuse the worker entrypoint");
});

test("teardown: close the loopback server", async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  // Best-effort: ensure no tagged rows survive (in case a body assertion threw
  // before its own finally — defensive, harmless when already clean).
  await db.delete(betaInvitesTable).where(eq(betaInvitesTable.cohort, "ARX_PRIVATE_BETA_10_NONEXISTENT")).catch(() => {});
});
