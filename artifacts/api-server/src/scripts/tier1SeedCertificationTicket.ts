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

import {
  tradingConstitutionRepo, approvalTicketsRepo,
  db, liveRiskDisclosureAcceptancesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * 60 minutes.
 *
 * The route's own TTL is 5 minutes, which is right for a scanner proposal
 * against a live quote. This is a CERTIFICATION ticket read by a human who may
 * still be starting the dashboard and logging in, and the first attempt expired
 * before it could be approved. An expiry that runs out mid-procedure teaches
 * nothing about the expiry logic and wastes a seed.
 *
 * It is still bounded, and expiry is still enforced against the DATABASE clock
 * at both approve and dispatch — this changes how long the human has, not
 * whether the rule applies.
 */
const PROPOSAL_TTL_MS = 60 * 60_000;

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

  // ── 1b. the risk disclosure — an EXPLICIT consent act, never assumed ────
  // The earlier seed stamped gateVerdictsPassed: true with no disclosure on
  // record: a false assertion of consent. The flag below is the consent act —
  // the account owner, at their own terminal, stating acceptance. Without it,
  // and without an existing acceptance row, the seed refuses.
  const [existingAcceptance] = await db.select({ id: liveRiskDisclosureAcceptancesTable.id })
    .from(liveRiskDisclosureAcceptancesTable)
    .where(eq(liveRiskDisclosureAcceptancesTable.userId, userId)).limit(1);
  if (!existingAcceptance) {
    if (!argv.includes("--accept-risk-disclosure")) {
      // eslint-disable-next-line no-console
      console.error(
        "\nREFUSED — no risk-disclosure acceptance on record for this user.\n" +
        "Trading real venues (demo account included) carries risk. If you, the\n" +
        "account owner, accept the live-trading risk disclosure, re-run with:\n" +
        "    --accept-risk-disclosure\n" +
        "NOTHING WAS CREATED.\n",
      );
      process.exit(1);
    }
    await db.insert(liveRiskDisclosureAcceptancesTable).values({
      userId,
      disclosureVersion: "tier1-certification-v1",
      acceptedText:
        "I accept the live-trading risk disclosure for guided demo execution: orders are placed at " +
        "a real venue on a demo account; execution, slippage and venue behaviour are real; an " +
        "unresolved outcome halts further orders until reconciled.",
      // No ipAddress/userAgent: this consent was given at a terminal, not a
      // browser, and fabricating request metadata would be a false record.
    });
    // eslint-disable-next-line no-console
    console.log("Risk disclosure ACCEPTED by explicit flag — recorded (append-only).");
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
    gateVerdicts: {
      seededBy: "tier1-certification",
      constitution: { decision: "PERMIT", version: con.version },
      disclosure: "ACCEPTED",
    },
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
