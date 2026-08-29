// ── The Learning Flywheel worker (B0–B7) — SHADOW-ONLY orchestration ────────
//
// One background pass every tick, missionDriver idiom (interval + non-
// overlapping + env opt-out + fail-soft per stage):
//
//   B0 assemble case files from the seams that exist (mission_trade_drafts +
//      economic_postings) — evidence rearranged, nothing derived;
//   B1 build rewards from broker-reconciled postings only (UNRECONCILED is
//      excluded, never guessed);
//   B2 recompute cohort NIG posteriors from RECONCILED rewards;
//   B4/B5 decay watch: change-point/posterior decay ⇒ shadow weight 0 AND the
//      reduce-only demotion seam is notified (injected by the composition
//      root; auto-DEMOTE allowed, promote never called — source-pinned);
//   B3 journal ONE shadow allocation record (discounted Thompson sampling,
//      promoted-eligible + clamps; mode SHADOW, authority NONE, no apply path);
//   B6 append the advisory OPE report over declined drafts;
//   B7 aggregate opted-in rewards into the anonymized cohort ledger.
//
// THE FLYWHEEL INVARIANT (inviolable, pinned by
// scripts/src/ci/check-flywheel-isolation.test.ts): nothing in this directory
// imports — directly or transitively — any floor, stop, gate-threshold,
// sizing, dispatch, or master-switch setter. Learning influences ALLOCATION
// JOURNALS only; while no edge is owner-promoted every journaled weight is 0
// by gate #20 semantics, and kellyCapGovernor independently holds real size
// at 0 without a measured edge_OOS.
//
// FAIL-SOFT: every stage runs in its own try/catch; an unreadable input skips
// that stage with an honest log (typed absence, never a fabricated row).

import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  missionTradeDraftsTable,
  economicPostingsTable,
  economicDiscrepanciesTable,
  productionEdgesTable,
  userPrivacySettingsTable,
  flywheelCaseFilesTable,
  flywheelRewardsTable,
  flywheelPosteriorsTable,
  flywheelAllocationJournalTable,
  flywheelOpeReportsTable,
  flywheelCohortOutcomesTable,
  type FlywheelRewardRow,
} from "@workspace/db";
import { findMarketByStandardSymbol } from "@workspace/markets";
import { logger } from "../logger.js";
import { shadowCaptureFAF } from "../auditVault.js";
import { buildDraftCounterfactual } from "../draftCounterfactual.js";
import {
  assembleCaseFile,
  type CaseDraftEvidence,
  type CasePostingEvidence,
} from "./caseFile.js";
import { buildReward, type RewardPostingLeg } from "./rewardBuilder.js";
import {
  FLYWHEEL_NIG_PRIOR,
  cohortKeyOf,
  mulberry32,
  nigUpdate,
  posteriorStatus,
} from "./posterior.js";
import { computeShadowAllocation, type BanditArm } from "./bandit.js";
import { decideEdgeDecay, type DemotionNotifier } from "./decayDemotion.js";
import { aggregateCohortOutcomes, type CohortContribution } from "./cohortLedger.js";
import type { DeclinedDraftEvidence } from "./ope.js";
import { buildOpeReport } from "./ope.js";

export const FLYWHEEL_INTERVAL_MS = 5 * 60 * 1000;
/** How much wall time equals one exponential-forgetting step (B3). */
export const FLYWHEEL_DISCOUNT_STEP_MS = 24 * 60 * 60 * 1000;
const MAX_DRAFTS_PER_PASS = 200;
const MAX_REWARD_ROWS = 5000;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the flywheel worker enabled? Absent env = ENABLED. */
export function flywheelEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

export interface FlywheelPassResult {
  caseFilesAssembled: number;
  rewardsBuilt: number;
  rewardsUnreconciled: number;
  posteriorsUpdated: number;
  decayed: number;
  demotionsNotified: number;
  allocationJournaled: boolean;
  opeReported: boolean;
  cohortsAggregated: number;
  stageErrors: string[];
}

