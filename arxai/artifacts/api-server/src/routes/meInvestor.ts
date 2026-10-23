// Investor Portal (Task #72) — per-investor, view-only read endpoints + the
// single intent-only allocation-submit write.
//
// SAFETY (inviolable):
// - STRICTLY per-user. Every query is scoped by req.authUser.id. No row from
//   investor A is ever returned to investor B.
// - Read-only by design. The ONLY mutation is POST /me/investor/allocation,
//   which records an intent-only allocation-preference REQUEST. It NEVER wires
//   into live sizing, the 16-gate live pipeline, kill switch, or any broker
//   surface. It only inserts a PENDING_APPROVAL preference row for an admin to
//   review.
// - No execution / admin / bridge / kill-switch surface is exposed here.
// - Metrics are honest: realized/unrealized P/L are 0 and performance is
//   reported as "no data" until a real source exists. NEVER guaranteed returns.

import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  investorAllocationPreferencesTable,
  investorStatementsTable,
  investorStatementEventsTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { assertActionAllowed, FundControlError } from "../lib/fundbook/fundControls.js";
import {
  ensureSettings,
  ensureStrategyProfiles,
  getProfile,
  getLedger,
  getPreferences,
  computeMetrics,
  computeEquitySeries,
  activePref,
  pendingPref,
  prefToDto,
  round2,
} from "../lib/investor/investorService.js";
import { streamStatementFile } from "../lib/investor/statementFiles.js";

const router = Router();

function uid(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

const SLEEVE_LABELS: Record<string, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

// ── GET /me/investor/overview ───────────────────────────────────────────────
router.get("/me/investor/overview", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const [profile, ledger, prefs] = await Promise.all([
    getProfile(userId),
    getLedger(userId),
    getPreferences(userId),
  ]);
  const m = computeMetrics(ledger);
  const active = activePref(prefs);
  const allocatedFunds = active ? m.currentValue : 0;
  const availableFunds = round2(m.currentValue - allocatedFunds);
  const status = profile?.status ?? "active";
  const currentRiskProfile = active?.profileKey ?? profile?.currentRiskProfile ?? null;

  const lastUpdatedCandidates = [
    profile?.updatedAt,
    ledger[0]?.createdAt,
    prefs[0]?.updatedAt,
  ].filter((d): d is Date => d instanceof Date);
  const lastUpdatedAt = lastUpdatedCandidates.length
    ? new Date(Math.max(...lastUpdatedCandidates.map((d) => d.getTime()))).toISOString()
    : null;

  res.json({
    ok: true,
    hasFunds: m.hasFunds,
    baseCurrency: profile?.baseCurrency ?? "USD",
    currentValue: m.currentValue,
    depositedTotal: m.depositedTotal,
    withdrawnTotal: m.withdrawnTotal,
    netContributed: m.netContributed,
    allocatedFunds: round2(allocatedFunds),
    availableFunds,
    realizedPnl: m.realizedPnl,
    unrealizedPnl: m.unrealizedPnl,
    monthlyReturnPct: m.monthlyReturnPct,
    allTimeReturnPct: m.allTimeReturnPct,
    hasPerformanceData: m.hasPerformanceData,
    currentRiskProfile,
    status,
    pausedReason: profile?.pausedReason ?? null,
    lastUpdatedAt,
  });
});

