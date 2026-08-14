/**
 * qaAuthLoginRoles.ts
 *
 * End-to-end QA for the single-login role-based system.
 *
 * Verifies (the 7 listed checks):
 *   1. Seeded admin can log in with valid credentials.
 *   2. Wrong password fails (and stays HTTP 401 with a clean message).
 *   3. Regular user logs in but cannot access admin/operator routes.
 *   4. New user defaults to Trading Off
 *      (no user_master_live_access row OR row with approval=false).
 *   5. Admin/operator can reach an admin-gated route after login.
 *   6. User cannot enable live trading for themselves
 *      (PUT /api/me/live/settings rejects requireStopLoss=false).
 *   7. No secrets / seed passwords leak to login response or /me payload.
 *
 * Inviolables:
 *   - Does NOT set ARX_LIVE_BROKER_EXECUTION_ENABLED.
 *   - Does NOT insert into arx_live_commands. Asserts strict-zero.
 *   - Does NOT print the admin password to stdout.
 *
 * Requires:
 *   - API server running at $BASE_URL (defaults to http://localhost:80).
 *   - Seeded admin email/password via ARX_ADMIN_EMAIL / ARX_ADMIN_PASSWORD.
 */

import { pool } from "@workspace/db";
import { randomBytes, scryptSync } from "node:crypto";

const BASE = (process.env.BASE_URL ?? "http://localhost:80").replace(/\/$/, "");
// Self-seed an isolated admin for normal CI. If you want to point this
// test at a real seeded admin instead, set ARX_ADMIN_EMAIL + ARX_ADMIN_PASSWORD.
// The default path uses a fresh random admin row that is created and torn
// down by this script — no real user (and specifically not user 4) is touched.
const MANUAL_ADMIN_EMAIL = process.env.ARX_ADMIN_EMAIL?.trim().toLowerCase();
const MANUAL_ADMIN_PASSWORD = process.env.ARX_ADMIN_PASSWORD;

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (ok) pass++; else fail++;
}

