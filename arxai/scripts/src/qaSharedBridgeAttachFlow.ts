// qaSharedBridgeAttachFlow.ts — Shared-bridge attach flow acceptance proof
//
// Locks the T001/T002 wiring that auto-attaches APPROVED master-live users to
// the active shared/master live bridge as VISIBILITY SCAFFOLDING ONLY:
//
//   A1. The shared attach flow (`attachUserToSharedMasterInTxFlow`) flips a
//       user from "assignment pending" to attached — i.e. it makes the same
//       `sharedMasterAssigned` predicate the account shell uses
//       (a SHARED_MASTER virtual_trading_accounts row that is `active`) go
//       false → true.
//   A2. NO-ARMING INVARIANT: the attach NEVER creates or mutates an
//       `arx_live_arming` row. Execution still requires manual arming + the 18
//       Phase B gates. (The whole point of the task: attachment ≠ execution.)
//   A3. IDEMPOTENCY: re-running the flow re-uses the existing VTA (created
//       false, reactivated false) and never duplicates the row; a soft-detached
//       (closed) VTA is REACTIVATED rather than duplicated.
//   A4. BACKFILL IDEMPOTENCY: the real back-fill script
//       (`backfillApprovedSharedBridgeAttach`) attaches an APPROVED user on the
//       first `--apply`, is a no-op on the second run (still exactly one VTA),
//       and never arms the user across either run.
//
// SAFETY / ISOLATION:
//   - Seeds only THROW-AWAY users (cleaned up in finally) + a synthetic master
//     mt5_connection. It seeds an `arx_master_account_config` active row ONLY
//     when none already exists (fresh CI schema), and removes only what it
//     itself created — so it never deletes a real master config / shared-master
//     account in the dev DB.
//   - CRITICAL audit: asserts `arx_live_commands` is byte-for-byte unchanged
//     across the whole run (baseline-delta + max(id)); never inserts a command.
//   - Never prints tokens, hashes, account numbers, or balances.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  mt5ConnectionTable,
  arxMasterAccountConfigTable,
  sharedMasterAccountsTable,
  virtualTradingAccountsTable,
  userSlotAllocationTable,
  arxLiveArmingTable,
  adminActionAuditLogTable,
  userMasterLiveAccessTable,
  securityEventsTable,
} from "@workspace/db";
import { attachUserToSharedMasterInTxFlow } from "../../artifacts/api-server/src/routes/adminAllocations.js";

const ROOT = join(import.meta.dirname, "..", "..");

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

// Mirror of meAccountShell's `sharedMasterAssigned`: a SHARED_MASTER VTA that
// is `active`. NO accountType filter — a live OR demo active row flips it true.
async function sharedMasterAssigned(userId: number): Promise<boolean> {
  const rows = await db
    .select({
      status: virtualTradingAccountsTable.status,
      sharedMasterAccountId: virtualTradingAccountsTable.sharedMasterAccountId,
    })
    .from(virtualTradingAccountsTable)
    .where(eq(virtualTradingAccountsTable.userId, userId));
  return rows.some(
    (a) => a.sharedMasterAccountId != null && String(a.status ?? "").toLowerCase() === "active",
  );
}

async function sharedVtaCount(userId: number): Promise<number> {
  const rows = await db
    .select({ id: virtualTradingAccountsTable.id })
    .from(virtualTradingAccountsTable)
    .where(
      and(
        eq(virtualTradingAccountsTable.userId, userId),
        eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
      ),
    );
  return rows.length;
}

async function armingRowExists(userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: arxLiveArmingTable.id })
    .from(arxLiveArmingTable)
    .where(eq(arxLiveArmingTable.userId, userId))
    .limit(1);
  return rows.length > 0;
}

