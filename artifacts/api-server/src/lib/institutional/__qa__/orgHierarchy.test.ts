// Capability #50 — org hierarchy, consolidated exposure, ownership graph.
//
// Pins, offline (pure domain + schema/source pins):
//   1. Hierarchy builds: parents/children/roots resolve; dangling links are
//      reported, never dropped.
//   2. A parent CYCLE refuses with a typed error — no roll-up is produced
//      from a cyclic hierarchy, ever.
//   3. Consolidation: child exposure rolls into the parent; unlinked
//      exposure lands in unattributedExposures; non-finite exposure marks
//      the org incomplete instead of counting as 0.
//   4. Ownership graph: multiplied-through percentages; unknown-percentage
//      hops propagate null (never invented); ownership cycles refuse.
//   5. SoD-adjacent schema pins: one layer object links to at most ONE org
//      (unique index), and the admin route refuses self-ownership.
//
// Run: node --import tsx --test src/lib/institutional/__qa__/orgHierarchy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildOrgHierarchy,
  consolidateExposure,
  resolveEffectiveOwners,
  type OrgNodeInput,
} from "@workspace/domain/institutional";

const org = (orgId: number, parentOrgId: number | null, over: Partial<OrgNodeInput> = {}): OrgNodeInput => ({
  orgId,
  name: `org-${orgId}`,
  entityKind: "ORGANIZATION",
  parentOrgId,
  jurisdiction: null,
  status: "active",
  ...over,
});

test("hierarchy builds with roots, children, and reported dangling links", () => {
  const r = buildOrgHierarchy(
    [org(1, null), org(2, 1), org(3, 1), org(4, 2)],
    [
      { orgId: 2, layerKind: "STRATEGY_POOL", layerRefId: 10 },
      { orgId: 99, layerKind: "USER", layerRefId: 5 }, // dangling
    ],
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.rootOrgIds, [1]);
  assert.deepEqual(r.nodes.get(1)!.childOrgIds, [2, 3]);
  assert.deepEqual(r.nodes.get(2)!.childOrgIds, [4]);
  assert.equal(r.danglingLinks.length, 1, "unknown-org links are reported, never dropped");
});

test("LEGAL_ENTITY without jurisdiction is flagged, never invented", () => {
  const r = buildOrgHierarchy([org(1, null, { entityKind: "LEGAL_ENTITY" })], []);
  assert.ok(r.ok && r.nodes.get(1)!.jurisdictionMissing);
});

test("a parent cycle refuses with a typed error", () => {
  const r = buildOrgHierarchy([org(1, 2), org(2, 1)], []);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.reason, "PARENT_CYCLE");
  assert.deepEqual(r.offendingOrgIds, [1, 2]);

  const roll = consolidateExposure([org(1, 2), org(2, 1)], [], []);
  assert.ok(!roll.ok, "no roll-up may be produced from a cyclic hierarchy");
});

test("consolidation rolls child exposure into the parent; strangers land unattributed", () => {
  const r = consolidateExposure(
    [org(1, null), org(2, 1)],
    [
      { orgId: 1, layerKind: "SHARED_MASTER_ACCOUNT", layerRefId: 7 },
      { orgId: 2, layerKind: "VIRTUAL_TRADING_ACCOUNT", layerRefId: 8 },
    ],
    [
      { layerKind: "SHARED_MASTER_ACCOUNT", layerRefId: 7, grossExposure: 1.0, netExposure: 0.4 },
      { layerKind: "VIRTUAL_TRADING_ACCOUNT", layerRefId: 8, grossExposure: 0.5, netExposure: -0.2 },
      { layerKind: "STRATEGY_POOL", layerRefId: 999, grossExposure: 3, netExposure: 3 }, // unlinked
    ],
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  const parent = r.perOrg.find((o) => o.orgId === 1)!;
  const child = r.perOrg.find((o) => o.orgId === 2)!;
  assert.equal(child.directGross, 0.5);
  assert.equal(parent.directGross, 1.0);
  assert.equal(parent.consolidatedGross, 1.5, "child rolls into parent");
  assert.equal(parent.consolidatedNet, 0.2);
  assert.deepEqual(parent.includedOrgIds, [2]);
  assert.equal(r.unattributedExposures.length, 1);
  assert.equal(r.unattributedExposures[0]!.reason, "LAYER_NOT_LINKED_TO_ANY_ORG");
});

test("non-finite exposure marks the org INCOMPLETE instead of counting as 0", () => {
  const r = consolidateExposure(
    [org(1, null)],
    [{ orgId: 1, layerKind: "STRATEGY_POOL", layerRefId: 3 }],
    [{ layerKind: "STRATEGY_POOL", layerRefId: 3, grossExposure: Number.NaN, netExposure: Number.NaN }],
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.perOrg[0]!.incomplete, true);
  assert.equal(r.perOrg[0]!.consolidatedGross, 0);
  assert.equal(r.unattributedExposures[0]!.reason, "EXPOSURE_NOT_FINITE");
});

test("ownership: percentages multiply through org chains; unknown pct propagates null", () => {
  // user 5 owns 50% of org 2; org 2 owns 80% of org 1 → user 5 owns 40% of org 1.
  const r = resolveEffectiveOwners(
    [
      { ownerKind: "USER", ownerRefId: 5, ownedOrgId: 2, ownershipPct: 50, controlKind: "BENEFICIAL_OWNER" },
      { ownerKind: "ORG", ownerRefId: 2, ownedOrgId: 1, ownershipPct: 80, controlKind: "BENEFICIAL_OWNER" },
      { ownerKind: "USER", ownerRefId: 6, ownedOrgId: 1, ownershipPct: null, controlKind: "CONTROLLER" },
    ],
    1,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  const via = r.owners.find((o) => o.ownerRefId === 5)!;
  assert.equal(via.effectivePct, 40);
  assert.deepEqual(via.path, [1, 2]);
  const controller = r.owners.find((o) => o.ownerRefId === 6)!;
  assert.equal(controller.effectivePct, null, "unknown percentage is never invented");
});

test("ownership cycles refuse with a typed error", () => {
  const r = resolveEffectiveOwners(
    [
      { ownerKind: "ORG", ownerRefId: 2, ownedOrgId: 1, ownershipPct: 100, controlKind: "BENEFICIAL_OWNER" },
      { ownerKind: "ORG", ownerRefId: 1, ownedOrgId: 2, ownershipPct: 100, controlKind: "BENEFICIAL_OWNER" },
    ],
    1,
  );
  assert.ok(!r.ok && r.reason === "OWNERSHIP_CYCLE");
});

test("schema + route pins: single-org linking, self-ownership refused, additive SQL exists", () => {
  const schema = readFileSync(
    fileURLToPath(new URL("../../../../../../lib/db/src/schema/institutional.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(schema.includes('uniqueIndex("org_entity_links_layer_object_uq")'),
    "one layer object may belong to at most one org (ambiguity never resolves permissively)");

  const route = readFileSync(
    fileURLToPath(new URL("../../../routes/adminOrgStructure.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(route.includes("SELF_OWNERSHIP_REFUSED"), "an org may not own itself");

  const sql = readFileSync(
    fileURLToPath(new URL("../../../../../../docs/migrations-pending/build-institutional.sql", import.meta.url)),
    "utf8",
  );
  for (const t of ["organizations", "org_entity_links", "beneficial_ownership_edges"]) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `pending SQL creates ${t} additively`);
  }
});