// ── GET /me/investor/allocation ─────────────────────────────────────────────
router.get("/me/investor/allocation", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const [profile, prefs, settings, strategyProfiles] = await Promise.all([
    getProfile(userId),
    getPreferences(userId),
    ensureSettings(),
    ensureStrategyProfiles(),
  ]);

  const active = activePref(prefs);
  const pending = pendingPref(prefs);
  const allocationPaused = (profile?.status ?? "active") === "paused";
  const canSubmit = !allocationPaused && !pending;

  res.json({
    ok: true,
    status: profile?.status ?? "active",
    allocationPaused,
    pausedReason: profile?.pausedReason ?? null,
    maxAggressivePct: settings.maxAggressivePct,
    riskDisclosureVersion: settings.riskDisclosureVersion,
    canSubmit,
    active: active ? prefToDto(active) : null,
    pending: pending ? prefToDto(pending) : null,
    profiles: strategyProfiles.map((p) => ({
      profileKey: p.profileKey,
      label: p.label,
      description: p.description ?? null,
      conservativePct: p.conservativePct,
      balancedPct: p.balancedPct,
      aggressivePct: p.aggressivePct,
    })),
    history: prefs.map(prefToDto),
  });
});

// ── POST /me/investor/allocation ────────────────────────────────────────────
// Intent-only. Records a PENDING_APPROVAL allocation-preference request.
const submitSchema = z.object({
  profileKey: z.enum(["CONSERVATIVE", "BALANCED", "AGGRESSIVE", "CUSTOM"]),
  conservativePct: z.number().int().min(0).max(100).optional(),
  balancedPct: z.number().int().min(0).max(100).optional(),
  aggressivePct: z.number().int().min(0).max(100).optional(),
  riskDisclosureAccepted: z.boolean(),
});

router.post("/me/investor/allocation", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid allocation request." });
    return;
  }
  const body = parsed.data;
  if (!body.riskDisclosureAccepted) {
    res.status(400).json({
      ok: false,
      error: "DISCLOSURE_REQUIRED",
      message: "You must acknowledge the risk disclosure before submitting.",
    });
    return;
  }

  const [profile, prefs, settings, strategyProfiles] = await Promise.all([
    getProfile(userId),
    getPreferences(userId),
    ensureSettings(),
    ensureStrategyProfiles(),
  ]);

  if ((profile?.status ?? "active") === "paused") {
    res.status(409).json({
      ok: false,
      error: "ALLOCATION_PAUSED",
      message: "Allocation changes are paused on your account. Contact your administrator.",
    });
    return;
  }
  if (pendingPref(prefs)) {
    res.status(409).json({
      ok: false,
      error: "PENDING_REQUEST_EXISTS",
      message: "You already have an allocation request awaiting review.",
    });
    return;
  }

  // Fund-control freezes (Task #133): refuse new allocation requests while the
  // ALLOCATION scope or this investor is frozen for verification. Investor-safe
  // message only — never an internal.
  try {
    await assertActionAllowed(["ALLOCATION"]);
    await assertActionAllowed(["INVESTOR"], { scopeKey: String(userId) });
  } catch (err) {
    if (err instanceof FundControlError) {
      res.status(err.httpStatus).json({
        ok: false,
        error: "ALLOCATION_PAUSED",
        message: err.investorMessage,
      });
      return;
    }
    throw err;
  }

  // Resolve the sleeve split: presets pull from the configured profile; CUSTOM
  // uses the investor-provided split.
  let conservativePct: number;
  let balancedPct: number;
  let aggressivePct: number;
  if (body.profileKey === "CUSTOM") {
    conservativePct = body.conservativePct ?? 0;
    balancedPct = body.balancedPct ?? 0;
    aggressivePct = body.aggressivePct ?? 0;
  } else {
    const preset = strategyProfiles.find((p) => p.profileKey === body.profileKey);
    if (!preset) {
      res.status(400).json({ ok: false, error: "UNKNOWN_PROFILE", message: "Unknown strategy profile." });
      return;
    }
    conservativePct = preset.conservativePct;
    balancedPct = preset.balancedPct;
    aggressivePct = preset.aggressivePct;
  }

  const sum = conservativePct + balancedPct + aggressivePct;
  if (sum !== 100) {
    res.status(400).json({
      ok: false,
      error: "SUM_NOT_100",
      message: "Allocation percentages must sum to exactly 100.",
    });
    return;
  }
  if (aggressivePct > settings.maxAggressivePct) {
    res.status(400).json({
      ok: false,
      error: "AGGRESSIVE_CAP_EXCEEDED",
      message: `Aggressive allocation cannot exceed ${settings.maxAggressivePct}%.`,
    });
    return;
  }

  const now = new Date();
  const inserted = await db
    .insert(investorAllocationPreferencesTable)
    .values({
      userId,
      profileKey: body.profileKey,
      conservativePct,
      balancedPct,
      aggressivePct,
      status: "PENDING_APPROVAL",
      riskDisclosureVersion: settings.riskDisclosureVersion,
      riskDisclosureAcceptedAt: now,
      submittedAt: now,
    })
    .returning();

  const newPref = inserted[0];
  const allPrefs = [newPref, ...prefs];
  const active = activePref(allPrefs);

  res.json({
    ok: true,
    status: profile?.status ?? "active",
    allocationPaused: false,
    pausedReason: null,
    maxAggressivePct: settings.maxAggressivePct,
    riskDisclosureVersion: settings.riskDisclosureVersion,
    canSubmit: false,
    active: active ? prefToDto(active) : null,
    pending: prefToDto(newPref),
    profiles: strategyProfiles.map((p) => ({
      profileKey: p.profileKey,
      label: p.label,
      description: p.description ?? null,
      conservativePct: p.conservativePct,
      balancedPct: p.balancedPct,
      aggressivePct: p.aggressivePct,
    })),
    history: allPrefs.map(prefToDto),
  });
});

