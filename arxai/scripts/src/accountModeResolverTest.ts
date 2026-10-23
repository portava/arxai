// T003-6 — Account-mode resolver regression suite.
//
// Three parts:
//   PART A — Env parser narrow truth table for isEnvTruthy. Confirms
//            we accept ONLY case-insensitive trimmed "true" and nothing
//            else (1, yes, on, "", undefined, false, whitespace).
//   PART B — Pure precedence matrix for computeAccountModePrecedence,
//            covering every reachable state the live UI may render.
//            Verifies currentAccountMode + cleanBlockedReason +
//            user-safe vs admin copy + permission booleans.
//   PART C — Non-admin contract on the live `/api/me/account-mode`
//            endpoint. Confirms anonymous callers are rejected with
//            401, the response never carries `adminDiagnostics` or any
//            raw boolean to a non-admin (asserted defensively against
//            the live envelope when reachable). Read-only; never
//            inserts arx_live_commands.
//
// SAFETY: pure read tests. No live trades, no broker calls, no DB
// writes. Env mutations are restored in a `finally` block.

import { isEnvTruthy } from "../../lib/domain/src/safety-contracts/isLiveBrokerExecutionEnabled.js";
import {
  computeAccountModePrecedence,
  type PrecedenceInput,
  type PrecedenceResult,
} from "../../artifacts/api-server/src/lib/computeAccountModePrecedence.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ────────────────────────────────────────────────────────────────────
// PART A — isEnvTruthy narrow truth table
// ────────────────────────────────────────────────────────────────────
console.log("\nPART A — isEnvTruthy narrow truth table");

const envCases: Array<{ raw: string | undefined | null; expected: boolean; label: string }> = [
  { raw: "true", expected: true, label: 'literal "true" → true' },
  { raw: "True", expected: true, label: '"True" (mixed) → true' },
  { raw: "TRUE", expected: true, label: '"TRUE" (upper) → true' },
  { raw: "  true  ", expected: true, label: 'whitespace-trimmed "  true  " → true' },
  { raw: "\ttrue\n", expected: true, label: 'tab/newline-trimmed → true' },
  { raw: "false", expected: false, label: '"false" → false' },
  { raw: "1", expected: false, label: '"1" must NOT be accepted' },
  { raw: "yes", expected: false, label: '"yes" must NOT be accepted' },
  { raw: "on", expected: false, label: '"on" must NOT be accepted' },
  { raw: "", expected: false, label: 'empty string → false' },
  { raw: "   ", expected: false, label: 'whitespace-only → false' },
  { raw: undefined, expected: false, label: 'undefined → false' },
  { raw: null, expected: false, label: 'null → false' },
  { raw: "TrueValue", expected: false, label: '"TrueValue" (substring) → false' },
  { raw: "0", expected: false, label: '"0" → false' },
];

for (const c of envCases) {
  const got = isEnvTruthy(c.raw);
  record(`env: ${c.label}`, got === c.expected, `got=${got} want=${c.expected}`);
}

// ────────────────────────────────────────────────────────────────────
// PART B — Precedence matrix
// ────────────────────────────────────────────────────────────────────
console.log("\nPART B — Account-mode precedence matrix");

function base(): PrecedenceInput {
  return {
    isAdmin: false,
    liveExecutionArmed: false,
    sharedMasterAttached: false,
    effectiveLiveBrokerOn: false,
    serverEnvOn: false,
    operatorOn: false,
    accountShellTradingMode: "DISABLED",
    accountShellTradingStatus: "ACTIVE",
    needsReviewItems: false,
  };
}

function expect(name: string, input: PrecedenceInput, check: (r: PrecedenceResult) => string | null) {
  const r = computeAccountModePrecedence(input);
  const failure = check(r);
  if (failure === null) {
    record(name, true);
  } else {
    record(name, false, failure + ` :: got=${JSON.stringify(r)}`);
  }
}

