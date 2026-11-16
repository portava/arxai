// Phase 13 — Protective Auto-Close hook for the monitor worker.
//
// SAFETY: Thin re-export wrapper so the worker can dynamic-import without
// pulling tradeAction internals at module init time (avoids any potential
// import cycle with meTradeIntelligence). All real work is in
// lib/protectiveClose/engine.ts.

import { evaluateUserOpenTrades } from "../protectiveClose/engine.js";

export async function runProtectiveCloseForUser(userId: number, openTradeKeys: string[]): Promise<void> {
  if (!openTradeKeys.length) return;
  await evaluateUserOpenTrades(userId, openTradeKeys);
}
