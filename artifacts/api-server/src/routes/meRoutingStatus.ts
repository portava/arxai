// User-facing routing status (Centralized Master MT5 Bridge — Slice 1+2).
//
// SECURITY (inviolable):
//  - Never returns: apiKeyHash, raw bridgeToken, tokenLast4 of master,
//    master server name, real master account number, IP. Only the
//    masked display string (e.g. "•••• 9717") and broker name are
//    surfaced.
//  - Per-user isolation: the response reflects the calling user's
//    effective routing decision (override or inherit). No other user's
//    data is read.

import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, mt5ConnectionTable, sharedMasterAccountsTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { resolveRouting } from "../lib/adminTrading/routingResolver.js";

const router = Router();

const HEARTBEAT_FRESH_SECONDS = 15;

router.get("/me/routing-status", requireUser, async (req: Request, res) => {
  const userId = (req as Request & { authUser?: { id?: number } }).authUser?.id;
  if (!userId) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return;
  }
  try {
    const routing = await resolveRouting({ userId, mode: "DEMO" });
    if (routing.effectiveRoutingMode === "USER_OWNED_MT5") {
      res.json({
        ok: routing.ok,
        effectiveRoutingMode: "USER_OWNED_MT5",
        routedViaMaster: false,
        blockReason: routing.ok ? null : routing.blockReason,
        master: null,
        // Safety contract echoed for client paranoia checks.
        safetyMode: "paper_only",
        liveLocked: true,
      });
      return;
    }
    // SHARED_MASTER_MT5 — fetch master conn but ONLY return non-secret fields.
    let master: {
      brokerName: string | null;
      accountNumberMasked: string | null;
      eaVersion: string | null;
      heartbeatAgeSeconds: number | null;
      healthy: boolean;
      sharedMasterAccountId: number | null;
    } | null = null;
    if (routing.connectionId) {
      const [conn] = await db
        .select({
          eaVersion: mt5ConnectionTable.eaVersion,
          lastHeartbeat: mt5ConnectionTable.lastHeartbeat,
          accountType: mt5ConnectionTable.accountType,
        })
        .from(mt5ConnectionTable)
        .where(eq(mt5ConnectionTable.id, routing.connectionId))
        .limit(1);
      let smRow: { brokerName: string | null; accountNumberMasked: string | null } | undefined;
      if (routing.sharedMasterAccountId) {
        [smRow] = await db
          .select({
            brokerName: sharedMasterAccountsTable.brokerName,
            accountNumberMasked: sharedMasterAccountsTable.accountNumberMasked,
          })
          .from(sharedMasterAccountsTable)
          .where(eq(sharedMasterAccountsTable.id, routing.sharedMasterAccountId))
          .limit(1);
      }
      const hbAge = conn?.lastHeartbeat
        ? Math.floor((Date.now() - new Date(conn.lastHeartbeat).getTime()) / 1000)
        : null;
      const healthy = hbAge !== null && hbAge <= HEARTBEAT_FRESH_SECONDS
        && (conn?.accountType === "demo" || conn?.accountType === "contest");
      master = {
        brokerName: smRow?.brokerName ?? null,
        accountNumberMasked: smRow?.accountNumberMasked ?? null,
        eaVersion: conn?.eaVersion ?? null,
        heartbeatAgeSeconds: hbAge,
        healthy,
        sharedMasterAccountId: routing.sharedMasterAccountId,
      };
    }
    res.json({
      ok: routing.ok,
      effectiveRoutingMode: "SHARED_MASTER_MT5",
      routedViaMaster: true,
      blockReason: routing.ok ? null : routing.blockReason,
      master,
      safetyMode: "paper_only",
      liveLocked: true,
    });
  } catch (err) {
    req.log?.warn({ err }, "me_routing_status_failed");
    res.status(500).json({ ok: false, error: "ROUTING_STATUS_FAILED" });
  }
});

export default router;
