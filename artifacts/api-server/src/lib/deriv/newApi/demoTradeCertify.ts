// Single-trade DEMO certification (spec Phase 15).
//
// THIS FILE PLACES A REAL ORDER AT A REAL VENUE. It is the only code in ARX
// that does so outside the 18-gate live path, and it is deliberately isolated
// from it: no DerivExecutionAdapter, no dispatch pipeline, no strategy input.
// If buy/sell semantics, contract tracking, or reconciliation are wrong, the
// blast radius is one explicit demo trade that a human asked for.
//
// SCOPE, and why it is two operations rather than one:
// A multiplier contract has NO expiry — MULTUP/MULTDOWN run until closed. So
// settlement cannot be reached by waiting; the position must be sold. This
// harness therefore performs exactly ONE buy and ONE sell, and the sell is
// bound to the contract id returned by that buy. Attaching a take-profit
// instead would leave a position open for an unbounded time, which is worse.
//
// REFUSALS, in the order they are checked:
//   1. not new-generation mode
//   2. no explicit human authorization token
//   3. account is real, or not provably demo
//   4. stake above the hard cap
//   5. a second order in the same process
//
// This module is NEVER imported by strategy, dispatch, or scheduler code. A
// test pins that.

import { type DerivNewApiConfig } from "./restClient.js";
import { fetchAccounts, selectDemoAccount, isDemoAccount, isRealAccount } from "./accounts.js";
import { NewDerivTransport, canSendTradingRequest } from "./transport.js";
import { DerivNewApiError, type DerivNewApiErrorCode } from "./errors.js";
import { type DerivOtpPhase } from "./otp.js";
import {
  mapProposalRequest, mapBuyRequest, mapSellRequest, mapOpenContractRequest,
  normalizeProposal, normalizePurchase, normalizeOpenContract,
} from "./wire.js";

/**
 * The exact string a human must supply to authorize an order. Deliberately
 * unmistakable: nobody types this by accident, and it cannot be produced by a
 * default, a truthy flag, or an empty env var.
 */
export const DEMO_TRADE_AUTHORIZATION = "PLACE-ONE-DEMO-ORDER";

/** Hard ceiling on stake, independent of any caller-supplied value. */
export const DEMO_TRADE_MAX_STAKE = 1;

/** One order per process. Module state, so a second call cannot reset it. */
export const MAX_ORDERS_PER_PROCESS = 1;
let ordersPlacedThisProcess = 0;

/** Test-only reset. Named so its presence in production code is obvious. */
export function __resetOrderLatchForTests(): void { ordersPlacedThisProcess = 0; }
export function ordersPlaced(): number { return ordersPlacedThisProcess; }

export class DemoTradeRefusal extends Error {}

export interface DemoTradeOptions {
  /** Must equal DEMO_TRADE_AUTHORIZATION. */
  authorization?: string;
  stake?: number;
  symbol?: string;
  currency?: string;
  multiplier?: number;
  accountId?: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  transportFactory?: (c: DerivNewApiConfig) => NewDerivTransport;
  /** Max wall-clock spent observing the open position before selling. */
  observeMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DemoTradeStep {
  step: string;
  status: "PASS" | "FAIL" | "UNRESOLVED";
  detail: string;
  errorCode?: DerivNewApiErrorCode | null;
}

export interface DemoTradeReport {
  steps: DemoTradeStep[];
  certified: boolean;
  /** Set the moment a buy is acknowledged, so an open position is always
   *  reported even if a later step throws. */
  contractId: number | null;
  /** True when a position was opened and NOT confirmed closed. Demands human
   *  attention: the harness will not silently leave this implicit. */
  positionLeftOpen: boolean;
  reconciliation: {
    buyPrice: number | null;
    sellProceeds: number | null;
    reportedProfit: number | null;
    derivedProfit: number | null;
    agrees: boolean | null;
  } | null;
}

/**
 * Gate every capital-committing payload for this harness.
 *
 * The read-only certification's allow-list REFUSES buy and sell outright; this
 * one permits exactly those two, and nothing else that commits capital. It is
 * a separate function on purpose — weakening the read-only gate to accommodate
 * trading would have removed the guarantee that certification cannot trade.
 */
export function assertSingleDemoOrder(payload: Record<string, unknown>): void {
  const forbidden = ["buy_contract_for_multiple_accounts", "cashier",
    "transfer_between_accounts", "topup_virtual", "sell_expired"];
  for (const k of forbidden) {
    if (k in payload) throw new DemoTradeRefusal(`refused a forbidden operation: ${k}`);
  }
  if ("buy" in payload) {
    if (ordersPlacedThisProcess >= MAX_ORDERS_PER_PROCESS) {
      throw new DemoTradeRefusal(
        `refused a second order: ${ordersPlacedThisProcess} already placed in this process`,
      );
    }
    const price = payload["price"];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new DemoTradeRefusal("refused a buy with no finite positive price ceiling");
    }
    if (price > DEMO_TRADE_MAX_STAKE) {
      throw new DemoTradeRefusal(
        `refused a buy priced ${price} above the ${DEMO_TRADE_MAX_STAKE} cap`,
      );
    }
  }
}

