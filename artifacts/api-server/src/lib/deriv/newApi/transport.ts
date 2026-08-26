// Deriv NEW API — authenticated transport (spec Phases 3, 4, 9).
//
// HARD BOUNDARY. This module never imports the legacy client, never builds a
// legacy URL, never sends `authorize`, and never uses app_id 1089. The
// authenticated socket URL comes from the OTP endpoint and is dialled as-is:
// the session itself establishes the account context, so there is no
// post-connect authentication step at all.
//
// LIFECYCLE (Phase 9): no trading request may leave ARX before WS_READY, and a
// reconnect always obtains a FRESH OTP — an old OTP URL is single-use and
// re-dialling it is both a protocol error and a silent-failure trap.

import { WebSocket } from "ws";
import { DerivNewApiError } from "./errors.js";
import { type DerivNewApiConfig } from "./restClient.js";
import { type DerivOtpPhase } from "./otp.js";
import {
  requestOtpTicket, isTicketUsable, describeOtpUrlForLog, type DerivOtpTicket,
} from "./otp.js";
import { logger } from "../../logger.js";

/** Official unauthenticated market-data endpoint (Phase 4). */
export const DERIV_PUBLIC_WS_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

export const DERIV_WS_CONNECT_TIMEOUT_MS = 15_000;
export const DERIV_WS_REQUEST_TIMEOUT_MS = 20_000;
/** Bounded OTP retry (Phase 9). Small on purpose: an OTP that keeps failing is
 *  a condition to surface, not to hammer. */
export const DERIV_OTP_MAX_ATTEMPTS = 3;

/** How many issued req_ids stay attributable. Bounds memory on a long-lived
 *  transport while comfortably covering any in-flight window. */
export const DERIV_ISSUED_OP_HISTORY = 256;

export type DerivTransportState =
  | "DISCONNECTED"
  | "REST_AUTHENTICATING"
  | "ACCOUNT_RESOLVED"
  | "OTP_REQUESTING"
  | "WS_CONNECTING"
  | "WS_READY"
  | "RECONNECTING"
  | "FAILED";

/** PURE — may a trading request be sent in this state? Phase 9 permits exactly
 *  one state, and this is the single place that judgement lives. */
export function canSendTradingRequest(state: DerivTransportState): boolean {
  return state === "WS_READY";
}

/** Minimal socket surface, so tests can inject a fake without a network. */
export interface DerivSocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", cb: (arg?: unknown) => void): void;
}

export type DerivSocketFactory = (url: string) => DerivSocket;

/**
 * Raw WS frame observer, for evidence capture ONLY.
 *
 * Opt-in via the constructor and unset in every production construction, so
 * this cannot become an ambient logging vector. The observer receives frames
 * VERBATIM; redacting them is the observer's job, because only the caller
 * knows which credentials are in scope. WS frames carry no PAT (it rides the
 * REST Authorization header) and no OTP (it rides the socket URL query), but
 * the recorder redacts regardless — a guarantee that depends on where a secret
 * happens to live is not a guarantee.
 */
export type DerivFrameObserver = (
  direction: "out" | "in",
  raw: string,
  meta: { reqId: number | null; op: string | null; atMs: number },
) => void;

const defaultSocketFactory: DerivSocketFactory = (url) => {
  const ws = new WebSocket(url, { handshakeTimeout: DERIV_WS_CONNECT_TIMEOUT_MS });
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    on: (event, cb) => { ws.on(event, cb as (...a: unknown[]) => void); },
  };
};

/**
 * A venue reply that arrived for a request ARX had already given up on.
 *
 * It is AUTHORITATIVE: it carries our own req_id, which is never reused. A
 * late buy receipt is evidence a position EXISTS, and discarding it turns a
 * recoverable UNKNOWN into a position nobody can find.
 */
export interface OrphanReply {
  reqId: number;
  /** The operation ARX issued under this id — not one read off the reply. */
  op: string;
  /** The reply body, unmodified. */
  body: Record<string, unknown>;
  /** Present when the reply is a venue error rather than a receipt. */
  derivErrorCode: string | null;
}

