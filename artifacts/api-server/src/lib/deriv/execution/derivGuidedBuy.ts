// Phase 6 — the guided buy, over the CERTIFIED Phase 5 primitives.
//
// Composes the same transport, mappers and normalizers the Phase 5 demo-trade
// certification uses. It does not re-implement the protocol and it does not
// re-derive any of Phase 5's judgements — that would be a fifth Deriv path in a
// codebase that has already been bitten three times by parallel implementations
// of things newApi/ had certified.
//
// Its only job is to translate the certified outcome into the four facts the
// DerivExecutionAdapter needs:
//
//     replied · wireWritten · contractId · venueRejection
//
// THE ONE JUDGEMENT THAT MATTERS. `wireWritten === false` is the ONLY thing
// that proves non-transmission, and only the transport can assert it. Everything
// else — a throw, an unreadable reply, a timeout — leaves open that a frame
// reached the venue, and the adapter turns that into INDETERMINATE. Getting
// this backwards frees an exposure reservation for an order that may be open,
// which is the single most expensive mistake available here.

import { NewDerivTransport, canSendTradingRequest } from "../newApi/transport.js";
import { resolveNewApiConfig } from "../newApi/restClient.js";
import { mapProposalRequest, mapBuyRequest, normalizeProposal, normalizePurchase } from "../newApi/wire.js";
import { DerivNewApiError } from "../newApi/errors.js";
import { isAdjudicatedRejection } from "../newApi/demoTradeCertify.js";
import type { DerivMultiplierContractIntent } from "@workspace/domain/deriv-contracts";

export interface GuidedBuyOutcome {
  replied: boolean;
  wireWritten: boolean;
  contractId: string | null;
  venueRejection: string | null;
  detail: string;
}

export interface GuidedBuyArgs {
  accountId: string;
  symbol: string;
  currency: string;
  /** BUY -> MULTUP, SELL -> MULTDOWN. Direction comes from the SIDE. */
  side: "BUY" | "SELL";
  stake: number;
  multiplier: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Absolute ceiling on what may be spent, independent of the venue's quote. */
  maxStake: number;
}

/**
 * Read a Deriv error into the adapter's vocabulary.
 *
 * `wireWritten` defaults to TRUE for anything that is not explicitly false: an
 * error that does not say whether it transmitted has not proved it did not.
 * Defaulting the other way would be conservative-looking and wrong.
 */
function fromError(e: unknown, phase: string): GuidedBuyOutcome {
  const err = e instanceof DerivNewApiError ? e : null;
  const provablyNotSent = err?.wireWritten === false;
  const detail = err
    ? `${phase}: ${err.code}${err.detail ? ` — ${err.detail}` : ""}`
    : `${phase}: ${e instanceof Error ? e.message : String(e)}`;

  // A venue that ANSWERED our req_id and refused proves both transmission and
  // that no contract exists. That is the one failure we may report as definite.
  if (isAdjudicatedRejection(e)) {
    return { replied: true, wireWritten: true, contractId: null, venueRejection: detail, detail };
  }
  return {
    replied: false,
    wireWritten: !provablyNotSent,
    contractId: null,
    venueRejection: null,
    detail,
  };
}

/**
 * Place one guided multiplier buy.
 *
 * Sequence mirrors the certified harness: connect, propose, validate the quote
 * against BOTH the venue's ask and our own ceiling, then buy at that ask.
 *
 * The quote is validated rather than trusted. Buying at a price the venue
 * quoted above our ceiling would spend more than authorized; clamping to our
 * ceiling would buy at a price the venue never offered. Neither is acceptable,
 * so an over-ceiling quote REFUSES — before anything is written.
 */