/** Count an order the moment it is SENT, not when it succeeds. An order whose
 *  reply is lost still reached the venue. */
export function recordOrderAttempt(): void { ordersPlacedThisProcess += 1; }

const ok = (step: string, detail: string): DemoTradeStep => ({ step, status: "PASS", detail });
const bad = (step: string, detail: string, code?: DerivNewApiErrorCode | null): DemoTradeStep =>
  ({ step, status: "FAIL", detail, errorCode: code ?? null });
const unresolved = (step: string, detail: string): DemoTradeStep =>
  ({ step, status: "UNRESOLVED", detail });

function describe(e: unknown): { detail: string; code: DerivNewApiErrorCode | null } {
  if (e instanceof DerivNewApiError) {
    return {
      detail: `${e.code}${e.derivCode ? ` deriv:${e.derivCode}` : ""}${e.detail ? ` — ${e.detail}` : ""}`,
      code: e.code,
    };
  }
  if (e instanceof DemoTradeRefusal) return { detail: e.message, code: null };
  return { detail: "non-protocol error (message withheld)", code: null };
}

/**
 * Place, observe, close and reconcile exactly one demo multiplier trade.
 *
 * Returns a report rather than throwing, because a thrown error after a buy
 * would lose the contract id — and an open position nobody knows about is the
 * worst outcome this harness can produce.
 */
