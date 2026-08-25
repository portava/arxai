// Deriv NEW API read-only certification (spec Phase 14).
//
// Promotes the transport from "written against the published schema" to
// "observed against the venue". Nothing here commits capital.
//
// READ-ONLY IS ENFORCED, NOT PROMISED. Every payload passes assertReadOnly()
// before it can reach the socket. A reviewer should not have to read the whole
// sequence to be sure no trade is placed — one function decides it, and a
// source pin plus a unit test hold it in place.
//
// A `proposal` IS included: it is a price quote and commits nothing. `buy` is
// what commits, and `buy` cannot pass the allow-list.

import { resolveNewApiConfig, describeConfig, type DerivNewApiConfig } from "./restClient.js";
import { fetchAccounts, selectDemoAccount, isRealAccount } from "./accounts.js";
import { NewDerivTransport, canSendTradingRequest } from "./transport.js";
import { DerivNewApiError, type DerivNewApiErrorCode } from "./errors.js";
import {
  mapActiveSymbolsRequest, mapContractsForRequest, mapProposalRequest,
  mapBalanceRequest, mapPortfolioRequest, normalizeProposal, normalizeBalance,
  normalizePortfolio,
} from "./wire.js";

/** Message keys that commit capital or move money. Never sendable here. */
export const CAPITAL_COMMITTING_KEYS = [
  "buy", "sell", "buy_contract_for_multiple_accounts",
  "sell_expired", "cashier", "transfer_between_accounts", "topup_virtual",
] as const;

/** Operations this certification may invoke. An allow-list, so an operation
 *  Deriv adds after this file was written is denied by default. */
export const READ_ONLY_KEYS = [
  "ping", "time", "active_symbols", "contracts_for", "proposal",
  "balance", "portfolio", "forget", "forget_all",
] as const;

/** Non-operation keys: request parameters and envelope fields. A Deriv payload
 *  carries these ALONGSIDE the operation, so they cannot be treated as
 *  operations — the first version of this gate did, and refused a perfectly
 *  legal `contracts_for` for carrying `currency`. */
export const PERMITTED_PARAM_KEYS = [
  "req_id", "subscribe",
  "underlying_symbol", "contract_type", "amount", "basis", "currency",
  "multiplier", "limit_order", "contract_id", "product_type",
] as const;

export class DerivCertificationRefusal extends Error {}

/**
 * Gate every outbound payload. Throws rather than returning a verdict: a
 * caller that forgets to check a boolean would send the payload anyway.
 *
 * Three independent refusals, in order of severity:
 *   1. any capital-committing key ANYWHERE in the payload — even beside a
 *      legal operation, which is how one would be smuggled through;
 *   2. not exactly one recognised operation — zero means an unknown op,
 *      two means an ambiguous payload; neither is certifiable;
 *   3. any parameter outside the permitted set.
 */
export function assertReadOnly(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload);

  for (const key of CAPITAL_COMMITTING_KEYS) {
    if (key in payload) {
      throw new DerivCertificationRefusal(
        `read-only certification refused a capital-committing operation: ${key}`,
      );
    }
  }

  const ops = keys.filter((k) => (READ_ONLY_KEYS as readonly string[]).includes(k));
  if (ops.length === 0) {
    throw new DerivCertificationRefusal(
      `read-only certification refused a payload with no permitted operation: ${keys.join(",")}`,
    );
  }
  if (ops.length > 1) {
    throw new DerivCertificationRefusal(
      `read-only certification refused an ambiguous payload naming ${ops.length} operations: ${ops.join(",")}`,
    );
  }

  const stray = keys.filter((k) =>
    !ops.includes(k) && !(PERMITTED_PARAM_KEYS as readonly string[]).includes(k));
  if (stray.length > 0) {
    throw new DerivCertificationRefusal(
      `read-only certification refused unrecognised parameter(s): ${stray.join(",")}`,
    );
  }
}

export interface CertificationStep {
  step: number;
  name: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  /** Sanitized. Never a token, OTP URL, header, or environment dump. */
  detail: string;
  errorCode?: DerivNewApiErrorCode | null;
}

export interface CertificationReport {
  mode: string;
  accountId: string | null;
  steps: CertificationStep[];
  passed: boolean;
  /** Set when the run stopped early. A partial run is NOT a pass. */
  haltedAt: number | null;
}

const ok = (step: number, name: string, detail: string): CertificationStep =>
  ({ step, name, status: "PASS", detail });
const bad = (step: number, name: string, detail: string, code?: DerivNewApiErrorCode | null): CertificationStep =>
  ({ step, name, status: "FAIL", detail, errorCode: code ?? null });

