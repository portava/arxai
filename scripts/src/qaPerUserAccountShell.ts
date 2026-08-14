// qaPerUserAccountShell.ts — Per-User Account Shell acceptance proof.
//
// Seeds 2 throwaway users A and B, each with their own
// virtual_trading_accounts row carrying a distinct currentBalance. Then
// authenticates each via real session cookies and hits
// GET /api/me/account-shell through the proxy. Asserts:
//
//   * A sees ONLY their own currentBalance (never B's).
//   * Anonymous (no cookie) callers get 401.
//   * Response shape contains required keys (accountMode,
//     approvalStatus, tradingStatus, allocation, pnl, risk).
//   * arx_live_commands count is unchanged from start → end. NO live
//     trade dispatched at any point.
//
// Exit code 0 on PASS, 1 on FAIL.

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  virtualTradingAccountsTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
async function createUserSession(userId: number): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId, tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1", userAgent: "qaPUAS",
  });
  return rawToken;
}

const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaPUAS_${Date.now()}_${randomBytes(3).toString("hex")}`;
type Probe = { name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}
async function globalSettingsFingerprint(): Promise<string> {
  // Hash count + max(updated_at) so any insert OR mutation is detected.
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n, COALESCE(MAX(updated_at)::text, '') AS mu FROM global_trading_settings"
  );
  const row = r.rows[0] as { n: number; mu: string };
  return `${row.n}|${row.mu}`;
}

type SeededUser = { id: number; email: string; cookie: string; balance: number };

async function seed(label: "A" | "B", balance: number): Promise<SeededUser> {
  const email = `${TAG}_${label.toLowerCase()}@arx.test`;
  const [u] = await db.insert(usersTable).values({
    email, name: `${TAG} ${label}`, role: "USER",
  }).returning();
  const userId = u!.id;
  await db.insert(virtualTradingAccountsTable).values({
    userId,
    routingMode: "USER_OWNED_MT5",
    accountType: "demo",
    virtualBalance: balance,
    virtualEquity: balance,
    virtualMarginUsed: 0,
    virtualPnl: 0,
    status: "active",
  });
  const rawToken = await createUserSession(userId);
  return { id: userId, email, cookie: `${USER_SESSION_COOKIE}=${rawToken}`, balance };
}

async function cleanup(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(virtualTradingAccountsTable).where(inArray(virtualTradingAccountsTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function main(): Promise<void> {
  const startLive = await liveCmdCount();
  const startGlobalFp = await globalSettingsFingerprint();
  // eslint-disable-next-line no-console
  console.log(`[setup] arx_live_commands start count = ${startLive}; global_trading_settings fp = ${startGlobalFp}`);

  let A: SeededUser | null = null;
  let B: SeededUser | null = null;
  try {
    A = await seed("A", 11111);
    B = await seed("B", 99999);

    // Anonymous probe
    {
      const r = await fetch(`${BASE}/api/me/account-shell`);
      record("anonymous-returns-401", r.status === 401, `status=${r.status}`);
    }

    // Authenticated probes
    const ra = await fetch(`${BASE}/api/me/account-shell`, { headers: { cookie: A.cookie } });
    const ja: any = await ra.json();
    record("A-authenticated-200", ra.status === 200, `status=${ra.status}`);
    record("A-userId-matches", ja?.userId === A.id, `got userId=${ja?.userId} expected ${A.id}`);
    const requiredKeys = ["accountMode", "approvalStatus", "tradingStatus", "allocation", "pnl", "risk"];
    const missing = requiredKeys.filter((k) => !(k in (ja ?? {})));
    record("A-shape-matches-spec", missing.length === 0, missing.length === 0 ? "all keys present" : `missing: ${missing.join(",")}`);
    record(
      "A-balance-matches-own",
      Number(ja?.allocation?.currentBalance) === A.balance,
      `got balance=${ja?.allocation?.currentBalance} expected ${A.balance}`,
    );
    const rawA = JSON.stringify(ja);
    record(
      "A-no-leak-of-B-balance",
      !rawA.includes(String(B.balance)) && !rawA.includes(B.email),
      "A's response must not contain B's balance or email",
    );

    const rb = await fetch(`${BASE}/api/me/account-shell`, { headers: { cookie: B.cookie } });
    const jb: any = await rb.json();
    record("B-authenticated-200", rb.status === 200, `status=${rb.status}`);
    record("B-userId-matches", jb?.userId === B.id, `got userId=${jb?.userId} expected ${B.id}`);
    record(
      "B-balance-matches-own",
      Number(jb?.allocation?.currentBalance) === B.balance,
      `got balance=${jb?.allocation?.currentBalance} expected ${B.balance}`,
    );
    const rawB = JSON.stringify(jb);
    record(
      "B-no-leak-of-A-balance",
      !rawB.includes(String(A.balance)) && !rawB.includes(A.email),
      "B's response must not contain A's balance or email",
    );

    // Param-trick: any client-supplied userId in query/body is ignored
    // by /me/* handlers (covered by per-user-isolation CI guard, but
    // verify behaviorally too).
    const trick = await fetch(`${BASE}/api/me/account-shell?userId=${B.id}`, { headers: { cookie: A.cookie } });
    const jtrick: any = await trick.json();
    record(
      "A-cannot-impersonate-B-via-query",
      jtrick?.userId === A.id && Number(jtrick?.allocation?.currentBalance) === A.balance,
      `got userId=${jtrick?.userId} balance=${jtrick?.allocation?.currentBalance}`,
    );
  } finally {
    const ids = [A?.id, B?.id].filter((v): v is number => typeof v === "number");
    await cleanup(ids);
  }

  const endLive = await liveCmdCount();
  record("arx_live_commands-unchanged", endLive === startLive, `start=${startLive} end=${endLive}`);
  record("arx_live_commands-strict-zero", startLive === 0 && endLive === 0, `start=${startLive} end=${endLive} (both must be 0)`);
  const endGlobalFp = await globalSettingsFingerprint();
  record(
    "read-only-invariant-no-write-on-read",
    endGlobalFp === startGlobalFp,
    `global_trading_settings fingerprint must not change after a GET. start=${startGlobalFp} end=${endGlobalFp}`,
  );

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} checks PASSED`);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`FAILED:\n${failed.map((f) => ` - ${f.name}: ${f.note}`).join("\n")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("qaPerUserAccountShell crashed:", e);
  process.exit(1);
});
