// Phase 6 — Personal Trading Constitution persistence.
//
// APPEND-ONLY. A new version is a NEW ROW naming the version it supersedes; an
// existing row is never updated. Editing one in place would retroactively
// rewrite the rules a user was told governed a trade they already approved, and
// an approval ticket pins constitutionVersion precisely so that record holds.
//
// This module deliberately contains no db.update() on the constitution table.
// That is enforced, not merely intended: tradingConstitutionsTable is
// registered in scripts/src/ci/check-vault-mutations.ts, so adding an UPDATE
// here fails the vault-append-only guard in CI.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../index";
import { tradingConstitutionsTable } from "../schema/phase6GuidedExecution";

export type TradingConstitutionRow = typeof tradingConstitutionsTable.$inferSelect;

/**
 * The version currently governing this user, or null.
 *
 * Null is a REFUSAL upstream, not a licence to trade unconstrained: the pure
 * evaluator returns CONSTITUTION_MISSING for null and refuses. Callers must not
 * substitute a default here.
 */
export async function getActiveConstitution(userId: number): Promise<TradingConstitutionRow | null> {
  const rows = await db.select().from(tradingConstitutionsTable)
    .where(eq(tradingConstitutionsTable.userId, userId))
    .orderBy(desc(tradingConstitutionsTable.version))
    .limit(1);
  return rows[0] ?? null;
}

/** A specific historical version — what a ticket pinned when it was created. */
export async function getConstitutionVersion(
  userId: number,
  version: number,
): Promise<TradingConstitutionRow | null> {
  const rows = await db.select().from(tradingConstitutionsTable)
    .where(and(
      eq(tradingConstitutionsTable.userId, userId),
      eq(tradingConstitutionsTable.version, version),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Append a new version.
 *
 * The version number is derived from the current head rather than supplied by
 * the caller, and (user_id, version) is UNIQUE — so two concurrent writers
 * cannot both claim the same version. The loser gets a unique-violation, which
 * is the correct outcome: it must retry against the new head rather than
 * silently overwrite a policy change it never saw.
 */
export async function appendConstitutionVersion(args: {
  userId: number;
  createdBy: string;
  values: Omit<
    typeof tradingConstitutionsTable.$inferInsert,
    "userId" | "version" | "supersedesVersion" | "createdBy"
  >;
}): Promise<TradingConstitutionRow> {
  const head = await getActiveConstitution(args.userId);
  const nextVersion = (head?.version ?? 0) + 1;
  const rows = await db.insert(tradingConstitutionsTable).values({
    ...args.values,
    userId: args.userId,
    version: nextVersion,
    supersedesVersion: head?.version ?? null,
    createdBy: args.createdBy,
  }).returning();
  const row = rows[0];
  if (!row) throw new Error("TRADING_CONSTITUTION_INSERT_RETURNED_NO_ROW");
  return row;
}

export async function listConstitutionHistory(userId: number): Promise<TradingConstitutionRow[]> {
  return db.select().from(tradingConstitutionsTable)
    .where(eq(tradingConstitutionsTable.userId, userId))
    .orderBy(desc(tradingConstitutionsTable.version));
}
