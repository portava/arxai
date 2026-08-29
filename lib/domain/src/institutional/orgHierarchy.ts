// Capability #50 — pure org-hierarchy builder + consolidated-exposure roll-up
// + beneficial-ownership graph traversal.
//
// Pure and deterministic: no IO, no DB, no clock. The api-server service
// (lib/institutional/consolidatedExposure.ts) assembles the inputs from
// organizations / org_entity_links / beneficial_ownership_edges plus the
// per-layer exposure facts, and capbrain (#22) consumes the same typed
// output through that service — a clean interface, no shared mutable state.
//
// REFUSAL PHILOSOPHY (matches the compliance gate):
//   * A parent cycle does NOT loop or throw mid-way: buildOrgHierarchy
//     returns ok:false with the offending org ids. A cyclic hierarchy has no
//     truthful roll-up, so no roll-up is produced.
//   * An exposure whose link target does not resolve to a known org is NEVER
//     silently dropped OR silently summed into a guess — it lands in
//     `unattributedExposures` with a typed reason.
//   * Exposure numbers must be finite; a non-finite input rejects that
//     exposure with a typed reason (never coerced to 0).

export interface OrgNodeInput {
  orgId: number;
  name: string;
  entityKind: string;
  parentOrgId: number | null;
  jurisdiction: string | null;
  status: string;
}

export interface OrgLinkInput {
  orgId: number;
  layerKind: string;
  layerRefId: number;
}

export interface LayerExposureInput {
  layerKind: string;
  layerRefId: number;
  /** Gross exposure attributed to this layer object (finite, >= 0).
   *  UNIT-AGNOSTIC: the caller chooses one unit (lots or USD) per roll-up
   *  pass and must never mix units in a single call. */
  grossExposure: number;
  /** Net exposure (finite; may be negative). */
  netExposure: number;
}

export type ExposureRejectReason =
  | "LAYER_NOT_LINKED_TO_ANY_ORG"
  | "LINKED_ORG_UNKNOWN"
  | "EXPOSURE_NOT_FINITE";

export interface UnattributedExposure {
  exposure: LayerExposureInput;
  reason: ExposureRejectReason;
}

export interface OrgHierarchyNode {
  orgId: number;
  name: string;
  entityKind: string;
  jurisdiction: string | null;
  status: string;
  /** True when a LEGAL_ENTITY is missing its jurisdiction (honest gap flag). */
  jurisdictionMissing: boolean;
  childOrgIds: number[];
  /** Layer links attached directly to this org. */
  links: OrgLinkInput[];
}

export type OrgHierarchyResult =
  | {
      ok: true;
      /** Every node, keyed by orgId. */
      nodes: Map<number, OrgHierarchyNode>;
      /** Root org ids (no parent / parent outside the set), sorted. */
      rootOrgIds: number[];
      /** Links whose orgId is not a known org (typed, never dropped). */
      danglingLinks: OrgLinkInput[];
    }
  | {
      ok: false;
      reason: "PARENT_CYCLE" | "DUPLICATE_ORG_ID";
      offendingOrgIds: number[];
    };

export function buildOrgHierarchy(
  orgs: readonly OrgNodeInput[],
  links: readonly OrgLinkInput[],
): OrgHierarchyResult {
  const nodes = new Map<number, OrgHierarchyNode>();
  for (const o of orgs) {
    if (nodes.has(o.orgId)) {
      return { ok: false, reason: "DUPLICATE_ORG_ID", offendingOrgIds: [o.orgId] };
    }
    nodes.set(o.orgId, {
      orgId: o.orgId,
      name: o.name,
      entityKind: o.entityKind,
      jurisdiction: o.jurisdiction,
      status: o.status,
      jurisdictionMissing:
        o.entityKind === "LEGAL_ENTITY" &&
        (o.jurisdiction == null || o.jurisdiction.trim() === ""),
      childOrgIds: [],
      links: [],
    });
  }

  // Cycle detection: walk each node's parent chain with a visited set.
  for (const o of orgs) {
    const seen = new Set<number>([o.orgId]);
    let cur = o.parentOrgId;
    while (cur != null && nodes.has(cur)) {
      if (seen.has(cur)) {
        return { ok: false, reason: "PARENT_CYCLE", offendingOrgIds: [...seen].sort((a, b) => a - b) };
      }
      seen.add(cur);
      const parent = orgs.find((p) => p.orgId === cur);
      cur = parent ? parent.parentOrgId : null;
    }
  }

  const rootOrgIds: number[] = [];
  for (const o of orgs) {
    if (o.parentOrgId != null && nodes.has(o.parentOrgId)) {
      nodes.get(o.parentOrgId)!.childOrgIds.push(o.orgId);
    } else {
      rootOrgIds.push(o.orgId);
    }
  }
  for (const n of nodes.values()) n.childOrgIds.sort((a, b) => a - b);
  rootOrgIds.sort((a, b) => a - b);

  const danglingLinks: OrgLinkInput[] = [];
  for (const l of links) {
    const n = nodes.get(l.orgId);
    if (n) n.links.push(l);
    else danglingLinks.push(l);
  }

  return { ok: true, nodes, rootOrgIds, danglingLinks };
}

