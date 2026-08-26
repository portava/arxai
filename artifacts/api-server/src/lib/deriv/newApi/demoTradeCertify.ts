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
// REFUSALS implemented HERE, in the order they are checked:
//   1. no explicit human authorization token
//   2. stake above the hard cap
//   3. account is real, or not provably demo
//   4. a second order in the same process
//   5. any money-movement operation
//
// A legacy-format App ID is refused earlier and elsewhere, by
// resolveNewApiConfig() in restClient.ts, which the CLI calls before reaching
// this module. An earlier version of this comment listed that as refusal #1 of
// this file, which was simply untrue of this file.
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
  normalizeProposal, normalizePurchase, normalizeOpenContract, normalizeSale, numeric,
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

/** Hard ceiling on the hold. A killed process cannot report an open position,
 *  so the window in which that can happen stays bounded. */
export const DEMO_TRADE_MAX_OBSERVE_MS = 300_000;
export const DEMO_TRADE_DEFAULT_OBSERVE_MS = 3_000;

/**
 * Ping interval during the hold.
 *
 * A 60s hold dropped the socket at EXACTLY 60s: the connection idles out when
 * nothing is sent, and the harness was sleeping silently. That stranded an
 * open position — the harness reported it correctly, but the position still
 * had to be closed by hand. The hold now keeps the socket alive.
 */
export const DEMO_TRADE_KEEPALIVE_MS = 15_000;
let ordersPlacedThisProcess = 0;

/** Test-only reset. Named so its presence in production code is obvious. */
export function __resetOrderLatchForTests(): void { ordersPlacedThisProcess = 0; }
export function ordersPlaced(): number { return ordersPlacedThisProcess; }

export class DemoTradeRefusal extends Error {}

/**
 * Did the VENUE adjudicate this request?
 *
 * The transport builds TRADING_REJECTED / REQUEST_REJECTED only from an
 * `error` frame correlated to our own req_id — meaning Deriv answered and
 * refused. That is evidence of non-creation, not an absence of evidence, so
 * it is a clean no-trade rather than an UNKNOWN.
 *
 * The distinction was previously unreachable: recordOrderAttempt() ran before
 * the send, so every buy failure took the "an order was sent" branch and a
 * proven refusal was indistinguishable from a dropped socket. Crying wolf on
 * refusals ARX can prove never became contracts is how operators learn to
 * ignore the alarm that matters.
 *
 * Deriv's buy_response requires all nine receipt fields including
 * `balance_after` — a balance that cannot exist for a purchase that never
 * completed — so a refusal can never masquerade as a conforming receipt.
 */