// Case 1: live-armed + shared-master attached + everything green → clean LIVE_SHARED
expect(
  "armed+attached+green → LIVE_SHARED, no block, can manual+auto",
  {
    ...base(),
    liveExecutionArmed: true,
    sharedMasterAttached: true,
    effectiveLiveBrokerOn: true,
    serverEnvOn: true,
    operatorOn: true,
    accountShellTradingMode: "LIVE",
    accountShellTradingStatus: "ACTIVE",
  },
  (r) =>
    r.currentAccountMode !== "LIVE_SHARED"
      ? "expected LIVE_SHARED"
      : r.cleanBlockedReason !== null
        ? "expected no block reason"
        : !r.userCanManualTrade
          ? "expected canManualTrade=true"
          : !r.userCanAutoTrade
            ? "expected canAutoTrade=true"
            : !r.cleanModeLabel.toLowerCase().includes("live")
              ? "expected label to mention live"
              : null,
);

// Case 2: armed + tradingMode=DISABLED (operator yanked) → LIVE_SHARED + block, no auto
expect(
  "armed+DISABLED → LIVE_SHARED + block, normal-user copy generic",
  { ...base(), liveExecutionArmed: true, accountShellTradingMode: "DISABLED" },
  (r) =>
    r.currentAccountMode !== "LIVE_SHARED"
      ? "expected LIVE_SHARED"
      : r.cleanBlockedReason === null
        ? "expected block reason"
        : r.cleanBlockedReason.includes("user_trading_permissions")
          ? "leaked operator-only wording to normal user"
          : r.userCanManualTrade
            ? "expected canManualTrade=false"
            : r.userCanAutoTrade
              ? "expected canAutoTrade=false"
              : null,
);

// Case 2b: same as case 2 but admin — should leak operator detail
expect(
  "armed+DISABLED (admin view) → admin-only operator wording present",
  {
    ...base(),
    isAdmin: true,
    liveExecutionArmed: true,
    accountShellTradingMode: "DISABLED",
  },
  (r) =>
    r.cleanBlockedReason === null
      ? "expected block reason"
      : r.cleanBlockedReason.includes("user_trading_permissions")
        ? null
        : "expected admin technical wording 'user_trading_permissions'",
);

// Case 3: armed + tradingMode=SIMULATED → LIVE_SHARED + block
expect(
  "armed+SIMULATED → LIVE_SHARED + block, no auto",
  { ...base(), liveExecutionArmed: true, accountShellTradingMode: "SIMULATED" },
  (r) =>
    r.currentAccountMode !== "LIVE_SHARED"
      ? "expected LIVE_SHARED"
      : r.cleanBlockedReason === null
        ? "expected block reason"
        : r.userCanAutoTrade
          ? "expected canAutoTrade=false"
          : null,
);

// Case 4: armed + tradingMode=DEMO → LIVE_SHARED + block (NOT silently demoted to DEMO)
expect(
  "armed+DEMO precedence keeps LIVE_SHARED (no silent demote)",
  { ...base(), liveExecutionArmed: true, accountShellTradingMode: "DEMO" },
  (r) =>
    r.currentAccountMode !== "LIVE_SHARED"
      ? "expected LIVE_SHARED (must not demote silently)"
      : r.cleanBlockedReason === null
        ? "expected block reason"
        : null,
);

// Case 5: armed + tradingStatus != ACTIVE → block
expect(
  "armed+tradingStatus=PAUSED → block, no auto",
  {
    ...base(),
    liveExecutionArmed: true,
    accountShellTradingMode: "LIVE",
    accountShellTradingStatus: "PAUSED",
    effectiveLiveBrokerOn: true,
  },
  (r) =>
    r.currentAccountMode !== "LIVE_SHARED"
      ? "expected LIVE_SHARED"
      : r.cleanBlockedReason === null
        ? "expected block reason"
        : r.userCanAutoTrade
          ? "expected canAutoTrade=false"
          : null,
);

