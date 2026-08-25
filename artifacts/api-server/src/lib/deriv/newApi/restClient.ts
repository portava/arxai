// Deriv NEW API — authenticated REST client (spec: "REST API", Phase 11).
//
// ONE place constructs the credential headers. Duplicating that construction is
// how a Bearer token eventually reaches a log line or an error message, so
// every new-API REST call goes through here.
//
// SECRET DISCIPLINE (Phase 11):
//   * The PAT is read from env at call time and never stored on the instance,
//     never returned, never interpolated into a message, never logged.
//   * Errors carry ARX's classification + Deriv's enum-like code + HTTP status.
//     Deriv's prose is deliberately NOT propagated: it can echo request context.
//   * `describeConfig()` reports PRESENCE and metadata only.

import { detectDerivApiMode, type DerivApiMode } from "../apiMode.js";
import {
  DerivNewApiError,
  classifyHttpStatus,
  type DerivNewApiErrorCode,
} from "./errors.js";

/** Deriv's current REST base. */
export const DERIV_NEW_API_BASE = "https://api.derivws.com";

/** Bound on any single REST call. */
export const DERIV_REST_TIMEOUT_MS = 15_000;

export interface DerivNewApiConfig {
  appId: string;
  token: string;
}

/**
 * Resolve new-API config from env WITHOUT exposing it.
 *
 * Returns a typed refusal rather than throwing a message that might later be
 * logged with the values interpolated.
 */
export function resolveNewApiConfig(
  opts: {
    /**
     * Accept a configuration that CANNOT authenticate. Only the diagnose
     * command passes this: its whole purpose is to examine a broken config,
     * and a refusal here would disable the tool that identifies the breakage.
     */
    allowIncoherent?: boolean;
  } = {},
): DerivNewApiConfig | DerivNewApiErrorCode {
  const appId = (process.env["DERIV_APP_ID"] ?? "").trim();
  const token = (process.env["DERIV_API_TOKEN"] ?? "").trim();
  if (appId.length === 0) return "DERIV_NEW_API_INVALID_APP_ID";
  if (token.length === 0) return "DERIV_NEW_API_UNAUTHORIZED";
  // A NUMERIC App ID is the legacy generation's format, and Deriv rejects one
  // on the new API as "Invalid application". detectDerivApiMode already encodes
  // exactly this (numeric implies legacy), so refusing here contradicts
  // nothing — it closes the one way the pair could still reach the wire: an
  // explicit DERIV_API_MODE=new, which overrides the inference that would
  // otherwise have caught it. That combination produced a live incident whose
  // only symptom was an HTTP rejection that reads like a credential problem.
  if (!opts.allowIncoherent && /^\d+$/.test(appId)) return "DERIV_NEW_API_INVALID_APP_ID";
  return { appId, token };
}

/** Safe-to-log configuration description. Presence and metadata ONLY. */
export function describeConfig(): {
  mode: DerivApiMode;
  appIdPresent: boolean;
  /** An App ID is a PUBLIC identifier — it travels in legacy WS URLs — so its
   *  shape is safe to report, unlike the token's. A NUMERIC App ID is the
   *  legacy generation's format; the new generation issues alphanumeric ones.
   *  Sending a legacy App ID to the new API is rejected as "Invalid
   *  application", so this distinction is the first thing to check. */
  appIdShape: "numeric" | "alphanumeric" | "empty";
  patPresent: boolean;
  patLength: number;
} {
  const appId = (process.env["DERIV_APP_ID"] ?? "").trim();
  const token = (process.env["DERIV_API_TOKEN"] ?? "").trim();
  return {
    // The REAL detected mode. This used to be the literal "new", which made
    // every caller's mode check unfireable — including certification's.
    mode: detectDerivApiMode(),
    appIdPresent: appId.length > 0,
    appIdShape: appId.length === 0 ? "empty"
      : /^\d+$/.test(appId) ? "numeric" : "alphanumeric",
    patPresent: token.length > 0,
    // Length is metadata, not content: it distinguishes "empty" and "truncated"
    // from "present" without revealing a single character.
    patLength: token.length,
  };
}