export async function guidedBuy(args: GuidedBuyArgs): Promise<GuidedBuyOutcome> {
  const config = resolveNewApiConfig();
  if (typeof config === "string") {
    // Config unresolvable. Nothing was constructed, let alone sent.
    return {
      replied: false, wireWritten: false, contractId: null, venueRejection: null,
      detail: `config: ${config}`,
    };
  }
  const transport = new NewDerivTransport(config);
  try {
    // ── connect ───────────────────────────────────────────────────────────
    try {
      await transport.connect(args.accountId);
    } catch (e) {
      // Nothing was sent: the socket never became ready.
      const o = fromError(e, "connect");
      return { ...o, wireWritten: false };
    }
    if (!canSendTradingRequest(transport.getState())) {
      return {
        replied: false, wireWritten: false, contractId: null, venueRejection: null,
        detail: `connect: transport is ${transport.getState()}, not ready to trade`,
      };
    }

    // ── proposal ──────────────────────────────────────────────────────────
    const intent: DerivMultiplierContractIntent = {
      kind: "DERIV_MULTIPLIER_CONTRACT",
      // Direction from the SIDE. An earlier draft branched on `stake >= 0` with
      // MULTUP on both sides — a ternary that compiled, read as deliberate, and
      // would have silently turned every SELL into a long position.
      contractType: args.side === "SELL" ? "MULTDOWN" : "MULTUP",
      symbol: args.symbol,
      currency: args.currency,
      stake: args.stake,
      multiplier: args.multiplier,
      ...(args.stopLoss !== undefined ? { stopLoss: args.stopLoss } : {}),
      ...(args.takeProfit !== undefined ? { takeProfit: args.takeProfit } : {}),
    };
    const proposalReq = mapProposalRequest(intent);
    if (proposalReq instanceof DerivNewApiError) {
      return {
        replied: false, wireWritten: false, contractId: null, venueRejection: null,
        detail: `proposal_map: ${proposalReq.code}${proposalReq.detail ? ` — ${proposalReq.detail}` : ""}`,
      };
    }

    let quote;
    try {
      const res = await transport.send(proposalReq as unknown as Record<string, unknown>);
      const p = normalizeProposal(res);
      if (p instanceof DerivNewApiError) {
        // A proposal we cannot read is not an order — nothing was bought.
        return {
          replied: true, wireWritten: true, contractId: null, venueRejection: null,
          detail: `proposal_read: ${p.code}${p.detail ? ` — ${p.detail}` : ""}`,
        };
      }
      quote = p;
    } catch (e) {
      return fromError(e, "proposal");
    }

    // ── validate the quote before spending ────────────────────────────────
    // `askPrice` is nullable, and null is exactly the case that must refuse:
    // Number.isFinite(null) is false but does not narrow the type, so the null
    // check is explicit. An absent ask is not a cheap ask.
    if (quote.askPrice === null || !Number.isFinite(quote.askPrice)) {
      return {
        replied: true, wireWritten: true, contractId: null, venueRejection: null,
        detail: "quote_validate: venue ask is unreadable — refusing rather than guessing a price",
      };
    }
    if (quote.askPrice > args.maxStake) {
      // Refuse, do not clamp. Clamping buys at a price the venue never offered.
      return {
        replied: true, wireWritten: true, contractId: null, venueRejection: null,
        detail: `quote_validate: venue quoted ${quote.askPrice}, above the ${args.maxStake} ceiling — refused, nothing bought`,
      };
    }

    // ── buy at the venue's own ask ────────────────────────────────────────
    const buyReq = mapBuyRequest(quote.proposalId, quote.askPrice);
    if (buyReq instanceof DerivNewApiError) {
      return {
        replied: false, wireWritten: false, contractId: null, venueRejection: null,
        detail: `buy_map: ${buyReq.code}${buyReq.detail ? ` — ${buyReq.detail}` : ""}`,
      };
    }

    try {
      const res = await transport.send(buyReq as unknown as Record<string, unknown>);
      const purchase = normalizePurchase(res);
      if (purchase instanceof DerivNewApiError) {
        // Replied, but unreadable as a purchase. The order MAY exist. This is
        // the UNKNOWN case and must never be reported as "no trade".
        return {
          replied: true, wireWritten: true, contractId: null, venueRejection: null,
          detail: `buy_read: ${purchase.code} — an order was SENT and its outcome is UNKNOWN`,
        };
      }
      return {
        replied: true, wireWritten: true,
        contractId: String(purchase.contractId),
        venueRejection: null,
        detail: `bought contract ${purchase.contractId}`,
      };
    } catch (e) {
      return fromError(e, "buy");
    }
  } finally {
    // Always close. A leaked socket holds the process open and, worse, keeps a
    // session alive that nothing is reading replies from.
    try { transport.close(); } catch { /* closing must never mask the outcome */ }
  }
}
