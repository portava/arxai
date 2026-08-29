// Foundation Gates #19–#21 — pure verdict logic for the Phase B evaluator.
//
// Three additive gates extending the default-deny live-dispatch evaluator
// (livePhaseBDispatchGate.ts). Each is a pure function of caller-assembled
// facts — no DB, no network, no clock reads (the caller supplies ages).
//
//   #19 PROVENANCE_UNPROVEN      — a LIVE entry must carry a provenance
//       envelope naming WHERE its decision data came from, WHEN it was true,
//       and WHICH feed produced it. Missing, untradeable-origin, stale, or
//       tamper-suspect (not covered by the command integrity hash) ⇒ BLOCKED.
//   #20 STRATEGY_NOT_LIVE_PROMOTED — an autonomously-originated LIVE entry
//       must reference a production_edges row that reached LIVE_CANDIDATE
//       with the owner's liveAllowed press and intact validation evidence.
//       Human manual clicks (USER/ADMIN/OWNER) are exempt: promotion governs
//       machine strategies, not the owner's own hand.
//   #21 CAPITAL_TIER_EXCEEDED    — per-user capital tier caps (per-trade lot
//       + total open USD notional). The tier can only TIGHTEN existing caps
//       (effective cap = min over every applicable cap) — never loosen.
//
// SAFETY (inviolable):
// - Fail closed everywhere: an unresolvable fact (missing envelope, unknown
//   tier literal, USD exposure that cannot be established from real contract
//   specs) BLOCKS an entry. Nothing here estimates, guesses, or fabricates.
// - ENTRY-ONLY: CLOSE_LIVE_POSITION / MODIFY_LIVE_SLTP are exempt from all
//   three gates — a risk-reducing command must never be trapped (the same
//   entry-vs-ops split every dispatch pre-gate applies).
// - These gates only ADD block reasons. No existing gate is weakened.

/**
 * lib/provenance origin taxonomy, mirrored structurally (the api-server
 * module cannot be imported from lib/domain without inverting the dependency
 * direction — the same structural-mirror precedent edgePromotion.ts uses).
 * The string literals are pinned by test:foundation-gates against the
 * canonical taxonomy so the two can never drift silently.
 */
export type CommandProvenanceSource =
  | "LIVE_TICK"
  | "DERIVED"
  | "MODEL"
  | "SYNTHETIC"
  | "UNKNOWN"
  | "STALE";

/**
 * The only origins that may back a LIVE entry. Explicit ALLOW-list, never a
 * deny-list (mirrors lib/provenance isTradeable): an origin this predicate
 * does not recognise — including any member added later without revisiting
 * it — is refused. Fail closed.
 */
export function isTradeableProvenanceSource(source: string | null | undefined): boolean {
  return source === "LIVE_TICK" || source === "DERIVED";
}

/**
 * Outer sanity bound on provenance age at dispatch (ms). The envelope's
 * `asOf` is the instant the decision data was true; a human confirm flow may
 * legitimately take minutes between draft and dispatch, so this is a broad
 * backstop — the per-user max_signal_age_ms pre-gate remains the tight,
 * user-demanded bound. Tightening this default is an owner call.
 */
export const LIVE_PROVENANCE_MAX_AGE_MS = 15 * 60_000;

// ── #21 capital tiers ───────────────────────────────────────────────────────
//
// Static tier ladder (tier → hard caps). Values are deliberately conservative
// defaults-of-record: an UNASSIGNED user (capital_tier NULL) resolves to the
// MOST RESTRICTIVE tier (default-deny), and an unrecognised tier literal
// resolves to nothing at all — the gate refuses rather than guess.
// maxOpenExposureUsd caps the TOTAL open USD notional including the candidate.
export interface CapitalTierCaps {
  key: string;
  maxLotPerTrade: number;
  maxOpenExposureUsd: number;
}

export const CAPITAL_TIERS: readonly CapitalTierCaps[] = [
  { key: "T0", maxLotPerTrade: 0.01, maxOpenExposureUsd: 2_500 },
  { key: "T1", maxLotPerTrade: 0.10, maxOpenExposureUsd: 25_000 },
  { key: "T2", maxLotPerTrade: 0.50, maxOpenExposureUsd: 125_000 },
  { key: "T3", maxLotPerTrade: 2.00, maxOpenExposureUsd: 600_000 },
] as const;