/**
 * Remove anything credential-shaped from a string.
 *
 * The credential values are used to FIND and mask themselves — the standing
 * rule is that the token is never exposed, and masking is what enforces that
 * rather than violating it. Nothing about the token's content is reported.
 */
export function redactSecrets(text: string, config: DerivNewApiConfig): string {
  const capped = text.length > 256 ? `${text.slice(0, 256)}…[truncated]` : text;
  let out = capped;
  if (config.token) out = out.split(config.token).join("<token:redacted>");
  if (config.appId) out = out.split(config.appId).join("<app-id:redacted>");
  // An OTP can appear in a URL echoed back inside an error body.
  out = out.replace(/otp=[^&\s"']+/gi, "otp=<redacted>");
  // Bearer values, in case one is echoed in a form we did not send.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>");
  return out;
}

/** MEASURED durations for one REST attempt. Timing only — no content. */
export interface RestTiming {
  /** Time to response headers. */
  fetchMs: number | null;
  /** Additional time spent reading the body. */
  bodyMs: number | null;
  /** Total wall clock for the attempt. */
  totalMs: number | null;
}

export interface DerivRestResponse<T> {
  ok: true;
  status: number;
  body: T;
  timing: RestTiming;
}

/**
 * Perform an authenticated Deriv new-API REST call.
 *
 * Throws DerivNewApiError on any non-2xx or transport failure — classified,
 * never a raw fetch error whose message could contain the request (and thus
 * the Authorization header) in some runtimes.
 */
export async function derivRestRequest<T>(args: {
  method: "GET" | "POST";
  path: string;
  config: DerivNewApiConfig;
  body?: unknown;
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Which credential headers to send. DIAGNOSTIC USE ONLY — omitting a header
   * is how the diagnose command distinguishes an App-ID rejection from a token
   * rejection WITHOUT inspecting the token. Defaults to sending both.
   */
  authMode?: "both" | "app-id-only" | "bearer-only";
  /**
   * Capture a REDACTED, truncated error body. DIAGNOSTIC USE ONLY.
   *
   * Ordinarily the venue's prose is never propagated — it can echo request
   * context. But a short text/plain rejection usually states the actual cause,
   * and refusing to read it turns diagnosis into guesswork. So it is opt-in,
   * length-capped, and passed through redactSecrets() first.
   */
  captureBody?: boolean;
  /** Receives MEASURED phase durations, on success and on failure alike.
   *  Durations only — never headers, body, or credentials. */
  onTiming?: (timing: RestTiming) => void;
}): Promise<DerivRestResponse<T>> {
  const doFetch = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DERIV_REST_TIMEOUT_MS;
  const startedAt = Date.now();

  // Whether OUR timer is what aborted the request. Without this flag every
  // AbortError — from any cause — was reported as DERIV_NEW_API_REQUEST_TIMEOUT
  // with the message "no response within 15000ms", a duration that was never
  // measured. That turned an unrelated fast failure into a fabricated timeout
  // and sent the investigation after network latency that did not exist.
  let timerFired = false;
  const controller = new AbortController();
  const timer = setTimeout(() => { timerFired = true; controller.abort(); }, timeoutMs);

  const timing: RestTiming = { fetchMs: null, bodyMs: null, totalMs: null };
  const finish = <R>(v: R): R => {
    timing.totalMs = Date.now() - startedAt;
    args.onTiming?.(timing);
    return v;
  };

  // The timer is cleared in an OUTER finally, so the abort signal still covers
  // the BODY read. It used to be cleared as soon as headers arrived, leaving
  // res.json() unguarded — a stalled body then hung forever with no timeout
  // at all, which is a worse failure than the one being guarded against.
  try {
    let res: Response;
    try {
      res = await doFetch(`${DERIV_NEW_API_BASE}${args.path}`, {
        method: args.method,
        // STILL the one and only place credential headers are constructed.
        headers: {
          ...(args.authMode === "bearer-only" ? {} : { "Deriv-App-ID": args.config.appId }),
          ...(args.authMode === "app-id-only" ? {} : { Authorization: `Bearer ${args.config.token}` }),
          "Content-Type": "application/json",
        },
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
        signal: controller.signal,
      });
    } catch (e) {
      // The caught error's MESSAGE is still never included: a fetch failure can
      // stringify the request init, headers included. The class name and any
      // errno-style cause code are enum-like and safe, and they are what
      // actually distinguishes DNS failure from refusal from abort.
      const elapsedMs = Date.now() - startedAt;
      const name = (e as Error)?.name ?? "unknown";
      const causeCode = (e as { cause?: { code?: unknown } })?.cause?.code;
      const causeStr = `${name}${typeof causeCode === "string" ? `/${causeCode}` : ""}`;
      timing.fetchMs = elapsedMs;
      finish(null);
      if (timerFired) {
        throw new DerivNewApiError("DERIV_NEW_API_REQUEST_TIMEOUT", {
          detail: `our ${timeoutMs}ms timeout fired (measured ${elapsedMs}ms)`,
          elapsedMs, causeCode: causeStr,
        });
      }
      // An abort we did NOT cause is not a timeout. Saying so was the defect.
      throw new DerivNewApiError("DERIV_NEW_API_REST_TRANSPORT_FAILED", {
        detail: `${causeStr} after ${elapsedMs}ms — our ${timeoutMs}ms timeout had NOT fired`,
        elapsedMs, causeCode: causeStr,
      });
    }
    timing.fetchMs = Date.now() - startedAt;

    if (!res.ok) {
      // Read the body ONCE as text, then shape + parse from that. Calling
      // res.json() and later res.text() would fail: the stream is single-use.
      const contentType = (res.headers.get("content-type") ?? "none").split(";")[0]!;
      let raw = "";
      try { raw = await res.text(); } catch { /* unreadable */ }
      timing.bodyMs = Date.now() - startedAt - (timing.fetchMs ?? 0);
      const bodyShape = `${contentType} ${raw.length}B`;

      let derivCode: string | null = null;
      try {
        const parsed = JSON.parse(raw) as { error?: { code?: unknown }; code?: unknown };
        const c = parsed?.error?.code ?? parsed?.code;
        if (typeof c === "string" && c.length > 0) derivCode = c;
      } catch { /* not JSON — status and shape classify it */ }

      // RFC 6750 challenge: capture the `error=` ENUM only. error_description
      // is prose and is deliberately left behind.
      const challenge = res.headers.get("www-authenticate");
      const m = challenge ? /error="?([A-Za-z0-9_-]+)"?/.exec(challenge) : null;
      const authChallenge = m ? m[1]! : (challenge ? "present-without-error-param" : null);

      finish(null);
      throw new DerivNewApiError(classifyHttpStatus(res.status), {
        derivCode, httpStatus: res.status, authChallenge, bodyShape,
        bodySnippet: args.captureBody ? redactSecrets(raw, args.config) : null,
        elapsedMs: timing.totalMs,
      });
    }

    let body: T;
    try {
      body = await res.json() as T;
    } catch (e) {
      const elapsedMs = Date.now() - startedAt;
      finish(null);
      // A body read aborted by OUR timer is a timeout, not malformed JSON.
      // Before the timer covered the body read this case could not arise —
      // the read simply hung forever instead.
      if (timerFired) {
        throw new DerivNewApiError("DERIV_NEW_API_REQUEST_TIMEOUT", {
          detail: `our ${timeoutMs}ms timeout fired while reading the body (measured ${elapsedMs}ms)`,
          elapsedMs, httpStatus: res.status,
        });
      }
      throw new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
        httpStatus: res.status, elapsedMs,
        detail: "response was not valid JSON",
        causeCode: (e as Error)?.name ?? null,
      });
    }
    timing.bodyMs = Date.now() - startedAt - (timing.fetchMs ?? 0);
    finish(null);
    return { ok: true, status: res.status, body, timing };
  } finally {
    clearTimeout(timer);
  }
}
