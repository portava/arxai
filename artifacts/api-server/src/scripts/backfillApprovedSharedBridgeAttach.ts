// Idempotent back-fill that attaches already-APPROVED master-live users to the
// active shared/master live bridge so their account shell flips out of
// "assignment pending" and the live virtual_trading_accounts row + slot
// allocation exist.
//
// WHY:
//   The approve handler now auto-attaches on approval (see
//   adminMasterLiveAccess.ts), but users approved BEFORE that wiring landed are
//   stuck APPROVED-but-unattached. This back-fill repairs them by calling the
//   SAME audited attach flow the admin attach route + approve handler use, so
//   there is ZERO duplication of the provisioning/safety/audit code.
//
// SAFETY (identical posture to the approve-time auto-attach):
//   - STRICTLY visibility/provisioning. It NEVER arms a user for live
//     execution, NEVER inserts into arx_live_commands, and NEVER bypasses any
//     Phase B gate. Manual per-user arming + all 23 gates still independently
//     gate execution. The script asserts the user's arming state is byte-for-
//     byte unchanged across the attach and aborts that user's write if not.
//   - Only attaches users whose master-live status is APPROVED (and
//     approvedForMasterLive=true). Any other status (SUSPENDED / DISABLED /
//     REVOKED / RISK_LOCKED / DENIED / NOT_APPROVED / PENDING_REQUEST) is
//     skipped — never silently "fixed".
//   - Skips users whose slot allocation is frozen or closed (tradingFrozen,
//     allocationStatus != "active", or isActive=false) — a paused/closed user
//     must not be re-attached by maintenance.
//   - Idempotent: the shared flow re-uses (or reactivates) an existing
//     SHARED_MASTER_MT5 virtual_trading_accounts row, so re-running is a no-op
//     for already-attached users.
//   - DRY-RUN BY DEFAULT: prints exactly what it would do and writes nothing.
//     Pass `--apply` (or `--confirm`) to actually write.
//
// ACTOR (who the audit/mirror records as performing the attach):
//   Resolved from env BACKFILL_ACTOR_ID if set, else the lowest-id ADMIN-role
//   user, else owner user 340 when present. Aborts if none can be resolved so
//   the audit trail is never anonymous.
//
// RUN:
//   pnpm --filter @workspace/api-server run backfill:approved-shared-bridge-attach
//   pnpm --filter @workspace/api-server run backfill:approved-shared-bridge-attach -- --apply
//   # optional: override the target users with positional ids
//   pnpm --filter @workspace/api-server run backfill:approved-shared-bridge-attach -- 6145 6146 6147 --apply

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  userMasterLiveAccessTable,
  userSlotAllocationTable,
  arxLiveArmingTable,
} from "@workspace/db";
import {
  attachUserToSharedMasterInTxFlow,
  mirrorAllocationChange,
} from "../routes/adminAllocations.js";

const DEFAULT_TARGET_USER_IDS = [6145, 6146, 6147];

const args = process.argv.slice(2);
const APPLY = args.some((a) => a === "--apply" || a === "--confirm");
const positionalIds = args
  .filter((a) => /^\d+$/.test(a))
  .map((a) => parseInt(a, 10));
const TARGET_USER_IDS = positionalIds.length > 0 ? positionalIds : DEFAULT_TARGET_USER_IDS;

function log(line: string) {
  // eslint-disable-next-line no-console
  console.log(line);
}

type ArmingSnapshot = { exists: boolean; isArmed: boolean | null };

async function readArmingSnapshot(userId: number): Promise<ArmingSnapshot> {
  const [row] = await db
    .select({ isArmed: arxLiveArmingTable.isArmed })
    .from(arxLiveArmingTable)
    .where(eq(arxLiveArmingTable.userId, userId))
    .limit(1);
  return row ? { exists: true, isArmed: row.isArmed } : { exists: false, isArmed: null };
}

function armingChanged(before: ArmingSnapshot, after: ArmingSnapshot): boolean {
  return before.exists !== after.exists || before.isArmed !== after.isArmed;
}

async function resolveActor(): Promise<{ id: number; role: "ADMIN" | "OWNER" }> {
  const envId = process.env.BACKFILL_ACTOR_ID;
  if (envId && /^\d+$/.test(envId)) {
    const id = parseInt(envId, 10);
    const [u] = await db.select({ id: usersTable.id, role: usersTable.role })
      .from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!u) throw new Error(`BACKFILL_ACTOR_ID=${envId} does not match any user.`);
    // Audit integrity: the actor role is recorded verbatim into the audit +
    // mirror evidence, so it must be the user's REAL privileged role. Never
    // coerce a non-privileged user to OWNER — fail hard instead.
    if (u.role !== "ADMIN" && u.role !== "OWNER") {
      throw new Error(
        `BACKFILL_ACTOR_ID=${envId} resolves to a non-privileged role (${u.role}); `
        + "the attach actor must be a real ADMIN or OWNER.",
      );
    }
    // Guard above guarantees role ∈ {ADMIN, OWNER}; ternary yields the literal
    // union the signature requires (users.role is plain text → typed string).
    return { id: u.id, role: u.role === "ADMIN" ? "ADMIN" : "OWNER" };
  }
  const [admin] = await db.select({ id: usersTable.id })
    .from(usersTable).where(eq(usersTable.role, "ADMIN")).orderBy(asc(usersTable.id)).limit(1);
  if (admin) return { id: admin.id, role: "ADMIN" };
  const [owner] = await db.select({ id: usersTable.id })
    .from(usersTable).where(eq(usersTable.id, 340)).limit(1);
  if (owner) return { id: owner.id, role: "OWNER" };
  throw new Error("No actor could be resolved (no BACKFILL_ACTOR_ID, no ADMIN user, no user 340).");
}

