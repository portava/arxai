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
  // Deriv NESTS the socket URL: { data: { url: "wss://…?otp=…" } }. The first
  // implementation searched only the top level and reported a bare
  // PROTOCOL_ERROR against a perfectly valid response. Both shapes are
  // accepted because the published schema documents the nesting only through
  // a code example, so pinning exclusively to it would be its own guess.
  const nested = (typeof r["data"] === "object" && r["data"] !== null)
    ? r["data"] as Record<string, unknown>
    : {};
  const candidate = [
    nested["url"], nested["ws_url"], nested["wsUrl"], nested["websocket_url"],
    r["ws_url"], r["wsUrl"], r["url"], r["websocket_url"],
  ].find((v): v is string => typeof v === "string" && v.length > 0);

  if (!candidate) {
    // Report the STRUCTURE that arrived — key names only, never values. A
    // value here would be the OTP itself. Without this the next schema change
    // is another blind investigation.
    const seen = Object.keys(r);
    const seenNested = Object.keys(nested);
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "OTP response contained no WebSocket URL"
        + ` (top-level keys: ${seen.join(",") || "none"}`
        + `${seenNested.length ? `; data keys: ${seenNested.join(",")}` : ""})`,
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

/**
 * One observable stage of the OTP + socket handshake.
 *
 * Reports STRUCTURE and TIMING only: status, durations, content-type, key
 * names, and whether a URL field was present. Never the OTP, never the URL's
 * query string, never a credential.
 */
export interface DerivOtpPhase {
  name: "otp_request" | "otp_response_parse" | "ws_url_validate" | "ws_connect" | "ws_ready";
  ok: boolean;
  detail: string;
  elapsedMs: number | null;
}

export async function requestOtpTicket(args: {
  accountId: string;
  config: DerivNewApiConfig;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  onPhase?: (p: DerivOtpPhase) => void;
}): Promise<DerivOtpTicket> {
  const emit = args.onPhase ?? (() => {});
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
      emit({
        name: "otp_request", ok: false, elapsedMs: e.elapsedMs,
        detail: `http ${e.httpStatus ?? "-"} ${e.code}`
          + (e.derivCode ? ` deriv:${e.derivCode}` : "")
          + (e.detail ? ` — ${e.detail}` : ""),
      });
      // A credential verdict is preserved as-is: re-labelling it OTP_FAILED
      // would send an operator to the OTP endpoint for a token problem.
      if (e.code === "DERIV_NEW_API_UNAUTHORIZED" || e.code === "DERIV_NEW_API_INSUFFICIENT_SCOPE") throw e;
      // Otherwise classify as an OTP failure but PRESERVE the original code,
      // Deriv's code and the status rather than collapsing them.
      throw new DerivNewApiError("DERIV_NEW_API_OTP_FAILED", {
        derivCode: e.derivCode, httpStatus: e.httpStatus,
        elapsedMs: e.elapsedMs, causeCode: e.causeCode,
        detail: `underlying=${e.code}${e.detail ? ` (${e.detail})` : ""}`,
      });
    }
    emit({ name: "otp_request", ok: false, elapsedMs: null, detail: "non-protocol failure" });
    throw e;
  }

  const bodyKeys = (typeof res.body === "object" && res.body !== null)
    ? Object.keys(res.body as Record<string, unknown>) : [];
  const nestedKeys = (typeof (res.body as { data?: unknown })?.data === "object"
    && (res.body as { data?: unknown }).data !== null)
    ? Object.keys((res.body as { data: Record<string, unknown> }).data) : [];
  emit({
    name: "otp_request", ok: true, elapsedMs: res.timing.totalMs,
    detail: `http ${res.status} ${res.contentType}`
      + ` headers ${res.timing.fetchMs}ms body ${res.timing.bodyMs}ms`
      + ` keys:[${bodyKeys.join(",") || "none"}]`
      + (nestedKeys.length ? ` data.keys:[${nestedKeys.join(",")}]` : ""),
  });

  const parsed = parseOtpResponse(res.body);
  if (parsed instanceof DerivNewApiError) {
    emit({
      name: "otp_response_parse", ok: false, elapsedMs: null,
      detail: parsed.detail ?? parsed.code,
    });
    throw parsed;
  }
  emit({
    name: "otp_response_parse", ok: true, elapsedMs: null,
    detail: "WebSocket URL field present",
  });

  // Scheme + host + path only. describeOtpUrlForLog drops the query string,
  // which is where the OTP lives.
  emit({
    name: "ws_url_validate", ok: true, elapsedMs: null,
    detail: describeOtpUrlForLog(parsed),
  });

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
