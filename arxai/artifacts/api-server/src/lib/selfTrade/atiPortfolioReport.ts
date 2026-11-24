import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, paperAccountsTable as accounts, userRiskEventsTable as events, vaultEventsTable as vault } from "@workspace/db";
import { atiPortfolioPolicy, compareAtiPortfolioRisk, gradeAtiPortfolioOutcome, stressAtiPortfolioBatches } from "./atiPortfolioRisk.js";

export async function readAtiPortfolioRisk(owner: number, accountId: number, from: Date, through: Date) {
  return db.transaction(async (tx) => {
    const [book] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.userId, owner)));
    if (!book) return null;
    const rows = await tx.select({ id: events.id, userId: events.userId, eventType: events.eventType, decision: events.decision,
      receiptTime: vault.generatedAtIso, details: events.details, proof: sql<string | null>`${vault.payload}->>'portfolioEvidenceHash'` }).from(events)
      .innerJoin(vault, and(eq(vault.source, "RISK_GOVERNOR"), eq(vault.truthDomain, "DECISION"),
        sql`${vault.linkedDecisionId} = 'risk:' || ${events.id}::text
          AND ${vault.kind} = CASE WHEN ${events.decision} = 'block' THEN 'GOVERNED_TRADE_BLOCKED' ELSE 'GOVERNED_TRADE_DECISION' END
          AND ${vault.payload}->>'userId' = ${String(owner)} AND ${vault.payload}->>'decision' = ${events.decision}
          AND ${vault.payload}->>'venue' = 'PAPER' AND ${vault.payload}->>'action' = 'OPEN'`))
      .where(and(eq(events.userId, owner), gte(vault.generatedAtIso, from.toISOString()), lt(vault.generatedAtIso, through.toISOString()),
        sql`(${vault.payload}->>'portfolioAccountId' = ${String(accountId)}
          OR (${vault.payload}->>'portfolioAccountId' IS NULL AND ${events.details}->>'source' = 'pre_trade_risk_governor'
            AND ${events.details}->'intent'->>'venue' = 'PAPER' AND ${events.details}->'intent'->>'action' = 'OPEN'
            AND ${events.details}->'facts'->'account'->>'source' = ${"paper_account:" + accountId}))`))
      .orderBy(asc(vault.generatedAtIso), asc(events.id)).limit(1001);
    if (rows.length > 1000) return { state: "NARROW_WINDOW" as const };
    const seen = new Set<number>();
    const comparisons = [];
    for (const row of rows) {
      const recordedAt = new Date(row.receiptTime);
      if (!Number.isFinite(+recordedAt) || recordedAt.toISOString() !== row.receiptTime || seen.has(row.id))
        return { state: "AUDIT_INTEGRITY_GAP" as const };
      seen.add(row.id);
      if (row.proof != null && createHash("sha256").update(stableStringify(row.details)).digest("hex") !== row.proof)
        return { state: "AUDIT_INTEGRITY_GAP" as const };
      if (row.proof == null && row.decision === "pass")
        comparisons.push({ eventId: row.id, recordedAt: row.receiptTime, state: "UNRESOLVED" as const, reason: "FROZEN_BOOK_PROOF_MISSING" });
      else comparisons.push(compareAtiPortfolioRisk({ ...row, createdAt: recordedAt }, owner, accountId));
    }
    const compared = comparisons.filter((row) => row.state === "COMPARED");
    const orderColumns = { linkedDecisionId: vault.linkedDecisionId, linkedTradeId: vault.linkedTradeId,
      generatedAtIso: vault.generatedAtIso, payload: vault.payload };
    const orderScope = and(eq(vault.source, "SYSTEM"), eq(vault.truthDomain, "EXECUTION"), lt(vault.generatedAtIso, through.toISOString()),
      sql`${vault.payload}->>'userId' = ${String(owner)} AND ${vault.payload}->>'accountId' = ${String(accountId)}`);
    const bookings = compared.length ? await tx.select(orderColumns).from(vault).where(and(orderScope, eq(vault.kind, "PAPER_ORDER_PLACED"),
      inArray(vault.linkedDecisionId, compared.map((row) => `risk:${row.eventId}`)))) : [];
    const ids = bookings.flatMap((row) => row.linkedTradeId ? [row.linkedTradeId] : []);
    const exits = ids.length ? await tx.select(orderColumns).from(vault).where(and(orderScope, eq(vault.kind, "PAPER_ORDER_CLOSED"),
      inArray(vault.linkedTradeId, ids))) : [];
    const outcomes = compared.map((entry) => gradeAtiPortfolioOutcome(entry, owner, accountId, bookings, exits, through));
    const settled = outcomes.filter((outcome) => outcome.state === "SAME_FILL_SIZE_REPLAY");
    return { state: "REPORTED" as const, accountId, from: from.toISOString(), throughExclusive: through.toISOString(),
      policy: atiPortfolioPolicy, basis: "PAPER_GOVERNOR_DECISIONS", authority: "NONE",
      scopedDecisions: rows.length, compared: compared.length, reduced: compared.filter((row) => row.challengerLots < row.baselineLots).length,
      governorBlocked: comparisons.filter((row) => row.state === "GOVERNOR_BLOCKED").length,
      unresolved: comparisons.filter((row) => row.state === "UNRESOLVED").length, comparisons,
      outcomes, sameFillSizeReplay: { settled: settled.length, unresolved: outcomes.length - settled.length,
        meanPairedDeltaR: settled.length ? settled.reduce((sum, row) => sum + row.deltaR, 0) / settled.length : null,
        netAfterBrokerCostsR: null },
      simultaneousStopStress: comparisons.some((row) => row.state === "UNRESOLVED")
        ? { state: "INCOMPLETE_INPUTS", scenarios: [] }
        : { state: "EVALUATED", scenarios: stressAtiPortfolioBatches(comparisons, +from, +through) } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
