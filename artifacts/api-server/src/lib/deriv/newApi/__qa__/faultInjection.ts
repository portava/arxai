// Fault-injection fixtures for the Deriv execution path.
//
// The owner's two invariants, which every scenario here exists to pin:
//
//   I1. ARX never claims a position EXISTS unless there is venue evidence it
//       exists.
//   I2. ARX never claims "NO TRADE" once an order may have reached the venue.
//
// They pull in opposite directions, and that tension is the whole design.
// Erring toward I1 alone invents clean failures that strand positions; erring
// toward I2 alone cries wolf about orders that never left. Each scenario must
// pin WHICH side the code lands on.
//
// Everything here is deterministic and offline. No network, no credentials,
// no order ever reaches a venue.

/** What an injected operation does when called. */
export type Reaction =
  | { kind: "reply"; body: Record<string, unknown> }
  | { kind: "throw"; error: Error }
  /** Reply, then drop the socket — the shape that stranded a real position. */
  | { kind: "reply-then-close"; body: Record<string, unknown> }
  /** Drop the socket without replying: the order may or may not have landed. */
  | { kind: "close-without-reply" }
  /** Never settle. Exercises the caller's own timeout, not the transport's. */
  | { kind: "hang" };

/** A reaction per call, so an operation can behave differently on retry. */
export type Script = Reaction | Reaction[];

export interface InjectionPlan {
  [operation: string]: Script;
}

export interface InjectionLog {
  /** Operations in the order they were sent. */
  sent: string[];
  /** Full payloads, so a test can assert what was on the wire. */
  payloads: Record<string, unknown>[];
  reconnects: number;
  closed: boolean;
  /** Orphan replies the test wants the transport to surface afterwards. */
  orphans: Array<{ reqId: number; op: string; body: Record<string, unknown>; derivErrorCode: string | null }>;
}

import { DerivNewApiError } from "../errors.js";

const reply = (body: Record<string, unknown>): Reaction => ({ kind: "reply", body });

/**
 * A transport that answers from a plan.
 *
 * Deliberately NOT a subclass of NewDerivTransport: it must be able to produce
 * shapes the real class would never construct, which is the entire point of
 * fault injection.
 */
export function injectedTransport(plan: InjectionPlan, log: InjectionLog) {
  const calls: Record<string, number> = {};
  let state: string = "WS_READY";

  const reactionFor = (op: string): Reaction | undefined => {
    const script = plan[op];
    if (script === undefined) return undefined;
    if (!Array.isArray(script)) return script;
    const n = calls[op] ?? 0;
    // Past the end of a script, the LAST reaction repeats — so a test only
    // has to spell out the calls whose behaviour actually differs.
    return script[Math.min(n, script.length - 1)];
  };

  return () => ({
    connect: async () => { state = "WS_READY"; },
    reconnect: async () => { log.reconnects += 1; state = "WS_READY"; },
    getState: () => state,
    getAccountId: () => "VRTC9001",
    close: () => { log.closed = true; },
    // Mirrors the real transport: drains the retained late replies so a
    // caller cannot resolve two requests from the same evidence.
    takeOrphanReplies: () => log.orphans.splice(0, log.orphans.length),
    send: async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const op = Object.keys(payload).find((k) => k !== "req_id" && k !== "subscribe") ?? "unknown";
      log.sent.push(op);
      log.payloads.push(payload);
      calls[op] = (calls[op] ?? 0) + 1;

      if (state !== "WS_READY") {
        throw Object.assign(new Error("transport not ready"), { name: "TransportClosed" });
      }
      const r = reactionFor(op);
      if (r === undefined) throw new Error(`no injection planned for ${op}`);

      switch (r.kind) {
        case "reply": return r.body;
        case "throw": throw r.error;
        case "reply-then-close": state = "DISCONNECTED"; return r.body;
        case "close-without-reply":
          state = "DISCONNECTED";
          // The caller cannot tell whether this reached the venue. That
          // ambiguity is exactly what I2 governs.
          //
          // TYPED, as the real transport's onClose does — it rejects in-flight
          // requests with WS_CONNECT_FAILED. A plain Error here made the
          // classification legitimately null and hid that UNRESOLVED steps
          // were dropping their error code.
          throw new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
            detail: "socket closed with the request in flight",
          });
        case "hang": return new Promise<Record<string, unknown>>(() => {});
      }
    },
  }) as never;
}

