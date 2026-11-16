// Binds the feed scope of the signed-in reader to the request (see feedScope.ts).
// Mounted on /api after the body parsers, so the scope survives into every
// handler and everything it awaits. Anonymous requests get the platform scope.

import type { Request, Response, NextFunction } from "express";
import { getUserActiveConnection } from "../brokerHub/connections.js";
import { feedScopeForUser, runWithFeedScope } from "./feedScope.js";

const lookupActiveBridge = async (userId: number): Promise<number | null> =>
  (await getUserActiveConnection(userId))?.id ?? null;

export function bindFeedScope(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.authUser?.id ?? null;
  runWithFeedScope(feedScopeForUser(userId, lookupActiveBridge), () => next());
}
