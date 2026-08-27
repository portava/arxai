// Phase 6 — TIER 1 demo certification harness.
//
// Places EXACTLY ONE Deriv demo order through the complete guided path, then
// reconciles it. Everything before the order is a refusal opportunity.
//
// THIS SCRIPT PLACES A REAL ORDER ON A REAL (DEMO) ACCOUNT. It therefore
// refuses unless an explicit authorization flag is present:
//
//     --i-authorize-one-demo-order
//
// The flag exists because a script that places an order when run with no
// arguments is a script that places an order by accident. Nothing about the
// environment can substitute for it — not a tier value, not a secret, not a
// config file.
//
// STOP CONDITIONS, checked before and after:
//   - the account must be proven DEMO by VENUE evidence (account_type), not by
//     naming, env, a label or the adapter's allow-list;
//   - the execution tier must resolve to TIER_1_DEMO_GUIDED explicitly;
//   - there must be NO unresolved prior Deriv intent;
//   - if the outcome becomes UNKNOWN, the script STOPS and does not retry.
//
// It never places a second order. If one order proves the lifecycle, that is
// the certification.

import { TIER_1_DEMO_GUIDED } from "@workspace/domain/safety-contracts/executionTier";
import { resolveConfiguredExecutionTier } from "../lib/phase6/guidedDispatchEntry.js";
import { demoIsProven, type DemoClassification } from "../lib/phase6/derivDependencyResolver.js";
import { fetchAccounts, isDemoAccount, isRealAccount } from "../lib/deriv/newApi/accounts.js";
import { resolveNewApiConfig } from "../lib/deriv/newApi/restClient.js";
import { derivOrderIntentsRepo, approvalTicketsRepo, guidedAttemptEventsRepo } from "@workspace/db";
import { reconstructAttempt, positionStateLabel, type GuidedAuditEvent }
  from "../lib/phase6/guidedLineage.js";

const AUTH_FLAG = "--i-authorize-one-demo-order";

interface Check { name: string; ok: boolean; detail: string }

function line(c: Check): string {
  return `[${c.ok ? "PASS" : "FAIL"}] ${c.name.padEnd(52)} ${c.detail}`;
}

/**
 * Read the venue's own classification for the target account.
 *
 * Uses the CERTIFIED Phase 5 classifier, not a hand-rolled field check. Two
 * reasons that matter:
 *
 *   - I originally assumed `account_type`. Deriv's new API reports `account_type`.
 *     A harness inventing its own field would have silently classified every
 *     account as unproven, or worse, wrong.
 *   - `isDemoAccount` is STRICT: only an explicit "demo"/"virtual" marker
 *     qualifies, and an unknown type is NOT demo, because the cost of that
 *     mistake is a real-money trade. Re-deriving that judgement here would mean
 *     two rules that can drift apart.
 */
/**
 * Every account the venue reports.
 *
 * Delegates to the CERTIFIED Phase 5 fetchAccounts. My first version of this
 * hand-rolled the envelope parsing and checked only `accounts` and a bare
 * array — missing the `data` wrapper that Phase 5 already knew Deriv uses (the
 * same nesting that caused the OTP parsing bug). Worse, it returned an empty
 * list on an unrecognised shape, so a protocol mismatch printed
 * "(none returned)" and looked like an empty account book.
 *
 * fetchAccounts handles all three shapes and THROWS on an unrecognised one,
 * which is the honest outcome: not knowing how to read the response is not the
 * same as there being nothing in it.
 */
async function fetchVenueAccounts() {
  const config = resolveNewApiConfig();
  if (typeof config === "string") throw new Error(`DERIV_CONFIG_UNRESOLVED:${config}`);
  return fetchAccounts(config);
}

