// ARX Adaptive Cohesion Intelligence (AACI) — per-user advisory alerts.
//
// ADVISORY / READ-ONLY ONLY. This module turns an already-computed AaciDecision
// into clean, plain-English notifications for the owning user. It NEVER places,
// modifies, or closes a trade, never gates live/demo execution, and never names
// internal systems, machine codes, or sub-scores to the user. It only ADDS
// visibility.
//
// Honesty rules:
//   - Alerts are emitted ONLY from fields the decision really carries this
//     cycle (system conflicts, stale inputs, missing handshakes, and an
//     explicit RECONCILE_SYSTEM verdict). We never fabricate categories that
//     the decision does not model (e.g. there is no "shock mode" or per-user
//     "quota" signal on the user decision).
//   - Every emit is deduped per (kind, user, symbol) so a polled read never
//     spams the inbox — repeat occurrences bump the existing row's count, and a
//     dismissed advisory stays dismissed (only CRITICAL reactivates, and AACI
//     advisories are never CRITICAL).
//   - Fail-open: a notification failure must never affect the decision response.

import type { AaciDecision } from "@workspace/domain/aaci";
import { notify } from "../notifications/service.js";
import { logger } from "../logger.js";

function symbolLabel(decision: AaciDecision): string {
  const s = (decision.symbol ?? "").trim();
  return s.length > 0 ? s : "this market";
}

// Count the handshakes the engine could not read this cycle. We surface this as
// a soft "still connecting" note, never naming the systems involved.
function missingHandshakeCount(decision: AaciDecision): number {
  return decision.handshakes.filter((h) => h.status === "MISSING").length;
}

/**
 * Emit per-user advisory notifications for an AACI decision. Fire-and-forget
 * friendly: callers may `void` this. Never throws.
 */
export async function emitAaciUserAlerts(
  decision: AaciDecision,
  userId: number,
): Promise<void> {
  if (!userId || userId <= 0) return;
  const symbol = symbolLabel(decision);
  // dedupeKey uses the raw symbol token (or a stable placeholder) — it is an
  // internal key, never shown to the user.
  const keySymbol = (decision.symbol ?? "GENERAL").trim() || "GENERAL";

  try {
    // 1) Cross-system disagreement — the desk's systems don't currently agree
    //    on this market. Caution only.
    if (decision.systemConflicts.length > 0) {
      await notify({
        userId,
        type: "SYSTEM",
        severity: "WARNING",
        title: `Mixed signals on ${symbol}`,
        message:
          "ARX's systems don't fully agree on this market right now. Treat any setup with extra caution until they line up.",
        sourceBuild: "LL",
        dedupeKey: `AACI:CONFLICT:${userId}:${keySymbol}`,
        symbol: decision.symbol ?? undefined,
        relatedDecisionId: decision.decisionId,
      });
    }

    // 2) Stale inputs — some of the data behind this read is older than we'd
    //    like. Caution only.
    if (decision.staleInputs.length > 0) {
      await notify({
        userId,
        type: "DATA",
        severity: "WARNING",
        title: `Data is catching up on ${symbol}`,
        message:
          "Some of the information behind this read is a little behind. Give it a moment to refresh before acting.",
        sourceBuild: "LL",
        dedupeKey: `AACI:STALE:${userId}:${keySymbol}`,
        symbol: decision.symbol ?? undefined,
        relatedDecisionId: decision.decisionId,
      });
    }

    // 3) Systems still connecting — one or more inputs couldn't be read this
    //    cycle. Low-urgency, informational.
    if (missingHandshakeCount(decision) > 0) {
      await notify({
        userId,
        type: "SYSTEM",
        severity: "INFO",
        title: `Still bringing systems online for ${symbol}`,
        message:
          "A few of ARX's systems are still coming online for this market. The read will get sharper as they connect.",
        sourceBuild: "LL",
        dedupeKey: `AACI:HANDSHAKE:${userId}:${keySymbol}`,
        symbol: decision.symbol ?? undefined,
        relatedDecisionId: decision.decisionId,
      });
    }

    // 4) Explicit re-sync verdict — the desk wants things re-synced before this
    //    is trustworthy. Action-required, but advisory (never an execution gate).
    if (decision.recommendedAction === "RECONCILE_SYSTEM") {
      await notify({
        userId,
        type: "SYSTEM",
        severity: "WARNING",
        title: `Re-sync needed for ${symbol}`,
        message:
          "ARX needs to re-sync before this read can be trusted. Open the market and let it refresh, then check again.",
        sourceBuild: "LL",
        dedupeKey: `AACI:RECONCILE:${userId}:${keySymbol}`,
        symbol: decision.symbol ?? undefined,
        relatedDecisionId: decision.decisionId,
        actionRequired: true,
      });
    }
  } catch (err) {
    // Advisory alerts are best-effort. Never let a notification failure affect
    // the read that triggered it.
    logger.warn({ err }, "aaci: user alert emission failed (non-fatal)");
  }
}