// ── GET /me/investor/performance ────────────────────────────────────────────
router.get("/me/investor/performance", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const [profile, ledger] = await Promise.all([getProfile(userId), getLedger(userId)]);
  const m = computeMetrics(ledger);
  // Real, dated, per-user equity history derived from the append-only ledger.
  // Empty when there is no recorded activity, so the equity curve stays honest.
  const series = computeEquitySeries(ledger);

  res.json({
    ok: true,
    // The Performance tab's empty state is gated on REAL recorded performance
    // figures (PERFORMANCE ledger rows), not on contribution-only activity, so
    // an investor with deposits but no recorded returns still sees the honest
    // "no performance recorded yet" empty state.
    hasPerformanceData: m.hasPerformanceData,
    baseCurrency: profile?.baseCurrency ?? "USD",
    realizedPnl: m.realizedPnl,
    unrealizedPnl: m.unrealizedPnl,
    monthlyReturnPct: m.monthlyReturnPct,
    allTimeReturnPct: m.allTimeReturnPct,
    series,
  });
});

// ── GET /me/investor/exposure ───────────────────────────────────────────────
router.get("/me/investor/exposure", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const [profile, ledger, prefs] = await Promise.all([
    getProfile(userId),
    getLedger(userId),
    getPreferences(userId),
  ]);
  const m = computeMetrics(ledger);
  const active = activePref(prefs);
  const baseCurrency = profile?.baseCurrency ?? "USD";

  const sleeves = active
    ? (["conservative", "balanced", "aggressive"] as const).map((key) => {
        const pct =
          key === "conservative"
            ? active.conservativePct
            : key === "balanced"
              ? active.balancedPct
              : active.aggressivePct;
        return {
          key,
          label: SLEEVE_LABELS[key],
          pct,
          amount: round2((m.currentValue * pct) / 100),
        };
      })
    : [];

  res.json({
    ok: true,
    hasActiveAllocation: Boolean(active),
    baseCurrency,
    currentValue: m.currentValue,
    currentRiskProfile: active?.profileKey ?? profile?.currentRiskProfile ?? null,
    sleeves,
  });
});

