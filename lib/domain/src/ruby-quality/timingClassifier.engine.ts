// Task #199 — entry-timing classifier. PURE.
//
// Classifies how a user's actual entry timing compared to the moment Ruby's
// signal appeared: EARLY (jumped in before / right at the signal), ON_TIME
// (within the admin-tuned late-entry tolerance), or LATE (chased it). Returns
// null when there is no real entry timestamp — we never fabricate a timing
// verdict from missing evidence.

import type { TimingClass } from "./rubyQuality.types";

export function classifyEntryTiming(args: {
  signalAtMs: number;
  entryAtMs: number | null | undefined;
  lateEntrySeconds: number;
}): TimingClass | null {
  const { signalAtMs, entryAtMs, lateEntrySeconds } = args;
  if (entryAtMs == null || !Number.isFinite(entryAtMs)) return null;
  const deltaSec = (entryAtMs - signalAtMs) / 1000;
  // Entered before / at the signal moment — pre-empted Ruby's confirmation.
  if (deltaSec <= 0) return "EARLY";
  if (deltaSec <= Math.max(0, lateEntrySeconds)) return "ON_TIME";
  return "LATE";
}