export interface OrgConsolidatedExposure {
  orgId: number;
  name: string;
  /** Direct exposure from this org's own links. */
  directGross: number;
  directNet: number;
  /** Consolidated = direct + every descendant org's consolidated. */
  consolidatedGross: number;
  consolidatedNet: number;
  /** Descendant org ids included in the consolidation (sorted). */
  includedOrgIds: number[];
  /** True when any included exposure input was rejected — totals INCOMPLETE. */
  incomplete: boolean;
}

export type ConsolidatedExposureResult =
  | {
      ok: true;
      perOrg: OrgConsolidatedExposure[];
      unattributedExposures: UnattributedExposure[];
    }
  | { ok: false; reason: "HIERARCHY_INVALID"; hierarchy: OrgHierarchyResult };

/**
 * Roll exposures up the hierarchy. Deterministic (sorted outputs).
 */
export function consolidateExposure(
  orgs: readonly OrgNodeInput[],
  links: readonly OrgLinkInput[],
  exposures: readonly LayerExposureInput[],
): ConsolidatedExposureResult {
  const hierarchy = buildOrgHierarchy(orgs, links);
  if (!hierarchy.ok) return { ok: false, reason: "HIERARCHY_INVALID", hierarchy };

  // Index links: layerKind:layerRefId → orgId.
  const linkIndex = new Map<string, number>();
  for (const n of hierarchy.nodes.values()) {
    for (const l of n.links) linkIndex.set(`${l.layerKind}:${l.layerRefId}`, n.orgId);
  }

  const unattributedExposures: UnattributedExposure[] = [];
  const directGross = new Map<number, number>();
  const directNet = new Map<number, number>();
  const incompleteOrgs = new Set<number>();

  for (const e of exposures) {
    const orgId = linkIndex.get(`${e.layerKind}:${e.layerRefId}`);
    if (orgId == null) {
      unattributedExposures.push({ exposure: e, reason: "LAYER_NOT_LINKED_TO_ANY_ORG" });
      continue;
    }
    if (!Number.isFinite(e.grossExposure) || !Number.isFinite(e.netExposure)) {
      unattributedExposures.push({ exposure: e, reason: "EXPOSURE_NOT_FINITE" });
      incompleteOrgs.add(orgId);
      continue;
    }
    directGross.set(orgId, (directGross.get(orgId) ?? 0) + e.grossExposure);
    directNet.set(orgId, (directNet.get(orgId) ?? 0) + e.netExposure);
  }

  // Post-order consolidation (hierarchy is acyclic — proven above).
  const consolidated = new Map<number, { gross: number; net: number; ids: number[]; incomplete: boolean }>();
  const visit = (orgId: number): { gross: number; net: number; ids: number[]; incomplete: boolean } => {
    const memo = consolidated.get(orgId);
    if (memo) return memo;
    const node = hierarchy.nodes.get(orgId)!;
    let gross = directGross.get(orgId) ?? 0;
    let net = directNet.get(orgId) ?? 0;
    let incomplete = incompleteOrgs.has(orgId);
    const ids: number[] = [];
    for (const child of node.childOrgIds) {
      const c = visit(child);
      gross += c.gross;
      net += c.net;
      incomplete = incomplete || c.incomplete;
      ids.push(child, ...c.ids);
    }
    const out = { gross, net, ids: [...new Set(ids)].sort((a, b) => a - b), incomplete };
    consolidated.set(orgId, out);
    return out;
  };
  for (const orgId of hierarchy.nodes.keys()) visit(orgId);

  const perOrg: OrgConsolidatedExposure[] = [...hierarchy.nodes.values()]
    .sort((a, b) => a.orgId - b.orgId)
    .map((n) => {
      const c = consolidated.get(n.orgId)!;
      return {
        orgId: n.orgId,
        name: n.name,
        directGross: directGross.get(n.orgId) ?? 0,
        directNet: directNet.get(n.orgId) ?? 0,
        consolidatedGross: c.gross,
        consolidatedNet: c.net,
        includedOrgIds: c.ids,
        incomplete: c.incomplete,
      };
    });

  return { ok: true, perOrg, unattributedExposures };
}

