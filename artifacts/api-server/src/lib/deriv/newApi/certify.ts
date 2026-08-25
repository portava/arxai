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

import {
  resolveNewApiConfig, describeConfig,
  type DerivNewApiConfig, type RestTiming,
} from "./restClient.js";
import { fetchAccounts, selectDemoAccount, isRealAccount } from "./accounts.js";
import { NewDerivTransport, canSendTradingRequest } from "./transport.js";
import { DerivNewApiError, type DerivNewApiErrorCode } from "./errors.js";
import { type DerivOtpPhase } from "./otp.js";
import { DERIV_OTP_VALIDITY_MS, DERIV_OTP_SAFE_AGE_MS } from "./otp.js";

/** Maximum tolerable clock disagreement with Deriv. Derived from the OTP
 *  freshness margin so the two cannot drift apart. */
export const MAX_CLOCK_SKEW_MS = DERIV_OTP_VALIDITY_MS - DERIV_OTP_SAFE_AGE_MS;
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

/** Envelope keys, legal on EVERY operation per Deriv's request schemas. */
export const ENVELOPE_KEYS = ["req_id", "passthrough", "subscribe"] as const;

/**
 * Parameters each operation permits, mirroring Deriv's per-operation request
 * schemas — every one of which is additionalProperties:false, so a single
 * surplus key is a hard reject.
 *
 * This replaces a single GLOBAL parameter list. That list could not express
 * per-operation legality, so `currency` and `contract_type` — legal on
 * proposal, illegal on contracts_for — passed the gate and reached the venue
 * as the live InputValidationFailed. I had previously widened the gate
 * believing it had wrongly refused a "perfectly legal" contracts_for carrying
 * currency; per Deriv's schema that payload was never legal. The gate was
 * right and the diagnosis was wrong.
 */
export const OPERATION_PARAMS: Record<string, readonly string[]> = {
  ping: [],
  time: [],
  // The symbol/detail level is the VALUE of the operation key, not a parameter.
  active_symbols: [],
  contracts_for: [],
  balance: [],
  portfolio: [],
  forget: [],
  forget_all: [],
  proposal: [
    "underlying_symbol", "contract_type", "amount", "basis",
    "currency", "multiplier", "limit_order",
  ],
};

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

  // Per-operation, not global: legality depends on WHICH operation is being
  // sent, and Deriv rejects any surplus key outright.
  const op = ops[0]!;
  const permitted = new Set<string>([
    ...ENVELOPE_KEYS,
    ...(OPERATION_PARAMS[op] ?? []),
  ]);
  const stray = keys.filter((k) => k !== op && !permitted.has(k));
  if (stray.length > 0) {
    throw new DerivCertificationRefusal(
      `read-only certification refused parameter(s) not permitted on ${op}: ${stray.join(",")}`,
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
    // ARX's OWN explanation. This is our text, not the venue's, so it is safe
    // — and it is usually the sentence that identifies the fault. Dropping it
    // turned a precise "no WebSocket URL in the OTP response" into a bare
    // PROTOCOL_ERROR and cost a full round trip.
    if (e.detail !== null) parts.push(`— ${e.detail}`);
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

  // 1 — configuration present, coherent, and actually the new generation.
  const d = describeConfig();
  if (d.mode !== "new") {
    steps.push(bad(1, "config", `mode is ${d.mode}; certification applies to the new generation only`));
    return report();
  }
  // GATE, not a label. This previously printed the App ID shape inside a
  // PASSING step: a legacy App ID in new mode certified step 1 green and then
  // failed at step 2 as an HTTP rejection, which reads like a credential
  // problem and sends the operator after the token. The incoherence is
  // detectable here, before a single request, so it is refused here.
  if (d.appIdShape === "numeric") {
    steps.push(bad(1, "config",
      "DERIV_APP_ID is NUMERIC — the legacy generation's format. Deriv rejects it "
      + "on the new API as \"Invalid application\". This is a CONFIGURATION error, "
      + "not a credential error: the token is not implicated.",
      "DERIV_NEW_API_INVALID_APP_ID"));
    return report();
  }
  const config = resolveNewApiConfig();
  if (typeof config === "string") {
    steps.push(bad(1, "config", config, config));
    return report();
  }
  // Presence and length only — never the value, never a prefix.
  steps.push(ok(1, "config",
    `mode=new appId=${d.appIdShape} pat=present(len ${d.patLength})`));

  let transport: NewDerivTransport | null = null;
  try {
    // 2 — REST reachability + credential acceptance.
    let accounts;
    let restTiming: RestTiming | null = null;
    try {
      accounts = await fetchAccounts(config, args.fetchImpl, (t) => { restTiming = t; });
    } catch (e) {
      const { detail, code } = describeErr(e);
      steps.push(bad(2, "rest_accounts", detail, code));
      return report();
    }
    const t = restTiming as RestTiming | null;
    steps.push(ok(2, "rest_accounts",
      `${accounts.length} account(s) visible`
      + (t ? ` (headers ${t.fetchMs}ms, body ${t.bodyMs}ms, total ${t.totalMs}ms)` : "")));

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

    // 5 — OTP + authenticated socket, reported as FIVE named substeps.
    // A single pass/fail here could not distinguish a rejected request from a
    // parse mismatch from a socket failure: the live run reported
    // PROTOCOL_ERROR with no indication of which. Each substep is emitted by
    // the REAL transport path, not a parallel copy of it.
    transport = args.transportFactory
      ? args.transportFactory(config)
      : new NewDerivTransport(config, undefined, args.fetchImpl);

    const phases: DerivOtpPhase[] = [];
    let connectErr: unknown = null;
    try {
      await transport.connect(accountId, (p) => phases.push(p));
    } catch (e) {
      connectErr = e;
    }
    for (const p of phases) {
      steps.push(p.ok
        ? ok(5, p.name, p.detail + (p.elapsedMs !== null ? ` (${p.elapsedMs}ms)` : ""))
        : bad(5, p.name, p.detail));
    }
    if (connectErr !== null) {
      const { detail, code } = describeErr(connectErr);
      // Only add a summary line if no substep already recorded the failure —
      // otherwise the precise substep is the better record.
      if (!phases.some((p) => !p.ok)) steps.push(bad(5, "otp_and_connect", detail, code));
      return report();
    }
    if (!canSendTradingRequest(transport.getState())) {
      steps.push(bad(5, "ws_ready", `state ${transport.getState()} is not ready`));
      return report();
    }
    if (phases.length === 0) {
      steps.push(ok(5, "ws_ready", "authenticated socket ready (no authorize sent)"));
    }

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
    // A BOUND, not a readout. Step 7 used to compute the skew and pass
    // regardless of magnitude, which certifies a clock that cannot support the
    // things depending on it. The bound is DERIVED from the OTP margin rather
    // than picked: an OTP is treated as stale at DERIV_OTP_SAFE_AGE_MS against
    // Deriv's DERIV_OTP_VALIDITY_MS, and skew larger than that margin can let a
    // ticket ARX believes is fresh already be expired at the venue. Deriving it
    // means the two cannot drift apart.
    if (skewSec * 1000 > MAX_CLOCK_SKEW_MS) {
      steps.push(bad(7, "time",
        `clock skew ${skewSec}s exceeds the ${MAX_CLOCK_SKEW_MS / 1000}s OTP freshness margin`));
      return report();
    }
    steps.push(ok(7, "time", `server clock reachable, skew ${skewSec}s (bound ${MAX_CLOCK_SKEW_MS / 1000}s)`));

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
    const cfReq = mapContractsForRequest(symbol);
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