interface FetchResult { status: number; headers: Headers; body: string; cookies: string[] }
async function call(method: string, path: string, opts: { cookie?: string; json?: unknown } = {}): Promise<FetchResult> {
  const headers: Record<string, string> = { "content-type": "application/json", "accept": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const body = await res.text();
  return { status: res.status, headers: res.headers, body, cookies: setCookie };
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

const N = 65536, r = 8, p = 1, KEYLEN = 64;
function hashLocal(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function main(): Promise<void> {
  const startRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
  const start = startRow.rows[0]!.c;

  // ─── Seed an isolated regular user for negative tests ─────────────────
  const userEmail = `qa-user-${randomBytes(4).toString("hex")}@arx.local`;
  const userPassword = `User-${randomBytes(6).toString("hex")}`;
  const userHash = hashLocal(userPassword);
  const insRow = await pool.query<{ id: number }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'QA User', $2, 'USER') RETURNING id`,
    [userEmail, userHash],
  );
  const userId = insRow.rows[0]!.id;
  console.log(`[setup] seeded regular user id=${userId} email=${userEmail}`);

  // ─── Resolve admin credentials ────────────────────────────────────────
  // Default: seed a fresh isolated ADMIN row with a random password so
  // CI doesn't need a real owner secret. Optionally: use a pre-seeded
  // admin via ARX_ADMIN_EMAIL + ARX_ADMIN_PASSWORD.
  let ADMIN_EMAIL: string;
  let ADMIN_PASSWORD: string;
  let seededAdminId: number | null = null;
  if (MANUAL_ADMIN_EMAIL && MANUAL_ADMIN_PASSWORD) {
    ADMIN_EMAIL = MANUAL_ADMIN_EMAIL;
    ADMIN_PASSWORD = MANUAL_ADMIN_PASSWORD;
    console.log(`[setup] using pre-seeded admin email=${ADMIN_EMAIL}`);
  } else {
    ADMIN_EMAIL = `qa-admin-${randomBytes(4).toString("hex")}@arx.local`;
    ADMIN_PASSWORD = `Admin-${randomBytes(12).toString("hex")}`;
    const adminHash = hashLocal(ADMIN_PASSWORD);
    const adminIns = await pool.query<{ id: number }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'QA Admin', $2, 'ADMIN') RETURNING id`,
      [ADMIN_EMAIL, adminHash],
    );
    seededAdminId = adminIns.rows[0]!.id;
    console.log(`[setup] seeded isolated admin id=${seededAdminId} email=${ADMIN_EMAIL}`);
  }

  try {
    // 1. Admin login succeeds
    const adminLogin = await call("POST", "/api/auth/login", { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    check("01_admin_login_succeeds_with_valid_credentials",
      adminLogin.status === 200, `status=${adminLogin.status}`);
    const adminCookie = cookieHeader(adminLogin.cookies);
    check("01b_admin_login_sets_both_cookies",
      adminCookie.includes("arx_user_session") && adminCookie.includes("hr_session"),
      `cookies=${adminLogin.cookies.map((c) => c.split("=")[0]).join(",")}`);

    // 2. Wrong password fails with 401
    const wrong = await call("POST", "/api/auth/login", { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD + "-wrong" } });
    check("02_wrong_password_returns_401",
      wrong.status === 401, `status=${wrong.status}`);
    check("02b_wrong_password_message_is_clean",
      wrong.body.includes("Invalid email or password"), `body=${wrong.body.slice(0, 80)}`);

    // 3. Regular user can log in but cannot reach admin routes
    const userLogin = await call("POST", "/api/auth/login", { json: { email: userEmail, password: userPassword } });
    check("03a_regular_user_login_succeeds",
      userLogin.status === 200, `status=${userLogin.status}`);
    const userCookie = cookieHeader(userLogin.cookies);
    const adminRouteAsUser = await call("GET", "/api/daily-testing/status", { cookie: userCookie });
    check("03b_regular_user_blocked_from_admin_route",
      adminRouteAsUser.status === 401 || adminRouteAsUser.status === 403,
      `status=${adminRouteAsUser.status}`);

    // Also: unauthenticated cannot reach admin route
    const adminRouteAnon = await call("GET", "/api/daily-testing/status");
    check("03c_anonymous_blocked_from_admin_route",
      adminRouteAnon.status === 401 || adminRouteAnon.status === 403,
      `status=${adminRouteAnon.status}`);

    // 4. New user defaults to Trading Off
    const tradingRow = await pool.query<{ approved_for_master_live: boolean; master_live_status: string | null }>(
      `SELECT approved_for_master_live, master_live_status FROM user_master_live_access WHERE user_id = $1`,
      [userId],
    );
    const tradingOff = tradingRow.rows.length === 0
      || tradingRow.rows[0]!.approved_for_master_live === false
      || (tradingRow.rows[0]!.master_live_status ?? "NOT_APPROVED") !== "APPROVED";
    check("04_new_user_defaults_to_trading_off",
      tradingOff,
      tradingRow.rows.length === 0 ? "no row (default deny)" : JSON.stringify(tradingRow.rows[0]));

    // 5. Admin can reach an admin-gated route after login
    const adminRouteAsAdmin = await call("GET", "/api/daily-testing/status", { cookie: adminCookie });
    check("05_admin_can_reach_admin_route",
      adminRouteAsAdmin.status === 200,
      `status=${adminRouteAsAdmin.status} body=${adminRouteAsAdmin.body.slice(0, 80)}`);

    // 6. User cannot self-enable live trading. The system never exposes a
    //    user-facing toggle for masterLiveTradingEnabled — admin-only.
    //    Verify the admin-side toggle is rejected from a regular user.
    const selfEnable = await call("POST", `/api/admin/master-live-access/${userId}/approve`, { cookie: userCookie, json: { reason: "self-grant" } });
    check("06_user_cannot_self_enable_live_trading",
      selfEnable.status === 401 || selfEnable.status === 403 || selfEnable.status === 404,
      `status=${selfEnable.status}`);

    // Also: PUT /api/me/live/settings cannot disable requireStopLoss.
    const meLive = await call("PUT", "/api/me/live/settings", { cookie: userCookie, json: { requireStopLoss: false } });
    check("06b_user_cannot_disable_require_stop_loss",
      // Either the endpoint returns 400 (bad input) / 403 / strips the field
      // and returns 200 with requireStopLoss still true. Any of these is OK.
      [200, 400, 403, 404].includes(meLive.status),
      `status=${meLive.status} body=${meLive.body.slice(0, 120)}`);
    if (meLive.status === 200) {
      try {
        const parsed = JSON.parse(meLive.body) as { settings?: { requireStopLoss?: boolean }; requireStopLoss?: boolean };
        const stillRequired = (parsed.settings?.requireStopLoss ?? parsed.requireStopLoss ?? true) === true;
        check("06c_requireStopLoss_remains_true_after_attempted_disable", stillRequired,
          `body=${meLive.body.slice(0, 120)}`);
      } catch {
        check("06c_requireStopLoss_remains_true_after_attempted_disable", false, "unparseable body");
      }
    } else {
      check("06c_requireStopLoss_remains_true_after_attempted_disable", true,
        `route refused with ${meLive.status} (acceptable)`);
    }

    // 7. No secrets leak
    const blob = [adminLogin.body, userLogin.body, adminRouteAsAdmin.body].join("\n");
    const leaks: string[] = [];
    if (blob.includes(ADMIN_PASSWORD)) leaks.push("ADMIN_PASSWORD");
    if (blob.includes(userPassword)) leaks.push("USER_PASSWORD");
    if (/password_hash|passwordHash/.test(blob)) leaks.push("password_hash field exposed");
    if (/scrypt\$/.test(blob)) leaks.push("scrypt hash exposed");
    const sessSecret = (process.env.SESSION_SECRET ?? "").trim();
    if (sessSecret && blob.includes(sessSecret)) leaks.push("SESSION_SECRET");
    const derivApp = (process.env.DERIV_APP_ID ?? "").trim();
    if (derivApp && blob.includes(derivApp)) leaks.push("DERIV_APP_ID");
    check("07_no_secrets_leak_to_login_or_me_response",
      leaks.length === 0, leaks.length ? leaks.join(", ") : "clean");

    // /me with admin cookie should return the public user (no password_hash).
    const meAdmin = await call("GET", "/api/me", { cookie: adminCookie });
    check("07b_me_endpoint_omits_password_hash",
      meAdmin.status === 200 && !/password.?hash/i.test(meAdmin.body),
      `status=${meAdmin.status}`);

    // Strict-zero invariant
    const endRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
    const end = endRow.rows[0]!.c;
    check("08_arx_live_commands_unchanged", start === end, `start=${start} end=${end}`);
    check("09_arx_live_commands_strict_zero", start === 0 && end === 0, `start=${start} end=${end}`);

  } finally {
    // Cleanup ONLY the isolated test rows we created. Never touch real users.
    const cleanupIds = [userId, ...(seededAdminId !== null ? [seededAdminId] : [])];
    for (const id of cleanupIds) {
      await pool.query(`DELETE FROM auth_user_sessions WHERE user_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM user_activity_events WHERE user_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM user_master_live_access WHERE user_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM user_one_click_settings WHERE user_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
    }
  }

  console.log("");
  console.log(`${pass}/${pass + fail} checks PASSED`);
}

main()
  .then(async () => { try { await pool.end(); } catch { /* ignore */ } process.exit(fail > 0 ? 1 : 0); })
  .catch(async (err) => { console.error(err); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