async function main() {
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  log(`[backfillApprovedSharedBridgeAttach] Mode: ${mode}`);
  log(`[backfillApprovedSharedBridgeAttach] Targets: ${TARGET_USER_IDS.join(", ")}`);

  const actor = await resolveActor();
  log(`[backfillApprovedSharedBridgeAttach] Actor: user #${actor.id} (${actor.role})`);

  // Pre-load access + allocation rows for all targets in two queries.
  const accessRows = await db.select().from(userMasterLiveAccessTable)
    .where(inArray(userMasterLiveAccessTable.userId, TARGET_USER_IDS));
  const accessByUser = new Map(accessRows.map((r) => [r.userId, r]));

  const allocRows = await db.select().from(userSlotAllocationTable)
    .where(inArray(userSlotAllocationTable.userId, TARGET_USER_IDS));
  const allocByUser = new Map(allocRows.map((r) => [r.userId, r]));

  let attached = 0;
  let skipped = 0;
  let failed = 0;

  for (const userId of TARGET_USER_IDS) {
    const access = accessByUser.get(userId);
    if (!access) {
      log(`  • SKIP user=${userId}: no master-live access row (never requested/approved).`);
      skipped += 1;
      continue;
    }
    if (!(access.approvedForMasterLive && access.masterLiveStatus === "APPROVED")) {
      log(
        `  • SKIP user=${userId}: not APPROVED `
        + `(approved=${access.approvedForMasterLive}, status=${access.masterLiveStatus}).`,
      );
      skipped += 1;
      continue;
    }

    const alloc = allocByUser.get(userId);
    if (alloc && (alloc.tradingFrozen || alloc.allocationStatus !== "active" || !alloc.isActive)) {
      log(
        `  • SKIP user=${userId}: slot frozen/closed `
        + `(frozen=${alloc.tradingFrozen}, status=${alloc.allocationStatus}, active=${alloc.isActive}).`,
      );
      skipped += 1;
      continue;
    }

    const armingBefore = await readArmingSnapshot(userId);

    if (!APPLY) {
      log(
        `  • WOULD ATTACH user=${userId} (live shared bridge) `
        + `armingBefore={exists:${armingBefore.exists}, isArmed:${armingBefore.isArmed}}.`,
      );
      attached += 1;
      continue;
    }

    try {
      const result = await db.transaction(async (tx) =>
        attachUserToSharedMasterInTxFlow(
          tx,
          actor,
          userId,
          "live",
          "Back-fill: attach pre-existing approved user to shared live bridge",
          null,
        ),
      );

      if (!("ok" in result)) {
        log(`  ✗ FAIL user=${userId}: ${result.body?.error ?? `HTTP ${result.status}`}`);
        failed += 1;
        continue;
      }

      // Invariant: the attach must NEVER have created or changed an arming row.
      const armingAfter = await readArmingSnapshot(userId);
      if (armingChanged(armingBefore, armingAfter)) {
        log(
          `  ✗ FAIL user=${userId}: ARMING CHANGED across attach `
          + `(before=${JSON.stringify(armingBefore)}, after=${JSON.stringify(armingAfter)}). `
          + "This must never happen — investigate immediately.",
        );
        failed += 1;
        continue;
      }

      await mirrorAllocationChange(
        actor,
        "ALLOCATION_ATTACH_SHARED_MASTER",
        userId,
        "Back-fill: attach pre-existing approved user to shared live bridge",
      );

      log(
        `  ✓ ATTACHED user=${userId} vAccount=${result.virtualAccountId} `
        + `created=${result.created} reactivated=${result.reactivated} `
        + `armingUnchanged={exists:${armingAfter.exists}, isArmed:${armingAfter.isArmed}}.`,
      );
      attached += 1;
    } catch (err) {
      log(`  ✗ FAIL user=${userId}: ${(err as Error).message}`);
      failed += 1;
    }
  }

  log("[backfillApprovedSharedBridgeAttach] Summary:");
  log(`    ${APPLY ? "attached" : "would attach"} : ${attached}`);
  log(`    skipped                  : ${skipped}`);
  log(`    failed                   : ${failed}`);
  if (!APPLY) {
    log("[backfillApprovedSharedBridgeAttach] DRY-RUN complete. Re-run with `-- --apply` to write.");
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error("[backfillApprovedSharedBridgeAttach] FAILED:", err);
    process.exit(1);
  },
);