// ── GET /me/investor/activity ───────────────────────────────────────────────
router.get("/me/investor/activity", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const [ledger, prefs, statementEvents] = await Promise.all([
    getLedger(userId),
    getPreferences(userId),
    db
      .select()
      .from(investorStatementEventsTable)
      .where(eq(investorStatementEventsTable.userId, userId))
      .orderBy(sql`${investorStatementEventsTable.createdAt} DESC`)
      .limit(100),
  ]);

  type Item = {
    id: string;
    kind: string;
    title: string;
    detail: string | null;
    amount: number | null;
    at: string;
  };
  const items: Item[] = [];

  for (const e of ledger) {
    const label =
      e.entryType === "DEPOSIT" ? "Deposit" : e.entryType === "WITHDRAWAL" ? "Withdrawal" : "Adjustment";
    items.push({
      id: `ledger-${e.id}`,
      kind: `LEDGER_${e.entryType}`,
      title: label,
      detail: e.reason,
      amount: round2(Number(e.signedAmount)),
      at: e.createdAt.toISOString(),
    });
  }

  for (const p of prefs) {
    items.push({
      id: `alloc-submit-${p.id}`,
      kind: "ALLOCATION_SUBMITTED",
      title: `Allocation request submitted (${p.profileKey})`,
      detail: `${p.conservativePct}/${p.balancedPct}/${p.aggressivePct}`,
      amount: null,
      at: (p.submittedAt ?? p.createdAt).toISOString(),
    });
    if (p.status === "ACTIVE" && p.activatedAt) {
      items.push({
        id: `alloc-active-${p.id}`,
        kind: "ALLOCATION_APPROVED",
        title: `Allocation approved (${p.profileKey})`,
        detail: p.reviewNote ?? null,
        amount: null,
        at: p.activatedAt.toISOString(),
      });
    } else if (p.status === "REJECTED" && p.reviewedAt) {
      items.push({
        id: `alloc-reject-${p.id}`,
        kind: "ALLOCATION_REJECTED",
        title: "Allocation request rejected",
        detail: p.reviewNote ?? null,
        amount: null,
        at: p.reviewedAt.toISOString(),
      });
    }
  }

  // Statement change events — investor-facing transparency in the activity feed
  // (Task #101). Plain-English titles; the reason is the detail. No internal
  // names, no table/route/status-code wording.
  const statementEventTitle: Record<string, string> = {
    CORRECT: "A statement was corrected",
    REPLACE: "A statement was replaced",
    REMOVE: "A statement was removed",
    RESTORE: "A statement was restored",
    SUPERSEDE: "A statement was superseded",
  };
  for (const ev of statementEvents) {
    items.push({
      id: `statement-event-${ev.id}`,
      kind: `STATEMENT_${ev.action}`,
      title: statementEventTitle[ev.action] ?? "A statement was updated",
      detail: ev.reason,
      amount: null,
      at: ev.createdAt.toISOString(),
    });
  }

  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  res.json({ ok: true, items });
});

// ── Plain-English statement status (Task #101) ──────────────────────────────
// Investor-facing wording only. NEVER expose internal/table/route/status-code
// names. ACTIVE statements carry no note. DRAFT/PENDING_REVIEW are internal
// work-in-progress and are hidden from the investor entirely.
const INVESTOR_HIDDEN_STATEMENT_STATUSES = new Set(["DRAFT", "PENDING_REVIEW"]);
function statementStatusLabel(status: string): string {
  switch (status) {
    case "ACTIVE": return "Active";
    case "CORRECTED": return "Corrected";
    case "REPLACED": return "Replaced";
    case "REMOVED": return "Removed";
    case "SUPERSEDED": return "Superseded";
    default: return "Active";
  }
}
function fmtNoteDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
function statementInvestorNote(
  status: string,
  reason: string | null,
  changedAt: Date | null,
  hasReplacement: boolean,
): string | null {
  const when = changedAt ? ` on ${fmtNoteDate(changedAt)}` : "";
  const why = reason && reason.trim().length > 0 ? ` Reason: ${reason.trim()}` : "";
  switch (status) {
    case "CORRECTED":
      return `This statement was corrected${when}.${why}`;
    case "REPLACED":
      return hasReplacement
        ? `This statement was replaced by a newer version${when}.${why} Please view the current statement below.`
        : `This statement was replaced${when}.${why}`;
    case "REMOVED":
      return `This statement was removed${when} and is no longer available for download.${why}`;
    case "SUPERSEDED":
      return hasReplacement
        ? `This statement is no longer current — a newer version is available${when}.${why}`
        : `This statement is no longer current${when}.${why}`;
    default:
      return null;
  }
}

