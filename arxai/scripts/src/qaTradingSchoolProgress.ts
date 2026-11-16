/**
 * qaTradingSchoolProgress.ts
 *
 * End-to-end QA for per-user Trading School progress persistence.
 *
 * Verifies:
 *   1. Unauthenticated GET/PUT are rejected (401).
 *   2. Authenticated GET with no saved row returns the empty default.
 *   3. PUT persists the full blob and echoes it back.
 *   4. A fresh GET returns exactly what was persisted (survives "device switch").
 *   5. Per-user isolation: user B never sees user A's progress.
 *
 * Self-seeds two isolated regular users and tears them down afterward.
 * Requires the API server running at $BASE_URL (default http://localhost:80).
 */

import { pool } from "@workspace/db";
import { randomBytes, scryptSync } from "node:crypto";

const BASE = (process.env.BASE_URL ?? "http://localhost:80").replace(/\/$/, "");
const PATH = "/api/me/trading-school/progress";

let pass = 0,
  fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

interface FetchResult {
  status: number;
  body: string;
  cookies: string[];
}
async function call(
  method: string,
  path: string,
  opts: { cookie?: string; json?: unknown } = {},
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  return {
    status: res.status,
    body: await res.text(),
    cookies: res.headers.getSetCookie?.() ?? [],
  };
}
function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

const N = 65536,
  r = 8,
  p = 1,
  KEYLEN = 64;
function hashLocal(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function seedUser(): Promise<{ id: number; email: string; password: string }> {
  const email = `qa-school-${randomBytes(4).toString("hex")}@arx.local`;
  const password = `User-${randomBytes(6).toString("hex")}`;
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'QA School', $2, 'USER') RETURNING id`,
    [email, hashLocal(password)],
  );
  return { id: ins.rows[0]!.id, email, password };
}

async function main(): Promise<void> {
  const a = await seedUser();
  const b = await seedUser();
  console.log(`[setup] user A=${a.id}  user B=${b.id}`);

  try {
    // 1. Unauthenticated
    const anonGet = await call("GET", PATH);
    const anonPut = await call("PUT", PATH, { json: {} });
    check("01a_anon_get_401", anonGet.status === 401, `status=${anonGet.status}`);
    check("01b_anon_put_401", anonPut.status === 401, `status=${anonPut.status}`);

    // login A and B
    const loginA = await call("POST", "/api/auth/login", { json: { email: a.email, password: a.password } });
    const loginB = await call("POST", "/api/auth/login", { json: { email: b.email, password: b.password } });
    const cookieA = cookieHeader(loginA.cookies);
    const cookieB = cookieHeader(loginB.cookies);
    check("02_logins_succeed", loginA.status === 200 && loginB.status === 200, `A=${loginA.status} B=${loginB.status}`);

    // 2. Empty default for fresh user A
    const emptyA = await call("GET", PATH, { cookie: cookieA });
    let emptyOk = false;
    try {
      const j = JSON.parse(emptyA.body) as { ok: boolean; progress: { completedLessonIds: string[]; startedAt: string | null } };
      emptyOk = j.ok === true && j.progress.completedLessonIds.length === 0 && j.progress.startedAt === null;
    } catch { /* fail below */ }
    check("03_empty_default_for_fresh_user", emptyA.status === 200 && emptyOk, `body=${emptyA.body.slice(0, 120)}`);

    // 3. PUT persists for A
    const payload = {
      startedAt: "2026-06-01T10:00:00.000Z",
      completedAt: null,
      lastLessonId: "step-3",
      completedLessonIds: ["step-1", "step-2", "step-3"],
      passedLessonIds: ["step-1", "step-2"],
      attempts: [
        { lessonId: "step-1", scorePct: 0.9, passed: true, at: "2026-06-01T10:05:00.000Z" },
        { lessonId: "step-2", scorePct: 0.85, passed: true, at: "2026-06-02T11:00:00.000Z" },
      ],
      labsAttempted: ["lab-position-sizing"],
      earnedBadgeIds: ["badge-foundations"],
    };
    const putA = await call("PUT", PATH, { cookie: cookieA, json: payload });
    let echoOk = false;
    try {
      const j = JSON.parse(putA.body) as { ok: boolean; progress: typeof payload };
      echoOk = j.ok === true && j.progress.lastLessonId === "step-3" && j.progress.attempts.length === 2;
    } catch { /* fail below */ }
    check("04_put_persists_and_echoes", putA.status === 200 && echoOk, `body=${putA.body.slice(0, 160)}`);

    // 4. Fresh GET returns persisted state (device-switch simulation)
    const reGetA = await call("GET", PATH, { cookie: cookieA });
    let persistedOk = false;
    try {
      const j = JSON.parse(reGetA.body) as { progress: typeof payload };
      persistedOk =
        j.progress.startedAt === payload.startedAt &&
        j.progress.lastLessonId === "step-3" &&
        JSON.stringify(j.progress.completedLessonIds) === JSON.stringify(payload.completedLessonIds) &&
        j.progress.attempts.length === 2 &&
        JSON.stringify(j.progress.labsAttempted) === JSON.stringify(payload.labsAttempted) &&
        JSON.stringify(j.progress.earnedBadgeIds) === JSON.stringify(payload.earnedBadgeIds);
    } catch { /* fail below */ }
    check("05_persisted_state_survives_reload", reGetA.status === 200 && persistedOk, `body=${reGetA.body.slice(0, 200)}`);

    // 5. Per-user isolation: B sees its own empty progress, not A's
    const getB = await call("GET", PATH, { cookie: cookieB });
    let isolatedOk = false;
    try {
      const j = JSON.parse(getB.body) as { progress: { completedLessonIds: string[]; lastLessonId: string | null } };
      isolatedOk = j.progress.completedLessonIds.length === 0 && j.progress.lastLessonId === null;
    } catch { /* fail below */ }
    check("06_per_user_isolation", getB.status === 200 && isolatedOk, `body=${getB.body.slice(0, 160)}`);

    // 6. Upsert (second PUT) updates the same row, no duplicate
    const putA2 = await call("PUT", PATH, { cookie: cookieA, json: { ...payload, lastLessonId: "step-4", completedLessonIds: [...payload.completedLessonIds, "step-4"] } });
    const rowCount = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM trading_school_progress WHERE user_id = $1`, [a.id]);
    check("07_upsert_no_duplicate_row", putA2.status === 200 && rowCount.rows[0]!.c === 1, `count=${rowCount.rows[0]?.c}`);
  } finally {
    await pool.query(`DELETE FROM trading_school_progress WHERE user_id = ANY($1::int[])`, [[a.id, b.id]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[a.id, b.id]]);
    console.log(`[teardown] removed users ${a.id}, ${b.id} and their progress rows`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
