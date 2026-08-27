// Phase 6 — per-request Deriv dependency resolution.
//
// The DerivExecutionAdapter cannot be a module constant. Its dependencies are
// request- and account-specific: which user, which broker connection, which
// Deriv account, whether that account is demonstrably DEMO, the resolved
// execution tier, the kill-switch state. Holding any of those in module scope
// means one request can be served with another request's account — which is the
// single worst failure available to this subsystem, because it places a real
// order on someone else's money.
//
// So everything here is resolved fresh, per request, from the authenticated
// user id, and NOTHING is cached in module scope. There is deliberately no
// mutable top-level state in this file at all.
//
// SECRETS. The Deriv token is never returned by this resolver. What comes back
// is a HANDLE — an opaque reference the transport layer exchanges for a
// credential server-side. Nothing downstream (ticket, command, audit, journal,
// position, debrief, API response, log) can leak a token it was never given.
// `assertNoSecretLeak` below is the belt to that braces.

import {
  resolveExecutionTier, tierPermitsVenueSend,
  type ExecutionTier,
} from "@workspace/domain/safety-contracts/executionTier";
import {
  routeExecutionVenue, type ExecutionVenue,
} from "@workspace/domain/safety-contracts/executionVenue";

export const DERIV_DEP_REFUSALS = [
  "NO_AUTHENTICATED_USER",
  "NO_BROKER_CONNECTION",
  "CONNECTION_NOT_OWNED_BY_USER",
  "NO_DERIV_ACCOUNT",
  "ACCOUNT_NOT_OWNED_BY_CONNECTION",
  "NO_CREDENTIAL_HANDLE",
  "ACCOUNT_DEMO_STATUS_UNPROVEN",
  "ACCOUNT_IS_LIVE_MONEY",
  "KILL_SWITCH_ENGAGED",
  "VENUE_NOT_DERIV",
  "TIER_FORBIDS_SEND",
  "UNRESOLVED_INTENT_OUTSTANDING",
] as const;
export type DerivDepRefusal = (typeof DERIV_DEP_REFUSALS)[number];

/**
 * How an account's DEMO status was established.
 *
 * The owner's rule: DEMO must not be inferred from token naming, environment
 * variable naming, a UI label, or the adapter's URL allow-list. Only evidence
 * the VENUE itself supplied counts, so the provenance travels with the verdict
 * and a caller can refuse anything weaker.
 */
export const DEMO_EVIDENCE_SOURCES = [
  /** The authenticated Deriv connection reported the account's own is_virtual. */
  "VENUE_ACCOUNT_ATTRIBUTE",
  /** A venue read of the account list classified this loginid. */
  "VENUE_ACCOUNT_LIST",
  /** Anything weaker — naming, labels, env. NEVER sufficient. */
  "INFERRED_FROM_NAMING",
] as const;
export type DemoEvidenceSource = (typeof DEMO_EVIDENCE_SOURCES)[number];

export interface DemoClassification {
  isDemo: boolean;
  source: DemoEvidenceSource;
  /** The venue's own field value, for the audit trail. Never a secret. */
  evidence: string;
}

/**
 * Only venue-supplied evidence proves DEMO.
 *
 * INFERRED_FROM_NAMING is present in the vocabulary precisely so it can be
 * REFUSED explicitly rather than being unrepresentable and therefore untested.
 */
export function demoIsProven(c: DemoClassification | null | undefined): boolean {
  if (!c || typeof c !== "object") return false;
  if (c.isDemo !== true) return false;
  return c.source === "VENUE_ACCOUNT_ATTRIBUTE" || c.source === "VENUE_ACCOUNT_LIST";
}

export interface ResolvedDerivDeps {
  userId: number;
  connectionId: number;
  accountRef: string;
  venue: ExecutionVenue;
  tier: ExecutionTier;
  /** Opaque server-side reference. NEVER the token itself. */
  credentialHandle: string;
  demo: DemoClassification;
}

export type DerivDepResolution =
  | { ok: true; deps: ResolvedDerivDeps }
  | { ok: false; refusal: DerivDepRefusal; detail: string };

