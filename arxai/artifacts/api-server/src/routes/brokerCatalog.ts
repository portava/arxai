// Phase 1 (multi-broker spec §15) — GET /api/brokers/catalog.
//
// The venue catalog: every broker ARX knows about, what it can do for THIS
// user right now, and — when it can do nothing — the explicit reason why.
//
// SAFETY / HONESTY:
//   * Read-only. This router imports no execution, mailbox, or credential
//     writer, and returns no credential material of any kind.
//   * Spec §21: an unimplemented broker returns an explicit
//     NOT_IMPLEMENTED / ONBOARDING_REQUIRED disabled state. It is NEVER
//     presented as connected, and no capability is advertised that no
//     certified adapter provides. The catalog is sourced from the domain's
//     frozen unavailable-venue table, so a venue cannot become "available"
//     by accident here — only by shipping an adapter.
//   * Compliance is fail-closed per user × venue: the absence of a
//     broker_eligibility review refuses exactly like COMPLIANCE_HOLD, and
//     outside-client funds refuse regardless of eligibility (inviolable).
//   * `tradingEnabled` is a literal false on every entry. Phase 1 is the
//     READ-ONLY broker hub; no order submission exists at this stage.

import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, brokerEligibilityTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import {
  listUnavailableVenues,
  type BrokerVenue,
} from "@workspace/domain/broker-hub";
import { evaluateComplianceGate } from "@workspace/domain/compliance-gate";
import { isBrokerHubReadOnlyEnabled } from "../lib/brokerHub/featureFlag.js";
import { logger } from "../lib/logger.js";

const router = Router();

/** Phase 1 is read-only for EVERY venue, implemented or not. */
const READ_ONLY_FLAGS = {
  tradingEnabled: false as const,
  automationEnabled: false as const,
  canPlaceLiveTrade: false as const,
};

/**
 * Venues that demand an explicit per-user eligibility approval before any
 * activity. Conservative default: a venue absent from this map is treated as
 * REQUIRING approval, so adding a venue can never silently widen access.
 */
const VENUE_REQUIRES_APPROVAL: Partial<Record<BrokerVenue, boolean>> = {
  MT5: false, // the user's own terminal + their own per-user bridge token
};

function venueRequiresApproval(venue: BrokerVenue): boolean {
  return VENUE_REQUIRES_APPROVAL[venue] ?? true;
}

/**
 * GET /api/brokers/catalog
 *
 * Per-user venue catalog. MT5 is the one venue with a shipped read-only
 * adapter; everything else reports its honest unavailable state from the
 * domain table.
 */
router.get("/brokers/catalog", requireUser, async (req: Request, res: Response): Promise<void> => {
  const userId = req.authUser?.id ?? null;
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }

  // Eligibility rows are per user × venue. A read failure must NOT be mistaken
  // for "no restrictions": we fall through with an empty map, and the gate
  // then refuses every venue on the absent-review path (fail-closed).
  let eligibilityByVenue = new Map<string, string>();
  let eligibilityReadFailed = false;
  try {
    const rows = await db
      .select({
        venueCode: brokerEligibilityTable.venueCode,
        eligibilityStatus: brokerEligibilityTable.eligibilityStatus,
      })
      .from(brokerEligibilityTable)
      .where(eq(brokerEligibilityTable.userId, userId));
    eligibilityByVenue = new Map(rows.map((r) => [r.venueCode, r.eligibilityStatus]));
  } catch (err) {
    eligibilityReadFailed = true;
    logger.warn({ err, userId }, "broker_catalog_eligibility_read_failed_fail_closed");
  }

  const decideCompliance = (venue: BrokerVenue) =>
    evaluateComplianceGate({
      eligibilityStatus: eligibilityByVenue.get(venue) ?? null,
      venueRequiresApproval: venueRequiresApproval(venue),
      // Phase 1 has no managed-allocation surface, so nothing here is trading
      // outside-client funds. When that surface lands it must pass the real
      // per-assignment provenance rather than this constant.
      outsideClientFunds: false,
    });

  // ── MT5: the one venue with a shipped read-only adapter ──────────────────
  const mt5Compliance = decideCompliance("MT5");
  const mt5HubEnabled = isBrokerHubReadOnlyEnabled();
  const mt5 = {
    venue: "MT5" as const,
    status: mt5HubEnabled ? ("DISCOVERY_REQUIRED" as const) : ("DISABLED" as const),
    adapterImplemented: true,
    // Read capability is claimed ONLY when the hub flag is on AND compliance
    // allows. Anything else advertises nothing.
    capabilities: {
      accountSnapshot: mt5HubEnabled && mt5Compliance.allowed,
      positionSnapshot: mt5HubEnabled && mt5Compliance.allowed,
      openOrderSnapshot: mt5HubEnabled && mt5Compliance.allowed,
      instrumentDiscovery: mt5HubEnabled && mt5Compliance.allowed,
      marketDataSnapshot: mt5HubEnabled && mt5Compliance.allowed,
    },
    compliance: { allowed: mt5Compliance.allowed, reasons: mt5Compliance.reasons },
    // Per-user bridge token issued from MT5 Setup. Never the legacy
    // server-wide env token, which is rejected on every EA endpoint.
    credentialRequirements: ["PER_USER_BRIDGE_TOKEN"],
    ...READ_ONLY_FLAGS,
  };

  // ── Every other venue: honest unavailable state from the domain table ────
  const unavailable = listUnavailableVenues().map((entry) => {
    const compliance = decideCompliance(entry.venue);
    return {
      venue: entry.venue,
      status: entry.status,
      reason: entry.reason,
      adapterImplemented: false,
      capabilities: entry.capabilities,
      compliance: { allowed: compliance.allowed, reasons: compliance.reasons },
      credentialRequirements: entry.credentialRequirements,
      ...READ_ONLY_FLAGS,
    };
  });

  res.json({
    venues: [mt5, ...unavailable],
    // Phase 1 of the multi-broker spec is the READ-ONLY hub: no order
    // submission exists for any venue, implemented or not.
    phase: "READ_ONLY_HUB",
    orderSubmissionAvailable: false,
    // Surfaced so a degraded eligibility read is visible rather than looking
    // like a clean set of refusals.
    eligibilityReadFailed,
  });
});

export default router;