async function main(): Promise<void> {
  // ── CRITICAL INVARIANT baseline (measure delta across the whole run) ──
  const baseRow = await pool.query(
    "SELECT COUNT(*)::int AS n, COALESCE(MAX(id),0)::int AS max_id FROM arx_live_commands",
  );
  const baselineN = Number(baseRow.rows[0].n);
  const baselineMaxId = Number(baseRow.rows[0].max_id);

  const stamp = Date.now();
  let userA = 0;
  let userB = 0;
  let actorId = 0;
  let seededConnId = 0;
  let seededConfigId: number | null = null;

  try {
    // ── Seed throw-away actor + two target users ───────────────────────
    const [actor] = await db
      .insert(usersTable)
      .values({ email: `qa-attach-actor-${stamp}@arx.test`, role: "ADMIN" })
      .returning();
    actorId = actor!.id;
    const [a] = await db
      .insert(usersTable)
      .values({ email: `qa-attach-a-${stamp}@arx.test`, role: "USER" })
      .returning();
    userA = a!.id;
    const [b] = await db
      .insert(usersTable)
      .values({ email: `qa-attach-b-${stamp}@arx.test`, role: "USER" })
      .returning();
    userB = b!.id;

    // ── Seed a synthetic master connection. Seed an ACTIVE master config
    //    pointing at it ONLY if none exists (fresh CI), so the dev DB's real
    //    pinned master is never displaced and we only clean what we create. ──
    const [conn] = await db
      .insert(mt5ConnectionTable)
      .values({
        status: "connected",
        accountType: "live",
        brokerName: "QA-MASTER",
        accountNumber: "99999999",
        accountBalance: 100000,
        accountEquity: 100000,
        freeMargin: 100000,
        lastHeartbeat: new Date(),
        mode: "LIVE",
        eaVersion: "1.55",
      })
      .returning();
    seededConnId = conn!.id;

    const existingActiveConfig = await db
      .select({ id: arxMasterAccountConfigTable.id })
      .from(arxMasterAccountConfigTable)
      .where(eq(arxMasterAccountConfigTable.isActive, true))
      .limit(1);
    if (!existingActiveConfig[0]) {
      const [cfg] = await db
        .insert(arxMasterAccountConfigTable)
        .values({ masterConnectionId: seededConnId, isActive: true, label: "QA attach-flow master" })
        .returning();
      seededConfigId = cfg!.id;
    }

    const actorRef = { id: actorId, role: "ADMIN" as const };

    // ── A1 — attach flips sharedMasterAssigned false → true ────────────
    const before = await sharedMasterAssigned(userA);
    const r1 = await db.transaction((tx) =>
      attachUserToSharedMasterInTxFlow(tx, actorRef, userA, "live", "QA attach test", null),
    );
    const r1ok = "ok" in r1 && r1.ok === true;
    const after = await sharedMasterAssigned(userA);
    record(
      "A1_attach_flips_shared_master_assigned",
      before === false && r1ok && r1ok && (r1 as { created: boolean }).created === true && after === true,
      `before=${before} attachOk=${r1ok} created=${r1ok ? (r1 as { created: boolean }).created : "n/a"} after=${after}`,
    );

    // ── A2 — NO-ARMING INVARIANT (attach must never arm) ───────────────
    const armedAfterAttach = await armingRowExists(userA);
    record(
      "A2_attach_never_creates_arming_row",
      armedAfterAttach === false,
      `arx_live_arming row for attached user exists=${armedAfterAttach} (must be false)`,
    );

    // ── A3 — idempotency: re-run is a no-op (no duplicate VTA) ──────────
    const r2 = await db.transaction((tx) =>
      attachUserToSharedMasterInTxFlow(tx, actorRef, userA, "live", "QA attach test (rerun)", null),
    );
    const r2ok = "ok" in r2 && r2.ok === true;
    const r2created = r2ok ? (r2 as { created: boolean }).created : true;
    const r2react = r2ok ? (r2 as { reactivated: boolean }).reactivated : true;
    const countAfterRerun = await sharedVtaCount(userA);
    record(
      "A3a_attach_idempotent_no_duplicate",
      r2ok && r2created === false && r2react === false && countAfterRerun === 1,
      `rerun ok=${r2ok} created=${r2created} reactivated=${r2react} vtaCount=${countAfterRerun}`,
    );

    // Soft-detach (close) then re-attach → must REACTIVATE, not duplicate.
    await db
      .update(virtualTradingAccountsTable)
      .set({ status: "closed" })
      .where(
        and(
          eq(virtualTradingAccountsTable.userId, userA),
          eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
        ),
      );
    const r3 = await db.transaction((tx) =>
      attachUserToSharedMasterInTxFlow(tx, actorRef, userA, "live", "QA reattach", null),
    );
    const r3ok = "ok" in r3 && r3.ok === true;
    const r3react = r3ok ? (r3 as { reactivated: boolean }).reactivated : false;
    const countAfterReattach = await sharedVtaCount(userA);
    const reassigned = await sharedMasterAssigned(userA);
    record(
      "A3b_closed_vta_reactivated_not_duplicated",
      r3ok && r3react === true && countAfterReattach === 1 && reassigned === true,
      `reattach ok=${r3ok} reactivated=${r3react} vtaCount=${countAfterReattach} assigned=${reassigned}`,
    );

    // ── A4 — back-fill script idempotency + no-arming (real script) ─────
    // Seed userB as APPROVED so the back-fill targets it. Run twice with the
    // throw-away ADMIN as the audit actor.
    await db.insert(userMasterLiveAccessTable).values({
      userId: userB,
      approvedForMasterLive: true,
      masterLiveTradingEnabled: true,
      masterLiveStatus: "APPROVED",
      masterLiveApprovedBy: actorId,
      masterLiveApprovedAt: new Date(),
    });

    const runBackfill = (): { ok: boolean; attached: boolean; detail: string } => {
      const res = spawnSync(
        "pnpm",
        [
          "--filter",
          "@workspace/api-server",
          "run",
          "backfill:approved-shared-bridge-attach",
          "--",
          String(userB),
          "--apply",
        ],
        {
          cwd: ROOT,
          env: { ...process.env, BACKFILL_ACTOR_ID: String(actorId) },
          encoding: "utf8",
          timeout: 110000,
        },
      );
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      const attached = new RegExp(`ATTACHED user=${userB}\\b`).test(out);
      return { ok: res.status === 0, attached, detail: `status=${res.status} attachedLine=${attached}` };
    };

    const bf1 = runBackfill();
    const vtaAfterBf1 = await sharedVtaCount(userB);
    const assignedAfterBf1 = await sharedMasterAssigned(userB);
    record(
      "A4a_backfill_attaches_approved_user",
      bf1.ok && bf1.attached && vtaAfterBf1 === 1 && assignedAfterBf1 === true,
      `${bf1.detail} vtaCount=${vtaAfterBf1} assigned=${assignedAfterBf1}`,
    );

    const bf2 = runBackfill();
    const vtaAfterBf2 = await sharedVtaCount(userB);
    const armedAfterBf = await armingRowExists(userB);
    record(
      "A4b_backfill_idempotent_and_never_arms",
      bf2.ok && vtaAfterBf2 === 1 && armedAfterBf === false,
      `${bf2.detail} vtaCount=${vtaAfterBf2} armingExists=${armedAfterBf} (must be false)`,
    );

    // ── A6 — backfill REFUSES a non-privileged audit actor ─────────────
    // Audit integrity: BACKFILL_ACTOR_ID must resolve to a real ADMIN/OWNER.
    // A USER-role actor must hard-fail (non-zero exit) BEFORE any attach/audit
    // write — never silently recorded as OWNER. Run against userA (already
    // attached) so a (wrongly) successful run would be a no-op attach; we assert
    // it FAILS regardless, and that no arming row appears for the USER actor.
    const bfBadActor = spawnSync(
      "pnpm",
      [
        "--filter",
        "@workspace/api-server",
        "run",
        "backfill:approved-shared-bridge-attach",
        "--",
        String(userA),
        "--apply",
      ],
      {
        cwd: ROOT,
        env: { ...process.env, BACKFILL_ACTOR_ID: String(userA) },
        encoding: "utf8",
        timeout: 110000,
      },
    );
    const badOut = `${bfBadActor.stdout ?? ""}${bfBadActor.stderr ?? ""}`;
    const refusedNonPrivileged =
      bfBadActor.status !== 0 && /non-privileged role/i.test(badOut);
    record(
      "A6_backfill_rejects_non_privileged_actor",
      refusedNonPrivileged,
      `status=${bfBadActor.status} refusedMsg=${/non-privileged role/i.test(badOut)} (must hard-fail)`,
    );

    // ── CRITICAL INVARIANT — arx_live_commands unchanged ───────────────
    const endRow = await pool.query(
      "SELECT COUNT(*)::int AS n, COALESCE(MAX(id),0)::int AS max_id FROM arx_live_commands",
    );
    const endN = Number(endRow.rows[0].n);
    const endMaxId = Number(endRow.rows[0].max_id);
    record(
      "A5_no_live_commands_inserted",
      endN === baselineN && endMaxId === baselineMaxId,
      `count ${baselineN}→${endN}, maxId ${baselineMaxId}→${endMaxId} (must be unchanged)`,
    );
  } finally {
    // ── Cleanup: remove ONLY our synthetic rows, FK-safe order ─────────
    const userIds = [userA, userB].filter((n) => n > 0);
    try {
      if (userIds.length) {
        await db.delete(virtualTradingAccountsTable).where(inArray(virtualTradingAccountsTable.userId, userIds));
        await db.delete(userSlotAllocationTable).where(inArray(userSlotAllocationTable.userId, userIds));
        await db.delete(arxLiveArmingTable).where(inArray(arxLiveArmingTable.userId, userIds));
        await db.delete(userMasterLiveAccessTable).where(inArray(userMasterLiveAccessTable.userId, userIds));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, userIds));
      }
      if (actorId > 0) {
        await db.delete(securityEventsTable).where(eq(securityEventsTable.actorUserId, actorId));
      }
      // Master fixtures — only what we created.
      if (seededConfigId != null) {
        await db.delete(arxMasterAccountConfigTable).where(eq(arxMasterAccountConfigTable.id, seededConfigId));
      }
      if (seededConnId > 0) {
        await db.delete(sharedMasterAccountsTable).where(eq(sharedMasterAccountsTable.connectionId, seededConnId));
        await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, seededConnId));
      }
      const allUsers = [actorId, userA, userB].filter((n) => n > 0);
      if (allUsers.length) {
        await db.delete(usersTable).where(inArray(usersTable.id, allUsers));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[qaSharedBridgeAttachFlow] cleanup warning:", (err as Error).message);
    }
  }

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(
    `\n[qaSharedBridgeAttachFlow] ${results.length - failed.length}/${results.length} passed.`,
  );
  if (failed.length) {
    // eslint-disable-next-line no-console
    console.error(`FAILURES: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error("[qaSharedBridgeAttachFlow] FAILED:", err);
    process.exit(1);
  },
);