/** Row-shaped inputs, all resolved per request. No ambient state. */
export interface DerivDepSources {
  /** Null when the request is unauthenticated. */
  authenticatedUserId: number | null;
  configuredTier: string | null;
  loadConnection: (userId: number, connectionId: number) => Promise<{
    id: number; ownerUserId: number; venue: string | null; credentialHandle: string | null;
  } | null>;
  loadAccount: (connectionId: number, accountRef: string) => Promise<{
    accountRef: string; connectionId: number;
  } | null>;
  /** Must come from the authenticated Deriv connection, not from config. */
  classifyAccount: (connectionId: number, accountRef: string) => Promise<DemoClassification | null>;
  killSwitchEngaged: (userId: number) => Promise<boolean>;
  hasUnresolvedIntent: (userId: number) => Promise<boolean>;
}

const deny = (refusal: DerivDepRefusal, detail: string): DerivDepResolution =>
  ({ ok: false, refusal, detail });

/**
 * Resolve everything the adapter needs, or refuse.
 *
 * Ownership is checked at BOTH hops — connection belongs to the user, account
 * belongs to the connection — because a single check would let a caller who
 * knows an account reference borrow a connection they do not own. That is the
 * "request A consumes request B's credentials" failure, and it is the reason
 * this resolver takes the authenticated user id rather than trusting any id in
 * the request body.
 */
export async function resolveDerivDependencies(
  args: { connectionId: number; accountRef: string; requestedVenue: string | null },
  src: DerivDepSources,
): Promise<DerivDepResolution> {
  const userId = src.authenticatedUserId;
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
    return deny("NO_AUTHENTICATED_USER", "no authenticated user on this request");
  }

  // Venue first: refuse a non-Deriv venue before touching credentials at all.
  const route = routeExecutionVenue(args.requestedVenue);
  if (!route.ok) return deny("VENUE_NOT_DERIV", `${route.refusal}: ${route.detail}`);
  if (route.venue !== "DERIV_DEMO") {
    return deny("VENUE_NOT_DERIV", `venue ${route.venue} is not served by the Deriv adapter`);
  }

  const tierResolution = resolveExecutionTier(src.configuredTier);
  const tier = tierResolution.tier;

  if (await src.killSwitchEngaged(userId)) {
    return deny("KILL_SWITCH_ENGAGED", "the per-user kill switch is engaged");
  }

  // An outstanding unresolved intent blocks a new order for this user: no new
  // order may assume that uncertain exposure is absent.
  if (await src.hasUnresolvedIntent(userId)) {
    return deny("UNRESOLVED_INTENT_OUTSTANDING",
      "an earlier Deriv intent is unresolved; resolve it before placing another order");
  }

  // Hop 1 — the connection must belong to THIS user.
  const conn = await src.loadConnection(userId, args.connectionId);
  if (!conn) return deny("NO_BROKER_CONNECTION", `connection ${args.connectionId} not found`);
  if (conn.ownerUserId !== userId) {
    return deny("CONNECTION_NOT_OWNED_BY_USER",
      `connection ${args.connectionId} belongs to another user`);
  }
  const connVenue = routeExecutionVenue(conn.venue);
  if (!connVenue.ok || connVenue.venue !== "DERIV_DEMO") {
    return deny("VENUE_NOT_DERIV", `connection ${args.connectionId} is not a Deriv demo connection`);
  }

  // Hop 2 — the account must belong to THAT connection.
  const account = await src.loadAccount(conn.id, args.accountRef);
  if (!account) return deny("NO_DERIV_ACCOUNT", `account ${args.accountRef} not found`);
  if (account.connectionId !== conn.id) {
    return deny("ACCOUNT_NOT_OWNED_BY_CONNECTION",
      `account ${args.accountRef} does not belong to connection ${conn.id}`);
  }

  const credentialHandle = conn.credentialHandle;
  if (typeof credentialHandle !== "string" || credentialHandle.trim() === "") {
    return deny("NO_CREDENTIAL_HANDLE", "no server-side credential handle for this connection");
  }

  // DEMO must be proven by the VENUE. Naming, labels and env are not evidence.
  const demo = await src.classifyAccount(conn.id, account.accountRef);
  if (!demo) {
    return deny("ACCOUNT_DEMO_STATUS_UNPROVEN",
      "the venue did not classify this account; DEMO status is unproven");
  }
  if (demo.isDemo !== true) {
    return deny("ACCOUNT_IS_LIVE_MONEY",
      `the venue classified ${account.accountRef} as a real-money account`);
  }
  if (!demoIsProven(demo)) {
    return deny("ACCOUNT_DEMO_STATUS_UNPROVEN",
      `DEMO status rests on ${demo.source}, which is not venue evidence`);
  }

  // Tier last: everything above is a fact about the request; this is policy.
  // Checked here as well as inside the adapter so a caller cannot construct an
  // adapter for a tier that forbids sending and discover it only at deliver().
  if (!tierPermitsVenueSend(tier)) {
    return deny("TIER_FORBIDS_SEND", `tier ${tier} does not permit a venue send`);
  }

  return {
    ok: true,
    deps: {
      userId, connectionId: conn.id, accountRef: account.accountRef,
      venue: route.venue, tier, credentialHandle, demo,
    },
  };
}