interface Pending {
  /** Which operation this request asked for. */
  op?: string;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The new-generation Deriv transport.
 *
 * Deliberately NOT a drop-in for the legacy client: it exposes `send()` over an
 * already-authenticated session rather than a connect-then-authorize flow.
 */
export class NewDerivTransport {
  private state: DerivTransportState = "DISCONNECTED";
  private socket: DerivSocket | null = null;
  private ticket: DerivOtpTicket | null = null;
  private accountId: string | null = null;
  private reqId = 0;
  private readonly pending = new Map<number, Pending>();
  /**
   * req_id -> operation, retained AFTER the request settles.
   *
   * This is what makes a late reply attributable. reqId is per-instance and
   * MONOTONIC ACROSS RECONNECT (verified by experiment: 2 -> 3 over a
   * reconnect, no reset), so an id is never reused within a transport and a
   * reply bearing one we issued is provably ours. Without this map a late
   * reply cannot be told apart from a reply for an id we never issued, and
   * the second must never be adopted.
   */
  private readonly issuedOps = new Map<number, string>();
  private readonly orphans: OrphanReply[] = [];
  private lastError: DerivNewApiError | null = null;

  constructor(
    private readonly config: DerivNewApiConfig,
    private readonly socketFactory: DerivSocketFactory = defaultSocketFactory,
    private readonly fetchImpl?: typeof fetch,
    /** Evidence capture only. Never set in production construction. */
    private readonly onFrame?: DerivFrameObserver,
  ) {}

  getState(): DerivTransportState { return this.state; }
  getLastError(): DerivNewApiError | null { return this.lastError; }
  /** Safe: the account id, never the OTP or the PAT. */
  getAccountId(): string | null { return this.accountId; }

  private setState(next: DerivTransportState): void {
    this.state = next;
    logger.info({ derivTransportState: next }, "deriv_new_transport_state");
  }

  private fail(err: DerivNewApiError): DerivNewApiError {
    this.lastError = err;
    this.setState("FAILED");
    // Code only — never the OTP URL, never the PAT.
    logger.warn({ derivErrorCode: err.code, derivCode: err.derivCode }, "deriv_new_transport_failed");
    return err;
  }

