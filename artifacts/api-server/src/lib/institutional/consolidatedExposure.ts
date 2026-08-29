// Capability #50 — consolidated-exposure read across the org hierarchy.
//
// This service is the CLEAN INTERFACE other capabilities consume (capbrain
// #22 imports getConsolidatedExposureView() — never these tables directly).
// It assembles the pure roll-up's inputs from:
//   * organizations / org_entity_links          (the hierarchy)
//   * shared_trade_attribution (status='open')  (open lots per master +
//                                                per virtual account)
//   * virtual_trading_accounts                  (capital: virtualEquity USD)
//   * strategy_pool_nav                         (capital: totalPoolValue when
//                                                navStatus=OK; UNDER_REVIEW
//                                                reports as not-finite)
//
// UNITS ARE NEVER MIXED: the roll-up runs twice — once over open LOTS
// (exposure), once over capital USD — and the response labels each pass.
//
// HONESTY: every failed read degrades to `null` for that section plus a
// typed reason in `readFailures`; nothing is synthesized, and a partial
// picture is labelled partial.

import { eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  orgEntityLinksTable,
  beneficialOwnershipEdgesTable,
  sharedTradeAttributionTable,
  virtualTradingAccountsTable,
} from "@workspace/db";
import {
  consolidateExposure,
  resolveEffectiveOwners,
  buildOrgHierarchy,
  type ConsolidatedExposureResult,
  type LayerExposureInput,
  type OrgNodeInput,
  type OrgLinkInput,
  type OwnershipEdgeInput,
  type EffectiveOwnershipResult,
} from "@workspace/domain/institutional";
import { logger } from "../logger.js";

export interface ConsolidatedExposureView {
  /** Roll-up over open LOTS (from open shared_trade_attribution rows). */
  openLots: ConsolidatedExposureResult | null;
  /** Roll-up over capital USD (virtual equity + pool NAV). */
  capitalUsd: ConsolidatedExposureResult | null;
  /** Raw hierarchy facts for callers that need structure, not numbers. */
  orgs: OrgNodeInput[];
  links: OrgLinkInput[];
  ownershipEdges: OwnershipEdgeInput[];
  /** Typed reasons for any section that could not be read. */
  readFailures: string[];
}

async function readHierarchy(): Promise<{
  orgs: OrgNodeInput[];
  links: OrgLinkInput[];
  edges: OwnershipEdgeInput[];
} | null> {
  const orgRows = await db.select().from(organizationsTable);
  const linkRows = await db.select().from(orgEntityLinksTable);
  const edgeRows = await db.select().from(beneficialOwnershipEdgesTable);
  return {
    orgs: orgRows.map((o) => ({
      orgId: o.id,
      name: o.name,
      entityKind: o.entityKind,
      parentOrgId: o.parentOrgId,
      jurisdiction: o.jurisdiction,
      status: o.status,
    })),
    links: linkRows.map((l) => ({
      orgId: l.orgId,
      layerKind: l.layerKind,
      layerRefId: l.layerRefId,
    })),
    edges: edgeRows.map((e) => ({
      ownerKind: e.ownerKind,
      ownerRefId: e.ownerRefId,
      ownedOrgId: e.ownedOrgId,
      ownershipPct: e.ownershipPct,
      controlKind: e.controlKind,
    })),
  };
}

/**
 * The consolidated exposure view. Never throws; failed sections are null with
 * a typed reason.
 */
