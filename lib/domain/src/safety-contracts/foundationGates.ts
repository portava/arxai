// Foundation Gates #19–#23 — pure verdict logic for the Phase B evaluator.
//
// Five additive gates extending the default-deny live-dispatch evaluator
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
//   #22 TENANT_CONTEXT_VIOLATION — the tenant context plane. Every live
//       command must be evaluated against ITS OWNER's limits/caps/kill-switch/
//       tier ONLY: every tenant-scoped fact the pipeline assembled carries a
//       stamp naming WHICH user it was read for and WHOSE rows came back. A
//       stamp naming any OTHER user is proven cross-tenant leakage and
//       refuses for EVERY command type; a missing/unstamped context refuses
//       entries (fail closed).
//   #23 EDGE_CAPACITY_EXCEEDED   — per-edge capacity ceiling. An entry backed
//       by a production edge must fit inside that edge's recorded capacity
//       (campaign-3 ruin/capacity simulator estimate + the owner-pressed USD
//       deployable ceiling) given the cumulative USD size already deployed on
//       the edge. NO capacity estimate, a NO_SAFE_CAPACITY verdict, or an
//       unresolvable deployed/candidate size ⇒ refuse LIVE entries. The
//       ceiling can only TIGHTEN existing caps — it is AND-ed after #21 and
//       an owner override can only lower it further.
//
// SAFETY (inviolable):
// - Fail closed everywhere: an unresolvable fact (missing envelope, unknown
//   tier literal, USD exposure that cannot be established from real contract
//   specs, an unstamped tenant read, an edge with no capacity estimate)
//   BLOCKS an entry. Nothing here estimates, guesses, or fabricates.
// - ENTRY-vs-OPS split: CLOSE_LIVE_POSITION / MODIFY_LIVE_SLTP are exempt
//   from #19/#20/#21/#23 and from #22's UNRESOLVABLE branches — a
//   risk-reducing command must never be trapped by a fact that cannot be
//   read. #22's PROVEN-violation branches (a stamp naming a different user,
//   a dispatch for a command the dispatcher does not own) refuse every
//   command type: a close evaluated inside another tenant's context is not
//   the owner's close being trapped — the rightful owner can re-issue it and
//   dispatch inside their own context.
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

// ── #22 tenant context plane ────────────────────────────────────────────────

/**
 * One tenant-scoped fact bundle the dispatch pipeline read while assembling
 * evaluator inputs, stamped at READ time with who it was read for and whose
 * rows actually came back. The stamps are the evidence the gate evaluates —
 * the pipeline must never fabricate them after the fact (they are written by
 * the same code lines that run the scoped query).
 */
export interface TenantFactStamp {
  /** What was read, e.g. "capital_access", "open_positions", "live_arming". */
  fact: string;
  /**
   * The userId the query was SCOPED by (the WHERE user_id = ?). null = the
   * read was not tenant-scoped at all — an entry then refuses (fail closed).
   */
  scopedToUserId: number | null;
  /**
   * Distinct user_id values observed ON THE RETURNED ROWS. Empty is fine (no
   * rows). Any member differing from the command owner is PROVEN cross-tenant
   * leakage and refuses every command type.
   */
  rowOwnerUserIds: number[];
}

export interface FoundationTenantContextInput {
  /** arx_live_commands.user_id on the command row itself. */
  commandOwnerUserId: number | null;
  /** The authenticated userId the dispatch pipeline is executing for. */
  dispatchUserId: number | null;
  /** Stamps for every tenant-scoped fact assembled for this dispatch. */
  facts: TenantFactStamp[];
}

// ── #23 edge capacity governor ──────────────────────────────────────────────

/** The only capacity status that can admit deployment. Explicit allow-list:
 *  NO_SAFE_CAPACITY, DEGENERATE_INPUT, an unknown literal, and null (no
 *  estimate recorded) all refuse. */
export const EDGE_CAPACITY_STATUS_ESTIMATED = "ESTIMATED" as const;

