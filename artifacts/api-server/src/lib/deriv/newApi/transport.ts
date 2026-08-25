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

const defaultSocketFactory: DerivSocketFactory = (url) => {
  const ws = new WebSocket(url, { handshakeTimeout: DERIV_WS_CONNECT_TIMEOUT_MS });
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    on: (event, cb) => { ws.on(event, cb as (...a: unknown[]) => void); },
  };
};

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
  private lastError: DerivNewApiError | null = null;

  constructor(
    private readonly config: DerivNewApiConfig,
    private readonly socketFactory: DerivSocketFactory = defaultSocketFactory,
    private readonly fetchImpl?: typeof fetch,
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
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED"));
      });
      sock.on("close", () => this.onClose());
    });
  }

  private onMessage(raw: unknown): void {
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
    if (!p) return;
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
        { derivCode: code, detail: `op=${p.op}${fields}` },
      ));
      return;
    }
    p.resolve(msg);
  }

  /** Terminal disconnect: every in-flight request is rejected, never left to
   *  hang. A caller that never hears back cannot reconcile. */
  private onClose(): void {
    this.socket = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
        detail: "socket closed with the request in flight",
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
      });
    }
    const sock = this.socket;
    if (!sock) {
      throw new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", { detail: "no socket" });
    }
    this.reqId += 1;
    const id = this.reqId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DerivNewApiError("DERIV_NEW_API_REQUEST_TIMEOUT", {
          detail: `no reply within ${DERIV_WS_REQUEST_TIMEOUT_MS}ms`,
        }));
      }, DERIV_WS_REQUEST_TIMEOUT_MS);
      // The operation name is retained so a rejection can be classified by
      // what was ASKED, not lumped under trading.
      const op = Object.keys(payload).find((k) => k !== "req_id" && k !== "subscribe") ?? "unknown";
      this.pending.set(id, { resolve, reject, timer, op });
      try {
        sock.send(JSON.stringify({ ...payload, req_id: id }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", { detail: "send failed" }));
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