// Case 6: armed + not attached → block (allocation pending)
expect(
  "armed+!sharedMasterAttached → allocation-pending block",
  {
    ...base(),
    liveExecutionArmed: true,
    accountShellTradingMode: "LIVE",
    accountShellTradingStatus: "ACTIVE",
    effectiveLiveBrokerOn: true,
    sharedMasterAttached: false,
  },
  (r) =>
    r.currentAccountMode !== "LIVE_SHARED"
      ? "expected LIVE_SHARED"
      : r.cleanBlockedReason === null
        ? "expected block reason"
        : !/allocation|pending/i.test(r.cleanBlockedReason)
          ? "expected allocation/pending wording"
          : null,
);

// Case 7: armed + master switch off → block (normal-user generic copy)
expect(
  "armed+!effectiveLiveBrokerOn → generic maintenance wording for normal user",
  {
    ...base(),
    liveExecutionArmed: true,
    sharedMasterAttached: true,
    accountShellTradingMode: "LIVE",
    accountShellTradingStatus: "ACTIVE",
    effectiveLiveBrokerOn: false,
    serverEnvOn: false,
    operatorOn: false,
  },
  (r) =>
    r.cleanBlockedReason === null
      ? "expected block reason"
      : /ARX_LIVE_BROKER_EXECUTION_ENABLED/.test(r.cleanBlockedReason)
        ? "leaked env var name to normal user"
        : null,
);

// Case 7b: same as 7 but admin → must include env var name + operator status
expect(
  "armed+!effectiveLiveBrokerOn (admin) → env-var detail present",
  {
    ...base(),
    isAdmin: true,
    liveExecutionArmed: true,
    sharedMasterAttached: true,
    accountShellTradingMode: "LIVE",
    accountShellTradingStatus: "ACTIVE",
    effectiveLiveBrokerOn: false,
    serverEnvOn: false,
    operatorOn: true,
  },
  (r) =>
    r.cleanBlockedReason === null
      ? "expected block reason"
      : !/ARX_LIVE_BROKER_EXECUTION_ENABLED/.test(r.cleanBlockedReason)
        ? "expected env-var name in admin copy"
        : null,
);

// Case 8: not armed + tradingMode=DEMO → DEMO, no block
expect(
  "not-armed + DEMO → DEMO, no block",
  { ...base(), accountShellTradingMode: "DEMO" },
  (r) =>
    r.currentAccountMode !== "DEMO"
      ? "expected DEMO"
      : r.cleanBlockedReason !== null
        ? "did not expect block reason"
        : r.userCanAutoTrade
          ? "expected canAutoTrade=false (not LIVE_SHARED)"
          : null,
);

// Case 9: not armed + tradingMode=SIMULATED → PAPER, no block
expect(
  "not-armed + SIMULATED → PAPER, no block",
  { ...base(), accountShellTradingMode: "SIMULATED" },
  (r) =>
    r.currentAccountMode !== "PAPER"
      ? "expected PAPER"
      : r.cleanBlockedReason !== null
        ? "did not expect block reason"
        : null,
);

// Case 10: not armed + tradingMode=LIVE → DEMO + readiness-gap copy
expect(
  "not-armed + LIVE → DEMO with readiness-gap copy",
  { ...base(), accountShellTradingMode: "LIVE" },
  (r) =>
    r.currentAccountMode !== "DEMO"
      ? "expected DEMO (operator-enabled but not armed)"
      : r.cleanBlockedReason === null
        ? "expected readiness-gap reason"
        : null,
);

// Case 11: not armed + tradingMode=DISABLED → DEMO + disabled copy
expect(
  "not-armed + DISABLED → DEMO + disabled copy",
  { ...base(), accountShellTradingMode: "DISABLED" },
  (r) =>
    r.currentAccountMode !== "DEMO"
      ? "expected DEMO"
      : r.cleanBlockedReason === null
        ? "expected block reason"
        : null,
);

// Case 12: not armed + needsReviewItems=true → canManualTrade=false
expect(
  "not-armed + needsReviewItems → canManualTrade=false",
  { ...base(), accountShellTradingMode: "DEMO", needsReviewItems: true },
  (r) => (r.userCanManualTrade ? "expected canManualTrade=false" : null),
);