export interface FoundationEdgeCapacityInput {
  /**
   * Capacity governance is demanded for this command: true for autonomous
   * (SELF_TRADE_AGENT/SYSTEM) origination OR any command carrying an edge
   * reference. A human manual click with no edge reference has no edge whose
   * capacity could govern it (mirrors #20's human exemption).
   */
  required: boolean;
  /** The command carries an edge reference (arx_live_commands.edge_id). */
  edgeRefPresent: boolean;
  /** production_edges.capacity_status. null = no estimate recorded ⇒ refuse. */
  capacityStatus: string | null;
  /**
   * production_edges.capacity_max_deployed_usd — the owner-pressed USD
   * deployable ceiling recorded WITH the simulator estimate. null/non-finite/
   * <=0 ⇒ refuse (an estimate without a pressed ceiling admits nothing).
   */
  capacityDeployableUsd: number | null;
  /**
   * Optional owner tighten-only override (production_edges.
   * capacity_deploy_cap_override_usd). Folded as min(ceiling, override) —
   * it can only LOWER the effective ceiling, never raise it.
   */
  capacityCapOverrideUsd: number | null;
  /**
   * Cumulative USD notional already deployed on this edge (open positions
   * attributed via their source command's edge_id + in-flight commands
   * carrying the edge_id, across the platform). null = could not be
   * established from real contract specs/prices ⇒ fail closed for entries.
   */
  deployedUsd: number | null;
  /** The candidate command's USD notional. null = unresolvable ⇒ fail closed. */
  candidateUsd: number | null;
}