export async function runDemoTradeCertification(
  config: DerivNewApiConfig,
  opts: DemoTradeOptions = {},
): Promise<DemoTradeReport> {
  const steps: DemoTradeStep[] = [];
  let contractId: number | null = null;
  let positionLeftOpen = false;
  let reconciliation: DemoTradeReport["reconciliation"] = null;
  const report = (): DemoTradeReport => ({
    steps, contractId, positionLeftOpen, reconciliation,
    certified: steps.length > 0 && steps.every((s) => s.status === "PASS"),
  });

  // 1 — explicit human authorization. Checked FIRST and compared to an exact
  // string: a truthy flag or a set-but-empty env var must not satisfy it.
  if (opts.authorization !== DEMO_TRADE_AUTHORIZATION) {
    steps.push(bad("authorization",
      "refused: this command places a real order and requires explicit authorization"));
    return report();
  }
  steps.push(ok("authorization", "explicit authorization supplied"));

  // 2 — stake cap, before anything is quoted.
  const stake = opts.stake ?? DEMO_TRADE_MAX_STAKE;
  if (!Number.isFinite(stake) || stake <= 0 || stake > DEMO_TRADE_MAX_STAKE) {
    steps.push(bad("stake_cap", `refused stake ${stake}; cap is ${DEMO_TRADE_MAX_STAKE}`));
    return report();
  }
  steps.push(ok("stake_cap", `stake ${stake} within the ${DEMO_TRADE_MAX_STAKE} cap`));

  // 3 — the account must be PROVABLY demo. Checked against the venue's own
  // account listing, not against configuration.
  let accounts;
  try {
    accounts = await fetchAccounts(config, opts.fetchImpl);
  } catch (e) {
    const { detail, code } = describe(e);
    steps.push(bad("account_discovery", detail, code));
    return report();
  }
  const selected = selectDemoAccount(accounts, opts.accountId ?? null);
  if (selected instanceof DerivNewApiError) {
    steps.push(bad("demo_account", selected.code, selected.code));
    return report();
  }
  const account = selected.account;
  // Both directions asserted: not real, AND positively demo. "Not real" alone
  // would accept an account whose type the venue did not report.
  if (isRealAccount(account) || !isDemoAccount(account)) {
    steps.push(bad("demo_account", "account is not provably demo — refusing to trade"));
    return report();
  }
  steps.push(ok("demo_account", `demo account confirmed (...${account.accountId.slice(-4)})`));

  const transport = opts.transportFactory
    ? opts.transportFactory(config)
    : new NewDerivTransport(config, undefined, opts.fetchImpl);

  try {
    const phases: DerivOtpPhase[] = [];
    try {
      await transport.connect(account.accountId, (p) => phases.push(p));
    } catch (e) {
      const { detail, code } = describe(e);
      steps.push(bad("connect", detail, code));
      return report();
    }
    if (!canSendTradingRequest(transport.getState())) {
      steps.push(bad("connect", `state ${transport.getState()} is not ready`));
      return report();
    }
    steps.push(ok("connect", "authenticated demo session ready"));

    const send = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      assertSingleDemoOrder(payload);
      if ("buy" in payload) recordOrderAttempt();
      return transport.send(payload);
    };

    // 4 — quote.
    const symbol = opts.symbol ?? "R_100";
    const currency = opts.currency ?? account.currency ?? "USD";
    const proposalReq = mapProposalRequest({
      symbol, contractType: "MULTUP", stake, currency,
      multiplier: opts.multiplier ?? 100,
    } as never);
    let quote;
    try {
      const res = await send(proposalReq as unknown as Record<string, unknown>);
      const q = normalizeProposal(res);
      if (q instanceof DerivNewApiError) {
        steps.push(bad("proposal", q.detail ?? q.code, q.code));
        return report();
      }
      quote = q;
    } catch (e) {
      const { detail, code } = describe(e);
      steps.push(bad("proposal", detail, code));
      return report();
    }
    steps.push(ok("proposal", `quote ${quote.proposalId.slice(0, 6)}… ask=${quote.askPrice ?? "unstated"}`));

    // 5 — THE ORDER. Price ceiling is the lower of the quoted ask and the cap,
    // so a requote between quote and buy cannot exceed what was authorized.
    const ceiling = Math.min(quote.askPrice ?? stake, DEMO_TRADE_MAX_STAKE);
    const buyReq = mapBuyRequest(quote.proposalId, ceiling);
    if (buyReq instanceof DerivNewApiError) {
      steps.push(bad("buy", buyReq.detail ?? buyReq.code, buyReq.code));
      return report();
    }
    let purchase;
    try {
      const res = await send(buyReq as unknown as Record<string, unknown>);
      const p = normalizePurchase(res);
      if (p instanceof DerivNewApiError) {
        // A reply we cannot read as a purchase is NOT a failure to buy — the
        // order may have reached the venue. This is the UNKNOWN state, and it
        // must never be reported as "no trade happened".
        steps.push(unresolved("buy",
          `${p.detail ?? p.code} — an order was SENT and its outcome is UNKNOWN; reconcile manually`));
        positionLeftOpen = true;
        return report();
      }
      purchase = p;
    } catch (e) {
      const { detail, code } = describe(e);
      // Same reasoning: the send already counted. Only a refusal BEFORE the
      // send can be called a clean no-trade.
      if (ordersPlacedThisProcess > 0) {
        steps.push(unresolved("buy", `${detail} — order was SENT; outcome UNKNOWN, reconcile manually`));
        positionLeftOpen = true;
      } else {
        steps.push(bad("buy", detail, code));
      }
      return report();
    }
    contractId = purchase.contractId;
    positionLeftOpen = true;   // true until a sell is CONFIRMED
    steps.push(ok("buy", `contract ${contractId} opened at ${purchase.buyPrice ?? "unstated"}`));

    // 6 — observe the open position.
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(Math.min(opts.observeMs ?? 3000, 30_000));
    let openState;
    try {
      const req = mapOpenContractRequest(contractId);
      if (req instanceof DerivNewApiError) throw req;
      const res = await send(req as unknown as Record<string, unknown>);
      const c = normalizeOpenContract(res);
      if (c instanceof DerivNewApiError) throw c;
      openState = c;
      steps.push(ok("observe",
        `settled=${c.isSettled} profit=${c.profit ?? "unstated"} spot=${c.currentSpot ?? "unstated"}`));
    } catch (e) {
      const { detail } = describe(e);
      steps.push(unresolved("observe", `${detail} — position ${contractId} is OPEN and unobserved`));
      return report();
    }

    // 7 — close. Bound to the contract this process bought; no other id is
    // reachable from here.
    const sellReq = mapSellRequest(contractId, 0);   // 0 = sell at market
    if (sellReq instanceof DerivNewApiError) {
      steps.push(unresolved("sell", `${sellReq.detail ?? sellReq.code} — position ${contractId} LEFT OPEN`));
      return report();
    }
    let proceeds: number | null = null;
    try {
      const res = await send(sellReq as unknown as Record<string, unknown>);
      const sold = (res as { sold?: unknown }).sold ?? (res as { sell?: unknown }).sell;
      const s = (typeof sold === "object" && sold !== null) ? sold as Record<string, unknown> : {};
      proceeds = typeof s["sold_for"] === "number" ? s["sold_for"]
        : typeof s["amount"] === "number" ? s["amount"] : null;
      steps.push(ok("sell", `contract ${contractId} closed for ${proceeds ?? "unstated"}`));
    } catch (e) {
      const { detail } = describe(e);
      steps.push(unresolved("sell", `${detail} — position ${contractId} is LEFT OPEN; close it manually`));
      return report();
    }

    // 8 — confirm closure from the venue, not from the sell reply.
    let confirmedClosed = false;
    try {
      const req = mapOpenContractRequest(contractId);
      if (req instanceof DerivNewApiError) throw req;
      const res = await send(req as unknown as Record<string, unknown>);
      const c = normalizeOpenContract(res);
      if (c instanceof DerivNewApiError) throw c;
      confirmedClosed = c.isSettled;
      openState = c;
    } catch { /* fall through to the honest UNRESOLVED below */ }

    if (!confirmedClosed) {
      steps.push(unresolved("confirm_closed",
        `contract ${contractId} not confirmed settled by the venue — verify manually`));
      return report();
    }
    positionLeftOpen = false;
    steps.push(ok("confirm_closed", `contract ${contractId} confirmed settled`));

    // 9 — reconcile. Deriv's reported profit must agree with proceeds minus
    // cost. A disagreement is a FAIL: this is the entire point of the run.
    const buyPrice = purchase.buyPrice;
    const derived = (proceeds !== null && buyPrice !== null) ? proceeds - buyPrice : null;
    const reported = openState.profit;
    const agrees = (derived !== null && reported !== null)
      ? Math.abs(derived - reported) < 0.01
      : null;
    reconciliation = { buyPrice, sellProceeds: proceeds, reportedProfit: reported, derivedProfit: derived, agrees };
    if (agrees === null) {
      steps.push(unresolved("reconcile",
        `cannot reconcile: buy=${buyPrice ?? "?"} proceeds=${proceeds ?? "?"} reported=${reported ?? "?"}`));
      return report();
    }
    if (!agrees) {
      steps.push(bad("reconcile",
        `P/L MISMATCH: derived ${derived} vs Deriv-reported ${reported}`));
      return report();
    }
    steps.push(ok("reconcile", `P/L agrees: ${reported} (proceeds ${proceeds} − cost ${buyPrice})`));
    return report();
  } finally {
    transport.close();
  }
}
