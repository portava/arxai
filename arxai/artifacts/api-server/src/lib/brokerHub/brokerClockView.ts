// The signed-in trader's broker clock, for the order window's "Today" expiry.
//
// MT5's "Today" pending-order expiry means the end of the BROKER's trading
// day, not 23:59 UTC. The dashboard needs the broker-to-UTC offset of the
// trader's OWN bridge to compute that instant. This view projects only the
// offset measured for that bridge (brokerClockOffset.ts); the bridge is the
// reader's feed-scope bridge, never one named by the request, so no other
// user's bridge can be read through it. Unknown stays null.
//
// DB-free on purpose: the route wires the real resolvers.

import type { Request, Response } from "express";
import { getBrokerClockOffset, type BrokerClockOffset } from "./brokerClockOffset.js";
import { currentFeedScopeBridge } from "../data/feedScope.js";

export interface BrokerClockView {
  bridgeConnectionId: number | null;
  /** broker clock − UTC in ms (positive = broker ahead), or null when unknown. */
  brokerClockOffsetMs: number | null;
  brokerClockOffsetMeasuredAt: string | null;
}

export function brokerClockView(
  bridgeConnectionId: number | null,
  getOffset: (bridgeConnectionId: number, nowMs: number) => BrokerClockOffset | null = getBrokerClockOffset,
  nowMs: number = Date.now(),
): BrokerClockView {
  if (bridgeConnectionId == null) return { bridgeConnectionId: null, brokerClockOffsetMs: null, brokerClockOffsetMeasuredAt: null };
  const off = getOffset(bridgeConnectionId, nowMs);
  return {
    bridgeConnectionId,
    brokerClockOffsetMs: off ? off.offsetMs : null,
    brokerClockOffsetMeasuredAt: off ? new Date(off.measuredAtMs).toISOString() : null,
  };
}

export interface BrokerClockHandlerDeps {
  /** The reader's own bridge (default: the request's bound feed scope). */
  resolveBridge?: () => Promise<number | null>;
  getOffset?: (bridgeConnectionId: number, nowMs: number) => BrokerClockOffset | null;
}

/** GET /me/broker-clock — the caller's own bridge only; ignores any bridge in the query. */
export function createBrokerClockHandler(deps: BrokerClockHandlerDeps = {}) {
  const resolveBridge = deps.resolveBridge ?? currentFeedScopeBridge;
  const getOffset = deps.getOffset ?? getBrokerClockOffset;
  return async (req: Request, res: Response): Promise<void> => {
    if (!req.authUser) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
    const bridge = await resolveBridge().catch(() => null);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(brokerClockView(bridge, getOffset));
  };
}
