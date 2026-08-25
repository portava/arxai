// Deriv NEW API — error taxonomy (spec Phase 10).
//
// The migration exists because a transport defect presented as a credential
// failure: a PAT sent down the legacy `authorize` route returned InvalidToken,
// and two perfectly good demo tokens were regenerated before the real cause was
// found. That is the failure mode this taxonomy prevents. A credential problem,
// a transport problem, an account-selection problem, an OTP problem, a protocol
// mismatch and a trade rejection must never collapse into one another.
//
// PURE: no IO, no credential material.

export const DERIV_NEW_API_ERRORS = [
  /** App ID missing, malformed, or rejected by Deriv. */
  "DERIV_NEW_API_INVALID_APP_ID",
  /** PAT rejected (401). The credential itself is bad. */
  "DERIV_NEW_API_UNAUTHORIZED",
  /** PAT authenticated but lacks the scope for this call (403). */
  "DERIV_NEW_API_INSUFFICIENT_SCOPE",
  /** Authenticated, but the PAT owns no demo account to certify against. */
  "DERIV_NEW_API_NO_DEMO_ACCOUNT",
  /** More than one candidate demo account and no explicit selection. */
  "DERIV_NEW_API_ACCOUNT_AMBIGUOUS",
  /** OTP request failed. */
  "DERIV_NEW_API_OTP_FAILED",
  /** OTP was consumed or aged out; a FRESH one must be requested. */
  "DERIV_NEW_API_OTP_EXPIRED",
  /** The authenticated socket could not be established. */
  "DERIV_NEW_API_WS_CONNECT_FAILED",
  /** Deriv spoke, but not in a shape this client can honour. */
  "DERIV_NEW_API_PROTOCOL_ERROR",
  /** A request was sent and no reply arrived inside the bound. */
  "DERIV_NEW_API_REQUEST_TIMEOUT",
  /** The venue refused the trade on its merits. NOT a credential fault. */
  "DERIV_NEW_API_TRADING_REJECTED",
  /** The new transport is selected but a required piece is not built yet. */
  "DERIV_NEW_API_NOT_IMPLEMENTED",
] as const;

export type DerivNewApiErrorCode = (typeof DERIV_NEW_API_ERRORS)[number];

/**
 * A transport error that preserves Deriv's own status/code alongside ARX's
 * classification. Deliberately carries NO message from Deriv verbatim in
 * `derivCode`: that field is enum-like, whereas prose can echo request context.
 */
export class DerivNewApiError extends Error {
  readonly code: DerivNewApiErrorCode;
  /** Deriv's own error code, when it supplied one. */
  readonly derivCode: string | null;
  /** HTTP status for REST failures; null for WS/protocol failures. */
  readonly httpStatus: number | null;
  /** The `error=` parameter from a WWW-Authenticate challenge (RFC 6750) —
   *  an enum such as invalid_token. The accompanying error_description is
   *  deliberately NOT captured: it is prose and can echo request context. */
  readonly authChallenge: string | null;
  /** Response content-type and byte length. Shape only, never content. A 401
   *  carrying no JSON body at all distinguishes an edge rejection from an
   *  application-level refusal. */
  readonly bodyShape: string | null;
  /** A REDACTED, truncated error body. Populated ONLY when a caller passes
   *  captureBody — the diagnose command does, ordinary calls do not, so the
   *  venue's prose still never reaches production logs or thrown errors. */
  readonly bodySnippet: string | null;

  constructor(
    code: DerivNewApiErrorCode,
    opts: {
      derivCode?: string | null; httpStatus?: number | null; detail?: string;
      authChallenge?: string | null; bodyShape?: string | null;
      bodySnippet?: string | null;
    } = {},
  ) {
    // The message is the CLASSIFICATION, never the credential or the venue's
    // prose — this object is what surfaces in logs and thrown errors.
    super(opts.detail ? `${code}: ${opts.detail}` : code);
    this.name = "DerivNewApiError";
    this.code = code;
    this.derivCode = opts.derivCode ?? null;
    this.httpStatus = opts.httpStatus ?? null;
    this.authChallenge = opts.authChallenge ?? null;
    this.bodyShape = opts.bodyShape ?? null;
    this.bodySnippet = opts.bodySnippet ?? null;
  }
}

/**
 * Classify an HTTP status into the taxonomy.
 *
 * 401 vs 403 is the distinction that matters most: "your token is wrong" and
 * "your token is right but lacks trade scope" demand completely different
 * operator action, and collapsing them is how the last incident became a
 * multi-cycle diagnosis.
 */
export function classifyHttpStatus(status: number): DerivNewApiErrorCode {
  if (status === 401) return "DERIV_NEW_API_UNAUTHORIZED";
  if (status === 403) return "DERIV_NEW_API_INSUFFICIENT_SCOPE";
  // A bad/unknown App ID is commonly rejected as 400 by the app-id header check.
  if (status === 400) return "DERIV_NEW_API_INVALID_APP_ID";
  if (status === 408 || status === 504) return "DERIV_NEW_API_REQUEST_TIMEOUT";
  return "DERIV_NEW_API_PROTOCOL_ERROR";
}

/** True when the failure means "get a new OTP and retry", not "give up". */
export function isRetryableOtpFailure(code: DerivNewApiErrorCode): boolean {
  return code === "DERIV_NEW_API_OTP_EXPIRED";
}
