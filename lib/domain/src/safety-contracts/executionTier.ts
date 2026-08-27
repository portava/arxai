// Phase 6 - the execution tier.
//
// The single server-authoritative answer to "how far may a guided order go?".
//
// The owner's rule is explicit: no code path may escalate a tier from the mere
// presence of an environment variable. That is enforced structurally here
// rather than by convention:
//
//   - resolution is a WHITELIST of exact literals. Anything unrecognised -
//     absent, empty, misspelled, whitespace-padded, a truthy string like "1" or
//     "true" - resolves to TIER_0_DRY_RUN. There is no "if the var is set, go
//     live" path to get wrong, because presence is never consulted, only value.
//
//   - TIER_3_LIVE_GUIDED and TIER_4_AUTONOMOUS are DENIED at resolution. They
//     exist in the vocabulary so the architecture can name them and so tests
//     can prove they are refused, but `resolveExecutionTier` clamps them to
//     TIER_0 and reports why. Enabling live or autonomous execution therefore
//     requires editing this file under a new owner ruling - it cannot happen
//     through configuration, a leaked env var, or a typo.
//
// Contract-only: importing this dispatches nothing.

export const EXECUTION_TIERS = [
  /** All gates and adapter mapping run; the transport refuses before send. */
  "TIER_0_DRY_RUN",
  /** One explicitly approved, unexpired ticket may execute on a DEMO account. */
  "TIER_1_DEMO_GUIDED",
  /** Multiple individually approved demo tickets during one session. */
  "TIER_2_DEMO_SUPERVISED",
  /** Live guided execution. NOT ENABLEABLE - see denyReason below. */
  "TIER_3_LIVE_GUIDED",
  /** Autonomous execution. NOT ENABLEABLE. */
  "TIER_4_AUTONOMOUS",
] as const;
export type ExecutionTier = (typeof EXECUTION_TIERS)[number];

export const DEFAULT_EXECUTION_TIER: ExecutionTier = "TIER_0_DRY_RUN";

/**
 * The one demo-guided tier, exported by NAME.
 *
 * Callers that need to compare against it import this rather than writing the
 * literal, so the string exists in exactly one file. The
 * phase6-execution-safety guard enforces that: a hard-coded tier literal
 * anywhere else is a second place the vocabulary can drift, and drift here
 * means a tier check that silently stops matching.
 */
export const TIER_1_DEMO_GUIDED: ExecutionTier = "TIER_1_DEMO_GUIDED";

/**
 * Tiers this build refuses to run at, with the reason surfaced in the resolution
 * so a refusal is never silent. Both are held by owner Ruling 19.
 */
export const DENIED_TIERS: Readonly<Record<string, string>> = {
  TIER_3_LIVE_GUIDED:
    "live-money guided execution is not authorized (owner Ruling 19: prepare architecture only)",
  TIER_4_AUTONOMOUS:
    "autonomous execution is not authorized (owner Ruling 19: do not enable)",
};

export interface ExecutionTierResolution {
  tier: ExecutionTier;
  /** True when the requested value was accepted verbatim. */
  requestedGranted: boolean;
  /** Present when the request was refused or unrecognised. */
  denyReason: string | null;
  /** Exactly what was requested, for the audit trail. Never a secret. */
  requested: string | null;
}

/**
 * Resolve a configured tier value. Total and default-deny.
 *
 * Takes the VALUE, never reads the environment itself: a pure function cannot
 * be tricked by ambient state, and the caller is forced to name the source it
 * trusts. `null`/`undefined`/unknown all resolve to TIER_0.
 */
export function resolveExecutionTier(requested: string | null | undefined): ExecutionTierResolution {
  const raw = typeof requested === "string" ? requested.trim() : null;

  if (raw === null || raw === "") {
    return {
      tier: DEFAULT_EXECUTION_TIER, requestedGranted: false,
      denyReason: "no execution tier configured; defaulting to dry run",
      requested: raw,
    };
  }
  // Exact match only. No case-folding, no aliasing, no prefix matching: a value
  // that is nearly right is not right, and guessing at intent here would be
  // guessing about whether real orders may be sent.
  if (!(EXECUTION_TIERS as readonly string[]).includes(raw)) {
    return {
      tier: DEFAULT_EXECUTION_TIER, requestedGranted: false,
      denyReason: `unrecognised execution tier ${JSON.stringify(raw)}; defaulting to dry run`,
      requested: raw,
    };
  }
  const denied = DENIED_TIERS[raw];
  if (denied !== undefined) {
    return {
      tier: DEFAULT_EXECUTION_TIER, requestedGranted: false,
      denyReason: denied, requested: raw,
    };
  }
  return {
    tier: raw as ExecutionTier, requestedGranted: true,
    denyReason: null, requested: raw,
  };
}

/**
 * May a real order frame be written to a venue at this tier?
 *
 * TIER_0 runs the entire guided flow and refuses at the transport, which is what
 * makes a dry run meaningful: everything upstream is exercised for real.
 */
export function tierPermitsVenueSend(tier: ExecutionTier): boolean {
  return tier === "TIER_1_DEMO_GUIDED" || tier === "TIER_2_DEMO_SUPERVISED";
}

/** May this tier reach a real-money account? No tier this build can resolve to. */
export function tierPermitsRealMoney(tier: ExecutionTier): boolean {
  // Deliberately not `tier === "TIER_3_LIVE_GUIDED"`: that would become true the
  // moment someone removed TIER_3 from DENIED_TIERS, coupling two separate
  // decisions. Live money requires an explicit new ruling and an edit here.
  void tier;
  return false;
}

/** May this tier dispatch without a human approving each order? Never, here. */
export function tierPermitsUnattendedDispatch(tier: ExecutionTier): boolean {
  void tier;
  return false;
}
