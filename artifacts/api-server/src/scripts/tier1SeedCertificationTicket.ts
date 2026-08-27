// Phase 6 — seed the ONE Tier 1 certification ticket.
//
// Creates a Constitution (if none) and exactly one PENDING proposal at the
// smallest practical stake, then STOPS. It never approves and never dispatches:
// those are the human acts being certified, and a script that performed them
// would be certifying the script.
//
// The proposal is created SERVER-SIDE through the same repository the route
// uses. That is not a shortcut around the API — it is where a proposal belongs.
// A scanner produces proposals server-side; a client POST is the unusual path,
// not the canonical one.
//
// THE CONSTITUTION IT WRITES IS DELIBERATELY THE TIGHTEST THING THAT CAN STILL
// TRADE:
//   maxTradesPerDay: 1     — the policy itself enforces "stop at one order"
//   stake bounds 1..1      — exactly $1, no room to drift upward
//   multiplier bounds 100..100
//   one instrument, one account, one broker
//   maxSimultaneousPositions: 1
// If the certification needs a second order later, that is a deliberate new
// version of the policy, not a value someone can nudge.

import { tradingConstitutionRepo, approvalTicketsRepo } from "@workspace/db";
import { randomUUID } from "node:crypto";

const PROPOSAL_TTL_MS = 15 * 60_000;   // longer than the route's 5m: a human is reading a terminal

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string): string =>
    (argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? "").trim();

  const userId = Number(arg("user"));
  const accountRef = arg("account");
  const instrument = arg("instrument") || "R_100";

  if (!Number.isInteger(userId) || userId <= 0 || accountRef === "") {
    // eslint-disable-next-line no-console
    console.error("usage: --user=<id> --account=<loginid> [--instrument=R_100]");
    process.exit(1);
  }

  // ── 1. Constitution ─────────────────────────────────────────────────────
  let con = await tradingConstitutionRepo.getActiveConstitution(userId);
  if (con) {
    // eslint-disable-next-line no-console
    console.log(`Constitution already present: v${con.version} (${con.constitutionId}) — NOT modified.`);
  } else {
    con = await tradingConstitutionRepo.appendConstitutionVersion({
      userId,
      createdBy: "tier1-certification",
      values: {
        constitutionId: `con_${randomUUID()}`,
        allowedBrokers: ["deriv"],
        allowedAccountRefs: [accountRef],
        allowedInstruments: [instrument],
        allowedMarketCategories: ["synthetic_indices"],
        // Every day, all hours. The certification must not fail on a clock.
        allowedSessionsUtc: [{ daysOfWeekUtc: [0, 1, 2, 3, 4, 5, 6], openMinuteUtc: 0, closeMinuteUtc: 1440 }],
        maxRiskPerTradeUsd: 1,
        maxDailyLossUsd: 2,
        maxWeeklyLossUsd: 5,
        maxSimultaneousPositions: 1,
        maxExposurePerSymbolUsd: 1,
        // ONE. The policy enforces the owner's "stop at one order" rule, so it
        // holds even if a later caller forgets it.
        maxTradesPerDay: 1,
        requireStopLoss: true,
        requireTakeProfit: false,
        minStakeUsd: 1, maxStakeUsd: 1,
        minMultiplier: 100, maxMultiplier: 100,
        lossStreakCooldown: null,
        forbiddenInstruments: [],
        forbiddenConditions: [],
        rubyAuthority: "PREPARE_TICKET",
      } as never,
    });
    // eslint-disable-next-line no-console
    console.log(`Constitution created: v${con.version} (${con.constitutionId})`);
  }

  // ── 2. refuse to create a second live ticket ────────────────────────────
  const existing = await approvalTicketsRepo.listInboxForUser(userId);
  const live = existing.filter((t) =>
    ["PENDING", "APPROVED", "DISPATCHING", "UNRESOLVED"].includes(t.state));
  if (live.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\nREFUSED — ${live.length} ticket(s) already live for this user:\n` +
      live.map((t) => `  ${t.ticketId}  ${t.state}  ${t.instrument}`).join("\n") +
      `\n\nResolve or reject them before seeding another. NOTHING WAS CREATED.\n`,
    );
    process.exit(1);
  }

  // ── 3. one proposal, smallest practical stake ───────────────────────────
  const ticketId = `tkt_${randomUUID()}`;
  const ticket = await approvalTicketsRepo.createTicket({
    ticketId,
    userId,
    state: "PENDING",
    broker: "deriv",
    accountRef,
    instrument,
    side: "BUY",
    stakeUsd: 1,
    multiplier: 100,
    stopLossUsd: 0.5,
    takeProfitUsd: null,
    intentId: `di_${ticketId}`,
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    constitutionVersion: con.version,
    gateVerdicts: { seededBy: "tier1-certification" },
    gateVerdictsPassed: true,
    scannerSignalId: "tier1-certification",
    rubyExplanation: "Tier 1 certification order — smallest practical stake, demo account only.",
  });

  // eslint-disable-next-line no-console
  console.log(
    `\nTicket created and PENDING — nothing has been approved or sent.\n\n` +
    `  ticket    ${ticket.ticketId}\n` +
    `  intent    ${ticket.intentId}\n` +
    `  terms     BUY ${instrument} stake $1 multiplier 100 stop $0.50\n` +
    `  account   ${accountRef}\n` +
    `  expires   ${ticket.expiresAt.toISOString()} (${Math.round(PROPOSAL_TTL_MS / 60000)} minutes)\n\n` +
    `NEXT — both acts are yours:\n` +
    `  1. open /approval-inbox in the dashboard\n` +
    `  2. press Approve\n` +
    `  3. press Send to broker\n` +
    `  4. reconcile:  pnpm --filter @workspace/api-server run certify:tier1-demo -- \\\n` +
    `                   --verify --user=${userId} --intent=${ticket.intentId}\n`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("\nSEED ABORTED — nothing was approved or sent\n", e);
  process.exit(1);
});