export const newLog = (): InjectionLog =>
  ({ sent: [], payloads: [], reconnects: 0, closed: false, orphans: [] });

// ── Venue-shaped building blocks ───────────────────────────────────────────
//
// Field names and optionality follow Deriv's published request/response
// schemas. Where a field is marked NOT required, omitting it is a legitimate
// venue reply and therefore a legitimate injection — not a malformed one.

export const V = {
  proposal: (over: Record<string, unknown> = {}) =>
    reply({ proposal: { id: "quote-1", ask_price: 1, spot: 617, ...over } }),

  /** A purchase. `contract_id` is the only thing that makes it one. */
  buy: (over: Record<string, unknown> = {}) =>
    reply({ buy: { contract_id: 555, buy_price: 1, transaction_id: 9, ...over } }),

  /**
   * A venue error, as the REAL transport delivers it.
   *
   * transport.ts turns an `error` frame correlated to our req_id into a
   * thrown DerivNewApiError — TRADING_REJECTED for buy/sell, REQUEST_REJECTED
   * otherwise. Injecting the raw frame as a REPLY was unfaithful: it made the
   * harness take the receiptless-response path instead of the catch, so the
   * suite never exercised what a real rejection does.
   */
  error: (code: string, op: "buy" | "sell" | "other" = "buy", details?: Record<string, unknown>): Reaction => ({
    kind: "throw",
    error: new DerivNewApiError(
      op === "buy" || op === "sell"
        ? "DERIV_NEW_API_TRADING_REJECTED"
        : "DERIV_NEW_API_REQUEST_REJECTED",
      {
        derivCode: code,
        detail: `op=${op}`
          + (details ? ` fields:[${Object.keys(details).join(",")}]` : ""),
      },
    ),
  }),

  /** The raw error FRAME, for testing the transport itself rather than the
   *  harness. Not what a harness-level injection should use. */
  errorFrame: (code: string, details?: Record<string, unknown>) =>
    reply({ error: { code, ...(details ? { details } : {}) } }),

  /** A sell receipt. The `sell` block itself is NOT required by the schema. */
  sell: (over: Record<string, unknown> = {}) =>
    reply({ sell: { contract_id: 555, sold_for: 1.25, transaction_id: 10, ...over } }),

  /** An open (unsettled) contract. Absence of settlement evidence is OPEN. */
  open: (over: Record<string, unknown> = {}) =>
    reply({ proposal_open_contract: { contract_id: 555, profit: 0, current_spot: 617.5, ...over } }),

  /** A settled contract, with the venue's own entry/exit. */
  /** Expired but NOT sold. Deriv can report this, and it is NOT settlement. */
  expiredUnsold: (over: Record<string, unknown> = {}) =>
    reply({
      proposal_open_contract: {
        contract_id: 555, is_sold: 0, is_expired: 1, is_settleable: 0,
        status: "open", profit: 0.25, ...over,
      },
    }),

  settled: (over: Record<string, unknown> = {}) =>
    reply({
      proposal_open_contract: {
        contract_id: 555, is_sold: 1, profit: 0.25,
        entry_spot: 617, exit_spot: 618, ...over,
      },
    }),

  pong: () => reply({ ping: "pong" }),
} as const;

/** The all-green plan. Tests override the one operation under test. */
export const HAPPY: InjectionPlan = {
  proposal: V.proposal(),
  buy: V.buy(),
  proposal_open_contract: V.settled(),
  sell: V.sell(),
  ping: V.pong(),
};
