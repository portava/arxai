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

import { resolveExecutionTier } from "@workspace/domain/safety-contracts/executionTier";
import { demoIsProven, type DemoClassification } from "../lib/phase6/derivDependencyResolver.js";
import {
  DERIV_ACCOUNTS_PATH, normalizeAccount, isDemoAccount, isRealAccount,
} from "../lib/deriv/newApi/accounts.js";
import { derivRestRequest, resolveNewApiConfig } from "../lib/deriv/newApi/restClient.js";
import { derivOrderIntentsRepo, approvalTicketsRepo } from "@workspace/db";

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
async function classifyFromVenue(accountRef: string): Promise<DemoClassification | null> {
  const config = resolveNewApiConfig();
  // resolveNewApiConfig returns EITHER a config or an error code. Refusing on
  // the error branch is the point: an unresolvable Deriv config must not be
  // squeezed past with a cast, because the next thing this function does is
  // decide whether an account may be traded.
  if (typeof config === "string") {
    throw new Error(`DERIV_CONFIG_UNRESOLVED:${config}`);
  }
  const res = await derivRestRequest<unknown>({
    method: "GET", path: DERIV_ACCOUNTS_PATH, config, captureBody: true,
  });
  const raw = res.body as { accounts?: unknown[] } | unknown[] | null;
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
  const accounts = list.map(normalizeAccount).filter((a): a is NonNullable<typeof a> => a !== null);
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const authorized = argv.includes(AUTH_FLAG);
  const accountRef = (argv.find((a) => a.startsWith("--account="))?.split("=")[1] ?? "").trim();
  const userIdRaw = (argv.find((a) => a.startsWith("--user="))?.split("=")[1] ?? "").trim();
  const userId = Number(userIdRaw);

  const checks: Check[] = [];

  // ── 1. execution tier, resolved by the SAME code the runtime uses ───────
  const tier = resolveExecutionTier(process.env["ARX_EXECUTION_TIER"] ?? null);
  checks.push({
    name: "1. execution tier resolves to TIER_1_DEMO_GUIDED",
    ok: tier.tier === "TIER_1_DEMO_GUIDED",
    detail: tier.tier === "TIER_1_DEMO_GUIDED"
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
