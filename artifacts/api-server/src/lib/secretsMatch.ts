import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison.
 *
 * `a !== b` on strings short-circuits at the first differing byte, so the time
 * it takes to reject leaks how much of the prefix was right. That is enough to
 * recover a token byte by byte given enough attempts.
 *
 * Both sides are hashed to a fixed 32 bytes FIRST. timingSafeEqual throws on
 * length mismatch, so comparing raw values would either crash on a wrong-length
 * token — turning a 401 into a 500 — or force a length check that leaks the
 * length by another channel. Digesting makes every comparison the same size and
 * the same cost.
 *
 * Lives in its own module, not inline in the route, so tests can import the
 * real function: the route's own imports require DATABASE_URL at load time.
 */
export function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