export interface FlywheelDeps {
  /**
   * The reduce-only demotion seam (B4/B5). Wired by the composition root
   * (index.ts) to the shadow registry's demote(); absent (tests, unwired
   * boots) decay is journaled but the demotion notification is honestly
   * logged as NOT delivered.
   */
  notifyDemotion?: DemotionNotifier;
}

// Change-only memory: cohorts already notified as decayed (avoid re-demoting
// every 5 minutes on the same standing verdict).
const notifiedDecays = new Set<string>();

/** Tests only. */
export function resetFlywheelState(): void {
  notifiedDecays.clear();
}

function toBigIntOrNull(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

/** One full flywheel pass. Fail-soft per stage. */
export async function runFlywheelPass(
  deps: FlywheelDeps = {},
  opts: { nowMs?: number } = {},
): Promise<FlywheelPassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const passId = `fw_${nowMs}_${createHash("sha256").update(String(nowMs)).digest("hex").slice(0, 8)}`;
  const result: FlywheelPassResult = {
    caseFilesAssembled: 0,
    rewardsBuilt: 0,
    rewardsUnreconciled: 0,
    posteriorsUpdated: 0,
    decayed: 0,
    demotionsNotified: 0,
    allocationJournaled: false,
    opeReported: false,
    cohortsAggregated: 0,
    stageErrors: [],
  };

  // ── B0 + B1: case files and rewards ──────────────────────────────────────
  try {
    const drafts = await db
      .select()
      .from(missionTradeDraftsTable)
      .orderBy(desc(missionTradeDraftsTable.updatedAt))
      .limit(MAX_DRAFTS_PER_PASS);

    const commandIds = drafts
      .map((d) => d.commandId)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    const postingRows = commandIds.length > 0
      ? await db
          .select()
          .from(economicPostingsTable)
          .where(inArray(economicPostingsTable.commandId, commandIds))
      : [];
    const postingsByCommand = new Map<string, typeof postingRows>();
    for (const p of postingRows) {
      if (!p.commandId) continue;
      const arr = postingsByCommand.get(p.commandId) ?? [];
      arr.push(p);
      postingsByCommand.set(p.commandId, arr);
    }

    for (const d of drafts) {
      try {
        const draftEvidence: CaseDraftEvidence = {
          draftId: d.draftId,
          missionId: d.missionId ?? null,
          userId: d.userId,
          agentKey: d.agentKey,
          symbol: d.symbol,
          direction: d.direction,
          entryPrice: d.entryPrice ?? null,
          stopLoss: d.stopLoss ?? null,
          takeProfit: d.takeProfit ?? null,
          lot: d.lot ?? null,
          riskAmount: d.riskAmount ?? null,
          expectedR: d.expectedR ?? null,
          status: d.status,
          reason: d.reason ?? null,
          edgeJson: d.edgeJson ?? null,
          resultJson: d.resultJson ?? null,
          commandId: d.commandId ?? null,
          brokerTicket: d.brokerTicket ?? null,
          pnl: d.pnl ?? null,
          rMultiple: d.rMultiple ?? null,
          exitReason: d.exitReason ?? null,
          createdAt: d.createdAt ?? null,
          approvedAt: d.approvedAt ?? null,
          closedAt: d.closedAt ?? null,
        };
        const casePostings: CasePostingEvidence[] = (d.commandId ? postingsByCommand.get(d.commandId) ?? [] : []).map((p) => ({
          journalId: p.journalId,
          kind: p.kind,
          source: p.source,
          ledger: p.ledger,
          valueUnknown: p.valueUnknown,
          effectiveAt: p.effectiveAt,
        }));
        const cf = assembleCaseFile(draftEvidence, casePostings);
        await db
          .insert(flywheelCaseFilesTable)
          .values({
            caseId: cf.caseId,
            userId: cf.userId,
            missionId: cf.missionId,
            strategyId: cf.strategyId,
            symbol: cf.symbol,
            direction: cf.direction,
            regimeLabel: cf.regimeLabel,
            phase: cf.phase,
            beforeJson: cf.before,
            duringJson: cf.during,
            afterJson: cf.after,
            provenanceJson: cf.provenance,
            completeness: cf.completeness,
            missingJson: cf.missing,
            commandId: cf.commandId,
            brokerTicket: cf.brokerTicket,
            ledger: cf.ledger,
            assembledAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: flywheelCaseFilesTable.caseId,
            set: {
              phase: cf.phase,
              beforeJson: cf.before,
              duringJson: cf.during,
              afterJson: cf.after,
              provenanceJson: cf.provenance,
              completeness: cf.completeness,
              missingJson: cf.missing,
              commandId: cf.commandId,
              brokerTicket: cf.brokerTicket,
              ledger: cf.ledger,
              regimeLabel: cf.regimeLabel,
              assembledAt: now,
              updatedAt: now,
            },
          });
        result.caseFilesAssembled += 1;

        // B1 — reward, only for cases whose postings exist (RECONCILED phase).
        if (cf.phase !== "RECONCILED" || !d.commandId) continue;
        const legs: RewardPostingLeg[] = (postingsByCommand.get(d.commandId) ?? []).map((p) => ({
          journalId: p.journalId,
          kind: p.kind,
          account: p.account,
          amountMinor: toBigIntOrNull(p.amountMinor) ?? 0n,
          currency: p.currency,
          scale: p.scale,
          valueUnknown: p.valueUnknown,
          ledger: p.ledger,
        }));

        // Equity base: broker-reconciled baseline + posting-ledger cash from
        // the accounting spine's latest reconciliation observation. No
        // observation ⇒ honest null ⇒ UNRECONCILED reward.
        let equityBaseMinor: bigint | null = null;
        const ledgerForEquity = legs.length > 0 ? legs[0]!.ledger : null;
        if (ledgerForEquity) {
          const [obs] = await db
            .select()
            .from(economicDiscrepanciesTable)
            .where(and(
              eq(economicDiscrepanciesTable.userId, d.userId),
              eq(economicDiscrepanciesTable.ledger, ledgerForEquity),
            ))
            .orderBy(desc(economicDiscrepanciesTable.observedAt))
            .limit(1);
          if (obs) {
            const baseline = toBigIntOrNull(obs.baselineMinor) ?? 0n;
            const cash = toBigIntOrNull(obs.ledgerCashMinor) ?? 0n;
            const eq_ = baseline + cash;
            equityBaseMinor = eq_ > 0n ? eq_ : null;
          }
        }

        const reward = buildReward({
          caseId: cf.caseId,
          userId: d.userId,
          strategyId: cf.strategyId,
          regimeLabel: cf.regimeLabel,
          instrument: cf.symbol,
          postings: legs,
          equityBaseMinor,
        });
        await db
          .insert(flywheelRewardsTable)
          .values({
            rewardId: reward.rewardId,
            caseId: reward.caseId,
            userId: reward.userId,
            ledger: reward.ledger ?? "UNKNOWN",
            strategyId: reward.strategyId,
            regimeLabel: reward.regimeLabel,
            instrument: reward.instrument,
            status: reward.status,
            netLogReturn: reward.netLogReturn,
            netPnlMinor: reward.netPnlMinor,
            equityBaseMinor: reward.equityBaseMinor,
            currency: reward.currency,
            scale: reward.scale,
            journalIdsJson: reward.journalIds,
            reasonsJson: reward.reasons,
            computedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: flywheelRewardsTable.rewardId,
            set: {
              status: reward.status,
              netLogReturn: reward.netLogReturn,
              netPnlMinor: reward.netPnlMinor,
              equityBaseMinor: reward.equityBaseMinor,
              currency: reward.currency,
              scale: reward.scale,
              journalIdsJson: reward.journalIds,
              reasonsJson: reward.reasons,
              computedAt: now,
              updatedAt: now,
            },
          });
        result.rewardsBuilt += 1;
        if (reward.status === "UNRECONCILED") result.rewardsUnreconciled += 1;
      } catch (err) {
        result.stageErrors.push(`B0/B1 draft ${d.draftId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.stageErrors.push(`B0/B1: ${msg}`);
    logger.warn({ err: msg }, "flywheel B0/B1 pass failed (skipped, fail-soft — apply docs/migrations-pending/build-flywheel-machinery.sql if tables are missing)");
  }

  // ── B2 + B4/B5 + B3: posteriors, decay watch, shadow allocation journal ──
  try {
    const rewardRows: FlywheelRewardRow[] = await db
      .select()
      .from(flywheelRewardsTable)
      .where(eq(flywheelRewardsTable.status, "RECONCILED"))
      .orderBy(desc(flywheelRewardsTable.id))
      .limit(MAX_REWARD_ROWS);
    rewardRows.reverse(); // chronological

    const byCohort = new Map<string, FlywheelRewardRow[]>();
    for (const r of rewardRows) {
      const key = cohortKeyOf(r.strategyId, r.regimeLabel, r.instrument);
      const arr = byCohort.get(key) ?? [];
      arr.push(r);
      byCohort.set(key, arr);
    }

    // Promoted-eligibility (gate #20 semantics): ONLY an owner-pressed
    // liveAllowed=true production edge (matched by its versionTag — the
    // edge-library's strategy identifier) makes a strategy promoted-eligible.
    // No code path sets liveAllowed true, so until the owner presses, every
    // shadow weight below journals 0 — exactly the front's contract.
    const promotedStrategies = new Set<string>();
    try {
      const edges = await db
        .select({ versionTag: productionEdgesTable.versionTag, liveAllowed: productionEdgesTable.liveAllowed })
        .from(productionEdgesTable)
        .limit(1000);
      for (const e of edges) {
        if (e.liveAllowed === true && typeof e.versionTag === "string") promotedStrategies.add(e.versionTag);
      }
    } catch (err) {
      result.stageErrors.push(`B3 eligibility read: ${err instanceof Error ? err.message : String(err)}`);
      // Fail CLOSED: an unreadable eligibility set promotes nothing.
    }

    const decayEvents: Array<{ cohortKey: string; strategyId: string; reasons: string[] }> = [];
    const arms: BanditArm[] = [];
    for (const [cohortKey, rows] of byCohort) {
      const first = rows[0]!;
      const series = rows
        .map((r) => r.netLogReturn)
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      const posterior = nigUpdate(FLYWHEEL_NIG_PRIOR, series);
      const status = posteriorStatus(posterior.n);
      await db
        .insert(flywheelPosteriorsTable)
        .values({
          cohortKey,
          strategyId: first.strategyId,
          regimeLabel: first.regimeLabel,
          instrument: first.instrument,
          mu: posterior.mu,
          kappa: posterior.kappa,
          alpha: posterior.alpha,
          beta: posterior.beta,
          sampleCount: posterior.n,
          status,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: flywheelPosteriorsTable.cohortKey,
          set: {
            mu: posterior.mu,
            kappa: posterior.kappa,
            alpha: posterior.alpha,
            beta: posterior.beta,
            sampleCount: posterior.n,
            status,
            updatedAt: now,
          },
        });
      result.posteriorsUpdated += 1;

      // B4/B5 — decay verdict + reduce-only notification (change-only).
      const verdict = decideEdgeDecay({
        strategyId: first.strategyId,
        cohortKey,
        rewardSeries: series,
        posterior,
      });
      if (verdict.decayed) {
        result.decayed += 1;
        decayEvents.push({ cohortKey, strategyId: first.strategyId, reasons: verdict.reasons });
        if (!notifiedDecays.has(cohortKey)) {
          notifiedDecays.add(cohortKey);
          shadowCaptureFAF({
            source: "FLYWHEEL",
            systemMode: null,
            globalState: null,
            eventType: "FLYWHEEL_EDGE_DECAY",
            severity: "WARN",
            payload: {
              cohortKey,
              strategyId: first.strategyId,
              reasons: verdict.reasons,
              detection: verdict.detection,
              note: "Shadow weight forced to 0; reduce-only demotion seam notified. Recovery stays owner-gated.",
            },
          });
          if (deps.notifyDemotion) {
            deps.notifyDemotion(
              first.strategyId,
              `flywheel edge decay (${cohortKey}): ${verdict.reasons[0] ?? "decayed"}`,
            );
            result.demotionsNotified += 1;
          } else {
            logger.warn(
              { cohortKey, strategyId: first.strategyId },
              "flywheel_decay_demotion_NOT_delivered — no demotion notifier wired (decay journaled; weight already 0)",
            );
          }
        }
      }

      const newestMs = rows.reduce((m, r) => Math.max(m, r.computedAt ? r.computedAt.getTime() : 0), 0);
      arms.push({
        strategyId: first.strategyId,
        cohortKey,
        posterior,
        promotedEligible: promotedStrategies.has(first.strategyId),
        decayed: verdict.decayed,
        stalenessSteps: newestMs > 0 ? Math.floor((nowMs - newestMs) / FLYWHEEL_DISCOUNT_STEP_MS) : 0,
      });
    }

    // B3 — ONE shadow allocation journal record per pass (append-only).
    if (arms.length > 0) {
      const seed = parseInt(createHash("sha256").update(passId).digest("hex").slice(0, 8), 16);
      const record = computeShadowAllocation(arms, mulberry32(seed));
      await db.insert(flywheelAllocationJournalTable).values({
        passId,
        mode: record.mode,
        authority: record.authority,
        weightsJson: record.weights,
        clampJson: record.clamp,
        decayJson: decayEvents,
        posteriorsUsed: record.posteriorsUsed,
        computedAt: now,
      });
      result.allocationJournaled = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.stageErrors.push(`B2/B3/B4/B5: ${msg}`);
    logger.warn({ err: msg }, "flywheel posterior/bandit pass failed (skipped, fail-soft)");
  }

  // ── B6: advisory OPE report over declined drafts ─────────────────────────
  try {
    const declined = await db
      .select()
      .from(missionTradeDraftsTable)
      .where(inArray(missionTradeDraftsTable.status, ["rejected", "expired", "cancelled"]))
      .orderBy(desc(missionTradeDraftsTable.updatedAt))
      .limit(MAX_DRAFTS_PER_PASS);
    if (declined.length > 0) {
      const evidence: DeclinedDraftEvidence[] = declined.map((d) => {
        const cf = buildDraftCounterfactual({
          direction: d.direction,
          entryPrice: d.entryPrice ?? null,
          stopLoss: d.stopLoss ?? null,
          takeProfit: d.takeProfit ?? null,
          riskAmount: d.riskAmount ?? null,
          expectedR: d.expectedR ?? null,
        });
        const asIs = cf.scenarios.find((s) => s.kind === "AS_IS");
        return {
          draftId: d.draftId,
          strategyId: d.agentKey,
          symbol: d.symbol,
          assetClass: findMarketByStandardSymbol(d.symbol)?.assetClass ?? "UNKNOWN",
          declineStatus: d.status,
          declineReason: d.rejectionReason ?? null,
          maxLossUsd: asIs && asIs.kind === "AS_IS" ? asIs.maxLossUsd : null,
          maxGainUsd: asIs && asIs.kind === "AS_IS" ? asIs.maxGainUsd : null,
          // No recorded evidence resolves declined counterfactuals yet (the
          // replay lab's post-hoc pass is the future resolver) — honest null.
          resolvedGrossLogReturn: null,
        };
      });
      const report = buildOpeReport(evidence);
      await db.insert(flywheelOpeReportsTable).values({
        reportId: `ope_${passId}`,
        passId,
        scope: "declined_drafts",
        advisory: report.advisory,
        estimateJson: report.estimate,
        recordsJson: report.records,
        reasonsJson: report.reasons,
        computedAt: now,
      });
      result.opeReported = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.stageErrors.push(`B6: ${msg}`);
    logger.warn({ err: msg }, "flywheel OPE pass failed (skipped, fail-soft)");
  }

  // ── B7: anonymized cross-tenant cohort ledger (opt-in only) ──────────────
  try {
    const optedIn = await db
      .select({ userId: userPrivacySettingsTable.userId })
      .from(userPrivacySettingsTable)
      .where(eq(userPrivacySettingsTable.contributeToGlobalLearning, true))
      .limit(10_000);
    const optedInIds = optedIn.map((u) => u.userId);
    if (optedInIds.length > 0) {
      const rows = await db
        .select()
        .from(flywheelRewardsTable)
        .where(and(
          eq(flywheelRewardsTable.status, "RECONCILED"),
          inArray(flywheelRewardsTable.userId, optedInIds),
        ))
        .limit(MAX_REWARD_ROWS);
      const contributions: CohortContribution[] = rows
        .filter((r) => typeof r.netLogReturn === "number")
        .map((r) => ({
          userId: r.userId,
          cohortKey: cohortKeyOf(r.strategyId, r.regimeLabel, r.instrument),
          strategyId: r.strategyId,
          regimeLabel: r.regimeLabel,
          instrument: r.instrument,
          netLogReturn: r.netLogReturn as number,
        }));
      const aggregates = aggregateCohortOutcomes(contributions);
      for (const a of aggregates) {
        await db
          .insert(flywheelCohortOutcomesTable)
          .values({
            cohortKey: a.cohortKey,
            strategyId: a.strategyId,
            regimeLabel: a.regimeLabel,
            instrument: a.instrument,
            contributorCount: a.contributorCount,
            sampleCount: a.sampleCount,
            meanNetLogReturn: a.meanNetLogReturn,
            varNetLogReturn: a.varNetLogReturn,
            isSurfaceable: a.isSurfaceable,
            lastAggregatedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: flywheelCohortOutcomesTable.cohortKey,
            set: {
              contributorCount: a.contributorCount,
              sampleCount: a.sampleCount,
              meanNetLogReturn: a.meanNetLogReturn,
              varNetLogReturn: a.varNetLogReturn,
              isSurfaceable: a.isSurfaceable,
              lastAggregatedAt: now,
              updatedAt: now,
            },
          });
        result.cohortsAggregated += 1;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.stageErrors.push(`B7: ${msg}`);
    logger.warn({ err: msg }, "flywheel cohort-ledger pass failed (skipped, fail-soft)");
  }

  return result;
}

// ── Worker (missionDriver idiom) ────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startFlywheelWorker(deps: FlywheelDeps = {}): void {
  if (timer) return;
  if (!flywheelEnabled(process.env["ARX_FLYWHEEL_ENABLED"])) {
    logger.warn(
      { flag: "ARX_FLYWHEEL_ENABLED" },
      "flywheel_worker_DISABLED_by_env — case files, rewards, posteriors and shadow allocation journals will NOT accumulate (nothing live is affected; the flywheel applies nothing anyway)",
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runFlywheelPass(deps)
      .then((r) => {
        if (r.decayed > 0 || r.stageErrors.length > 0) {
          logger.warn({ ...r }, "flywheel_pass");
        } else if (r.caseFilesAssembled > 0 || r.allocationJournaled) {
          logger.info({ ...r }, "flywheel_pass");
        }
      })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "flywheel_pass_failed (fail-safe; next tick retries — apply docs/migrations-pending/build-flywheel-machinery.sql if tables are missing)",
        ),
      )
      .finally(() => { running = false; });
  }, FLYWHEEL_INTERVAL_MS).unref();
  logger.info({ intervalMs: FLYWHEEL_INTERVAL_MS }, "flywheel_worker_started (SHADOW-ONLY: journals allocation intentions, applies nothing)");
}

export function stopFlywheelWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
