// pressReleaseKillSwitch — the owner's kill-switch release press, from the shell.
//
// WHY THIS EXISTS
//   The HTTP release doorway (POST /admin/live-shared/kill-switch,
//   { action: "RELEASE" }) needs the admin's browser session cookie, and the
//   owner works in the Replit shell — twice the browser-console fetch was
//   pasted into bash. An owner press that keeps failing on surface confusion
//   is a press that does not happen. This script is the SAME doorway with the
//   SAME wall: it consults the identical cold-posture policy and writes the
//   identical audit row. It adds no new authority — anyone with this shell
//   already holds DATABASE_URL.
//
// SAFETY
//   * The cold-posture wall (killSwitchReleasePolicy.ts) is consulted and a
//     hot platform REFUSES with every violation named. A hot release still
//     requires the full activate-step ceremony. The phase6-execution-safety
//     guard (R4) pins this file as a sanctioned writer ONLY while it keeps
//     consulting killSwitchReleaseViolations.
//   * Missing settings row → created fail-closed (kill switch ENGAGED) first,
//     then released as an explicit audited transition, atomically.
//   * Requires the explicit flag --confirm-release. Refuses without it.
//   * Idempotent: an already-released switch reports so and changes nothing.

import { db, globalTradingSettingsTable, adminActionAuditLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import {
  killSwitchReleaseViolations,
  postureFromSettingsRow,
} from "../lib/phase6/killSwitchReleasePolicy.js";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const confirmed = process.argv.includes("--confirm-release");
const adminUserId = Number(arg("user") ?? "");
const reason = arg("reason") ?? "owner shell press: tier1 demo certification - platform cold";

async function main(): Promise<void> {
  if (!confirmed || !Number.isInteger(adminUserId) || adminUserId <= 0) {
    console.error(
      "REFUSED — this is the owner's press and must be explicit.\n" +
      "  usage: press:release-kill-switch -- --user=<your user id> --confirm-release [--reason=\"...\"]",
    );
    process.exit(1);
  }

  const envEnabled = liveBrokerExecutionEnabled();

  const result = await db.transaction(async (tx) => {
    // Same advisory lock as the HTTP doorway — the settings singleton has no
    // unique constraint, so serialize any concurrent bootstrap.
    await tx.execute(sql`select pg_advisory_xact_lock(${0x4152_5807}, ${1})`);
    let row = (await tx.select().from(globalTradingSettingsTable).limit(1))[0];
    if (!row) {
      row = (await tx.insert(globalTradingSettingsTable)
        .values({ updatedAt: new Date() }).returning())[0]!;
    }

    if (row.emergencyKillSwitch === false) {
      return { kind: "already-released" as const, violations: [] as string[] };
    }

    const posture = postureFromSettingsRow(row, envEnabled);
    const violations = killSwitchReleaseViolations(posture);
    if (violations.length > 0) {
      return { kind: "refused" as const, violations };
    }

    await tx
      .update(globalTradingSettingsTable)
      .set({
        emergencyKillSwitch: false,
        killSwitchEngagedAt: null,
        killSwitchReason: null,
        updatedAt: new Date(),
      })
      .where(eq(globalTradingSettingsTable.id, row.id));
    await tx.insert(adminActionAuditLogTable).values({
      adminId: adminUserId,
      adminRole: "OWNER",
      action: "ADMIN_RELEASED_LIVE_SHARED_KILL_SWITCH",
      beforeState: {
        emergencyKillSwitch: row.emergencyKillSwitch,
        killSwitchEngagedAt: row.killSwitchEngagedAt,
        killSwitchReason: row.killSwitchReason,
        posture,
        via: "shell-press",
      } as Record<string, unknown>,
      afterState: {
        emergencyKillSwitch: false,
        releaseReason: reason,
        coldPostureVerified: true,
        via: "shell-press",
      } as Record<string, unknown>,
    });
    return { kind: "released" as const, violations: [] as string[] };
  });

  if (result.kind === "refused") {
    console.error(
      "REFUSED — COLD_POSTURE_REQUIRED_FOR_RELEASE. These live controls are hot:\n" +
      result.violations.map((v) => `  - ${v}`).join("\n") +
      "\nA hot release requires the shared-live activation ceremony " +
      "(POST /api/admin/live-shared/activate-step). NOTHING was changed.",
    );
    process.exit(1);
  }
  if (result.kind === "already-released") {
    console.log("Kill switch is ALREADY released — nothing to do, nothing changed.");
    return;
  }
  console.log(
    "RELEASED. The global emergency kill switch is now off, audited as " +
    `ADMIN_RELEASED_LIVE_SHARED_KILL_SWITCH by user ${adminUserId} (shell press).\n` +
    "Next: seed the Tier 1 ticket, then Approve and Send to broker in /approval-inbox.",
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("press failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