export async function getConsolidatedExposureView(): Promise<ConsolidatedExposureView> {
  const readFailures: string[] = [];

  let hierarchy: Awaited<ReturnType<typeof readHierarchy>> = null;
  try {
    hierarchy = await readHierarchy();
  } catch (err) {
    logger.warn({ err }, "institutional_hierarchy_read_failed");
    readFailures.push("HIERARCHY_READ_FAILED");
  }
  if (hierarchy == null) {
    return {
      openLots: null,
      capitalUsd: null,
      orgs: [],
      links: [],
      ownershipEdges: [],
      readFailures,
    };
  }

  // ── Open-lots exposures ──────────────────────────────────────────────────
  let lotsExposures: LayerExposureInput[] | null = null;
  try {
    const openAttrs = await db
      .select({
        sharedMasterAccountId: sharedTradeAttributionTable.sharedMasterAccountId,
        virtualAccountId: sharedTradeAttributionTable.virtualAccountId,
        side: sharedTradeAttributionTable.side,
        lotSize: sharedTradeAttributionTable.lotSize,
      })
      .from(sharedTradeAttributionTable)
      .where(eq(sharedTradeAttributionTable.status, "open"));
    const byLayer = new Map<string, { gross: number; net: number }>();
    for (const a of openAttrs) {
      const lots = Number(a.lotSize);
      if (!Number.isFinite(lots) || lots <= 0) continue; // rejected by the pure layer anyway
      const signed = a.side === "SELL" ? -lots : lots;
      for (const key of [
        `SHARED_MASTER_ACCOUNT:${a.sharedMasterAccountId}`,
        `VIRTUAL_TRADING_ACCOUNT:${a.virtualAccountId}`,
      ]) {
        const cur = byLayer.get(key) ?? { gross: 0, net: 0 };
        cur.gross += lots;
        cur.net += signed;
        byLayer.set(key, cur);
      }
    }
    lotsExposures = [...byLayer.entries()].map(([key, v]) => {
      const [layerKind, ref] = key.split(":");
      return {
        layerKind,
        layerRefId: Number(ref),
        grossExposure: v.gross,
        netExposure: v.net,
      };
    });
  } catch (err) {
    logger.warn({ err }, "institutional_open_lots_read_failed");
    readFailures.push("OPEN_LOTS_READ_FAILED");
  }

  // ── Capital USD exposures ────────────────────────────────────────────────
  let capitalExposures: LayerExposureInput[] | null = null;
  try {
    const vAccounts = await db
      .select({
        id: virtualTradingAccountsTable.id,
        virtualEquity: virtualTradingAccountsTable.virtualEquity,
      })
      .from(virtualTradingAccountsTable);
    const { strategyPoolNavTable } = await import("@workspace/db");
    const poolNavs = await db
      .select({
        strategyPoolId: strategyPoolNavTable.strategyPoolId,
        totalPoolValue: strategyPoolNavTable.totalPoolValue,
        navStatus: strategyPoolNavTable.navStatus,
      })
      .from(strategyPoolNavTable);
    capitalExposures = [
      ...vAccounts.map((v) => ({
        layerKind: "VIRTUAL_TRADING_ACCOUNT",
        layerRefId: v.id,
        grossExposure: Math.abs(Number(v.virtualEquity)),
        netExposure: Number(v.virtualEquity),
      })),
      ...poolNavs.map((p) => {
        // A pool whose NAV is UNDER_REVIEW has NO honest value right now —
        // pass NaN so the pure layer reports EXPOSURE_NOT_FINITE and flags
        // the owning org's totals as incomplete, instead of assuming 0.
        const nav = p.navStatus === "OK" ? Number(p.totalPoolValue) : Number.NaN;
        return {
          layerKind: "STRATEGY_POOL",
          layerRefId: p.strategyPoolId,
          grossExposure: Math.abs(nav),
          netExposure: nav,
        };
      }),
    ];
  } catch (err) {
    logger.warn({ err }, "institutional_capital_read_failed");
    readFailures.push("CAPITAL_READ_FAILED");
  }

  return {
    openLots: lotsExposures != null
      ? consolidateExposure(hierarchy.orgs, hierarchy.links, lotsExposures)
      : null,
    capitalUsd: capitalExposures != null
      ? consolidateExposure(hierarchy.orgs, hierarchy.links, capitalExposures)
      : null,
    orgs: hierarchy.orgs,
    links: hierarchy.links,
    ownershipEdges: hierarchy.edges,
    readFailures,
  };
}

/** Ownership resolution for one org — clean interface for capbrain #22 too. */
export async function getEffectiveOwnersOfOrg(
  orgId: number,
): Promise<{ result: EffectiveOwnershipResult | null; readFailed: boolean }> {
  try {
    const edgeRows = await db.select().from(beneficialOwnershipEdgesTable);
    const edges: OwnershipEdgeInput[] = edgeRows.map((e) => ({
      ownerKind: e.ownerKind,
      ownerRefId: e.ownerRefId,
      ownedOrgId: e.ownedOrgId,
      ownershipPct: e.ownershipPct,
      controlKind: e.controlKind,
    }));
    return { result: resolveEffectiveOwners(edges, orgId), readFailed: false };
  } catch (err) {
    logger.warn({ err, orgId }, "institutional_ownership_read_failed");
    return { result: null, readFailed: true };
  }
}

/** Structure-only hierarchy read (no numbers) for admin display. */
export async function getOrgHierarchy(): Promise<{
  hierarchy: ReturnType<typeof buildOrgHierarchy> | null;
  readFailed: boolean;
}> {
  try {
    const h = await readHierarchy();
    if (h == null) return { hierarchy: null, readFailed: true };
    return { hierarchy: buildOrgHierarchy(h.orgs, h.links), readFailed: false };
  } catch (err) {
    logger.warn({ err }, "institutional_hierarchy_read_failed");
    return { hierarchy: null, readFailed: true };
  }
}
