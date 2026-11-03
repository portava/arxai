// ── Profit Mission Phase 9 — Mission Risk Certificate service (append-only) ────
//
// SAFETY / SCOPE:
//   - The certificate is the explicit, honest "this is not guaranteed and losses
//     are possible" acknowledgement required before any live-auto level. Acceptance
//     is APPEND-ONLY: every accepted confirmation is appended to
//     `certificateAcceptanceJson.acceptances` and the latest `certificateAcceptedAt`
//     is stamped — prior acceptances are never overwritten or deleted.
//   - Validation is fail-closed (exact phrase + explicit confirm). Accepting a
//     certificate NEVER grants live permission on its own — it only satisfies one
//     gate; all promotion + live gates still apply.
//   - Per-user / per-mission isolation: mutation loads the row FOR UPDATE scoped by
//     (id, userId); the acceptance is journalled + audited in the same transaction.
//   - Drawdown line: read from ONE closed-mission-draft FORWARD aggregate (the
//     newest qualifying record) via the pure selector. Generated-price BACKTEST,
//     unknown-source/legacy, invalid-metrics and zero-trade rows never contribute,
//     and no maximum is pooled across sources or contexts. When nothing qualifies
//     the line says "unavailable" with the reason instead of printing 0.0%. This
//     usually LOWERS the displayed figure versus the old pooled max (which mixed in
//     generated-price runs), so the disclosure wording is load-bearing: it names
//     the source, sample size, nominal starting-amount equity basis and the
//     unverified execution mode / net costs. Building the certificate is read-only:
//     it never changes mission level, live-auto opt-in or certificate state.
//   - Inherited cap: the selector sees at most the newest 200 projected results
//     (listMissionTestResults' limit, missionTestingLabService.ts). A mission whose
//     only closed-draft aggregate is older than its newest 200 results shows
//     "unavailable"; the cap is intentionally not widened here.
import { and, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionEventsTable,
  oneClickAuditTable,
} from "@workspace/db";
import {
  buildCertificateContent,
  selectCertificateObservedDrawdown,
  validateCertificateAcceptance,
  MISSION_CERTIFICATE_PHRASE,
  FIRST_LIVE_AUTO_LEVEL,
  isMissionAutomationLevel,
  type CertificateContent,
  type CertificateObservedDrawdown,
  type MissionAutomationLevel,
} from "@workspace/domain/profit-mission";
import { listMissionTestResults } from "./missionTestingLabService.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function loadOwnedMission(userId: number, missionId: number): Promise<MissionRow | null> {
  const rows = await db
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, missionId), eq(profitMissionsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Closed-draft drawdown record for the certificate (null when none qualifies). */
async function observedClosedDraftDrawdown(
  userId: number,
  missionId: number,
): Promise<CertificateObservedDrawdown | null> {
  // Owner-scoped (userId, missionId) and capped at the newest 200 projected rows.
  const results = await listMissionTestResults(userId, missionId, { limit: 200 });
  return selectCertificateObservedDrawdown(results);
}

/** Build the certificate content for a mission (honest, banned-vocab clean). */
export async function buildMissionCertificate(args: {
  userId: number;
  missionId: number;
  targetAutomationLevel?: number;
}): Promise<{ ok: true; content: CertificateContent } | { ok: false; kind: "not_found" }> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };

  const targetAutomationLevel: MissionAutomationLevel =
    args.targetAutomationLevel != null && isMissionAutomationLevel(args.targetAutomationLevel)
      ? args.targetAutomationLevel
      : FIRST_LIVE_AUTO_LEVEL;

  const content = buildCertificateContent({
    startingAmount: mission.startingAmount,
    targetAmount: mission.targetAmount,
    riskProfile: mission.riskProfile,
    targetAutomationLevel,
    observedDrawdown: await observedClosedDraftDrawdown(args.userId, args.missionId),
  });
  return { ok: true, content };
}

export type AcceptCertificateResult =
  | { ok: true; acceptedAt: string; acceptanceCount: number }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "invalid"; reason: string };

/**
 * Record an APPEND-ONLY certificate acceptance for a mission. Fail-closed: the
 * exact phrase + explicit confirmation are required. Never overwrites prior
 * acceptances.
 */
export async function acceptMissionCertificate(args: {
  userId: number;
  missionId: number;
  confirmed: unknown;
  phrase: unknown;
  targetAutomationLevel?: number;
  ip?: string | null;
  ua?: string | null;
}): Promise<AcceptCertificateResult> {
  const validation = validateCertificateAcceptance({ confirmed: args.confirmed, phrase: args.phrase });
  if (!validation.ok) {
    return { ok: false, kind: "invalid", reason: validation.reason ?? "invalid acceptance" };
  }

  return db.transaction(async (tx): Promise<AcceptCertificateResult> => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)))
      .for("update")
      .limit(1);
    const mission = rows[0];
    if (!mission) return { ok: false, kind: "not_found" };

    const now = new Date();
    const prior = asRecord(mission.certificateAcceptanceJson);
    const acceptances = Array.isArray(prior.acceptances) ? [...(prior.acceptances as unknown[])] : [];
    acceptances.push({
      phrase: MISSION_CERTIFICATE_PHRASE,
      acceptedAt: now.toISOString(),
      targetAutomationLevel:
        args.targetAutomationLevel != null && isMissionAutomationLevel(args.targetAutomationLevel)
          ? args.targetAutomationLevel
          : null,
      ip: args.ip ?? null,
      userAgent: args.ua ?? null,
    });

    await tx
      .update(profitMissionsTable)
      .set({
        certificateAcceptedAt: now,
        certificateAcceptanceJson: { acceptances },
        updatedAt: now,
      })
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)));

    await tx.insert(missionEventsTable).values({
      missionId: args.missionId,
      type: "mission_certificate_accepted",
      message: "Mission Risk Certificate accepted (not guaranteed; losses are possible).",
      metadataJson: { acceptanceCount: acceptances.length },
    });
    await tx.insert(oneClickAuditTable).values({
      userId: args.userId,
      action: "MISSION_CERTIFICATE_ACCEPTED",
      ip: args.ip ?? null,
      userAgent: args.ua ?? null,
      metadata: JSON.stringify({ missionId: args.missionId, acceptanceCount: acceptances.length }),
    });

    return { ok: true, acceptedAt: now.toISOString(), acceptanceCount: acceptances.length };
  });
}
