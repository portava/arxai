/**
 * Pure classification for the REGISTRATION_KEY_PEPPER pre-flight.
 *
 * Separated from the CLI (preflightRegistrationKeyPepper.ts) so it can be unit
 * tested against fixtures WITHOUT a database, and so the counting rule an owner
 * bets a rotation on is one readable function rather than five SQL predicates.
 *
 * Reads no secret and touches no hash column. The only facts it needs are
 * status, whether the row is an ARX-format key, and its expiry.
 */

/**
 * What a pepper CHANGE does to one beta_invites row.
 *
 *  AT_RISK        ARX key, redeemable right now. A pepper change makes it
 *                 PERMANENTLY unredeemable — there is no re-hash path, because
 *                 the raw key is displayed once at mint and only
 *                 sha256(normalizedKey + pepper) is stored. This is the number
 *                 that decides whether a rotation is safe.
 *  EXPIRED        ARX key past its expiry, or already swept to EXPIRED.
 *                 Unredeemable already; a pepper change costs nothing.
 *  PAUSED         ARX key PAUSED. Not redeemable today either way — validation
 *                 refuses with INVITE_NOT_PENDING before any hash is compared.
 *  SETTLED        ARX key ACCEPTED or REVOKED. Matched by row id, never
 *                 re-hashed. Completely unaffected by any pepper change.
 *  LEGACY_PENDING Pre-shield invite (no key_prefix), still redeemable. Its hash
 *                 is sha256(rawCode) with NO pepper, so a pepper CHANGE does
 *                 not break it — but an ABSENT pepper blocks it anyway, because
 *                 validateInviteForRegistration fail-closes globally on
 *                 PEPPER_MISSING before it looks at the code format at all.
 *  LEGACY_SETTLED Pre-shield invite in a terminal, paused or expired state.
 */
export type PepperChangeCategory =
  | "AT_RISK" | "EXPIRED" | "PAUSED" | "SETTLED"
  | "LEGACY_PENDING" | "LEGACY_SETTLED";

export interface InviteFacts {
  status: string;
  /** True when beta_invites.key_prefix is non-null — an ARX-format, peppered
   *  key rather than a pre-shield invite. */
  isArxKey: boolean;
  expiresAt: Date | null;
}

export function classifyInviteForPepperChange(row: InviteFacts, now: Date): PepperChangeCategory {
  const lapsed = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
  if (!row.isArxKey) {
    return row.status === "PENDING" && !lapsed ? "LEGACY_PENDING" : "LEGACY_SETTLED";
  }
  if (row.status === "PAUSED") return "PAUSED";
  if (row.status === "EXPIRED") return "EXPIRED";
  if (row.status === "PENDING") return lapsed ? "EXPIRED" : "AT_RISK";
  // ACCEPTED | REVOKED — and any status this code has not heard of, which must
  // NOT silently land in AT_RISK and inflate the number that gates the press.
  return "SETTLED";
}

export type Tally = Record<PepperChangeCategory, number>;

export function emptyTally(): Tally {
  return {
    AT_RISK: 0, EXPIRED: 0, PAUSED: 0, SETTLED: 0,
    LEGACY_PENDING: 0, LEGACY_SETTLED: 0,
  };
}

export function tallyInvites(rows: readonly InviteFacts[], now: Date): Tally {
  const t = emptyTally();
  for (const r of rows) t[classifyInviteForPepperChange(r, now)] += 1;
  return t;
}

export const PEPPER_CHANGE_CATEGORY_ORDER: readonly PepperChangeCategory[] = [
  "AT_RISK", "EXPIRED", "PAUSED", "SETTLED", "LEGACY_PENDING", "LEGACY_SETTLED",
] as const;

export const PEPPER_CHANGE_CATEGORY_NOTES: Record<PepperChangeCategory, string> = {
  AT_RISK: "PENDING + unexpired ARX keys. A pepper change makes these PERMANENTLY unredeemable.",
  EXPIRED: "already unredeemable; a pepper change costs nothing here.",
  PAUSED: "not redeemable today (INVITE_NOT_PENDING) regardless of the pepper.",
  SETTLED: "ACCEPTED/REVOKED — matched by row id, never re-hashed. Unaffected.",
  LEGACY_PENDING: "un-peppered hash: a pepper CHANGE does not break these, but an ABSENT pepper blocks them.",
  LEGACY_SETTLED: "pre-shield invites in a terminal, paused or expired state. Unaffected.",
};