export interface FoundationGateInputs {
  /** true for PLACE_LIVE_MARKET_ORDER / PLACE_LIVE_PENDING_ORDER. */
  isEntryCommand: boolean;
  provenance: FoundationProvenanceInput;
  edgePromotion: FoundationEdgePromotionInput;
  capital: FoundationCapitalInput;
  /** #22 — REQUIRED: omitting it is a compile error, so no supplier of a
   *  foundation block can silently skip the tenant-context plane. */
  tenantContext: FoundationTenantContextInput;
  /** #23 — REQUIRED for the same reason. */
  edgeCapacity: FoundationEdgeCapacityInput;
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

// ── #22 TENANT_CONTEXT_VIOLATION ────────────────────────────────────────────

function isValidUserId(id: number | null | undefined): id is number {
  return typeof id === "number" && Number.isInteger(id) && id > 0;
}

/**
 * The tenant-context plane. PROVEN violations (a fact stamped for or
 * containing another user's rows, a dispatch whose authenticated user is not
 * the command's owner) refuse EVERY command type. UNRESOLVABLE context
 * (missing owner, unstamped/unscoped reads, no stamps at all) refuses
 * entries and passes ops with a loud advisory detail — a close must never be
 * trapped by a fact that cannot be read, but a proven cross-tenant
 * evaluation is refused outright (the rightful owner can re-issue it).
 */
export function evaluateTenantContextGate(
  isEntryCommand: boolean,
  t: FoundationTenantContextInput,
): FoundationGateVerdict {
  // PROVEN violations first — these refuse regardless of command type.
  if (isValidUserId(t.commandOwnerUserId) && isValidUserId(t.dispatchUserId)
    && t.commandOwnerUserId !== t.dispatchUserId) {
    return {
      passed: false,
      detail: `Cross-tenant dispatch: authenticated user ${t.dispatchUserId} is dispatching a command owned by user ${t.commandOwnerUserId}. Refused for every command type.`,
    };
  }
  const owner = isValidUserId(t.commandOwnerUserId) ? t.commandOwnerUserId : null;
  const advisories: string[] = [];
  for (const stamp of t.facts) {
    if (owner != null && stamp.scopedToUserId != null && stamp.scopedToUserId !== owner) {
      return {
        passed: false,
        detail: `Tenant-context leak: fact "${stamp.fact}" was read for user ${stamp.scopedToUserId}, not the command owner ${owner}. Refused for every command type.`,
      };
    }
    const foreign = owner != null
      ? stamp.rowOwnerUserIds.filter((id) => id !== owner)
      : [];
    if (foreign.length > 0) {
      return {
        passed: false,
        detail: `Tenant-context leak: fact "${stamp.fact}" returned rows owned by user(s) [${foreign.join(", ")}] while evaluating a command owned by user ${owner}. Refused for every command type.`,
      };
    }
    if (stamp.scopedToUserId == null) {
      advisories.push(`fact "${stamp.fact}" was read WITHOUT a tenant scope`);
    }
  }
  // UNRESOLVABLE context — fail closed for entries, advisory for ops.
  const gaps: string[] = [...advisories];
  if (owner == null) gaps.unshift("command owner userId missing/invalid");
  if (!isValidUserId(t.dispatchUserId)) gaps.unshift("dispatch userId missing/invalid");
  if (t.facts.length === 0) gaps.push("no tenant-scoped fact stamps were supplied");
  if (gaps.length > 0) {
    if (!isEntryCommand) {
      return {
        passed: true,
        detail: `ADVISORY (ops command not trapped): tenant context has gaps — ${gaps.join("; ")}.`,
      };
    }
    return {
      passed: false,
      detail: `Tenant context unresolvable for an entry (fail closed): ${gaps.join("; ")}.`,
    };
  }
  return { passed: true, detail: null };
}

// ── #23 EDGE_CAPACITY_EXCEEDED ──────────────────────────────────────────────

/**
 * Tighten-only fold of the recorded deployable ceiling and the optional owner
 * override: the effective ceiling is the MINIMUM of every applicable cap and
 * can never exceed either input. null when no valid ceiling exists (the gate
 * then refuses — an estimate without a pressed ceiling admits nothing).
 */
export function resolveEdgeCapacityCeilingUsd(
  capacityDeployableUsd: number | null,
  capacityCapOverrideUsd: number | null,
): number | null {
  if (capacityDeployableUsd == null || !Number.isFinite(capacityDeployableUsd)
    || capacityDeployableUsd <= 0) {
    return null;
  }
  if (capacityCapOverrideUsd != null && Number.isFinite(capacityCapOverrideUsd)
    && capacityCapOverrideUsd > 0) {
    return Math.min(capacityDeployableUsd, capacityCapOverrideUsd);
  }
  return capacityDeployableUsd;
}

export function evaluateEdgeCapacityGate(
  isEntryCommand: boolean,
  e: FoundationEdgeCapacityInput,
): FoundationGateVerdict {
  if (!isEntryCommand) {
    return { passed: true, detail: "Exempt: close/modify commands reduce or manage deployed size and are never capped here." };
  }
  if (!e.required) {
    return { passed: true, detail: "Not required: human-originated command with no edge reference (capacity governs machine strategies/edges)." };
  }
  if (!e.edgeRefPresent) {
    return { passed: false, detail: "Capacity-governed entry carries no production_edges reference — no edge capacity can admit it." };
  }
  if (e.capacityStatus == null) {
    return { passed: false, detail: "Edge has NO capacity estimate (ruin/capacity simulator never ran or was never recorded) — refusing LIVE (fail closed)." };
  }
  if (e.capacityStatus !== EDGE_CAPACITY_STATUS_ESTIMATED) {
    return { passed: false, detail: `Edge capacity status "${e.capacityStatus}" is not ${EDGE_CAPACITY_STATUS_ESTIMATED} — the simulator found no safe deployable capacity (or the status literal is unrecognised; allow-list refuses it).` };
  }
  const ceiling = resolveEdgeCapacityCeilingUsd(e.capacityDeployableUsd, e.capacityCapOverrideUsd);
  if (ceiling == null) {
    return { passed: false, detail: `Edge capacity ceiling unusable (deployable=$${String(e.capacityDeployableUsd)}) — an estimate without a valid pressed USD ceiling admits nothing (fail closed, never guess).` };
  }
  if (e.candidateUsd == null || !Number.isFinite(e.candidateUsd)) {
    return { passed: false, detail: "Candidate USD size could not be established from real contract specs/prices — refusing (fail closed, never estimate)." };
  }
  if (e.deployedUsd == null || !Number.isFinite(e.deployedUsd)) {
    return { passed: false, detail: "Cumulative deployed USD size on this edge could not be established — refusing (fail closed, never estimate)." };
  }
  const projected = e.deployedUsd + e.candidateUsd;
  if (projected > ceiling) {
    return { passed: false, detail: `Projected deployed size $${projected.toFixed(2)} exceeds this edge's capacity ceiling $${ceiling.toFixed(2)} (deployed $${e.deployedUsd.toFixed(2)} + candidate $${e.candidateUsd.toFixed(2)}).` };
  }
  return { passed: true, detail: null };
}
