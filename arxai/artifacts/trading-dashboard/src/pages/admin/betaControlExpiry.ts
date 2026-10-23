// Pure, framework-free helpers for the admin Registration Keys expiry indicator.
// Kept in a sibling module (not the .tsx) so they stay unit-testable and don't
// trip Vite fast-refresh (component files must only export components).

/** PENDING keys expiring within this many days are flagged "soon-to-expire". */
export const EXPIRES_SOON_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpiryIndicator =
  /** expiresAt is null — the key never auto-expires. */
  | { kind: "no-expiry" }
  /** status is not PENDING — countdown is not meaningful; show the raw date only. */
  | { kind: "not-applicable"; dateLabel: string }
  /** PENDING key whose expiry has already lapsed. */
  | { kind: "expired"; dateLabel: string; relativeLabel: string; tone: "danger" }
  /** PENDING key with a future expiry. `soon` marks the visually-distinguished window. */
  | {
      kind: "active";
      dateLabel: string;
      relativeLabel: string;
      daysLeft: number;
      soon: boolean;
      tone: "danger" | "warning" | "neutral";
    };

function toDateLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole calendar-ish days remaining, rounded up (a future expiry is always ≥ 1). */
function daysUntil(target: number, now: number): number {
  return Math.ceil((target - now) / DAY_MS);
}

function relativeLabel(daysLeft: number): string {
  if (daysLeft <= 1) return "in 1 day";
  return `in ${daysLeft} days`;
}

/**
 * Resolve the expiry indicator for a registration key row.
 * Only PENDING keys get a live countdown; everything else is plain.
 */
export function getExpiryIndicator(
  expiresAt: string | null | undefined,
  status: string,
  now: number = Date.now(),
): ExpiryIndicator {
  if (!expiresAt) return { kind: "no-expiry" };
  const parsed = new Date(expiresAt);
  const t = parsed.getTime();
  if (Number.isNaN(t)) return { kind: "no-expiry" };
  const dateLabel = toDateLabel(parsed);

  if (status !== "PENDING") return { kind: "not-applicable", dateLabel };

  if (t <= now) {
    return { kind: "expired", dateLabel, relativeLabel: "Expired", tone: "danger" };
  }

  const daysLeft = daysUntil(t, now);
  const soon = daysLeft <= EXPIRES_SOON_DAYS;
  const tone: "danger" | "warning" | "neutral" =
    daysLeft <= 2 ? "danger" : soon ? "warning" : "neutral";

  return { kind: "active", dateLabel, relativeLabel: relativeLabel(daysLeft), daysLeft, soon, tone };
}

/** True when this key is a PENDING, not-yet-lapsed key inside the soon-to-expire window. */
export function isExpiringSoon(
  expiresAt: string | null | undefined,
  status: string,
  now: number = Date.now(),
): boolean {
  const ind = getExpiryIndicator(expiresAt, status, now);
  return ind.kind === "active" && ind.soon;
}

/**
 * Sort comparator that orders PENDING keys with the nearest (soonest) expiry first.
 * Keys without an expiry, and non-PENDING keys, sort after all dated PENDING keys.
 * Stable for equal keys (returns 0); callers may chain a secondary sort.
 */
export function compareByExpiry(
  a: { expiresAt: string | null | undefined; status: string },
  b: { expiresAt: string | null | undefined; status: string },
): number {
  const av = expirySortValue(a);
  const bv = expirySortValue(b);
  return av - bv;
}

function expirySortValue(row: { expiresAt: string | null | undefined; status: string }): number {
  if (row.status !== "PENDING" || !row.expiresAt) return Number.POSITIVE_INFINITY;
  const t = new Date(row.expiresAt).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}