/**
 * Patterns that must never reach a persisted or user-visible surface.
 *
 * Deliberately matches the SHAPE of a credential rather than a variable name: a
 * token renamed on its way into a payload is still a token. Used by the
 * journal/audit writers and asserted by tests, so a secret cannot ride along in
 * a detail string, an error message, or a metadata blob.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bBearer\s+\S+/i,
  /\bAuthorization\b\s*[:=]/i,
  // Deriv PATs and app tokens: long opaque alphanumerics.
  /\b[A-Za-z0-9_-]{28,}\b/,
  /DERIV_API_TOKEN|VAULT_OVERRIDE_TOKEN|REGISTRATION_KEY_PEPPER|SESSION_SECRET|MT5_BRIDGE_TOKEN/,
];

/**
 * The system's OWN identifiers — prefixed UUIDs like `tkt_<uuid>`,
 * `di_tkt_<uuid>`, `con_<uuid>`, `gc_tkt_<uuid>`.
 *
 * WHY THIS EXISTS: the opaque-token heuristic above matches any 28+ run of
 * [A-Za-z0-9_-], and a prefixed UUID is 40+ characters of exactly that class.
 * The result in production was that EVERY approval-inbox response threw
 * SECRET_LEAK_REFUSED on its own ticket id — the inbox 500'd before the owner
 * ever saw a ticket. Tests missed it because fixtures used short ids like
 * "di_cert"; real ids are UUIDs. The exemption is deliberately NARROW: the
 * ENTIRE value must be dot-free prefixes plus one strict 8-4-4-4-12 UUID.
 * Deriv PATs are unbroken alphanumerics and cannot match this shape, and a
 * token smuggled NEXT to a UUID still fails the full-string anchor.
 */
const OWN_ID_SHAPE =
  /^(?:[a-z]{2,8}_){1,3}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a value looks like it carries a secret.
 *
 * Conservative by design: it would rather flag an innocent long identifier than
 * let a token through. Callers use it to REFUSE writing a field, not to redact
 * silently — silent redaction hides the bug that put a secret there.
 */
export function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (OWN_ID_SHAPE.test(value)) return false;
  return SECRET_SHAPES.some((re) => re.test(value));
}

/**
 * Throw if any string in this payload looks like a secret.
 *
 * Recursive, because a token hides just as well three levels down a metadata
 * object as it does at the top. Keys are checked too: a key named
 * `derivApiToken` is a leak even when its value is redacted, because the shape
 * of the record tells an attacker where to look next time.
 */
export function assertNoSecretLeak(payload: unknown, where: string): void {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (looksLikeSecret(v)) {
        throw new Error(`SECRET_LEAK_REFUSED: ${where} at ${path} carries a credential-shaped value`);
      }
      return;
    }
    if (!v || typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/token|secret|password|pepper|authorization|credential/i.test(k)) {
        throw new Error(`SECRET_LEAK_REFUSED: ${where} at ${path}.${k} names a credential field`);
      }
      walk(val, `${path}.${k}`);
    }
  };
  walk(payload, "$");
}
