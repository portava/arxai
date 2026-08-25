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
    patPresent: token.length > 0,
    // Length is metadata, not content: it distinguishes "empty" and "truncated"
    // from "present" without revealing a single character.
    patLength: token.length,
  };
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
}): Promise<DerivRestResponse<T>> {
  const doFetch = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DERIV_REST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(`${DERIV_NEW_API_BASE}${args.path}`, {
      method: args.method,
      headers: {
        "Deriv-App-ID": args.config.appId,
        Authorization: `Bearer ${args.config.token}`,
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
    // Read Deriv's enum-like code if present; never its prose.
    let derivCode: string | null = null;
    try {
      const parsed = await res.json() as { error?: { code?: unknown }; code?: unknown };
      const raw = parsed?.error?.code ?? parsed?.code;
      if (typeof raw === "string" && raw.length > 0) derivCode = raw;
    } catch { /* body unreadable — status alone classifies it */ }
    throw new DerivNewApiError(classifyHttpStatus(res.status), {
      derivCode,
      httpStatus: res.status,
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