/** NULL/unassigned resolves here — the most restrictive rung. */
export const DEFAULT_CAPITAL_TIER = "T0" as const;

/**
 * Resolve a stored tier literal to its caps. NULL/undefined = unassigned =
 * the most restrictive tier (default-deny, never "no cap"). An unrecognised
 * literal returns null — the gate refuses on it (fail closed, never guess).
 */
export function resolveCapitalTier(
  tier: string | null | undefined,
): CapitalTierCaps | null {
  const key = tier == null || tier.trim() === "" ? DEFAULT_CAPITAL_TIER : tier.trim().toUpperCase();
  return CAPITAL_TIERS.find((t) => t.key === key) ?? null;
}

// ── Gate inputs (assembled by the dispatch pipeline) ────────────────────────

export interface FoundationProvenanceInput {
  /** A parseable provenance envelope exists on the command. */
  envelopePresent: boolean;
  /** The envelope's data-source origin literal (taxonomy above). */
  source: string | null;
  /** now − envelope.asOf in ms. null = asOf missing/unparseable. */
  ageMs: number | null;
  /** Max acceptable age (ms). Callers pass LIVE_PROVENANCE_MAX_AGE_MS. */
  maxAgeMs: number;
  /**
   * The envelope is covered by the command's payload-hash integrity envelope
   * (the hashed payload copy matches the typed column byte-for-byte). false =
   * the envelope cannot be proven untampered between draft and dispatch.
   */
  integrityCovered: boolean;
}

export interface FoundationEdgePromotionInput {
  /**
   * Promotion is demanded for this command. Computed from the command's
   * actorType: true for SELF_TRADE_AGENT / SYSTEM origination, false for
   * USER / ADMIN / OWNER manual clicks (otherwise every human trade blocks).
   */
  required: boolean;
  /** The command carries an edge reference (arx_live_commands.edge_id). */
  edgeRefPresent: boolean;
  /** production_edges.status for the referenced edge. null = no row found. */
  edgeStatus: string | null;
  /** production_edges.live_allowed — the owner's press, read-only here. */
  edgeLiveAllowed: boolean;
  /**
   * The row's validation evidence is intact: a validation report + its
   * chained reportHash are present on the ledger row. false = no evidence
   * window ⇒ refuse.
   */
  edgeEvidenceValid: boolean;
}

export interface FoundationCapitalInput {
  /** user_master_live_access.capital_tier (null = unassigned ⇒ T0). */
  tier: string | null;
  /**
   * Current open USD notional across this user's open live positions plus
   * in-flight entries. null = could not be established from real contract
   * specs / prices ⇒ fail closed for entries.
   */
  openExposureUsd: number | null;
  /** The candidate command's USD notional. null = unresolvable ⇒ fail closed. */
  candidateExposureUsd: number | null;
  /**
   * Existing per-user lot cap (user_master_live_access.max_lot), folded in so
   * the tier can only TIGHTEN it: effective lot cap = min(tier, this).
   * null = no per-user cap configured (tier cap alone applies).
   */
  userMaxLot: number | null;
}

export interface FoundationGateInputs {
  /** true for PLACE_LIVE_MARKET_ORDER / PLACE_LIVE_PENDING_ORDER. */
  isEntryCommand: boolean;
  provenance: FoundationProvenanceInput;
  edgePromotion: FoundationEdgePromotionInput;
  capital: FoundationCapitalInput;
}

export interface FoundationGateVerdict {
  passed: boolean;
  detail: string | null;
}

// ── #19 PROVENANCE_UNPROVEN ─────────────────────────────────────────────────