function describeErr(e: unknown): { detail: string; code: DerivNewApiErrorCode | null } {
  if (e instanceof DerivNewApiError) {
    // Surface Deriv's OWN enum-like code and the HTTP status, not just ARX's
    // classification. Both are safe — an enum and a number, never prose —
    // and without them a 401 is undiagnosable without guessing. The previous
    // InvalidToken incident took several cycles for exactly this reason, and
    // the first version of this function reproduced the hole in new code.
    const parts: string[] = [e.code];
    if (e.httpStatus !== null) parts.push(`http ${e.httpStatus}`);
    parts.push(e.derivCode !== null ? `deriv:${e.derivCode}` : "deriv:<no code in body>");
    return { detail: parts.join(" "), code: e.code };
  }
  if (e instanceof DerivCertificationRefusal) return { detail: e.message, code: null };
  // Deliberately NOT the message: an arbitrary thrown value can carry request
  // context, and request context here contains the Authorization header.
  return { detail: "non-protocol error (message withheld)", code: null };
}

/**
 * Run the read-only sequence.
 *
 * Halts on the first failure. A later step's result is not meaningful once an
 * earlier one failed, and reporting greens after a red invites reading a
 * broken run as a working one.
 */
export async function runReadOnlyCertification(args: {
  transportFactory?: (c: DerivNewApiConfig) => NewDerivTransport;
  fetchImpl?: typeof fetch;
  /** Quote symbol. Default is a synthetic index — ARX's actual market. */
  symbol?: string;
  currency?: string;
  /** Explicit demo account id. A REAL id here is refused, not honoured. */
  accountId?: string | null;
}= {}): Promise<CertificationReport> {
  const steps: CertificationStep[] = [];
  const report = (): CertificationReport => ({
    mode: describeConfig().mode,
    accountId: accountId,
    steps,
    passed: steps.length > 0 && steps.every((s) => s.status === "PASS"),
    haltedAt: steps.find((s) => s.status === "FAIL")?.step ?? null,
  });
  let accountId: string | null = null;

  // 1 — configuration present and actually the new generation.
  const config = resolveNewApiConfig();
  if (typeof config === "string") {
    steps.push(bad(1, "config", config, config));
    return report();
  }
  const d = describeConfig();
  if (d.mode !== "new") {
    steps.push(bad(1, "config", `mode is ${d.mode}; certification applies to the new generation only`));
    return report();
  }
  // Presence and length only — never the value, never a prefix.
  steps.push(ok(1, "config", `mode=new appId=present pat=present(len ${d.patLength})`));

  let transport: NewDerivTransport | null = null;
  try {
    // 2 — REST reachability + credential acceptance.
    let accounts;
    try {
      accounts = await fetchAccounts(config, args.fetchImpl);
    } catch (e) {
      const { detail, code } = describeErr(e);
      steps.push(bad(2, "rest_accounts", detail, code));
      return report();
    }
    steps.push(ok(2, "rest_accounts", `${accounts.length} account(s) visible`));

    // 3 — deterministic demo selection. Fail-closed on ambiguity.
    // The config object deliberately holds ONLY the credential pair, so the
    // optional explicit account id is read separately. Passing null here means
    // selectDemoAccount must find a sole active demo or refuse.
    const configuredId = args.accountId ?? process.env["DERIV_DEMO_ACCOUNT_ID"] ?? null;
    const selected = selectDemoAccount(accounts, configuredId);
    if (selected instanceof DerivNewApiError) {
      steps.push(bad(3, "select_demo", selected.code, selected.code));
      return report();
    }
    const chosen = selected.account;
    accountId = chosen.accountId;
    // Only a 4-char suffix, enough to correlate two runs, not enough to be an
    // account identifier on its own.
    steps.push(ok(3, "select_demo", `selected demo via ${selected.reason} (...${accountId.slice(-4)})`));

    // 4 — independent re-check that the selection is not real. selectDemoAccount
    // already refuses real accounts; this asserts it again at the last moment
    // before a session is opened, because that is the irreversible step.
    if (isRealAccount(chosen)) {
      steps.push(bad(4, "assert_demo", "selected account is REAL — refusing to open a session"));
      return report();
    }
    steps.push(ok(4, "assert_demo", "account is demo/virtual"));

    // 5 — OTP + authenticated socket. The OTP URL is never logged or returned.
    transport = args.transportFactory
      ? args.transportFactory(config)
      : new NewDerivTransport(config, undefined, args.fetchImpl);
    try {
      await transport.connect(accountId);
    } catch (e) {
      const { detail, code } = describeErr(e);
      steps.push(bad(5, "otp_and_connect", detail, code));
      return report();
    }
    if (!canSendTradingRequest(transport.getState())) {
      steps.push(bad(5, "otp_and_connect", `state ${transport.getState()} is not ready`));
      return report();
    }
    steps.push(ok(5, "otp_and_connect", "authenticated socket ready (no authorize sent)"));

    const send = async (
      step: number, name: string, payload: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null> => {
      try {
        assertReadOnly(payload);          // gate BEFORE the socket, always
        const res = await transport!.send(payload);
        return res;
      } catch (e) {
        const { detail, code } = describeErr(e);
        steps.push(bad(step, name, detail, code));
        return null;
      }
    };

    // 6 — liveness.
    if (!await send(6, "ping", { ping: 1 })) return report();
    steps.push(ok(6, "ping", "socket answered"));

    // 7 — server clock. Clock skew silently corrupts signal-age gating.
    const timeRes = await send(7, "time", { time: 1 });
    if (!timeRes) return report();
    const serverTime = typeof timeRes["time"] === "number" ? timeRes["time"] : null;
    if (serverTime === null) {
      steps.push(bad(7, "time", "no server time in response"));
      return report();
    }
    const skewSec = Math.abs(Math.floor(Date.now() / 1000) - serverTime);
    steps.push(ok(7, "time", `server clock reachable, skew ${skewSec}s`));

    // 8 — tradable universe.
    const symbolsRes = await send(8, "active_symbols", mapActiveSymbolsRequest());
    if (!symbolsRes) return report();
    const list = symbolsRes["active_symbols"];
    const count = Array.isArray(list) ? list.length : 0;
    if (count === 0) {
      steps.push(bad(8, "active_symbols", "empty symbol universe"));
      return report();
    }
    steps.push(ok(8, "active_symbols", `${count} symbol(s)`));

    // 9 — THE DISCREPANCY CHECK. These endpoints are published under
    // /trading/v1/options/ while ARX trades MULTIPLIERS. Deriv documents the
    // surface as covering options, multipliers, accumulators and derived
    // indices, so `options` is most likely an umbrella product name — but that
    // is an assumption, and this is the step that settles it with evidence
    // instead. If multipliers are absent here, the transport is real but
    // unusable for ARX's actual strategy, and that must be a loud FAIL.
    const symbol = args.symbol ?? "R_100";
    const currency = args.currency ?? "USD";
    const cfReq = mapContractsForRequest(symbol, currency);
    if (cfReq instanceof DerivNewApiError) {
      steps.push(bad(9, "contracts_for", cfReq.code, cfReq.code));
      return report();
    }
    const cfRes = await send(9, "contracts_for", cfReq as unknown as Record<string, unknown>);
    if (!cfRes) return report();
    const available = (cfRes["contracts_for"] as { available?: unknown } | undefined)?.available;
    const types = Array.isArray(available)
      ? available.map((c) => (c as { contract_type?: unknown })?.contract_type).filter((t): t is string => typeof t === "string")
      : [];
    const hasMultipliers = types.includes("MULTUP") || types.includes("MULTDOWN");
    if (!hasMultipliers) {
      steps.push(bad(9, "contracts_for",
        `${symbol} exposes no MULTUP/MULTDOWN on this surface — the new API endpoints may not serve multipliers`));
      return report();
    }
    steps.push(ok(9, "contracts_for", `${symbol} offers multipliers (${types.length} contract type(s))`));

    // 10 — a quote. Read-only: this commits nothing and is never followed by
    // a buy in this command.
    const proposalReq = mapProposalRequest({
      symbol, contractType: "MULTUP", stake: 1, currency, multiplier: 100,
    } as never);
    const propRes = await send(10, "proposal", proposalReq as unknown as Record<string, unknown>);
    if (!propRes) return report();
    const quote = normalizeProposal(propRes);
    if (quote instanceof DerivNewApiError) {
      steps.push(bad(10, "proposal", quote.code, quote.code));
      return report();
    }
    // The id proves the quote is buyable — WITHOUT buying it. That is exactly
    // the evidence certification needs and the furthest it may go.
    steps.push(ok(10, "proposal", `quote received, buyable id present, ask=${quote.askPrice ?? "unstated"}`));

    // 11 — authenticated read: balance.
    const balRes = await send(11, "balance", mapBalanceRequest());
    if (!balRes) return report();
    const bal = normalizeBalance(balRes);
    if (bal instanceof DerivNewApiError) {
      steps.push(bad(11, "balance", bal.code, bal.code));
      return report();
    }
    // Currency and reachability only. The figure is a demo balance, but there
    // is no reason for certification output to carry an account balance.
    steps.push(ok(11, "balance", `readable, currency=${bal.currency ?? "unstated"}`));

    // 12 — authenticated read: portfolio. Proves reconciliation has a source.
    const portRes = await send(12, "portfolio", mapPortfolioRequest());
    if (!portRes) return report();
    const port = normalizePortfolio(portRes);
    if (port instanceof DerivNewApiError) {
      steps.push(bad(12, "portfolio", port.code, port.code));
      return report();
    }
    steps.push(ok(12, "portfolio",
      `${port.contracts.length} open contract(s), ${port.skipped} unparseable row(s)`));

    // 13 — the read-only gate itself still refuses a buy at the end of a live
    // session. Asserted in-run so the certification cannot pass on a build
    // where the gate was weakened.
    let refused = false;
    try { assertReadOnly({ buy: "x", price: 1 }); } catch { refused = true; }
    if (!refused) {
      steps.push(bad(13, "readonly_gate", "gate did NOT refuse a buy — certification is void"));
      return report();
    }
    steps.push(ok(13, "readonly_gate", "buy refused by the allow-list"));

    return report();
  } finally {
    transport?.close();
  }
}