// ── GET /me/investor/documents ──────────────────────────────────────────────
router.get("/me/investor/documents", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const rows = await db
    .select()
    .from(investorStatementsTable)
    .where(eq(investorStatementsTable.userId, userId))
    .orderBy(sql`${investorStatementsTable.createdAt} DESC`);

  const visible = rows.filter((r) => !INVESTOR_HIDDEN_STATEMENT_STATUSES.has(r.status));

  // Build a title map from investor-VISIBLE rows only (scoped to this investor
  // — never another tenant's row). A replacement that points at a hidden
  // (DRAFT/PENDING_REVIEW) statement is therefore never surfaced to the
  // investor — neither its id nor its title leaks through.
  const titleById = new Map(visible.map((r) => [r.id, r.title]));

  res.json({
    ok: true,
    items: visible.map((r) => {
      const isRemoved = r.status === "REMOVED";
      const isCurrent = r.status === "ACTIVE" || r.status === "CORRECTED";
      // A replacement is only surfaced if it's a real, investor-visible row.
      const replRow =
        r.replacementStatementId != null && titleById.has(r.replacementStatementId)
          ? r.replacementStatementId
          : null;
      const note = statementInvestorNote(
        r.status,
        r.statusReason ?? null,
        r.statusChangedAt ?? null,
        replRow != null,
      );
      return {
        id: r.id,
        title: r.title,
        periodLabel: r.periodLabel ?? null,
        statementType: r.statementType,
        summary: r.summary ?? null,
        // Download is disabled for removed statements.
        fileUrl: isRemoved ? null : r.fileUrl ?? null,
        status: r.status,
        statusLabel: statementStatusLabel(r.status),
        note,
        downloadable: !isRemoved && Boolean(r.fileUrl),
        isCurrent,
        statusChangedAt: r.statusChangedAt ? r.statusChangedAt.toISOString() : null,
        // Honest "Updated <date>" signal: set only when the statement's content
        // was edited after publish (NULL = never edited). Distinct from
        // createdAt (the publish date). No admin id or audit reason is exposed.
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
        replacementStatementId: replRow,
        replacementTitle: replRow != null ? titleById.get(replRow) ?? null : null,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  });
});

// ── GET /me/investor/documents/:statementId/file — serve uploaded file ───────
// Scoped to the requesting investor (WHERE id AND userId): no cross-investor
// access. External-link statements 404 here (the UI links to those directly).
router.get("/me/investor/documents/:statementId/file", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const statementId = Number(req.params.statementId);
  if (!Number.isInteger(statementId)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }

  const [row] = await db
    .select()
    .from(investorStatementsTable)
    .where(and(eq(investorStatementsTable.id, statementId), eq(investorStatementsTable.userId, userId)))
    .limit(1);
  if (!row) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Document not found." }); return; }
  // Mirror the documents-list gate on the direct download path: internal-only
  // statuses (DRAFT/PENDING_REVIEW) are never investor-visible, and a REMOVED
  // statement is "no longer available for download" — the object survives in
  // storage for a later admin RESTORE, but the investor cannot stream it while
  // removed. Without this an investor could download a removed/hidden statement
  // by hitting this route directly with a known id.
  if (INVESTOR_HIDDEN_STATEMENT_STATUSES.has(row.status) || row.status === "REMOVED") {
    res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Document not found." });
    return;
  }
  await streamStatementFile(req, res, row.fileUrl);
});

export default router;