// ── Beneficial-ownership graph ──────────────────────────────────────────────

export interface OwnershipEdgeInput {
  ownerKind: string; // USER | ORG
  ownerRefId: number;
  ownedOrgId: number;
  ownershipPct: number | null;
  controlKind: string;
}

export interface EffectiveOwner {
  ownerKind: string;
  ownerRefId: number;
  /**
   * Multiplied-through percentage in [0, 100], or null when any hop in the
   * chain lacks a stated percentage (control without percentage propagates
   * as "controlling interest, percentage UNKNOWN" — never invented).
   */
  effectivePct: number | null;
  /** The org-id path from the owner down to the target (exclusive of owner). */
  path: number[];
}

export type EffectiveOwnershipResult =
  | { ok: true; owners: EffectiveOwner[] }
  | { ok: false; reason: "OWNERSHIP_CYCLE"; offendingOrgIds: number[] };

/**
 * Resolve the ultimate (USER-kind) owners of `targetOrgId` by walking ORG→ORG
 * edges upward. Cycle-safe: an ownership cycle returns a typed refusal.
 */
export function resolveEffectiveOwners(
  edges: readonly OwnershipEdgeInput[],
  targetOrgId: number,
): EffectiveOwnershipResult {
  const byOwned = new Map<number, OwnershipEdgeInput[]>();
  for (const e of edges) {
    const list = byOwned.get(e.ownedOrgId) ?? [];
    list.push(e);
    byOwned.set(e.ownedOrgId, list);
  }

  const owners: EffectiveOwner[] = [];
  const walk = (
    orgId: number,
    pctSoFar: number | null,
    path: number[],
    seen: Set<number>,
  ): { cycle: number[] | null } => {
    if (seen.has(orgId)) return { cycle: [...seen].sort((a, b) => a - b) };
    const nextSeen = new Set(seen).add(orgId);
    const incoming = byOwned.get(orgId) ?? [];
    for (const e of incoming) {
      const hopPct = e.ownershipPct;
      const pct =
        pctSoFar == null || hopPct == null
          ? null
          : (pctSoFar * hopPct) / 100;
      if (e.ownerKind === "USER") {
        owners.push({
          ownerKind: "USER",
          ownerRefId: e.ownerRefId,
          effectivePct: pct,
          path: [...path, orgId],
        });
      } else if (e.ownerKind === "ORG") {
        const r = walk(e.ownerRefId, pct, [...path, orgId], nextSeen);
        if (r.cycle) return r;
      }
      // Unknown ownerKind: reported nowhere as an owner — the route layer
      // refuses writing unknown kinds, and a stranger row must never be
      // counted as a person. (It is visible in the raw edge listing.)
    }
    return { cycle: null };
  };

  const r = walk(targetOrgId, 100, [], new Set());
  if (r.cycle) return { ok: false, reason: "OWNERSHIP_CYCLE", offendingOrgIds: r.cycle };

  owners.sort((a, b) =>
    a.ownerRefId - b.ownerRefId || a.path.join(",").localeCompare(b.path.join(",")));
  return { ok: true, owners };
}