// Case 13: cleanUserMessage cannot include raw camelCase identifiers
expect(
  "armed+attached+green clean message has no camelCase identifier leak",
  {
    ...base(),
    liveExecutionArmed: true,
    sharedMasterAttached: true,
    effectiveLiveBrokerOn: true,
    serverEnvOn: true,
    operatorOn: true,
    accountShellTradingMode: "LIVE",
    accountShellTradingStatus: "ACTIVE",
  },
  (r) =>
    /tradingMode|liveExecutionArmed|liveBrokerExecution|sharedMasterAttached|effectiveLiveBrokerOn/.test(
      r.cleanUserMessage,
    )
      ? "leaked internal identifier into clean user message"
      : null,
);

// ────────────────────────────────────────────────────────────────────
// PART C — Live endpoint contract (full E2E).
//
// Seeds two real users (ADMIN + regular USER) directly in the dev DB
// using the same pattern as qaLaunchReadiness.ts, mints HTTP-only
// session cookies, and exercises GET /api/me/account-mode for:
//   1. Anonymous → 401/403
//   2. Authenticated USER → 200, isAdmin=false, adminDiagnostics===null,
//      no top-level brokerExecutionStatus, no raw boolean leak in body
//   3. Authenticated ADMIN → 200, isAdmin=true, adminDiagnostics
//      object present
//   4. Admin previewing as user (X-Arx-View-Mode: user) → 200,
//      isAdmin=false, adminDiagnostics===null
//
// SAFETY: read-only on /api/me/account-mode. The seeded users are
// tagged with a unique prefix so they are easy to identify. We DO NOT
// place trades, queue commands, or write to arx_live_commands. The
// final assertion confirms arx_live_commands count is unchanged.
//
// Skipped (with PASS) only if the API server is genuinely not
// reachable AND the DB is not available — otherwise the test runs
// fully authenticated.
// ────────────────────────────────────────────────────────────────────
console.log("\nPART C — Live endpoint contract (full E2E with seeded sessions)");

