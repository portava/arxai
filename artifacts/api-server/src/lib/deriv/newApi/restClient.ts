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
export function resolveNewApiConfig(): DerivNewApiConfig | DerivNewApiErrorCode {
  const appId = (process.env["DERIV_APP_ID"] ?? "").trim();
  const token = (process.env["DERIV_API_TOKEN"] ?? "").trim();
  if (appId.length === 0) return "DERIV_NEW_API_INVALID_APP_ID";
  if (token.length === 0) return "DERIV_NEW_API_UNAUTHORIZED";
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

export interface DerivRestResponse<T> {
  ok: true;
  status: number;
  body: T;
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
}): Promise<DerivRestResponse<T>> {
  const doFetch = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DERIV_REST_TIMEOUT_MS);

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
    // NOTE: the caught error is deliberately NOT included. A fetch failure can
    // stringify the request init — headers included — in some runtimes.
    const aborted = (e as Error)?.name === "AbortError";
    throw new DerivNewApiError(
      aborted ? "DERIV_NEW_API_REQUEST_TIMEOUT" : "DERIV_NEW_API_WS_CONNECT_FAILED",
      { detail: aborted ? `no response within ${args.timeoutMs ?? DERIV_REST_TIMEOUT_MS}ms` : "REST transport failure" },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Read the body ONCE as text, then shape + parse from that. Calling
    // res.json() and later res.text() would fail: the stream is single-use.
    const contentType = (res.headers.get("content-type") ?? "none").split(";")[0]!;
    let raw = "";
    try { raw = await res.text(); } catch { /* unreadable */ }
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

    throw new DerivNewApiError(classifyHttpStatus(res.status), {
      derivCode, httpStatus: res.status, authChallenge, bodyShape,
      bodySnippet: args.captureBody ? redactSecrets(raw, args.config) : null,
    });
  }

  let body: T;
  try {
    body = await res.json() as T;
  } catch {
    throw new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      httpStatus: res.status,
      detail: "response was not valid JSON",
    });
  }
  return { ok: true, status: res.status, body };
}
