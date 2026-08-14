// ARX Fund Book — per-deposit 30-day lock math (Task #132). Pure, no DB, no IO.
// Deterministic and unit-testable in isolation.
//
// DESIGN:
// - Each settled deposit creates a lock row whose principal cannot be withdrawn
//   until lockUntil. The locked-vs-withdrawable split is computed from these
//   rows against the investor's current total value and a reference "now".
// - We never lock more than the investor currently holds: lockedPrincipal is
//   capped at currentValue, so withdrawable is always ≥ 0.

export interface DepositLockRow {
  principalAmount: number;
  lockUntil: Date;
  status: string; // LOCKED | RELEASED
}

export interface LockedSplit {
  /** Sum of still-locked principal (capped at currentValue). */
  lockedPrincipal: number;
  /** currentValue − lockedPrincipal, floored at 0. */
  withdrawableValue: number;
  /** The earliest upcoming lock release (or null if nothing is locked). */
  nextReleaseAt: Date | null;
}

import { round2 } from "./navMath.js";

/**
 * Split an investor's current value into locked principal vs withdrawable.
 * A lock counts as locked when its status is LOCKED and lockUntil is strictly
 * after `now`. The locked principal is capped at currentValue so the
 * withdrawable amount can never be negative.
 */
export function computeLockedVsWithdrawable(
  currentValue: number,
  locks: DepositLockRow[],
  now: Date,
): LockedSplit {
  const value = Number.isFinite(currentValue) ? Math.max(0, currentValue) : 0;
  let rawLocked = 0;
  let nextReleaseAt: Date | null = null;
  for (const lock of locks) {
    if (lock.status !== "LOCKED") continue;
    if (!(lock.lockUntil instanceof Date)) continue;
    if (lock.lockUntil.getTime() <= now.getTime()) continue; // already releasable
    if (Number.isFinite(lock.principalAmount) && lock.principalAmount > 0) {
      rawLocked += lock.principalAmount;
    }
    if (nextReleaseAt === null || lock.lockUntil.getTime() < nextReleaseAt.getTime()) {
      nextReleaseAt = lock.lockUntil;
    }
  }
  const lockedPrincipal = round2(Math.min(rawLocked, value));
  const withdrawableValue = round2(Math.max(0, value - lockedPrincipal));
  return { lockedPrincipal, withdrawableValue, nextReleaseAt };
}

/** Compute a lock-until instant: lockedAt + lockDays (in whole days). */
export function computeLockUntil(lockedAt: Date, lockDays: number): Date {
  const days = Number.isFinite(lockDays) && lockDays > 0 ? Math.floor(lockDays) : 0;
  const out = new Date(lockedAt.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
