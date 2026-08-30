/**
 * reconcileGuidedClosures — carry venue-confirmed settlements into the guided
 * ledger.
 *
 *   pnpm --filter @workspace/api-server run reconcile:guided-closures -- --user=1
 *
 * READ-ONLY at the venue: this script sells nothing, cancels nothing, and
 * places nothing — it asks the venue for the settled/open status of each
 * EXECUTED-but-unreconciled guided attempt and, ONLY when the venue confirms
 * settlement of the exact contract asked about, appends the one RECONCILED
 * ledger event carrying the venue-reported P/L verbatim (null when the venue
 * stated no number — never zero, never derived).
 *
 * Failure modes are honest by construction (guidedCloseReconciler.ts): a
 * failed read leaves the attempt OPEN, a mismatched reply writes nothing, and
 * the database itself enforces at most one RECONCILED per attempt.
 */

import { guidedAttemptEventsRepo } from "@workspace/db";
import { resolveNewApiConfig } from "../lib/deriv/newApi/restClient.js";
import { fetchAccounts, selectDemoAccount, isDemoAccount, isRealAccount } from "../lib/deriv/newApi/accounts.js";
import { NewDerivTransport, canSendTradingRequest } from "../lib/deriv/newApi/transport.js";
import { DerivNewApiError } from "../lib/deriv/newApi/errors.js";
import { mapOpenContractRequest, normalizeOpenContract } from "../lib/deriv/newApi/wire.js";
import {
  reconcileGuidedClosures,
  type VenueContractRead,
} from "../lib/phase6/guidedCloseReconciler.js";

async function main(): Promise<void> {
  const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
  const userId = Number(userArg);
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error("usage: reconcile:guided-closures -- --user=<id>");
    process.exitCode = 1;
    return;
  }

  console.log(`GUIDED CLOSE RECONCILIATION — user ${userId}`);

  const work = await guidedAttemptEventsRepo.listUnreconciledExecutedForUser(userId);
  if (work.length === 0) {
    console.log("  nothing to reconcile — no EXECUTED attempt is missing a settlement record.");
    return;
  }
  console.log(`  ${work.length} executed attempt(s) without a settlement record`);

  const config = resolveNewApiConfig();
  if (typeof config === "string") { console.error(`cannot run: ${config}`); process.exitCode = 1; return; }
  const accounts = await fetchAccounts(config);
  const selected = selectDemoAccount(accounts, process.env["DERIV_DEMO_ACCOUNT_ID"] ?? null);
  if (selected instanceof DerivNewApiError) { console.error(`REFUSED: ${selected.code}`); process.exitCode = 1; return; }
  const account = selected.account;
  if (isRealAccount(account) || !isDemoAccount(account)) {
    console.error("REFUSED: account is not provably demo");
    process.exitCode = 1;
    return;
  }
  console.log(`  demo account confirmed (...${account.accountId.slice(-4)})`);

  const transport = new NewDerivTransport(config);
  try {
    await transport.connect(account.accountId);
    if (!canSendTradingRequest(transport.getState())) {
      console.error(`REFUSED: transport is ${transport.getState()}`);
      process.exitCode = 1;
      return;
    }

    const report = await reconcileGuidedClosures(userId, {
      listUnreconciled: (uid) => guidedAttemptEventsRepo.listUnreconciledExecutedForUser(uid),
      readContract: async (ref): Promise<VenueContractRead> => {
        const idNum = Number(ref);
        if (!Number.isInteger(idNum) || idNum <= 0) {
          return { kind: "UNREADABLE", detail: "contract reference is not a venue contract id" };
        }
        const req = mapOpenContractRequest(idNum);
        if (req instanceof DerivNewApiError) return { kind: "UNREADABLE", detail: req.code };
        const reply = normalizeOpenContract(await transport.send(req as unknown as Record<string, unknown>));
        if (reply instanceof DerivNewApiError) {
          return { kind: "UNREADABLE", detail: reply.detail ?? reply.code };
        }
        if (reply.isSettled) {
          return { kind: "SETTLED", contractId: String(reply.contractId), profit: reply.profit ?? null };
        }
        return { kind: "OPEN", contractId: String(reply.contractId) };
      },
      appendReconciled: (r) => guidedAttemptEventsRepo.appendReconciledOnce(r),
    });

    for (const r of report.reconciled) {
      console.log(`  RECONCILED  contract ${r.venueContractRef}  P/L ${r.venueProfitUsd ?? "unstated"}`);
    }
    for (const id of report.alreadyReconciled) console.log(`  already recorded  ${id}`);
    for (const id of report.stillOpen) console.log(`  still OPEN at the venue  ${id}`);
    for (const u of report.unreadable) console.log(`  UNREADABLE (left OPEN)  ${u.intentId}: ${u.detail}`);
    for (const a of report.anomalies) console.log(`  ANOMALY (nothing written)  ${a.intentId}: ${a.detail}`);

    const total =
      report.reconciled.length + report.alreadyReconciled.length +
      report.stillOpen.length + report.unreadable.length + report.anomalies.length;
    console.log(
      `\n  ${report.reconciled.length} reconciled, ${report.stillOpen.length} still open, ` +
      `${report.unreadable.length} unreadable, ${report.anomalies.length} anomalies (${total} examined).`,
    );
    if (report.anomalies.length > 0) process.exitCode = 2;
  } finally {
    transport.close();
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error("reconciliation failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