async function classifyFromVenue(accountRef: string): Promise<DemoClassification | null> {
  const accounts = await fetchVenueAccounts();
  const match = accounts.find((a) => a.accountId === accountRef);
  if (!match) return null;

  // A REAL account is refused loudly and distinctly — it must never be reported
  // merely as "unproven", which reads as a missing field rather than a hazard.
  if (isRealAccount(match)) {
    return { isDemo: false, source: "VENUE_ACCOUNT_LIST", evidence: `account_type=${match.accountType}` };
  }
  return {
    isDemo: isDemoAccount(match),
    source: "VENUE_ACCOUNT_LIST",
    evidence: `account_type=${match.accountType ?? "absent"}`,
  };
}

/**
 * Reconcile one attempt after the human pressed Send.
 *
 * Reports what is KNOWN, and says so when the answer is "we do not know". An
 * UNRESOLVED attempt is not a failure and is not a licence to place another
 * order — it is the one state that must stop the certification.
 */
async function verify(userId: number, intentId: string): Promise<void> {
  const rows = await guidedAttemptEventsRepo.listUserAttemptEvents(userId, intentId);
  if (rows.length === 0) {
    // An empty ledger is NOT proof of non-dispatch (audit C9): lineage writes
    // are non-fatal by design, so a dropped row leaves the ledger silent while
    // the ticket and intent rows carry the truth. Cross-check BOTH before
    // claiming anything — "nothing was dispatched" from a ledger gap is
    // UNKNOWN laundered into no-trade by the very tool meant to reconcile it.
    const intent = await derivOrderIntentsRepo.findIntent(intentId);
    const ticketId = intentId.startsWith("di_") ? intentId.slice(3) : null;
    const ticket = ticketId ? await approvalTicketsRepo.findOwnedTicket(ticketId, userId) : null;
    const dispatchEvidence =
      (intent && intent.writeDisposition !== "NOT_ATTEMPTED")
      || (ticket && ["DISPATCHING", "UNRESOLVED", "EXECUTED"].includes(ticket.state));
    if (dispatchEvidence) {
      // eslint-disable-next-line no-console
      console.log(
        `\nLEDGER GAP for ${intentId} — the ledger is empty but dispatch evidence exists:\n` +
        `  ticket   ${ticket ? ticket.state : "not found"}\n` +
        `  intent   ${intent ? `${intent.writeDisposition}${intent.resolvedAt ? " (resolved)" : " (UNRESOLVED)"}` : "not found"}\n` +
        `  venue    ${ticket?.venueContractRef ?? intent?.venueContractRef ?? "none recorded"}\n\n` +
        `The OUTCOME IS UNKNOWN. Do NOT place another order. Reconcile against the\n` +
        `venue first, then repair the ledger from the ticket row.\n`,
      );
      process.exit(2);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\nNo ledger events for ${intentId}, no intent row past NOT_ATTEMPTED, and no ticket\n` +
      `beyond APPROVED — nothing reached dispatch under this intent.\n`,
    );
    process.exit(1);
  }
  const attempt = reconstructAttempt(rows.map((r) => ({
    intentId: r.intentId, ticketId: r.ticketId, userId: r.userId,
    liveCommandId: r.liveCommandId, event: r.eventType as GuidedAuditEvent,
    occurredAtIso: r.occurredAt.toISOString(), constitutionVersion: r.constitutionVersion,
    venueContractRef: r.venueContractRef, detail: r.detail,
    scannerSignalId: r.scannerSignalId, rubyExplanation: r.rubyExplanation,
  })));

  const intent = await derivOrderIntentsRepo.findIntent(intentId);
  const ticket = rows[0] ? await approvalTicketsRepo.findOwnedTicket(rows[0].ticketId, userId) : null;

  // eslint-disable-next-line no-console
  console.log(
    `\nTIER 1 RECONCILIATION — ${intentId}\n\n` +
    `  lineage      ${attempt.events.join(" -> ")}\n` +
    `  state        ${attempt.state} — ${positionStateLabel(attempt.state)}\n` +
    `  venue ref    ${attempt.venueContractRef ?? "none (nothing proved a contract exists)"}\n` +
    `  ticket       ${ticket ? ticket.state : "not found"}\n` +
    `  intent       ${intent ? `${intent.writeDisposition}${intent.resolvedAt ? " (resolved)" : " (UNRESOLVED)"}` : "not found"}\n` +
    `  complete     ${attempt.complete}\n`,
  );

  if (attempt.state === "UNRESOLVED" || attempt.state === "RECONCILIATION_REQUIRED") {
    // eslint-disable-next-line no-console
    console.log(
      "STOP. The outcome is not established. An order MAY exist at the venue.\n" +
      "Do NOT place another order and do NOT retry this one. Resolve through the\n" +
      "certified Phase 5 reconciliation model first.\n",
    );
    process.exit(2);
  }
  // eslint-disable-next-line no-console
  console.log(attempt.complete
    ? "Attempt is complete and its lineage reconstructs from a single intent id.\n"
    : "Attempt is not yet complete — no terminal event recorded.\n");
  process.exit(attempt.complete ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // --verify runs BEFORE any pre-flight: reconciliation must work even when
  // pre-flight would now refuse (a spent daily allowance, an expired ticket).
  // Refusing to report on an order that exists would be the worst outcome here.
  if (argv.includes("--verify")) {
    const uid = Number((argv.find((a) => a.startsWith("--user="))?.split("=")[1] ?? "").trim());
    const iid = (argv.find((a) => a.startsWith("--intent="))?.split("=")[1] ?? "").trim();
    if (!Number.isInteger(uid) || uid <= 0 || iid === "") {
      // eslint-disable-next-line no-console
      console.error("usage: --verify --user=<id> --intent=<intentId>");
      process.exit(1);
    }
    await verify(uid, iid);
    return;
  }
  const authorized = argv.includes(AUTH_FLAG);
  const accountRef = (argv.find((a) => a.startsWith("--account="))?.split("=")[1] ?? "").trim();
  const userIdRaw = (argv.find((a) => a.startsWith("--user="))?.split("=")[1] ?? "").trim();
  const userId = Number(userIdRaw);

  // DISCOVERY MODE. Without --account there is nothing to check, so listing what
  // the venue actually reports is more useful than failing a check the operator
  // has no way to satisfy yet. Read-only; places nothing.
  if (accountRef === "") {
    // eslint-disable-next-line no-console
    console.log("\nNo --account given. Accounts the VENUE reports:\n");
    try {
      const accounts = await fetchVenueAccounts();
      if (accounts.length === 0) {
        // Genuinely empty, because fetchAccounts throws on a shape it cannot
        // read. "No accounts" and "I could not read the response" are different
        // facts and must never print the same way.
        // eslint-disable-next-line no-console
        console.log("  the venue returned an account list containing ZERO accounts");
      }
      for (const a of accounts) {
        const verdict = isRealAccount(a)
          ? "REAL — refused"
          : isDemoAccount(a) ? "DEMO — usable" : "UNKNOWN type — refused";
        // Account id and type only. No balance, no currency, no credential.
        // eslint-disable-next-line no-console
        console.log(`  ${a.accountId.padEnd(20)} account_type=${String(a.accountType).padEnd(10)} ${verdict}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`  could not read accounts: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
    // eslint-disable-next-line no-console
    console.log("\nRe-run with --account=<the DEMO id above> --user=<your arx user id>.\nNO ORDER WAS PLACED.\n");
    process.exit(1);
  }

  const checks: Check[] = [];

  // ── 1. execution tier, resolved by the SAME code the runtime uses ───────
  // Neither reads the environment nor names a tier literal. Both come from the
  // single owner of each — guidedDispatchEntry for the value, executionTier for
  // the vocabulary. The phase6-execution-safety guard caught this harness doing
  // both directly, which is precisely what that guard exists to prevent.
  const tier = resolveConfiguredExecutionTier();
  checks.push({
    name: "1. execution tier resolves to TIER_1_DEMO_GUIDED",
    ok: tier.tier === TIER_1_DEMO_GUIDED,
    detail: tier.tier === TIER_1_DEMO_GUIDED
      ? "explicit"
      : `resolved ${tier.tier}${tier.denyReason ? ` — ${tier.denyReason}` : ""}`,
  });

  // ── 2. arguments ────────────────────────────────────────────────────────
  checks.push({
    name: "2. target account and user supplied",
    ok: accountRef !== "" && Number.isInteger(userId) && userId > 0,
    detail: accountRef === "" || !Number.isInteger(userId)
      ? "pass --account=<loginid> --user=<id>"
      : `${accountRef} / user ${userId}`,
  });

  // ── 3. DEMO proven by VENUE evidence ────────────────────────────────────
  let demo: DemoClassification | null = null;
  if (accountRef !== "") {
    try {
      demo = await classifyFromVenue(accountRef);
    } catch (e) {
      demo = null;
      checks.push({
        name: "3a. venue account read",
        ok: false,
        detail: e instanceof Error ? e.message.slice(0, 90) : String(e),
      });
    }
  }
  checks.push({
    name: "3. account is DEMO by venue evidence (account_type)",
    ok: demoIsProven(demo),
    detail: demo
      ? `${demo.evidence} via ${demo.source}`
      : "the venue did not classify this account — naming is NOT evidence",
  });

  // ── 4. no unresolved prior intent ───────────────────────────────────────
  let unresolved = -1;
  if (Number.isInteger(userId) && userId > 0) {
    try {
      unresolved = (await derivOrderIntentsRepo.listUnresolved(userId, 50)).length;
    } catch {
      unresolved = -1;
    }
  }
  checks.push({
    name: "4. no unresolved prior Deriv intent",
    ok: unresolved === 0,
    detail: unresolved < 0 ? "could not read deriv_order_intents" : `${unresolved} outstanding`,
  });

  // ── 5. no live ticket already in flight ─────────────────────────────────
  let liveTickets = -1;
  if (Number.isInteger(userId) && userId > 0) {
    try {
      const rows = await approvalTicketsRepo.listInboxForUser(userId);
      liveTickets = rows.filter((r) =>
        ["PENDING", "APPROVED", "DISPATCHING", "UNRESOLVED"].includes(r.state)).length;
    } catch {
      liveTickets = -1;
    }
  }
  checks.push({
    name: "5. no approval ticket already in flight",
    ok: liveTickets === 0,
    detail: liveTickets < 0 ? "could not read approval_tickets" : `${liveTickets} live`,
  });

  // ── 6. explicit authorization ───────────────────────────────────────────
  checks.push({
    name: "6. explicit one-order authorization flag present",
    ok: authorized,
    detail: authorized ? "given" : `missing ${AUTH_FLAG}`,
  });

  // eslint-disable-next-line no-console
  console.log("\nTIER 1 DEMO CERTIFICATION — PRE-FLIGHT\n");
  for (const c of checks) console.log(line(c));   // eslint-disable-line no-console

  const blocked = checks.filter((c) => !c.ok);
  if (blocked.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `\nREFUSED — ${blocked.length} pre-flight check(s) did not pass. NO ORDER WAS PLACED.\n` +
      `Every one is a stop condition, not a warning.\n`,
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    "\nAll pre-flight checks passed.\n\n" +
    "NEXT STEP IS NOT AUTOMATIC. The order itself is placed through the guided\n" +
    "product path — propose, approve in the inbox, then dispatch — so that the\n" +
    "thing being certified is the path a user actually takes, not a shortcut\n" +
    "this script invented. A script that placed the order directly would certify\n" +
    "the script.\n\n" +
    "  1. open /approval-inbox in the dashboard\n" +
    "  2. approve the certification ticket\n" +
    "  3. press Send to broker\n" +
    "  4. re-run this script with --verify to reconcile\n",
  );
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("\nTIER 1 CERTIFICATION ABORTED — NO ORDER WAS PLACED\n", e);
  process.exit(1);
});
