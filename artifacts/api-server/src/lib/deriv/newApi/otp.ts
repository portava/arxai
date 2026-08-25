// Deriv NEW API — OTP issuance (spec Phase 2).
//
// The OTP endpoint returns a ready-to-use authenticated WebSocket URL with the
// OTP embedded in it. That makes the URL itself a CREDENTIAL:
//   * it is never logged,
//   * it is never returned in an error message,
//   * it is never reused after a connection attempt,
//   * it is requested immediately before connecting, because validity is only
//     about 120 seconds.
//
// The returned URL is AUTHORITATIVE. This module never manufactures a socket
// URL from assumptions about the account id — inventing one is how the last
// generation's compatibility shim produced a permanently failing route.

import { DerivNewApiError } from "./errors.js";
import { derivRestRequest, type DerivNewApiConfig } from "./restClient.js";

/** Documented OTP lifetime. Used to decide staleness BEFORE dialling. */
export const DERIV_OTP_VALIDITY_MS = 120_000;

/** Refuse to reuse an OTP older than this. Deliberately under the documented
 *  validity so a request in flight cannot straddle the expiry boundary. */
export const DERIV_OTP_SAFE_AGE_MS = 90_000;

export function otpPath(accountId: string): string {
  return `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
}

/** A single-use authenticated socket URL plus the instant it was issued. */
export interface DerivOtpTicket {
  /** CREDENTIAL — contains the OTP. Never log, never serialize. */
  readonly wsUrl: string;
  readonly issuedAtMs: number;
  /** Set once the ticket has been dialled, so it can never be dialled twice. */
  consumed: boolean;
}

/** PURE — may this ticket still be used to open a socket? */
export function isTicketUsable(ticket: DerivOtpTicket, nowMs: number): boolean {
  if (ticket.consumed) return false;
  const age = nowMs - ticket.issuedAtMs;
  if (!Number.isFinite(age) || age < 0) return false;
  return age < DERIV_OTP_SAFE_AGE_MS;
}

/**
 * PURE — extract the socket URL from an OTP response.
 *
 * Refuses anything that is not an authenticated Deriv WS URL. A response
 * missing the URL is a protocol error, NOT an auth failure: the PAT was
 * accepted to get this far.
 */
export function parseOtpResponse(raw: unknown): string | DerivNewApiError {
  if (typeof raw !== "object" || raw === null) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "OTP response was not an object",
    });
  }
  const r = raw as Record<string, unknown>;
  const candidate = [r["ws_url"], r["wsUrl"], r["url"], r["websocket_url"]]
    .find((v): v is string => typeof v === "string" && v.length > 0);
  if (!candidate) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "OTP response contained no WebSocket URL",
    });
  }
  if (!candidate.startsWith("wss://")) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "OTP WebSocket URL was not wss://",
    });
  }
  // A REAL-account socket must never be dialled by the certification path.
  // Checked here because this is the last point the destination is visible
  // before it becomes an opaque credential.
  if (/\/ws\/real(\b|\?)/.test(candidate)) {
    return new DerivNewApiError("DERIV_NEW_API_NO_DEMO_ACCOUNT", {
      detail: "OTP resolved to a REAL-account socket; refusing",
    });
  }
  return candidate;
}

/** Request a fresh OTP ticket for one account. */
export async function requestOtpTicket(args: {
  accountId: string;
  config: DerivNewApiConfig;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DerivOtpTicket> {
  let res;
  try {
    res = await derivRestRequest<unknown>({
      method: "POST",
      path: otpPath(args.accountId),
      config: args.config,
      fetchImpl: args.fetchImpl,
    });
  } catch (e) {
    if (e instanceof DerivNewApiError) {
      // Re-classify transport-level failures of THIS call as OTP failures so a
      // caller can tell "could not get an OTP" from "could not authenticate".
      if (e.code === "DERIV_NEW_API_UNAUTHORIZED" || e.code === "DERIV_NEW_API_INSUFFICIENT_SCOPE") throw e;
      throw new DerivNewApiError("DERIV_NEW_API_OTP_FAILED", {
        derivCode: e.derivCode, httpStatus: e.httpStatus,
      });
    }
    throw e;
  }
  const parsed = parseOtpResponse(res.body);
  if (parsed instanceof DerivNewApiError) throw parsed;
  return { wsUrl: parsed, issuedAtMs: args.nowMs ?? Date.now(), consumed: false };
}

/** Redact an OTP URL for diagnostics: scheme + host + path, never the query. */
export function describeOtpUrlForLog(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    // The OTP lives in the query string; dropping it is the entire point.
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<unparseable-ws-url>";
  }
}