  /**
   * Open an authenticated session for one account.
   *
   * A fresh OTP is requested immediately before each dial attempt; a stale or
   * consumed ticket is discarded rather than retried, because an OTP is
   * single-use and re-dialling one fails in a way that looks like an auth
   * problem.
   */
  async connect(accountId: string, onPhase?: (p: DerivOtpPhase) => void): Promise<void> {
    const emit = onPhase ?? (() => {});
    this.accountId = accountId;
    this.setState("OTP_REQUESTING");

    let lastErr: DerivNewApiError | null = null;
    for (let attempt = 1; attempt <= DERIV_OTP_MAX_ATTEMPTS; attempt += 1) {
      let ticket: DerivOtpTicket;
      try {
        ticket = await requestOtpTicket({
          accountId, config: this.config, fetchImpl: this.fetchImpl,
          onPhase: emit,
        });
      } catch (e) {
        lastErr = e instanceof DerivNewApiError
          ? e
          : new DerivNewApiError("DERIV_NEW_API_OTP_FAILED");
        // A credential or scope failure will not improve on retry.
        if (lastErr.code === "DERIV_NEW_API_UNAUTHORIZED"
          || lastErr.code === "DERIV_NEW_API_INSUFFICIENT_SCOPE") throw this.fail(lastErr);
        continue;
      }

      if (!isTicketUsable(ticket, Date.now())) {
        lastErr = new DerivNewApiError("DERIV_NEW_API_OTP_EXPIRED", {
          detail: "ticket aged out before it could be dialled",
        });
        continue;
      }

      this.ticket = ticket;
      const dialStart = Date.now();
      try {
        await this.dial(ticket);
        emit({
          name: "ws_connect", ok: true, elapsedMs: Date.now() - dialStart,
          // Host + path only; the query carrying the OTP is dropped.
          detail: `socket open to ${describeOtpUrlForLog(ticket.wsUrl)}`,
        });
        this.setState("WS_READY");
        emit({
          name: "ws_ready", ok: true, elapsedMs: null,
          detail: "authenticated session ready (no authorize sent)",
        });
        return;
      } catch (e) {
        emit({
          name: "ws_connect", ok: false, elapsedMs: Date.now() - dialStart,
          detail: e instanceof DerivNewApiError
            ? `${e.code}${e.detail ? ` — ${e.detail}` : ""}`
            : "socket dial failed",
        });
        // Mark consumed regardless: a dialled OTP is spent even on failure.
        ticket.consumed = true;
        this.ticket = null;
        lastErr = e instanceof DerivNewApiError
          ? e
          : new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED");
        logger.warn(
          { attempt, derivErrorCode: lastErr.code, endpoint: describeOtpUrlForLog(ticket.wsUrl) },
          "deriv_new_transport_dial_failed",
        );
      }
    }
    throw this.fail(lastErr ?? new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED"));
  }

  private dial(ticket: DerivOtpTicket): Promise<void> {
    this.setState("WS_CONNECTING");
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
          detail: `no open within ${DERIV_WS_CONNECT_TIMEOUT_MS}ms`,
        }));
      }, DERIV_WS_CONNECT_TIMEOUT_MS);

      const sock = this.socketFactory(ticket.wsUrl);
      this.socket = sock;

      sock.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // NOTE: there is deliberately NO authorize message here. The OTP
        // established the account context; sending one would be the legacy
        // flow leaking into the new generation.
        resolve();
      });
      sock.on("message", (raw) => this.onMessage(raw));
      sock.on("error", () => {
        if (!settled) {
          // Pre-open: the dial itself failed.
          settled = true;
          clearTimeout(timer);
          reject(new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED"));
          return;
        }
        // POST-OPEN. This used to return immediately, leaving the transport
        // reporting WS_READY over a broken socket — so canSendTradingRequest()
        // stayed true and a BUY could be dispatched into it. Measured: a
        // request issued after a post-open error sat pending with the state
        // still WS_READY. Claiming readiness ARX cannot substantiate is the
        // connection-level form of being falsely certain.
        logger.warn({}, "deriv_new_transport_post_open_socket_error");
        this.onClose();
      });
      sock.on("close", () => this.onClose());
    });
  }

  private onMessage(raw: unknown): void {
    // Recorded BEFORE parsing: a frame ARX cannot parse is exactly the kind of
    // evidence this observer exists to capture, and parsing first would drop it.
    if (this.onFrame) {
      const text = String(raw);
      let peekId: number | null = null;
      try {
        const v = (JSON.parse(text) as { req_id?: unknown })?.req_id;
        if (typeof v === "number") peekId = v;
      } catch { /* unparseable — that IS the observation */ }
      this.onFrame("in", text, {
        reqId: peekId,
        op: peekId === null ? null : this.issuedOps.get(peekId) ?? null,
        atMs: Date.now(),
      });
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      logger.warn({ derivErrorCode: "DERIV_NEW_API_PROTOCOL_ERROR" }, "deriv_new_transport_unparseable_message");
      return;
    }
    const id = msg["req_id"];
    if (typeof id !== "number") return;
    const p = this.pending.get(id);
    if (!p) {
      // The request is no longer pending — it timed out, or the socket closed
      // and rejected it. The reply is still the venue's answer to a question
      // ARX asked, and it used to be dropped here with no log and no ledger.
      this.retainOrphan(id, msg);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(id);
    const err = msg["error"] as { code?: unknown; details?: unknown } | undefined;
    if (err && typeof err === "object") {
      const code = typeof err.code === "string" ? err.code : null;
      // A validation failure usually names the offending FIELDS in `details`.
      // Those key names are structural and safe; their values are not
      // reported. Without this an InputValidationFailed says only that
      // something in the payload was wrong, not which part.
      const detailKeys = (typeof err.details === "object" && err.details !== null)
        ? Object.keys(err.details as Record<string, unknown>) : [];
      const fields = detailKeys.length ? ` fields:[${detailKeys.join(",")}]` : "";
      // Only an actual trade can be TRADING_REJECTED. A read-only query that
      // Deriv refuses is a rejected REQUEST — reporting it as a rejected trade
      // says a trade was attempted, which would be false.
      const isTrade = p.op === "buy" || p.op === "sell";
      p.reject(new DerivNewApiError(
        isTrade ? "DERIV_NEW_API_TRADING_REJECTED" : "DERIV_NEW_API_REQUEST_REJECTED",
        {
          derivCode: code, detail: `op=${p.op}${fields}`,
          // A venue REPLY is the strongest possible proof the frame reached
          // the venue — it could not have answered otherwise. This was left
          // unset, so the first live capture recorded every genuine rejection
          // as "wireWritten: unstated". Not a safety fault (a rejection is
          // adjudicated before transmission is consulted, and null is treated
          // as written anyway) but it understated a certainty ARX actually had.
          wireWritten: true,
        },
      ));
      return;
    }
    p.resolve(msg);
  }

  /**
   * Keep a late reply IF it is provably ours.
   *
   * An id ARX never issued is discarded and logged, never adopted: adopting it
   * would mean inventing an outcome from a message whose ownership cannot be
   * established, which is exactly the fabrication these invariants forbid.
   */
  private retainOrphan(id: number, msg: Record<string, unknown>): void {
    const op = this.issuedOps.get(id);
    if (op === undefined) {
      logger.warn({ reqId: id }, "deriv_new_transport_reply_for_unissued_req_id");
      return;
    }
    const err = msg["error"] as { code?: unknown } | undefined;
    const derivErrorCode = (err && typeof err === "object" && typeof err.code === "string")
      ? err.code : null;
    this.orphans.push({ reqId: id, op, body: msg, derivErrorCode });
    logger.warn(
      { reqId: id, op, derivErrorCode, orphanCount: this.orphans.length },
      "deriv_new_transport_late_reply_retained",
    );
  }

  /**
   * Late replies retained since the last call, oldest first.
   *
   * Draining is deliberate: a caller that resolves an UNKNOWN from one of
   * these has consumed the evidence, and leaving it queued would let a second
   * caller resolve a different request from the same reply.
   */
  takeOrphanReplies(): OrphanReply[] {
    return this.orphans.splice(0, this.orphans.length);
  }

  /** Terminal disconnect: every in-flight request is rejected, never left to
   *  hang. A caller that never hears back cannot reconcile. */
  private onClose(): void {
    this.socket = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
        detail: "socket closed with the request in flight",
        // In flight means it was written.
        wireWritten: true,
      }));
    }
    this.pending.clear();
    if (this.state === "WS_READY") this.setState("DISCONNECTED");
  }

  /**
   * Send one correlated request over the authenticated session.
   *
   * Refuses outside WS_READY (Phase 9): a request sent while connecting would
   * either be dropped or race the handshake.
   */
  async send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!canSendTradingRequest(this.state)) {
      throw new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
        detail: `transport is ${this.state}, not WS_READY`,
        // Nothing was written. Provable non-transmission.
        wireWritten: false,
      });
    }
    const sock = this.socket;
    if (!sock) {
      throw new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
        detail: "no socket", wireWritten: false,
      });
    }
    this.reqId += 1;
    const id = this.reqId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DerivNewApiError("DERIV_NEW_API_REQUEST_TIMEOUT", {
          detail: `no reply within ${DERIV_WS_REQUEST_TIMEOUT_MS}ms`,
          // The frame WAS written; silence is not evidence of non-execution.
          wireWritten: true,
        }));
      }, DERIV_WS_REQUEST_TIMEOUT_MS);
      // The operation name is retained so a rejection can be classified by
      // what was ASKED, not lumped under trading.
      const op = Object.keys(payload).find((k) => k !== "req_id" && k !== "subscribe") ?? "unknown";
      this.pending.set(id, { resolve, reject, timer, op });
      // Retained beyond the request's lifetime so a late reply can be
      // attributed. Bounded so a long-lived transport cannot grow unbounded.
      this.issuedOps.set(id, op);
      if (this.issuedOps.size > DERIV_ISSUED_OP_HISTORY) {
        const oldest = this.issuedOps.keys().next().value;
        if (oldest !== undefined) this.issuedOps.delete(oldest);
      }
      try {
        const frame = JSON.stringify({ ...payload, req_id: id });
        sock.send(frame);
        // Recorded AFTER the write returns. An exception above means the frame
        // did NOT go out, and it must not appear in evidence as though it did.
        this.onFrame?.("out", frame, { reqId: id, op, atMs: Date.now() });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        // sock.send() threw: the write did not complete.
        reject(new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
          detail: "send failed", wireWritten: false,
        }));
      }
    });
  }

  /** Reconnect ALWAYS re-issues an OTP. The previous ticket is discarded. */
  async reconnect(): Promise<void> {
    this.setState("RECONNECTING");
    this.ticket = null;
    this.close();
    if (!this.accountId) {
      throw this.fail(new DerivNewApiError("DERIV_NEW_API_NO_DEMO_ACCOUNT", {
        detail: "no account resolved to reconnect to",
      }));
    }
    await this.connect(this.accountId);
  }

  close(): void {
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      try { sock.close(); } catch { /* already gone */ }
    }
    this.onClose();
  }
}
