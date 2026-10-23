// P0-2 — the account currency a user's P/L is denominated in.
//
// Realized P/L on a symbol is denominated in that symbol's PROFIT currency
// (the quote half for an FX pair). Booking it into the ledger requires
// converting to the account currency; see `resolveQuoteToAccountFx` in
// `lib/mt5/contractSize.ts`.
//
// `user_slot_allocation.accountCurrency` is the authority and is NOT NULL with
// a "USD" default, so this read is total. Read-only.

import { eq } from "drizzle-orm";
import { db, userSlotAllocationTable } from "@workspace/db";

export const DEFAULT_ACCOUNT_CURRENCY = "USD" as const;

/**
 * The ISO-4217 currency the user's allocation (and therefore their ledger) is
 * denominated in. Falls back to USD when the user has no allocation row —
 * which is the same default the column itself carries, not a guess about
 * market data.
 */
export async function getAccountCurrency(userId: number): Promise<string> {
  const rows = await db
    .select({ accountCurrency: userSlotAllocationTable.accountCurrency })
    .from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId))
    .limit(1);
  const c = rows[0]?.accountCurrency?.trim().toUpperCase();
  return c && c.length === 3 ? c : DEFAULT_ACCOUNT_CURRENCY;
}
