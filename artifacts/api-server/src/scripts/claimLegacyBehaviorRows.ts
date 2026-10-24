// One-time claim of legacy ownerless (user_id IS NULL) rows in the paper
// sandbox + behaviour-coaching tables for ONE explicitly named user.
//
// WHY:
//   These routes used to be single-tenant and wrote rows without a user_id.
//   They are now owner-scoped, so those legacy rows are invisible to everyone.
//   On an install that was effectively single-user, the operator can hand the
//   history back to the person who created it.
//
// SAFETY:
//   - DRY-RUN BY DEFAULT: prints how many ownerless rows each table holds and
//     writes nothing. Pass `--apply` to write.
//   - The target user must be named explicitly with --user-id; there is no
//     default and no guessing. The user must exist.
//   - Only rows with user_id IS NULL are touched. Owned rows are never moved.
//   - weekly_performance_reviews is unique on (user_id, week_start): a legacy
//     review for a week the user already has is left ownerless (with its goals)
//     rather than overwriting the user's own review.
//   - weekly_improvement_plans (user_id, week_start), performance_symbol_snapshots
//     (user_id, symbol, range_key) and ai_performance_snapshots (user_id,
//     range_key) got owners in Tier 1 step 10. A legacy row that would collide
//     with one the user already owns is left ownerless, never overwritten.
//   - All updates run in one transaction.
//
// RUN (the owner is a deploy parameter — flag or ARX_LEGACY_OWNER_USER_ID):
//   pnpm --filter @workspace/api-server run claim:legacy-behavior-rows -- --user-id 340
//   pnpm --filter @workspace/api-server run claim:legacy-behavior-rows -- --user-id 340 --apply
//   ARX_LEGACY_OWNER_USER_ID=340 pnpm --filter @workspace/api-server run claim:legacy-behavior-rows -- --apply

import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

export const TABLES = [
  "paper_accounts",
  "paper_orders",
  "paper_trade_events",
  "post_trade_debriefs",
  "ai_mentor_sessions",
  "mentor_action_items",
  "trader_skill_profiles",
  "skill_level_history",
  "edge_discovery_reports",
  "edge_warnings",
  "trading_readiness_checks",
  "trading_rule_contracts",
  "trading_rule_violations",
  "session_commitments",
  "analytics_snapshots",
  "analytics_heatmaps",
  "trade_decision_logs",
] as const;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const userIdArg = args[args.indexOf("--user-id") + 1];
const envOwner = process.env["ARX_LEGACY_OWNER_USER_ID"];
const userId = args.includes("--user-id") ? Number(userIdArg) : envOwner ? Number(envOwner) : NaN;

/** Tables with a per-owner unique key: claim a legacy row only when it does not collide. */
export const KEYED_TABLES: ReadonlyArray<{ table: string; key: readonly string[] }> = [
  { table: "weekly_improvement_plans", key: ["week_start"] },
  { table: "performance_symbol_snapshots", key: ["symbol", "range_key"] },
  { table: "ai_performance_snapshots", key: ["range_key"] },
];

async function countNull(table: string): Promise<number> {
  const r = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${table} WHERE user_id IS NULL`));
  return Number((r.rows[0] as { c: number }).c);
}

async function main(): Promise<void> {
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error("Usage: claimLegacyBehaviorRows --user-id <id> [--apply]  (or set ARX_LEGACY_OWNER_USER_ID)");
    process.exit(2);
  }
  const [user] = await db.select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    console.error(`User ${userId} not found — aborting.`);
    process.exit(2);
  }

  console.log(`${APPLY ? "APPLY" : "DRY-RUN"}: claim ownerless rows for user ${user.id} (${user.email})`);
  for (const t of [...TABLES, "weekly_performance_reviews", "weekly_improvement_goals", ...KEYED_TABLES.map((k) => k.table)]) {
    console.log(`  ${t.padEnd(28)} ${await countNull(t)} ownerless`);
  }
  if (!APPLY) {
    console.log("Nothing written. Re-run with --apply to claim.");
    return;
  }

  await db.transaction(async (tx) => {
    for (const t of TABLES) {
      const r = await tx.execute(sql.raw(`UPDATE ${t} SET user_id = ${userId} WHERE user_id IS NULL`));
      console.log(`  ${t.padEnd(28)} claimed ${r.rowCount ?? 0}`);
    }
    const reviews = await tx.execute(sql`
      UPDATE weekly_performance_reviews r SET user_id = ${userId}
      WHERE r.user_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM weekly_performance_reviews o
          WHERE o.user_id = ${userId} AND o.week_start = r.week_start
        )`);
    console.log(`  ${"weekly_performance_reviews".padEnd(28)} claimed ${reviews.rowCount ?? 0}`);
    const goals = await tx.execute(sql`
      UPDATE weekly_improvement_goals g SET user_id = ${userId}
      FROM weekly_performance_reviews r
      WHERE g.user_id IS NULL AND g.weekly_review_id = r.id AND r.user_id = ${userId}`);
    console.log(`  ${"weekly_improvement_goals".padEnd(28)} claimed ${goals.rowCount ?? 0}`);
    for (const { table, key } of KEYED_TABLES) {
      const same = key.map((c) => `o.${c} = r.${c}`).join(" AND ");
      const r = await tx.execute(sql.raw(
        `UPDATE ${table} r SET user_id = ${userId} WHERE r.user_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM ${table} o WHERE o.user_id = ${userId} AND ${same})`,
      ));
      console.log(`  ${table.padEnd(28)} claimed ${r.rowCount ?? 0}`);
    }
  });
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
