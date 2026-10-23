// Shared EA-close-fill boundary (pure, deterministic).
//
// PURPOSE: when a closed trade has pnlStatus="UNKNOWN" the broker did not
// return a usable close fill price, so the numeric P/L cannot be trusted.
// v1.28 is the first EA version that reports the broker's real close fill
// price. The Trade Logs page and the Live Test Cycle panel both surface an
// "EA too old to report close fill — upgrade to v1.28" nudge for UNKNOWN rows
// closed by an EA older than v1.28 (or whose version is unknown). This single
// source of truth keeps both UI sites in lockstep so the boundary cannot drift.
//
// SAFETY: pure function, no IO. It only decides whether to show an upgrade
// hint; it never unlocks execution or weakens any gate.
//
// CONTRACT: returns true when the close fill was missing because the EA is too
// old. A null/empty/unparseable version is treated as "too old" — the close
// fill is missing and we cannot prove a modern EA, so the nudge still applies.
// Versions >= 1.28 are NOT flagged: those UNKNOWN cases are a genuine broker
// issue, not an EA age problem, so showing an upgrade hint would mislead.

export const EA_CLOSE_FILL_MIN_MAJOR = 1 as const;
export const EA_CLOSE_FILL_MIN_MINOR = 28 as const;

export function eaTooOldForCloseFill(version: string | null | undefined): boolean {
  if (!version) return true;
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
  return (
    major < EA_CLOSE_FILL_MIN_MAJOR ||
    (major === EA_CLOSE_FILL_MIN_MAJOR && minor < EA_CLOSE_FILL_MIN_MINOR)
  );
}
