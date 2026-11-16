// T013 real-user-4 envelope spot-check.
// Mints a short-lived session for the real OWNER user id=4 and verifies
// the /api/me/account-mode envelope. Cleans up its own session.

import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, authUserSessionsTable } from "@workspace/db";

if (process.env.QA_ALLOW_DB_MUTATION !== "true") {
  console.error("set QA_ALLOW_DB_MUTATION=true to run");
  process.exit(2);
}

const raw = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(raw).digest("hex");
await db.insert(authUserSessionsTable).values({
  userId: 4,
  tokenHash,
  expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  ipAddress: "127.0.0.1",
  userAgent: "qa-t013-real-user-4",
});

try {
  const r = await fetch("http://localhost:80/api/me/account-mode", {
    headers: { cookie: `arx_user_session=${raw}` },
  });
  const body: any = await r.json();
  console.log(JSON.stringify({
    status: r.status,
    userId: body.userId,
    role: body.role,
    isAdmin: body.isAdmin,
    isAdminPreviewingUserMode: body.isAdminPreviewingUserMode,
    currentAccountMode: body.currentAccountMode,
    cleanModeLabel: body.cleanModeLabel,
    cleanBlockedReason: body.cleanBlockedReason,
    accountMode: body.accountShellStatus?.accountMode,
    tradingMode: body.accountShellStatus?.tradingMode,
    tradingModeLabel: body.accountShellStatus?.tradingModeLabel,
    hasAlloc: body.userAllocation?.hasAllocation,
    balance: body.userAllocation?.currentBalance,
    equity: body.userAllocation?.equity,
    aiSleeve: body.aiSleeveStatus,
    smaAttached: body.userSharedMasterAssignment?.attached,
    liveExecutionArmed: body.liveExecutionArmed,
    adminDiagnosticsAvailable: body.adminDiagnosticsAvailable,
    canManualTrade: body.userCanManualTrade,
    canAutoTrade: body.userCanAutoTrade,
  }, null, 2));
} finally {
  await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.tokenHash, tokenHash));
  const pool = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
  if (pool?.end) await pool.end();
}
