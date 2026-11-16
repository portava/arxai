// Deriv NEW API — account discovery and selection (spec Phase 1).
//
// SAFETY: selection is deterministic and fails CLOSED. A real-money account is
// never chosen implicitly and never used as a fallback — ambiguity produces an
// explicit refusal, because "pick something sensible" is exactly how an
// automated system ends up trading real capital during a certification run.
//
// The account identifier is whatever Deriv returns. It is NOT assumed to be a
// legacy VRTC-style login id; that assumption belongs to the old generation.

import { DerivNewApiError } from "./errors.js";
import { type RestTiming, derivRestRequest, type DerivNewApiConfig } from "./restClient.js";

export const DERIV_ACCOUNTS_PATH = "/trading/v1/options/accounts";

/** ARX's normalized view of one Deriv new-API account. */
export interface DerivNewApiAccount {
  accountId: string;
  /** "demo" | "real" as reported, lowercased; null when Deriv omitted it. */
  accountType: string | null;
  currency: string | null;
  status: string | null;
  /** Present only when Deriv supplied it — never defaulted to 0, which would
   *  read as a funded-but-empty account. */
  balance: number | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Normalize one raw account object.
 *
 * Returns null for an entry with no usable identifier: a row we cannot address
 * is not a row we can trade, and inventing an id would be worse than dropping
 * one. Deriv's exact field spelling is not fully pinned until certification, so
 * the id is accepted from the documented `account_id` or a camelCase variant.
 */
export function normalizeAccount(raw: unknown): DerivNewApiAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const accountId = str(r["account_id"]) ?? str(r["accountId"]) ?? str(r["id"]);
  if (accountId === null) return null;
  const typeRaw = str(r["account_type"]) ?? str(r["accountType"]) ?? str(r["type"]);
  const balanceRaw = r["balance"];
  return {
    accountId,
    accountType: typeRaw ? typeRaw.toLowerCase() : null,
    currency: str(r["currency"]),
    status: str(r["status"]),
    balance: typeof balanceRaw === "number" && Number.isFinite(balanceRaw) ? balanceRaw : null,
  };
}

/** PURE — is this account a DEMO account by explicit evidence? */
export function isDemoAccount(a: DerivNewApiAccount): boolean {
  // Strict: only an explicit demo marker qualifies. An unknown type is NOT
  // treated as demo, because the cost of that mistake is a real-money trade.
  return a.accountType === "demo" || a.accountType === "virtual";
}

/** PURE — is this account explicitly REAL? Used to refuse loudly. */
export function isRealAccount(a: DerivNewApiAccount): boolean {
  return a.accountType === "real" || a.accountType === "live";
}

export interface AccountSelection {
  account: DerivNewApiAccount;
  reason: "EXPLICIT_CONFIG" | "SOLE_ACTIVE_DEMO";
}

/**
 * Deterministic demo-account selection (spec Phase 1).
 *
 *   1. an explicitly configured account id, when it exists AND is demo;
 *   2. otherwise exactly ONE active demo account;
 *   3. otherwise refuse — ambiguous or absent, never a guess.
 *
 * A configured id that resolves to a REAL account is refused rather than
 * honoured: explicit configuration is not authority to trade real money.
 */
export function selectDemoAccount(
  accounts: readonly DerivNewApiAccount[],
  configuredAccountId?: string | null,
): AccountSelection | DerivNewApiError {
  const configured = (configuredAccountId ?? "").trim();
  if (configured.length > 0) {
    const match = accounts.find((a) => a.accountId === configured);
    if (!match) {
      return new DerivNewApiError("DERIV_NEW_API_NO_DEMO_ACCOUNT", {
        detail: "the configured account id was not returned by Deriv",
      });
    }
    if (!isDemoAccount(match)) {
      return new DerivNewApiError("DERIV_NEW_API_NO_DEMO_ACCOUNT", {
        detail: "the configured account is not a demo account",
      });
    }
    return { account: match, reason: "EXPLICIT_CONFIG" };
  }

  const demos = accounts.filter(isDemoAccount);
  // "active" is honoured when Deriv reports a status; an unreported status is
  // not treated as inactive, only as unknown.
  const active = demos.filter((a) => a.status === null || a.status.toLowerCase() === "active");

  if (active.length === 1) return { account: active[0]!, reason: "SOLE_ACTIVE_DEMO" };
  if (active.length === 0) {
    return new DerivNewApiError("DERIV_NEW_API_NO_DEMO_ACCOUNT", {
      detail: accounts.some(isRealAccount)
        ? "only real-money accounts were returned; a real account is never selected implicitly"
        : "no active demo account was returned",
    });
  }
  return new DerivNewApiError("DERIV_NEW_API_ACCOUNT_AMBIGUOUS", {
    detail: `${active.length} active demo accounts; set an explicit account id`,
  });
}

/** Fetch and normalize the accounts the PAT can address. */
export async function fetchAccounts(
  config: DerivNewApiConfig,
  fetchImpl?: typeof fetch,
  onTiming?: (t: RestTiming) => void,
): Promise<DerivNewApiAccount[]> {
  const res = await derivRestRequest<unknown>({
    method: "GET", path: DERIV_ACCOUNTS_PATH, config, fetchImpl, onTiming,
  });
  const body = res.body as { accounts?: unknown; data?: unknown };
  const rawList = Array.isArray(body?.accounts) ? body.accounts
    : Array.isArray(body?.data) ? body.data
      : Array.isArray(body) ? body
        : null;
  if (rawList === null) {
    throw new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "accounts response contained no recognizable account array",
    });
  }
  // Malformed entries are skipped, not fatal — one unusable row must not hide
  // the rest of the book.
  return rawList.map(normalizeAccount).filter((a): a is DerivNewApiAccount => a !== null);
}