export function isAdjudicatedRejection(e: unknown): boolean {
  return e instanceof DerivNewApiError
    && (e.code === "DERIV_NEW_API_TRADING_REJECTED"
      || e.code === "DERIV_NEW_API_REQUEST_REJECTED");
}

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
  /** Wall-clock spent holding the position before selling. Bounded by
   *  DEMO_TRADE_MAX_OBSERVE_MS: a longer hold raises the chance that the spot
   *  moves enough to exercise reconciliation on a NON-ZERO P/L, but it also
   *  widens the window in which an interrupted process orphans an open
   *  position, which no in-process handler can report. */
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
    /**
     * How much this run actually PROVES about reconciliation.
     *
     * "zero-only" means the P/L was 0, so the comparison evaluated 0 === 0 and
     * a function that always agreed would produce identical output. The run is
     * still a valid lifecycle test; it is simply not evidence that ARX detects
     * a real disagreement. Grading this in the report keeps a weak result from
     * being read as a strong one.
     */
    evidence: "zero-only" | "non-zero";
    /** The venue's own entry/exit for the contract. Null when Deriv did not
     *  state them — never filled in from the quote or a streaming tick. */
    entrySpot: number | null;
    exitSpot: number | null;
    /** What the PROPOSAL quoted, before the order existed. Kept for
     *  comparison, never presented as the trade's entry. */
    quotedSpot: number | null;
    holdMs: number | null;
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
const unresolved = (step: string, detail: string, code?: DerivNewApiErrorCode | null): DemoTradeStep =>
  // The classification is retained. It used to be dropped on every UNRESOLVED
  // step, so the one state that most needs machine-readable triage carried
  // only prose.
  ({ step, status: "UNRESOLVED", detail, errorCode: code ?? null });

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
    // The QUOTE's spot. Explicitly NOT the trade's entry: the venue publishes
    // entry_spot for that, and attributing a pre-trade quote to the fill is
    // the thing unknownReconciler.ts already forbids on the MT5 path
    // ("never fabricated onto the command").
    const quotedSpot = quote.spotPrice;
    steps.push(ok("proposal",
      `quote ${quote.proposalId.slice(0, 6)}… ask=${quote.askPrice ?? "unstated"} quotedSpot=${quotedSpot ?? "unstated"}`));

    // 5 — THE ORDER.
    //
    // The quote must state a usable price BEFORE anything is sent. Three
    // failures used to slip through here:
    //   - ask_price absent: `?? stake` invented a ceiling out of ARX's own
    //     intent and the run certified GREEN against a quote that never
    //     stated a price;
    //   - ask_price unparseable: `numeric` returns null, collapsing into the
    //     same invented ceiling;
    //   - ask_price ABOVE the cap: Math.min silently clamped and sent a
    //     doomed order the venue was always going to refuse.
    // Refusing here costs nothing; the alternative spends a real order to
    // discover what the quote already said.
    if (quote.askPrice === null) {
      steps.push(bad("quote_validate",
        "venue quoted no readable ask price — there is no price to authorize"));
      return report();
    }
    if (quote.askPrice > DEMO_TRADE_MAX_STAKE) {
      steps.push(bad("quote_validate",
        `venue quoted ${quote.askPrice}, above the ${DEMO_TRADE_MAX_STAKE} cap — `
        + "refusing rather than clamping to a price the venue did not offer"));
      return report();
    }
    steps.push(ok("quote_validate",
      `ask ${quote.askPrice} is readable and within the ${DEMO_TRADE_MAX_STAKE} cap`));
    // Now a genuine ceiling: the venue's own ask, at or under the cap.
    const ceiling = quote.askPrice;
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
      if (isAdjudicatedRejection(e)) {
        // The venue answered our req_id and refused. No contract was created,
        // so there is nothing to warn about and positionLeftOpen stays false.
        steps.push(bad("buy", `${detail} — venue REFUSED the order; no contract was created`, code));
        return report();
      }
      if (ordersPlacedThisProcess > 0) {
        // The frame reached the wire and nothing adjudicated it. The order may
        // have executed; only the venue can settle that.
        steps.push(unresolved("buy",
          `${detail} — the buy frame WAS written to the socket; outcome UNKNOWN, reconcile manually`,
          code));
        positionLeftOpen = true;
      } else {
        // Refused before a byte left ARX. Non-transmission is provable, so
        // this is the one fault class that may claim a clean no-trade.
        steps.push(bad("buy", `${detail} — refused before the order reached the socket`, code));
      }
      return report();
    }
    contractId = purchase.contractId;
    positionLeftOpen = true;   // true until a sell is CONFIRMED
    steps.push(ok("buy", `contract ${contractId} opened at ${purchase.buyPrice ?? "unstated"}`));

    // 6 — observe the open position.
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const holdMs = Math.min(
      Math.max(opts.observeMs ?? DEMO_TRADE_DEFAULT_OBSERVE_MS, 0),
      DEMO_TRADE_MAX_OBSERVE_MS,
    );
    // Hold in KEEPALIVE-sized slices rather than one long sleep. `ping` is
    // read-only and cannot commit capital; the alternative is an idle socket
    // that Deriv closes underneath an open position.
    let held = 0;
    while (held < holdMs) {
      const slice = Math.min(DEMO_TRADE_KEEPALIVE_MS, holdMs - held);
      await sleep(slice);
      held += slice;
      if (held >= holdMs) break;
      try {
        await send({ ping: 1 });
      } catch {
        // A failed keepalive means the socket is gone. Stop holding and go
        // straight to closing — every extra second is a second the position
        // stays open.
        break;
      }
    }
    // A dropped socket must not strand the position. Reconnect (fresh OTP) and
    // continue to the close — abandoning an open trade because the transport
    // blinked is the worst outcome available here.
    if (!canSendTradingRequest(transport.getState())) {
      try {
        await transport.reconnect();
        steps.push(ok("reconnect", "socket dropped during the hold; reconnected to close the position"));
      } catch (e) {
        const { detail } = describe(e);
        steps.push(unresolved("reconnect",
          `${detail} — position ${contractId} is OPEN and the socket cannot be re-established`));
        return report();
      }
    }

    let openState;
    try {
      const req = mapOpenContractRequest(contractId);
      if (req instanceof DerivNewApiError) throw req;
      const res = await send(req as unknown as Record<string, unknown>);
      const c = normalizeOpenContract(res);
      if (c instanceof DerivNewApiError) throw c;
      // Identity assert. req_id correlation already pairs request to reply, but
      // this run is the thing PROVING contract tracking works, so it does not
      // lean on the mechanism under test. A reply about a different contract
      // must never be read as news about ours.
      if (c.contractId !== contractId) {
        throw new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
          detail: `venue replied about contract ${c.contractId}, not ${contractId}`,
        });
      }
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
      const sale = normalizeSale(res);
      if (sale instanceof DerivNewApiError) {
        // A reply with no receipt is NOT a close. This step used to report
        // PASS — "contract N closed" — on no evidence at all, and it is the
        // first line an operator reads. Deriv's sell_response marks the
        // receipt as not required, so a receiptless reply is legitimate and
        // must fall through to the venue re-read, which is the only thing
        // that can actually settle it.
        steps.push(unresolved("sell",
          `${sale.detail ?? sale.code} — verifying against the venue`));
      } else if (sale.contractId !== null && sale.contractId !== contractId) {
        steps.push(unresolved("sell",
          `receipt names contract ${sale.contractId}, not ${contractId} — verifying against the venue`));
      } else {
        proceeds = sale.proceeds;
        // "sell receipt", not "closed": closure is decided by the venue
        // re-read below, never by the sell reply.
        steps.push(ok("sell",
          `contract ${contractId} sell receipt: ${proceeds ?? "proceeds unstated"}`));
      }
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
      // Same assert on the closure check — a settled reply about ANY contract
      // must not clear the open-position alarm for OURS.
      if (c.contractId !== contractId) {
        throw new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
          detail: `closure reply named contract ${c.contractId}, not ${contractId}`,
        });
      }
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
    // Compared in whole CENTS. `Math.abs(a - b) < 0.01` is not float-safe: a
    // genuine one-cent discrepancy can land just under the threshold and
    // certify a real mismatch as agreement. Rounding both to integer cents
    // makes the comparison exact.
    const agrees = (derived !== null && reported !== null)
      ? Math.round(derived * 100) === Math.round(reported * 100)
      : null;
    // Grade the evidence, don't just record the verdict. A P/L of exactly 0
    // means the comparison only ever evaluated 0 === 0, which a reconciliation
    // that ALWAYS agreed would satisfy identically. Saying so in the report is
    // what stops a weak run being cited as a strong one.
    const evidence: "zero-only" | "non-zero" =
      (reported !== null && Math.round(reported * 100) !== 0) ? "non-zero" : "zero-only";
    reconciliation = {
      buyPrice, sellProceeds: proceeds, reportedProfit: reported,
      derivedProfit: derived, agrees, evidence,
      // The VENUE's own entry and exit. No `?? quotedSpot` and no
      // `?? currentSpot` fallback: a fallback here is exactly the guess this
      // fix removes, and UNRESOLVED is the honest answer when Deriv is silent.
      entrySpot: openState.entrySpot,
      exitSpot: openState.exitSpot,
      quotedSpot, holdMs,
    };
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
    steps.push(ok("reconcile",
      `P/L agrees: ${reported} (proceeds ${proceeds} − cost ${buyPrice})`
      + ` [evidence: ${evidence}]`));
    return report();
  } finally {
    transport.close();
  }
}