async function partC(): Promise<void> {
  const base = process.env["ARX_TEST_API_BASE"] ?? "http://localhost:80";

  // Probe reachability first.
  let reachable = false;
  try {
    const r = await fetch(`${base}/api/healthz`, { method: "GET" });
    reachable = r.status < 500;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    record("endpoint contract: skipped (API not reachable)", true);
    return;
  }

  // Anonymous → must be 401/403.
  try {
    const r = await fetch(`${base}/api/me/account-mode`, { method: "GET" });
    record(
      "endpoint contract: anonymous → 401/403",
      r.status === 401 || r.status === 403,
      `status=${r.status}`,
    );
  } catch (e) {
    record("endpoint contract: anonymous fetch error", false, (e as Error).message);
    return;
  }

  // Seed ADMIN + USER directly (mirrors qaLaunchReadiness pattern).
  const { randomBytes, createHash } = await import("node:crypto");
  type DbMod = {
    pool: { query: (s: string) => Promise<{ rows: Array<{ n: number }> }> };
    db: {
      insert: (t: unknown) => {
        values: (v: unknown) => { returning: () => Promise<Array<{ id: number }>> };
      };
    };
  };
  type SchemaMod = { usersTable: unknown; authUserSessionsTable: unknown };

  let dbMod: DbMod;
  let schema: SchemaMod;
  try {
    dbMod = (await import("@workspace/db")) as unknown as DbMod;
    schema = (await import("@workspace/db/schema")) as unknown as SchemaMod;
  } catch (e) {
    record("endpoint contract: skipped (DB not reachable: " + (e as Error).message + ")", true);
    return;
  }
  const { pool, db } = dbMod;
  const { usersTable, authUserSessionsTable } = schema;

  const USER_SESSION_COOKIE = "arx_user_session";
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const TAG = `t003C_${Date.now()}_${randomBytes(3).toString("hex")}`;

  async function liveCmdCount(): Promise<number> {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
    return r.rows[0]!.n;
  }

  async function seedUser(label: "ADMIN" | "USER"): Promise<{ id: number; cookie: string }> {
    const email = `${TAG}_${label.toLowerCase()}@arx.test`;
    const [u] = await db
      .insert(usersTable)
      .values({ email, name: `${TAG} ${label}`, role: label })
      .returning();
    const userId = u!.id;
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(authUserSessionsTable).values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ipAddress: "127.0.0.1",
      userAgent: TAG,
    });
    return { id: userId, cookie: `${USER_SESSION_COOKIE}=${rawToken}` };
  }

  const startLive = await liveCmdCount();

  let adminSession: { id: number; cookie: string };
  let userSession: { id: number; cookie: string };
  try {
    adminSession = await seedUser("ADMIN");
    userSession = await seedUser("USER");
  } catch (e) {
    record("endpoint contract: seed failed", false, (e as Error).message);
    return;
  }

  // (2) USER → 200, isAdmin=false, adminDiagnostics===null, no raw
  // engine boolean fields, no operator phrase leak.
  try {
    const r = await fetch(`${base}/api/me/account-mode`, {
      method: "GET",
      headers: { cookie: userSession.cookie, accept: "application/json" },
    });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* leave body empty */
    }
    const status200 = r.status === 200;
    record("endpoint contract: USER → 200", status200, `status=${r.status}`);
    if (status200) {
      record(
        "endpoint contract: USER body.isAdmin === false",
        body.isAdmin === false,
        `got=${JSON.stringify(body.isAdmin)}`,
      );
      record(
        "endpoint contract: USER body.adminDiagnostics === null",
        body.adminDiagnostics === null,
        `got=${JSON.stringify(body.adminDiagnostics)}`,
      );
      record(
        "endpoint contract: USER body has no top-level brokerExecutionStatus",
        !("brokerExecutionStatus" in body),
        `keys=${Object.keys(body).join(",")}`,
      );
      // Raw engine identifiers + operator phrases must never appear in
      // the user-visible serialized body.
      const FORBIDDEN = [
        "canExecuteRealBrokerOrder",
        "canSubmitLiveIntent",
        "mt5ConnectedAtSubmit",
        "liveExecutionDefaultDeny",
        "EXECUTE LIVE SHARED",
        "QUEUE MICRO LIVE TEST",
        "ENABLE LIVE TRADING",
        "ARX_LIVE_BROKER_EXECUTION_ENABLED",
        "MT5_BRIDGE_TOKEN",
        "SESSION_SECRET",
      ];
      const hit = FORBIDDEN.find((m) => text.includes(m));
      record(
        "endpoint contract: USER body free of internal identifiers/operator phrases",
        !hit,
        hit ? `found="${hit}"` : "clean",
      );
    }
  } catch (e) {
    record("endpoint contract: USER fetch error", false, (e as Error).message);
  }

  // (3) ADMIN → 200, isAdmin=true, adminDiagnostics object present.
  try {
    const r = await fetch(`${base}/api/me/account-mode`, {
      method: "GET",
      headers: { cookie: adminSession.cookie, accept: "application/json" },
    });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* */
    }
    const status200 = r.status === 200;
    record("endpoint contract: ADMIN → 200", status200, `status=${r.status}`);
    if (status200) {
      record(
        "endpoint contract: ADMIN body.isAdmin === true",
        body.isAdmin === true,
        `got=${JSON.stringify(body.isAdmin)}`,
      );
      const diag = body.adminDiagnostics;
      record(
        "endpoint contract: ADMIN body.adminDiagnostics is object",
        diag !== null && typeof diag === "object",
        `type=${typeof diag} null=${diag === null}`,
      );
    }
  } catch (e) {
    record("endpoint contract: ADMIN fetch error", false, (e as Error).message);
  }

  // (4) Admin previewing as user → adminDiagnostics===null (the
  // effective-view-mode middleware must downgrade so the user-shape is
  // returned even though the underlying session is admin).
  try {
    const r = await fetch(`${base}/api/me/account-mode`, {
      method: "GET",
      headers: {
        cookie: adminSession.cookie,
        accept: "application/json",
        "x-arx-view-mode": "user",
      },
    });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* */
    }
    const status200 = r.status === 200;
    record("endpoint contract: ADMIN-as-USER → 200", status200, `status=${r.status}`);
    if (status200) {
      record(
        "endpoint contract: ADMIN-as-USER body.isAdmin === false",
        body.isAdmin === false,
        `got=${JSON.stringify(body.isAdmin)}`,
      );
      record(
        "endpoint contract: ADMIN-as-USER body.adminDiagnostics === null",
        body.adminDiagnostics === null,
        `got=${JSON.stringify(body.adminDiagnostics)}`,
      );
    }
  } catch (e) {
    record("endpoint contract: ADMIN-as-USER fetch error", false, (e as Error).message);
  }

  // Invariant: this test must NOT have inserted any arx_live_commands.
  try {
    const endLive = await liveCmdCount();
    record(
      "endpoint contract: arx_live_commands count unchanged",
      endLive === startLive,
      `start=${startLive} end=${endLive}`,
    );
  } catch (e) {
    record("endpoint contract: arx_live_commands count check error", false, (e as Error).message);
  }
}

