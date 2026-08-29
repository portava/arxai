// Capability #37 — the authority expiry sweep (automatic REDUCTION only).
//
// A grant expiring must actually lower the persisted ladders that were raised
// under it. This worker walks the two ladders and REDUCES any level standing
// above its baseline that no active grant covers any more:
//   * profit_missions.automationLevel > 2 → back to 2 (+ liveAutoEnabled off),
//   * self_trade_agents.autonomyLevel > 0 → back to 0.
// Every demotion is journaled. The worker can ONLY lower autonomy — there is
// no code path here that raises anything, which is what makes it safe to run
// unattended (AUTO authority changes only REDUCE).
//
// FAIL-INERT on unreadable evidence: if the grants ledger cannot be read, the
// sweep does NOTHING and logs loudly. Mass-demoting on a DB blip would be
// acting on fabricated absence-of-evidence; the raise-time gate is the
// fail-closed side of this contract.
//
// Worker idiom mirrors missionDriver: unref'd interval, non-overlapping,
// per-item try/catch, env opt-out logged loudly, registered in index.ts.

import { and, eq, gt, inArray } from "drizzle-orm";
import {
  db,
  authorityGrantsTable,
  profitMissionsTable,
  missionEventsTable,
  selfTradeAgentsTable,
} from "@workspace/db";
import {
  resolveAuthorityCeiling,
  AUTHORITY_BASELINES,
} from "@workspace/domain/safety-contracts/authorityGrants";
import { logger } from "../logger.js";
import { writeSelfTradeAudit } from "../selfTrade/audit.js";

export const AUTHORITY_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const DISABLE_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

export function authoritySweepEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

export interface AuthoritySweepResult {
  checkedMissions: number;
  demotedMissions: number;
  checkedAgents: number;
  demotedAgents: number;
  skipped: boolean;
  skipReason: string | null;
}

