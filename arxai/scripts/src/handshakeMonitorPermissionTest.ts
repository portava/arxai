// ARX Handshake System — admin monitor permission-isolation test (in-process).
//
// Boots the REAL Express app in-process and asserts the System Handshake
// Monitor endpoints are admin-only AND wired at the correct path:
//   - anonymous caller is rejected (401) on BOTH read and refresh, with no
//     verdict-data leak in the body
//   - a regular USER session is rejected (403)
//   - a real ADMIN session gets 200 with a `verdicts` array
//
// The ADMIN positive path is essential: a blanket guard 401s ANY /api/admin/*
// path (even nonexistent ones), so an anon-401-only test would still pass even
// if the route were registered at the wrong path. The authenticated 200 + the
// verdicts shape are the only assertions that actually prove the route is
// mounted and reachable at /api/admin/handshake-monitor.
//
// Run: pnpm --filter @workspace/scripts run test:handshake-monitor-perm

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import { usersTable, authUserSessionsTable } from "@workspace/db/schema";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TAG = `qaHandshakeMon_${Date.now()}_${randomBytes(3).toString("hex")}`;

async function createSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: TAG,
  });
  return raw;
}

async function seedUser(label: "ADMIN" | "USER"): Promise<{ id: number; cookie: string }> {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}_${label.toLowerCase()}@arx.test`,
      name: `${TAG} ${label}`,
      role: label,
    })
    .returning();
  const raw = await createSession(u!.id);
  return { id: u!.id, cookie: `${USER_SESSION_COOKIE}=${raw}` };
}

async function cleanup(ids: number[]): Promise<void> {
  try {
    await pool.query("DELETE FROM auth_user_sessions WHERE user_agent = $1", [TAG]);
  } catch {
    /* fail-open: test cleanup must never throw */
  }
  if (ids.length > 0) {
    try {
      await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]);
    } catch {
      /* fail-open */
    }
  }
}

export async function run(): Promise<CiTestResultLike> {
  const name = "test:handshake-monitor-perm";
  let passes = 0;
  let failures = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) {
      passes++;
      console.log(`  PASS  ${label}`);
    } else {
      failures++;
      console.error(`  FAIL  ${label}`);
    }
  };

  const base = await getSharedBaseUrl();
  const seededIds: number[] = [];

  try {
    // 1. Anonymous GET → 401, no verdict body leak.
    {
      const r = await fetch(`${base}/api/admin/handshake-monitor`, { redirect: "manual" });
      check("anon GET monitor → 401", r.status === 401);
      const text = await r.text();
      check("anon GET → no verdict data leaked", !text.includes('"verdicts"'));
    }

    // 2. Anonymous POST refresh → 401 (cannot trigger a check-in write).
    {
      const r = await fetch(`${base}/api/admin/handshake-monitor/refresh`, {
        method: "POST",
        redirect: "manual",
      });
      check("anon POST refresh → 401", r.status === 401);
    }

    // 3. Regular USER session → 403 (role isolation, not just auth).
    {
      const user = await seedUser("USER");
      seededIds.push(user.id);
      const r = await fetch(`${base}/api/admin/handshake-monitor`, {
        headers: { cookie: user.cookie },
        redirect: "manual",
      });
      check("regular USER GET monitor → 403", r.status === 403);
      const text = await r.text();
      check("USER GET → no verdict data leaked", !text.includes('"verdicts"'));
    }

    // 4. Real ADMIN session → 200 with a verdicts array. This is the only
    //    assertion that proves the route is mounted at the documented path
    //    (a blanket guard 401s any /api/admin/* path, so anon-401 alone would
    //    pass even with a wrong-path registration).
    {
      const admin = await seedUser("ADMIN");
      seededIds.push(admin.id);
      const r = await fetch(`${base}/api/admin/handshake-monitor`, {
        headers: { cookie: admin.cookie },
        redirect: "manual",
      });
      check("ADMIN GET monitor → 200 (route reachable at documented path)", r.status === 200);
      const body = (await r.json().catch(() => null)) as { verdicts?: unknown } | null;
      check("ADMIN GET → response carries a verdicts array", Array.isArray(body?.verdicts));
    }
  } finally {
    await cleanup(seededIds);
  }

  console.log(`\n${name}: ${passes} passed, ${failures} failed`);
  return { name, passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run()
    .then(async (res) => {
      const { closeSharedServer } = await import("./ci/inProcessAppHarness.js");
      await closeSharedServer().catch(() => {});
      process.exit(res.failures > 0 ? 1 : 0);
    })
    .catch(async (err) => {
      const { closeSharedServer } = await import("./ci/inProcessAppHarness.js");
      await closeSharedServer().catch(() => {});
      console.error("[handshakeMonitorPermissionTest] FAILED:", err);
      process.exit(1);
    });
}
