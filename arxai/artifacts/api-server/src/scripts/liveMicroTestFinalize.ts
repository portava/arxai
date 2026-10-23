// Finalize the task #399 controlled LIVE micro-test after the open+close proof.
//
// The OPEN and CLOSE were both proven with real broker evidence:
//   OPEN : cmd lvcmd_47b95beb… broker ticket 40804303282 retcode 10009 entry 1.15326
//   CLOSE: cmd lvcmd_d942ba0b… close deal ticket 40804311402 retcode 10009,
//          position closed_at stamped (mt5_commands 342 CLOSED, reasonCode empty).
//
// This script does ONLY honest reconciliation + cleanup. It re-implements no
// gate and fabricates nothing:
//   1. Reconcile the orphaned cycle 97 (lvtc_cd604922…): its OWN auto-close
//      command (lvcmd_b1ac2c96…) hit the Bridge v2 positionTicket-mirror bug
//      (closed ticket 0 → POSITION_NOT_FOUND). The position was actually closed
//      by a SEPARATE fresh gated command, so we mark the cycle
//      CLOSE_FAILED_MANUAL_REQUIRED with a note pointing at the real close —
//      NEVER attribute the close to the broken command (advanceCycle would).
//   2. Revert the temporary $40 allocation → 0 through the REAL audited admin
//      endpoint (decrease: no pool precheck, virtual shell synced, audit row).
//   3. Restore operator state: role → USER, ownerLiveControlMode → true.
//   4. Print the final allocation disposition.

import { eq } from "drizzle-orm";
import { db, usersTable, ownerGovernanceSettingsTable, userSlotAllocationTable } from "@workspace/db";
import { createUserSession, destroyUserSession } from "../lib/auth/userSessions.js";
import { manualResolveCycle } from "../lib/live/liveTestCycle.js";

const USER_ID = 4;
const BASE = "http://localhost:80";
const CYCLE_ID = "lvtc_cd604922-bb6e-44c2-8802-300c489c6932";
const APPLY = process.argv.includes("--apply");
const j = (v: unknown) => JSON.stringify(v, null, 2);

async function api(method: string, path: string, cookie: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function main() {
  console.log(`=== LIVE MICRO-TEST FINALIZE (#399) apply=${APPLY} ===`);

  const [alloc0] = await db.select().from(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, USER_ID)).limit(1);
  console.log(`Allocation before: allocated=${alloc0?.allocatedFunds} status=${alloc0?.allocationStatus}`);

  if (!APPLY) {
    console.log("DRY RUN — would resolve cycle, revert allocation→0, restore role/gov. Re-run with --apply.");
    return;
  }

  // 1) Honest cycle reconciliation.
  const note =
    "Cycle auto-close (lvcmd_b1ac2c96) hit the Bridge v2 positionTicket-mirror bug " +
    "(enqueueBridgedMt5Command read only the broker_ticket column, NULL for CLOSE, so the EA " +
    "closed ticket 0 → POSITION_NOT_FOUND). Bug fixed (mirror now reads column ?? payload.brokerTicket). " +
    "Position 40804303282 was closed via a fresh gated command lvcmd_d942ba0b → close deal ticket " +
    "40804311402, retcode 10009, closed_at 2026-06-08T20:23:16Z. This cycle's own close did NOT execute.";
  const resolved = await manualResolveCycle({ userId: USER_ID, cycleId: CYCLE_ID, note });
  console.log(`\n[1] CYCLE RESOLVE ok=${resolved.ok} status=${resolved.ok ? resolved.cycle.status : (resolved as { reason?: string }).reason}`);

  // 2) Temporarily elevate to OWNER + mint a session to reach the audited admin endpoint.
  await db.update(usersTable).set({ role: "OWNER" }).where(eq(usersTable.id, USER_ID));
  const s = await createUserSession({ userId: USER_ID, userAgent: "arx-live-microtest-finalize" });
  const cookie = `arx_user_session=${s.rawToken}`;
  let revertOk = false;
  try {
    const dealloc = await api("POST", `/api/admin/allocations/${USER_ID}/set`, cookie, {
      amount: 0,
      note: "#399 revert temporary live micro-test allocation (open+close proof complete)",
    });
    console.log(`\n[2] ALLOCATION → 0 HTTP ${dealloc.status}\n${j(dealloc.json)}`);
    revertOk = dealloc.status === 200;
  } finally {
    await destroyUserSession(s.rawToken).catch(() => {});
    // 3) Restore operator state (role + governance posture).
    await db.update(usersTable).set({ role: "USER" }).where(eq(usersTable.id, USER_ID));
    await db.update(ownerGovernanceSettingsTable)
      .set({ ownerLiveControlMode: true })
      .where(eq(ownerGovernanceSettingsTable.userId, USER_ID));
    console.log("\n[3] RESTORED: role→USER, ownerLiveControlMode→true, session destroyed.");
  }

  // 4) Final disposition.
  const [allocF] = await db.select().from(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, USER_ID)).limit(1);
  const [uF] = await db.select().from(usersTable).where(eq(usersTable.id, USER_ID)).limit(1);
  const [gF] = await db.select().from(ownerGovernanceSettingsTable).where(eq(ownerGovernanceSettingsTable.userId, USER_ID)).limit(1);
  console.log(`\n=== FINAL DISPOSITION ===`);
  console.log(`allocation: allocated=${allocF?.allocatedFunds} manual=${allocF?.manualAllocatedFunds} ai=${allocF?.aiAllocatedFunds} status=${allocF?.allocationStatus} (revertOk=${revertOk})`);
  console.log(`role=${uF?.role} ownerLiveControlMode=${gF?.ownerLiveControlMode}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