/** One sweep pass. Exported for tests; production runs it on the interval. */
export async function runAuthorityExpirySweep(now: Date = new Date()): Promise<AuthoritySweepResult> {
  const result: AuthoritySweepResult = {
    checkedMissions: 0, demotedMissions: 0, checkedAgents: 0, demotedAgents: 0,
    skipped: false, skipReason: null,
  };

  // ── Evidence read: the whole grants ledger, once. Unreadable → inert. ──────
  let grants: (typeof authorityGrantsTable.$inferSelect)[];
  try {
    grants = await db.select().from(authorityGrantsTable);
  } catch (err) {
    result.skipped = true;
    result.skipReason = `AUTHORITY_LEDGER_UNREADABLE: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
    logger.warn({ reason: result.skipReason }, "authority_sweep_skipped — ledger unreadable, NOTHING was demoted");
    return result;
  }

  const missionBaseline = AUTHORITY_BASELINES.MISSION_AUTOMATION_LEVEL;
  const agentBaseline = AUTHORITY_BASELINES.AGENT_AUTONOMY_LEVEL;

  // ── Missions standing above baseline. ──────────────────────────────────────
  try {
    const elevated = await db
      .select({
        id: profitMissionsTable.id,
        userId: profitMissionsTable.userId,
        automationLevel: profitMissionsTable.automationLevel,
        status: profitMissionsTable.status,
      })
      .from(profitMissionsTable)
      .where(and(
        gt(profitMissionsTable.automationLevel, missionBaseline),
        inArray(profitMissionsTable.status, ["draft", "running", "paused", "protect_mode"]),
      ));
    for (const m of elevated) {
      result.checkedMissions += 1;
      try {
        const userGrants = grants.filter((g) => g.userId === m.userId);
        const ceiling = resolveAuthorityCeiling({
          kind: "MISSION_AUTOMATION_LEVEL",
          scopeType: "MISSION",
          scopeRef: String(m.id),
          now,
          grants: userGrants,
        });
        if (m.automationLevel <= ceiling.ceiling) continue;
        await db
          .update(profitMissionsTable)
          .set({ automationLevel: missionBaseline, liveAutoEnabled: false, updatedAt: now })
          .where(and(eq(profitMissionsTable.id, m.id), eq(profitMissionsTable.userId, m.userId)));
        await db.insert(missionEventsTable).values({
          missionId: m.id,
          type: "authority_grant_lapsed",
          message: `Automation level reduced ${m.automationLevel} → ${missionBaseline}: the authority grant backing it expired or was revoked. Raising again requires a fresh owner-pressed grant.`,
          metadataJson: { fromLevel: m.automationLevel, toLevel: missionBaseline, ceiling: ceiling.ceiling, reasons: ceiling.reasons },
        });
        result.demotedMissions += 1;
      } catch (err) {
        logger.warn({ missionId: m.id, err: err instanceof Error ? err.message : String(err) }, "authority_sweep mission demotion failed (non-fatal)");
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "authority_sweep mission scan failed (non-fatal)");
  }

  // ── Agents standing above baseline. ────────────────────────────────────────
  try {
    const elevated = await db
      .select({
        id: selfTradeAgentsTable.id,
        ownerId: selfTradeAgentsTable.ownerId,
        createdByUserId: selfTradeAgentsTable.createdByUserId,
        autonomyLevel: selfTradeAgentsTable.autonomyLevel,
      })
      .from(selfTradeAgentsTable)
      .where(gt(selfTradeAgentsTable.autonomyLevel, agentBaseline));
    for (const a of elevated) {
      result.checkedAgents += 1;
      try {
        const governingUserId = a.ownerId ?? a.createdByUserId;
        // An agent with no attributable owner account has no ledger to read
        // through — leave it alone and say so, never guess an owner.
        if (governingUserId == null) {
          logger.warn({ agentId: a.id }, "authority_sweep agent has no governing user id — left untouched");
          continue;
        }
        const userGrants = grants.filter((g) => g.userId === governingUserId);
        const ceiling = resolveAuthorityCeiling({
          kind: "AGENT_AUTONOMY_LEVEL",
          scopeType: "STRATEGY",
          scopeRef: String(a.id),
          now,
          grants: userGrants,
        });
        if (a.autonomyLevel <= ceiling.ceiling) continue;
        await db.transaction(async (tx) => {
          await tx
            .update(selfTradeAgentsTable)
            .set({ autonomyLevel: agentBaseline, updatedAt: now })
            .where(eq(selfTradeAgentsTable.id, a.id));
          await writeSelfTradeAudit(tx, {
            agentId: a.id,
            eventType: "AUTONOMY_GRANT_LAPSED",
            actorUserId: null,
            actorRole: "SYSTEM",
            severity: "WARNING",
            beforeState: { autonomyLevel: a.autonomyLevel },
            afterState: { autonomyLevel: agentBaseline },
            reason: "Authority grant expired or revoked — autonomy reduced to baseline by the expiry sweep (reduce-only).",
          });
        });
        result.demotedAgents += 1;
      } catch (err) {
        logger.warn({ agentId: a.id, err: err instanceof Error ? err.message : String(err) }, "authority_sweep agent demotion failed (non-fatal)");
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "authority_sweep agent scan failed (non-fatal)");
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startAuthorityExpirySweepWorker(): void {
  if (timer) return;

  if (!authoritySweepEnabled(process.env["ARX_AUTHORITY_SWEEP_ENABLED"])) {
    logger.warn(
      { flag: "ARX_AUTHORITY_SWEEP_ENABLED" },
      "authority_sweep_DISABLED_by_env — expired authority grants will NOT automatically reduce persisted automation levels; raise-time checks still apply",
    );
    return;
  }

  timer = setInterval(() => {
    if (running) return;
    running = true;
    runAuthorityExpirySweep()
      .then((r) => {
        if (r.demotedMissions > 0 || r.demotedAgents > 0 || r.skipped) {
          logger.info(r as unknown as Record<string, unknown>, "authority_sweep_pass");
        }
      })
      .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "authority_sweep_failed"))
      .finally(() => { running = false; });
  }, AUTHORITY_SWEEP_INTERVAL_MS).unref();

  logger.info({ intervalMs: AUTHORITY_SWEEP_INTERVAL_MS }, "authority_sweep_started");
}

export function stopAuthorityExpirySweepWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
