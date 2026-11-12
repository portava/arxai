// One transaction-scoped lock per learning entity, including before its first
// row exists. Every read-modify-write and idempotency check uses this lock.
// Hash collisions only serialize unrelated work; they cannot mix entity data.
import { sql } from "drizzle-orm";
import type { Tx } from "./learningAudit.js";

export function learningLockKey(kind: "trust" | "weight", userId: number, key: string, entityType = ""): string {
  return JSON.stringify(["aaci-learning-v1", kind, userId, entityType, key]);
}

export async function lockLearningEntity(tx: Tx, kind: "trust" | "weight", userId: number, key: string, entityType = ""): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${learningLockKey(kind, userId, key, entityType)}, 0))`);
}