export function evaluateProvenanceGate(
  isEntryCommand: boolean,
  p: FoundationProvenanceInput,
): FoundationGateVerdict {
  if (!isEntryCommand) {
    return { passed: true, detail: "Exempt: close/modify commands reduce or manage risk and carry no new decision data." };
  }
  if (!p.envelopePresent) {
    return { passed: false, detail: "No provenance envelope on this entry — cannot prove where its decision data came from." };
  }
  if (!p.integrityCovered) {
    return { passed: false, detail: "Provenance envelope is not covered by the command integrity hash — cannot prove it was not altered after draft." };
  }
  if (!isTradeableProvenanceSource(p.source)) {
    return { passed: false, detail: `Provenance source "${p.source ?? "?"}" is not tradeable (allow-list: LIVE_TICK, DERIVED).` };
  }
  if (p.ageMs == null || !Number.isFinite(p.ageMs)) {
    return { passed: false, detail: "Provenance asOf timestamp missing/unparseable — age cannot be established." };
  }
  if (!(p.maxAgeMs > 0) || !Number.isFinite(p.maxAgeMs)) {
    return { passed: false, detail: `Corrupt provenance age bound (${p.maxAgeMs}) — refusing (fail closed).` };
  }
  if (p.ageMs > p.maxAgeMs) {
    return { passed: false, detail: `Provenance is stale: ${p.ageMs}ms old (max ${p.maxAgeMs}ms).` };
  }
  return { passed: true, detail: null };
}

// ── #20 STRATEGY_NOT_LIVE_PROMOTED ──────────────────────────────────────────

export function evaluateEdgePromotionGate(
  isEntryCommand: boolean,
  e: FoundationEdgePromotionInput,
): FoundationGateVerdict {
  if (!isEntryCommand) {
    return { passed: true, detail: "Exempt: close/modify commands must never be trapped by promotion state." };
  }
  if (!e.required) {
    return { passed: true, detail: "Not required: human-originated command (promotion governs autonomous strategies)." };
  }
  if (!e.edgeRefPresent) {
    return { passed: false, detail: "Autonomous entry carries no production_edges reference — no promoted edge backs it." };
  }
  if (e.edgeStatus == null) {
    return { passed: false, detail: "Referenced production_edges row not found." };
  }
  if (e.edgeStatus !== "LIVE_CANDIDATE") {
    return { passed: false, detail: `Edge status "${e.edgeStatus}" has not reached LIVE_CANDIDATE.` };
  }
  if (!e.edgeLiveAllowed) {
    return { passed: false, detail: "Edge is LIVE_CANDIDATE but liveAllowed=false — the owner has not pressed live." };
  }
  if (!e.edgeEvidenceValid) {
    return { passed: false, detail: "Edge validation evidence missing/invalid (no intact signed report on the ledger row)." };
  }
  return { passed: true, detail: null };
}

// ── #21 CAPITAL_TIER_EXCEEDED ───────────────────────────────────────────────

export function evaluateCapitalAdmissibilityGate(
  isEntryCommand: boolean,
  commandVolume: number,
  c: FoundationCapitalInput,
): FoundationGateVerdict {
  if (!isEntryCommand) {
    return { passed: true, detail: "Exempt: close/modify commands reduce exposure and are never capped here." };
  }
  const tier = resolveCapitalTier(c.tier);
  if (tier == null) {
    return { passed: false, detail: `Unrecognised capital tier "${c.tier}" — refusing (fail closed, never guess a cap).` };
  }
  // Tighten-only: the tier may only REDUCE the effective lot cap vs the
  // existing per-user cap, never raise it.
  const effectiveMaxLot = c.userMaxLot != null && Number.isFinite(c.userMaxLot) && c.userMaxLot > 0
    ? Math.min(tier.maxLotPerTrade, c.userMaxLot)
    : tier.maxLotPerTrade;
  if (!(commandVolume > 0) || commandVolume > effectiveMaxLot) {
    return { passed: false, detail: `Volume ${commandVolume} exceeds tier ${tier.key} effective per-trade cap ${effectiveMaxLot}.` };
  }
  if (c.candidateExposureUsd == null || !Number.isFinite(c.candidateExposureUsd)) {
    return { passed: false, detail: "Candidate USD exposure could not be established from real contract specs/prices — refusing (fail closed, never estimate)." };
  }
  if (c.openExposureUsd == null || !Number.isFinite(c.openExposureUsd)) {
    return { passed: false, detail: "Open USD exposure could not be established from real contract specs/prices — refusing (fail closed, never estimate)." };
  }
  const projected = c.openExposureUsd + c.candidateExposureUsd;
  if (projected > tier.maxOpenExposureUsd) {
    return { passed: false, detail: `Projected open exposure $${projected.toFixed(2)} exceeds tier ${tier.key} cap $${tier.maxOpenExposureUsd.toFixed(2)}.` };
  }
  return { passed: true, detail: null };
}