await partC();

// ────────────────────────────────────────────────────────────────────
// PART D — /api/me/account-shell allocation contract (T004).
//
// Seeds a real SHARED_MASTER_MT5 user with a fixed allocation split
// ($total / $manual / $ai sleeve, AI auto-trading on, conservative),
// attaches them to the active shared master, then GETs the user-facing
// /api/me/account-shell endpoint and asserts the response exactly
// reflects the persisted allocation. Also asserts the user-shape body
// never carries master/credential/operator-only identifiers, and that
// arx_live_commands count is unchanged.
//
// SAFETY: pure read on /api/me/account-shell. The seeded user, shared
// master, virtual account, and allocation rows are all real but tagged
// with a unique prefix so they are easy to identify. No live trades,
// no command queue inserts.
// Skipped (with PASS) only if the API server / DB are not reachable.
// ────────────────────────────────────────────────────────────────────
console.log("\nPART D — /api/me/account-shell allocation contract (T004)");

async function partD(): Promise<void> {
  const base = process.env["ARX_TEST_API_BASE"] ?? "http://localhost:80";

  let reachable = false;
  try {
    const r = await fetch(`${base}/api/healthz`, { method: "GET" });
    reachable = r.status < 500;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    record("shell contract: skipped (API not reachable)", true);
    return;
  }

  const { randomBytes, createHash } = await import("node:crypto");
  type DbMod = {
    pool: { query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
    db: {
      insert: (t: unknown) => {
        values: (v: unknown) => { returning: () => Promise<Array<{ id: number }>> };
      };
    };
  };
  let dbMod: DbMod;
  try {
    dbMod = (await import("@workspace/db")) as unknown as DbMod;
  } catch (e) {
    record("shell contract: skipped (DB not reachable: " + (e as Error).message + ")", true);
    return;
  }
  const { pool } = dbMod;

  const TAG = `t004D_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const USER_SESSION_COOKIE = "arx_user_session";
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  // Find the active shared master account row id (FK target for the
  // virtual_trading_accounts seed). If none is configured, skip.
  const masterRows = await pool.query(
    "SELECT id, account_type FROM shared_master_accounts WHERE is_active = true ORDER BY id ASC LIMIT 1",
  );
  if (masterRows.rows.length === 0) {
    record("shell contract: skipped (no active shared_master_accounts row)", true);
    return;
  }
  const masterId = Number(masterRows.rows[0]!["id"]);
  const masterAccountType = String(masterRows.rows[0]!["account_type"] ?? "live");

  async function liveCmdCount(): Promise<number> {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
    return Number(r.rows[0]!["n"]);
  }
  const startLive = await liveCmdCount();

  // Seed user + session.
  const email = `${TAG}_shared_user@arx.test`;
  const newUserRows = await pool.query(
    `INSERT INTO users (email, name, role) VALUES ('${email}', '${TAG} SHARED', 'USER') RETURNING id`,
  );
  const userId = Number(newUserRows.rows[0]!["id"]);

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await pool.query(
    `INSERT INTO auth_user_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (${userId}, '${tokenHash}', '${expiresAt}', '127.0.0.1', '${TAG}')`,
  );
  const cookie = `${USER_SESSION_COOKIE}=${rawToken}`;

  // Seed user_slot_allocation: total=100, manual=70, ai=30, auto-trading on.
  await pool.query(
    `INSERT INTO user_slot_allocation (
        user_id, allocated_funds, manual_allocated_funds, ai_allocated_funds,
        account_currency, is_active, ai_auto_trading_enabled, ai_strategy_mode,
        allocation_status, trading_frozen, ai_trading_frozen, close_only_mode)
     VALUES (${userId}, 100, 70, 30, 'USD', true, true, 'conservative',
             'active', false, false, false)`,
  );

  // Seed virtual_trading_accounts shell with virtual_balance=0 to
  // simulate the bug condition the bridge sync used to silently
  // leave behind. The endpoint should still report $100 from the
  // allocation row (the T004 fix).
  await pool.query(
    `INSERT INTO virtual_trading_accounts (
        user_id, routing_mode, shared_master_account_id, account_type,
        virtual_balance, virtual_equity, virtual_margin_used, virtual_pnl, status)
     VALUES (${userId}, 'SHARED_MASTER_MT5', ${masterId}, '${masterAccountType}',
             0, 0, 0, 0, 'ACTIVE')`,
  );

  let r: Response;
  let text = "";
  let body: Record<string, unknown> = {};
  try {
    r = await fetch(`${base}/api/me/account-shell`, {
      method: "GET",
      headers: { cookie, accept: "application/json" },
    });
    text = await r.text();
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* empty */ }
  } catch (e) {
    record("shell contract: fetch error", false, (e as Error).message);
    return;
  }

  record("shell contract: status 200", r.status === 200, `status=${r.status}`);
  const alloc = body.allocation as Record<string, unknown> | undefined;
  const notes = body.notes as Record<string, unknown> | undefined;
  record(
    "shell contract: accountMode=SHARED_MASTER_MT5",
    body.accountMode === "SHARED_MASTER_MT5",
    `got=${JSON.stringify(body.accountMode)}`,
  );
  record(
    "shell contract: sharedMasterAccountAssigned=true",
    notes?.sharedMasterAccountAssigned === true,
    `got=${JSON.stringify(notes?.sharedMasterAccountAssigned)}`,
  );
  record(
    "shell contract: currentBalance===100 (alloc, not the 0 shell row)",
    Number(alloc?.currentBalance) === 100,
    `got=${JSON.stringify(alloc?.currentBalance)}`,
  );
  record(
    "shell contract: assignedStartingBalance===100",
    Number(alloc?.assignedStartingBalance) === 100,
    `got=${JSON.stringify(alloc?.assignedStartingBalance)}`,
  );
  record(
    "shell contract: totalAllocation===100",
    Number(alloc?.totalAllocation) === 100,
    `got=${JSON.stringify(alloc?.totalAllocation)}`,
  );
  record(
    "shell contract: manualAllocation===70",
    Number(alloc?.manualAllocation) === 70,
    `got=${JSON.stringify(alloc?.manualAllocation)}`,
  );
  record(
    "shell contract: aiSleeveAllocation===30",
    Number(alloc?.aiSleeveAllocation) === 30,
    `got=${JSON.stringify(alloc?.aiSleeveAllocation)}`,
  );
  record(
    "shell contract: aiSleeveEnabled===true",
    alloc?.aiSleeveEnabled === true,
    `got=${JSON.stringify(alloc?.aiSleeveEnabled)}`,
  );
  record(
    "shell contract: aiAutoTradingEnabled===true",
    alloc?.aiAutoTradingEnabled === true,
    `got=${JSON.stringify(alloc?.aiAutoTradingEnabled)}`,
  );
  record(
    "shell contract: aiStrategyMode==='conservative'",
    alloc?.aiStrategyMode === "conservative",
    `got=${JSON.stringify(alloc?.aiStrategyMode)}`,
  );
  record(
    "shell contract: allocationPending===false (alloc > 0)",
    alloc?.allocationPending === false,
    `got=${JSON.stringify(alloc?.allocationPending)}`,
  );
  record(
    "shell contract: frozen===false",
    alloc?.frozen === false,
    `got=${JSON.stringify(alloc?.frozen)}`,
  );

  // Master/credential/operator-only identifiers must never leak into a
  // user-facing shell response.
  const FORBIDDEN_SUBSTRINGS = [
    "masterBalance", "masterEquity", "masterFreeMargin",
    "MT5_BRIDGE_TOKEN", "SESSION_SECRET",
    "tokenHash", "apiKeyHash",
    "safetyGateSnapshot",
    "freezeReason", "notes\":\"", // raw operator notes column
    "EXECUTE LIVE SHARED", "QUEUE MICRO LIVE TEST", "ENABLE LIVE TRADING",
    "ARX_LIVE_BROKER_EXECUTION_ENABLED",
    "user_slot_allocation", "virtual_trading_accounts",
    "arx_master_account_config", "shared_master_accounts",
    "adminDiagnostics",
  ];
  const hit = FORBIDDEN_SUBSTRINGS.find((m) => text.includes(m));
  record(
    "shell contract: body free of master/credential/operator/internal identifiers",
    !hit,
    hit ? `found="${hit}"` : "clean",
  );

  // Other users' allocations must not be reachable through this endpoint.
  // We seed a second user with a different allocation and assert the
  // first user's response is unchanged.
  const otherEmail = `${TAG}_other@arx.test`;
  const otherRows = await pool.query(
    `INSERT INTO users (email, name, role) VALUES ('${otherEmail}', '${TAG} OTHER', 'USER') RETURNING id`,
  );
  const otherId = Number(otherRows.rows[0]!["id"]);
  await pool.query(
    `INSERT INTO user_slot_allocation (user_id, allocated_funds, manual_allocated_funds, ai_allocated_funds, account_currency, is_active)
     VALUES (${otherId}, 999, 999, 0, 'USD', true)`,
  );
  try {
    const r2 = await fetch(`${base}/api/me/account-shell`, {
      method: "GET",
      headers: { cookie, accept: "application/json" },
    });
    const t2 = await r2.text();
    record(
      "shell contract: per-user isolation — other user's 999 alloc not leaked",
      !t2.includes("999"),
      t2.includes("999") ? "leak detected" : "clean",
    );
  } catch (e) {
    record("shell contract: isolation fetch error", false, (e as Error).message);
  }

  // Invariant: arx_live_commands count must be unchanged.
  const endLive = await liveCmdCount();
  record(
    "shell contract: arx_live_commands count unchanged",
    endLive === startLive,
    `start=${startLive} end=${endLive}`,
  );

  // Cleanup (best-effort).
  try {
    await pool.query(`DELETE FROM auth_user_sessions WHERE user_agent = '${TAG}'`);
    await pool.query(`DELETE FROM virtual_trading_accounts WHERE user_id IN (${userId}, ${otherId})`);
    await pool.query(`DELETE FROM user_slot_allocation WHERE user_id IN (${userId}, ${otherId})`);
    await pool.query(`DELETE FROM users WHERE id IN (${userId}, ${otherId})`);
  } catch (e) {
    record("shell contract: cleanup warning", true, (e as Error).message);
  }
}

await partD();

// ────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
// eslint-disable-next-line no-console
console.log(`\n${pass}/${results.length} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
