// Phase 6 — the single composition point for a guided dispatch.
//
// The route resolves the user and calls this. This file wires the REAL
// repositories, the REAL dependency resolver and the REAL adapter into the
// guided execution service. There is deliberately exactly one of these: a
// second composition point would be a second dispatch path, and a second path
// is a bypass waiting to be found.
//
// Everything is constructed per call. No adapter, no credential and no account
// is held in module scope, because module scope is how one request ends up
// serving another request's account.

import {
  dispatchGuidedTicket,
  type GuidedDispatchDeps, type GuidedDispatchOutcome,
} from "./guidedExecutionService.js";
import { resolveDerivDependencies } from "./derivDependencyResolver.js";
import { resolveExecutionTier } from "@workspace/domain/safety-contracts/executionTier";
import { guidedBuy } from "../deriv/execution/derivGuidedBuy.js";
import { ARX_LOCK_NS, withTxAdvisoryLock } from "../concurrency/advisoryLock.js";
import { fetchAccounts, isDemoAccount, isRealAccount } from "../deriv/newApi/accounts.js";
import { resolveNewApiConfig } from "../deriv/newApi/restClient.js";
import { DerivExecutionAdapter } from "../deriv/execution/derivExecutionAdapter.js";
import { isIndeterminateDelivery } from "../live/executionAdapter.js";
import {
  approvalTicketsRepo, derivOrderIntentsRepo, tradingConstitutionRepo, guidedAttemptEventsRepo,
  db, arxLiveArmingTable, globalTradingSettingsTable, safetyCoreTable,
  approvalTicketsTable, derivOrderIntentsTable,
  liveRiskDisclosureAcceptancesTable, userMasterLiveAccessTable,
} from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { buildLineageRecord, type GuidedAuditEvent } from "./guidedLineage.js";
import type { ApprovalTicket, MaterialTradeTerms } from "@workspace/domain/safety-contracts/approvalTicket";
import type { TradingConstitution, ConstitutionObservedState }
  from "@workspace/domain/safety-contracts/tradingConstitution";

/**
 * Service audit kinds -> ledger event types.
 *
 * Explicit rather than a string cast, so a new audit kind is INVISIBLE to the
 * ledger until someone decides what it means. Silently coercing an unmapped
 * kind would write an event whose meaning nobody chose.
 */
const AUDIT_KIND_TO_EVENT: Readonly<Record<string, GuidedAuditEvent | undefined>> = {
  GUIDED_DISPATCH_EXECUTED: "EXECUTED",
  GUIDED_DISPATCH_INDETERMINATE: "EXECUTION_UNKNOWN",
  GUIDED_DISPATCH_DRY_RUN: "DRY_RUN_REFUSED",
  GUIDED_DISPATCH_REFUSED: "GATE_REFUSED",
  GUIDED_DISPATCH_BLOCKED_CONSTITUTION: "GATE_REFUSED",
  GUIDED_DISPATCH_BLOCKED_POLICY_CHANGE: "GATE_REFUSED",
  GUIDED_DISPATCH_BLOCKED_UNRESOLVED: "GATE_REFUSED",
  GUIDED_DISPATCH_UNROUTABLE: "GATE_REFUSED",
};

/**
 * LIVE observed state for the Constitution, derived from the GUIDED ledger.
 *
 * The audit confirmed the production route passed no loader, so the default —
 * deliberately unusable NaN fields — made every real dispatch refuse
 * CONSTITUTION_MALFORMED. Fail-closed, but the certification could never
 * complete: the wall was load-bearing against its own missing wiring.
 *
 * SCOPE IS THE GUIDED SURFACE, stated plainly: losses and counts come from
 * approval_tickets and deriv_order_intents, which see every guided attempt and
 * nothing else. MT5 activity is governed by its own pipeline's gates; folding
 * it in here would double-count it against two policies.
 *
 * CONSERVATIVE READINGS THROUGHOUT:
 *   - realised loss counts every EXECUTED ticket's full STAKE for the period.
 *     Until settlement P/L is reconciled back, the stake IS the amount at
 *     risk, and counting it as lost is the direction that refuses too early
 *     rather than too late. maxDailyLossUsd therefore behaves as "max staked
 *     per day" until P/L wiring lands — documented, not hidden.
 *   - open positions = EXECUTED tickets without a resolved close PLUS every
 *     unresolved intent: an order that MAY exist occupies a slot.
 *   - trades today = tickets that reached DISPATCHING or beyond, not just
 *     fills: an UNRESOLVED attempt spent the day's allowance, because the
 *     order may exist.
 *   - a read failure THROWS, and the service's pre-transmission wrapper turns
 *     that into a definite refusal. Trading on unreadable state is the
 *     inversion this whole layer exists to prevent.
 */
async function loadGuidedObservedState(userId: number): Promise<ConstitutionObservedState> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(dayStart.getTime() - ((dayStart.getUTCDay() + 6) % 7) * 86_400_000);

  const staked = async (since: Date): Promise<number> => {
    const [r] = await db.select({ v: sql<number>`coalesce(sum(stake_usd), 0)` })
      .from(approvalTicketsTable)
      .where(and(
        eq(approvalTicketsTable.userId, userId),
        sql`state in ('EXECUTED','UNRESOLVED','DISPATCHING')`,
        gte(approvalTicketsTable.updatedAt, since),
      ));
    return Number(r?.v ?? 0);
  };

  const [openTickets] = await db.select({ n: sql<number>`count(*)` })
    .from(approvalTicketsTable)
    .where(and(
      eq(approvalTicketsTable.userId, userId),
      sql`state in ('EXECUTED','DISPATCHING','UNRESOLVED')`,
    ));
  const [openIntents] = await db.select({ n: sql<number>`count(*)` })
    .from(derivOrderIntentsTable)
    .where(and(
      eq(derivOrderIntentsTable.userId, userId),
      sql`resolved_at is null and write_disposition in ('WRITTEN','UNRECORDED')`,
    ));
  const [today] = await db.select({ n: sql<number>`count(*)` })
    .from(approvalTicketsTable)
    .where(and(
      eq(approvalTicketsTable.userId, userId),
      sql`state in ('EXECUTED','DISPATCHING','UNRESOLVED')`,
      gte(approvalTicketsTable.updatedAt, dayStart),
    ));
  const [exposure] = await db.select({ v: sql<number>`coalesce(sum(stake_usd), 0)` })
    .from(approvalTicketsTable)
    .where(and(
      eq(approvalTicketsTable.userId, userId),
      sql`state in ('EXECUTED','DISPATCHING','UNRESOLVED')`,
    ));

  return {
    nowIso: now.toISOString(),
    realisedDailyLossUsd: await staked(dayStart),
    realisedWeeklyLossUsd: await staked(weekStart),
    openPositionCount: Math.max(Number(openTickets?.n ?? 0), Number(openIntents?.n ?? 0)),
    openExposureForSymbolUsd: Number(exposure?.v ?? 0),
    tradesTakenToday: Number(today?.n ?? 0),
    // Loss-streak needs settled P/L, which is not reconciled back yet. Zero
    // consecutive losses is the one field where the conservative direction is
    // PERMISSIVE, so it is stated loudly: the cooldown gate is INERT until
    // P/L reconciliation lands. The daily-stake ceiling above is what bounds
    // damage in the meantime.
    consecutiveLosses: 0,
    lastLossAtIso: null,
  };
}

/**
 * The LIVE per-user + global kill switch, fail-closed.
 *
 * The audit found the guided path wired `killSwitchEngaged: async () => false`
 * — a hard stub. The parity map declared gate 5 EQUIVALENT ("the same engaged
 * switch blocks both venues") while the switch was never consulted: a user
 * with the emergency stop engaged could still dispatch a Deriv order. The
 * parity claim was true on paper and false in the wiring.
 *
 * Semantics copied from the MT5 path, not re-derived:
 *   - per-user: arx_live_arming.killSwitchEngaged === true blocks
 *     (liveArming.ts:332 reads it the same way);
 *   - global: emergencyKillSwitch !== false blocks — absent/null counts as
 *     ENGAGED (approvedTraderLiveState.ts:245, the fail-closed polarity);
 *   - any read failure counts as ENGAGED. Not being able to read the stop
 *     button is not permission to trade.
 */
async function liveKillSwitchEngaged(userId: number): Promise<boolean> {
  try {
    const [arming] = await db.select({ k: arxLiveArmingTable.killSwitchEngaged })
      .from(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, userId)).limit(1);
    if (arming?.k === true) return true;
    const [settings] = await db.select({ e: globalTradingSettingsTable.emergencyKillSwitch })
      .from(globalTradingSettingsTable).limit(1);
    if (settings?.e !== false) return true;
    // The Phase 1 safety-core switch is a THIRD stop control (audit H7/H13):
    // an operator engaging it believes ALL order flow is halted, and the MT5
    // pipeline's own gates do not read it — the guided path being stricter
    // than MT5 here is deliberate, not parity drift.
    const [core] = await db.select({ k: safetyCoreTable.killSwitchEngaged })
      .from(safetyCoreTable).limit(1);
    return core?.k === true;
  } catch {
    return true;
  }
}

/**
 * Gate 18 — the risk disclosure, consulted for REAL.
 *
 * Same audit round: the parity map declared it EQUIVALENT while nothing on the
 * guided path read the acceptances table. Same query the MT5 pipeline uses
 * (liveCommandPipeline.ts:114), plus the operator waiver, reported SEPARATELY
 * so a waiver can never be presented as the user's own consent.
 */
export async function disclosureStatus(userId: number): Promise<{ accepted: boolean; waivedByOperator: boolean }> {
  const [acc] = await db.select({ id: liveRiskDisclosureAcceptancesTable.id })
    .from(liveRiskDisclosureAcceptancesTable)
    .where(eq(liveRiskDisclosureAcceptancesTable.userId, userId)).limit(1);
  const [waiver] = await db.select({ w: userMasterLiveAccessTable.disclosureWaivedAt })
    .from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
  return { accepted: acc !== undefined, waivedByOperator: waiver?.w != null };
}

/**
 * The ONE user permitted to use the environment-configured Deriv credential.
 *
 * The Deriv connection here is an env-level PAT, not a per-user OAuth grant.
 * Without this gate, ANY authenticated user would inherit the owner's broker
 * account — a multi-tenant credential leak wearing the shape of a feature.
 *
 * Unset means NOBODY may use it, which is the correct default: an unconfigured
 * owner is not "everyone".
 */
function derivCredentialOwnerUserId(): number | null {
  const raw = process.env["ARX_DERIV_OWNER_USER_ID"];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Live Deriv dependency sources, built per request.
 *
 * The "connection" is the env-configured credential, exposed ONLY to the owner
 * user. `credentialHandle` is a marker, never the token — the token never
 * leaves resolveNewApiConfig.
 */
function liveDerivDepSources(authenticatedUserId: number) {
  return {
    loadConnection: async (userId: number) => {
      const owner = derivCredentialOwnerUserId();
      if (owner === null || userId !== owner || userId !== authenticatedUserId) return null;
      const config = resolveNewApiConfig();
      if (typeof config === "string") return null;
      return {
        id: 1,
        ownerUserId: userId,
        venue: "DERIV_DEMO",
        // A MARKER, not a credential. Nothing downstream can leak what it was
        // never given.
        credentialHandle: "env:deriv-new-api",
      };
    },
    loadAccount: async (connectionId: number, accountRef: string) => {
      const accounts = await fetchAccounts(
        resolveNewApiConfig() as Exclude<ReturnType<typeof resolveNewApiConfig>, string>);
      const match = accounts.find((a) => a.accountId === accountRef);
      return match ? { accountRef: match.accountId, connectionId } : null;
    },
    classifyAccount: async (_connectionId: number, accountRef: string) => {
      const accounts = await fetchAccounts(
        resolveNewApiConfig() as Exclude<ReturnType<typeof resolveNewApiConfig>, string>);
      const match = accounts.find((a) => a.accountId === accountRef);
      if (!match) return null;
      // A REAL account is reported as explicitly not-demo, never as unknown:
      // unknown reads as a missing field, real reads as a hazard.
      if (isRealAccount(match)) {
        return { isDemo: false, source: "VENUE_ACCOUNT_LIST" as const, evidence: `account_type=${match.accountType}` };
      }
      return {
        isDemo: isDemoAccount(match),
        source: "VENUE_ACCOUNT_LIST" as const,
        evidence: `account_type=${match.accountType ?? "absent"}`,
      };
    },
  };
}

/** The server's tier. Read here, once, from the environment the SERVER owns. */
function configuredTier(): string | null {
  return process.env["ARX_EXECUTION_TIER"] ?? null;
}

/**
 * The resolved tier, for callers that need to REPORT it (a pre-flight harness,
 * a diagnostic) rather than act on it.
 *
 * Exported so nothing else has to read the environment. One reader means one
 * place where "what tier are we at?" is answered, and the
 * phase6-execution-safety guard keeps it that way — a second reader could
 * answer differently, including "if the var is set, go live".
 */
export function resolveConfiguredExecutionTier(): ReturnType<typeof resolveExecutionTier> {
  return resolveExecutionTier(configuredTier());
}

/** Row -> the pure ticket shape. Field by field; never a spread. */
function toDomainTicket(row: Awaited<ReturnType<typeof approvalTicketsRepo.findOwnedTicket>>): ApprovalTicket | null {
  if (!row) return null;
  const terms: MaterialTradeTerms = {
    userId: row.userId,
    broker: row.broker,
    accountRef: row.accountRef,
    instrument: row.instrument,
    side: row.side as "BUY" | "SELL",
    stakeUsd: row.stakeUsd,
    multiplier: row.multiplier,
    stopLossUsd: row.stopLossUsd,
    takeProfitUsd: row.takeProfitUsd,
    intentId: row.intentId,
  };
  return {
    ticketId: row.ticketId,
    userId: row.userId,
    state: row.state as ApprovalTicket["state"],
    terms,
    approvedFingerprint: row.approvedFingerprint,
    approvedByUserId: row.approvedByUserId,
    createdAtIso: row.createdAt.toISOString(),
    expiresAtIso: row.expiresAt.toISOString(),
    dispatchClaimedAtIso: row.dispatchClaimedAt ? row.dispatchClaimedAt.toISOString() : null,
    constitutionVersion: row.constitutionVersion,
    gateVerdictsPassed: row.gateVerdictsPassed,
    disclosureWaivedByOperator: row.disclosureWaivedByOperator,
  };
}

function toDomainConstitution(row: Awaited<ReturnType<typeof tradingConstitutionRepo.getActiveConstitution>>): TradingConstitution | null {
  if (!row) return null;
  return {
    constitutionId: row.constitutionId,
    userId: row.userId,
    version: row.version,
    allowedBrokers: row.allowedBrokers as string[],
    allowedAccountRefs: row.allowedAccountRefs as string[],
    allowedInstruments: row.allowedInstruments as string[],
    allowedMarketCategories: row.allowedMarketCategories as string[],
    allowedSessionsUtc: row.allowedSessionsUtc as TradingConstitution["allowedSessionsUtc"],
    maxRiskPerTradeUsd: row.maxRiskPerTradeUsd,
    maxDailyLossUsd: row.maxDailyLossUsd,
    maxWeeklyLossUsd: row.maxWeeklyLossUsd,
    maxSimultaneousPositions: row.maxSimultaneousPositions,
    maxExposurePerSymbolUsd: row.maxExposurePerSymbolUsd,
    maxTradesPerDay: row.maxTradesPerDay,
    requireStopLoss: row.requireStopLoss,
    requireTakeProfit: row.requireTakeProfit,
    minStakeUsd: row.minStakeUsd,
    maxStakeUsd: row.maxStakeUsd,
    minMultiplier: row.minMultiplier,
    maxMultiplier: row.maxMultiplier,
    lossStreakCooldown: row.lossStreakCooldown as TradingConstitution["lossStreakCooldown"],
    forbiddenInstruments: row.forbiddenInstruments as string[],
    forbiddenConditions: row.forbiddenConditions as string[],
    rubyAuthority: row.rubyAuthority as TradingConstitution["rubyAuthority"],
  };
}

/**
 * Hooks the caller may override — used by the Tier 0 product certificate to
 * substitute the SOCKET only. Everything else stays real.
 *
 * Deliberately narrow: there is no hook that can replace the Constitution, the
 * authorization, the CAS claim or the tier. A test that could stub those would
 * certify nothing.
 */
export interface GuidedDispatchOverrides {
  /**
   * PERSISTENCE substitutes only — never decision logic.
   *
   * A certificate may stand in for the database (this environment has none),
   * but there is deliberately no override for the Constitution evaluator, the
   * ticket authorization, the CAS semantics or the tier resolver. Those decide,
   * and a test that could stub them would certify nothing. The DB-bound halves
   * are certified separately against a live Postgres by approval-ticket-race-db.
   */
  loadOwnedTicket?: GuidedDispatchDeps["loadOwnedTicket"];
  loadActiveConstitution?: GuidedDispatchDeps["loadActiveConstitution"];
  deriveCurrentTerms?: GuidedDispatchDeps["deriveCurrentTerms"];
  claimForDispatch?: GuidedDispatchDeps["claimForDispatch"];
  hasUnresolvedIntent?: GuidedDispatchDeps["hasUnresolvedIntent"];
  persistIntent?: () => Promise<string>;
  /** Observed account state (daily loss, open positions, ...). */
  loadObservedState?: (userId: number) => Promise<ConstitutionObservedState>;
  /** The venue socket. The ONLY external boundary a certificate may fake. */
  buyViaCertifiedTransport?: Parameters<typeof buildAdapter>[0]["buy"];
  /** Connection/account lookups, so a certificate need not seed a broker. */
  depSources?: Partial<Parameters<typeof resolveDerivDependencies>[1]>;
  recordAudit?: GuidedDispatchDeps["recordAudit"];
  newLiveCommandId?: () => string;
  /** Settlement, injectable so a certificate can observe it without a DB. */
  applySettlement?: (outcome: GuidedDispatchOutcome, ticketId: string) => Promise<void>;
  /** Gate 18, injectable for certificates. Live default reads the acceptances table. */
  disclosureStatus?: (userId: number) => Promise<{ accepted: boolean; waivedByOperator: boolean }>;
  /**
   * Per-user dispatch serialization, injectable for certificates (the live
   * default needs Postgres). The live lock is held across the venue round-trip
   * so two concurrent dispatches for DIFFERENT tickets cannot both pass the
   * unresolved-intent and position-count reads before either writes.
   */
  serializeDispatch?: <T>(userId: number, fn: () => Promise<T>) => Promise<{ acquired: boolean; value?: T }>;
}

function buildAdapter(args: {
  tier: Parameters<typeof DerivExecutionAdapter.prototype.deliver> extends never ? never : import("@workspace/domain/safety-contracts/executionTier").ExecutionTier;
  accountIsProvenDemo: boolean;
  userId: number;
  ticketId: string;
  accountRef: string;
  instrument: string;
  side: string;
  stakeUsd: number;
  multiplier: number;
  liveCommandId: string;
  persistIntent?: () => Promise<string>;
  buy: (a: { intentId: string; cmd: unknown }) => Promise<{
    replied: boolean; wireWritten: boolean; contractId: string | null;
    venueRejection: string | null; detail: string;
  }>;
}): DerivExecutionAdapter {
  return new DerivExecutionAdapter({
    tier: args.tier,
    accountIsProvenDemo: args.accountIsProvenDemo,
    // The durable intent, written BEFORE any frame reaches the wire.
    persistIntent: args.persistIntent ?? (async () => {
      const intentId = `di_${args.ticketId}`;
      await derivOrderIntentsRepo.createIntent({
        intentId,
        userId: args.userId,
        ticketId: args.ticketId,
        liveCommandId: args.liveCommandId,
        accountRef: args.accountRef,
        instrument: args.instrument,
        side: args.side,
        stakeUsd: args.stakeUsd,
        multiplier: args.multiplier,
        // UNRECORDED from birth (audit C5). The adapter persists the intent
        // immediately before the send; a crash between frame and reply used to
        // leave NOT_ATTEMPTED — invisible to hasUnresolvedIntent, so nothing
        // blocked the next order while a real one might be open. Born-UNRECORDED
        // means the crash window has no gap, and a later PROVEN non-transmission
        // still resolves it (markRefusedPreTransmission covers UNRECORDED with
        // no venue ref).
        writeDisposition: "UNRECORDED",
        attemptedAt: new Date(),
      });
      return intentId;
    }),
    buyViaCertifiedTransport: args.buy as never,
  });
}

/** The repo operations settlement needs — injectable so the MAPPING itself is testable. */
export interface SettlementRepos {
  settleDispatchedTicket: (a: {
    ticketId: string; outcome: "EXECUTED" | "UNRESOLVED" | "REJECTED";
    venueContractRef?: string | null; rejectionReason?: string;
    rejectionSource?: "USER" | "SYSTEM_PRE_TRANSMISSION" | "SYSTEM_GATE";
  }) => Promise<unknown>;
  markUnrecorded: (intentId: string) => Promise<unknown>;
  resolveWithVenueContract: (a: { intentId: string; venueContractRef: string }) => Promise<unknown>;
  resolveAsVenueRejected: (intentId: string) => Promise<unknown>;
  markRefusedPreTransmission: (intentId: string) => Promise<unknown>;
}

/**
 * Map a dispatch outcome onto ticket + intent state.
 *
 * Exported, with repos injected, because a first version lived inline behind an
 * overridable hook — so the certificate's spy REPLACED it and a mutation that
 * gutted the success branch survived every test. The mapping is the safety
 * logic; the repos are already DB-proven separately. Never let the two be
 * tested only through each other.
 *
 * The rules it encodes:
 *   - success  -> ticket EXECUTED with the venue's ref; intent attempted then
 *                 venue-resolved. Before this existed a successful order left
 *                 the ticket DISPATCHING forever and the REAL exposure was
 *                 invisible to hasUnresolvedIntent.
 *   - unknown  -> ticket UNRESOLVED; intent UNRECORDED and left unresolved,
 *                 which is exactly what blocks every next order.
 *   - definite -> ticket REJECTED (no-op if no claim happened); the intent
 *                 resolves by the venue's adjudication or as pre-transmission.
 */
export async function applyLiveSettlement(
  o: GuidedDispatchOutcome,
  ticketId: string,
  repos: SettlementRepos,
): Promise<void> {
  // NO CLAIM, NO SETTLEMENT. A claim-race loser's outcome describes ITS OWN
  // refusal, not the ticket's fate — the winner owns the ticket now, and the
  // loser settling "REJECTED" onto the winner's DISPATCHING row marked a real
  // in-flight order as "no order exists". Audit finding C2/C3/C4/C7.
  if (!o.claimed) return;
  const intentId = o.intentId;
  if (o.ok && o.venueContractRef) {
    await repos.settleDispatchedTicket({
      ticketId, outcome: "EXECUTED", venueContractRef: o.venueContractRef,
    });
    if (intentId) {
      await repos.markUnrecorded(intentId);
      await repos.resolveWithVenueContract({ intentId, venueContractRef: o.venueContractRef });
    }
    return;
  }
  if (o.indeterminate) {
    await repos.settleDispatchedTicket({ ticketId, outcome: "UNRESOLVED" });
    if (intentId) await repos.markUnrecorded(intentId);
    return;
  }
  const venueAdjudicated = /DERIV_VENUE_REJECTED/.test(o.detail);
  await repos.settleDispatchedTicket({
    ticketId, outcome: "REJECTED",
    rejectionReason: o.detail.slice(0, 400),
    rejectionSource: venueAdjudicated ? "SYSTEM_GATE" : "SYSTEM_PRE_TRANSMISSION",
  });
  if (intentId) {
    if (venueAdjudicated) await repos.resolveAsVenueRejected(intentId);
    else await repos.markRefusedPreTransmission(intentId);
  }
}

/**
 * Dispatch one approved ticket for one authenticated user.
 *
 * The Deriv dependency resolution happens INSIDE the adapter factory, so a
 * refusal there (unowned connection, unproven demo, engaged kill switch,
 * forbidding tier) becomes an adapter refusal and the guided service records it
 * — rather than being silently skipped by a caller that forgot to check.
 */
export async function dispatchGuidedTicketForRequest(
  args: { userId: number; ticketId: string },
  overrides: GuidedDispatchOverrides = {},
): Promise<GuidedDispatchOutcome> {
  // ── PER-USER SERIALIZATION ──────────────────────────────────────────────
  // The unresolved-intent wall and the Constitution's position/trade counts
  // are plain reads: two concurrent dispatches for two different approved
  // tickets could both read "0 outstanding" before either writes (audit,
  // PLAUSIBLE TOCTOU). A pg try-advisory-xact-lock keyed by user makes one of
  // them refuse honestly instead. Non-blocking on purpose: queueing a trade
  // behind another trade is a decision a human should make, not a mutex.
  const serialize = overrides.serializeDispatch
    ?? (async <T,>(uid: number, fn: () => Promise<T>) => {
      try {
        const r = await withTxAdvisoryLock(ARX_LOCK_NS.GUIDED_DISPATCH, uid, () => fn());
        return r.acquired ? { acquired: true, value: r.value } : { acquired: false };
      } catch {
        // The lock INFRASTRUCTURE failed (database unreachable). Refusing is
        // right — a dispatch that cannot be serialized cannot be trusted not
        // to race — and nothing has been sent at this point.
        return { acquired: false };
      }
    });

  const serialized = await serialize(args.userId, () => dispatchGuidedTicketInner(args, overrides));
  if (!serialized.acquired) {
    return {
      ok: false, refusal: "TICKET_AUTHORIZATION_REFUSED",
      detail: "another guided dispatch for this user is in progress — nothing was sent; retry after it completes",
      venueContractRef: null, indeterminate: false, intentId: null, claimed: false,
    };
  }
  return serialized.value as GuidedDispatchOutcome;
}

async function dispatchGuidedTicketInner(
  args: { userId: number; ticketId: string },
  overrides: GuidedDispatchOverrides = {},
): Promise<GuidedDispatchOutcome> {
  const deps: GuidedDispatchDeps = {
    configuredTier: configuredTier(),

    loadActiveConstitution: overrides.loadActiveConstitution ?? (async (userId) =>
      toDomainConstitution(await tradingConstitutionRepo.getActiveConstitution(userId))),

    loadObservedState: overrides.loadObservedState
      ?? ((userId) => loadGuidedObservedState(userId)),

    loadOwnedTicket: overrides.loadOwnedTicket ?? (async (ticketId, userId) =>
      toDomainTicket(await approvalTicketsRepo.findOwnedTicket(ticketId, userId))),

    // Re-derived from the PERSISTED row, never echoed from the domain object a
    // caller handed in.
    deriveCurrentTerms: overrides.deriveCurrentTerms ?? (async (ticket) => {
      const row = await approvalTicketsRepo.findOwnedTicket(ticket.ticketId, ticket.userId);
      const fresh = toDomainTicket(row);
      if (!fresh) throw new Error("TICKET_VANISHED_MID_DISPATCH");
      return fresh.terms;
    }),

    hasUnresolvedIntent: overrides.hasUnresolvedIntent
      ?? ((userId) => derivOrderIntentsRepo.hasUnresolvedIntent(userId)),

    claimForDispatch: overrides.claimForDispatch
      ?? ((a) => approvalTicketsRepo.claimTicketForDispatch(a)),

    venueForTicket: async (ticket) => (ticket.terms.broker === "deriv" ? "DERIV_DEMO" : null),

    isIndeterminate: isIndeterminateDelivery,

    newLiveCommandId: overrides.newLiveCommandId ?? (() => `gc_${args.ticketId}`),

    recordAudit: overrides.recordAudit ?? (async (event) => {
      const eventType = AUDIT_KIND_TO_EVENT[event.kind];
      if (!eventType) return;   // not a lineage-bearing event
      try {
        // buildLineageRecord REFUSES a dishonest row — an UNKNOWN carrying a
        // contract reference, an EXECUTED without venue evidence, a credential
        // anywhere in the payload. The EXECUTED path previously hard-coded
        // venueContractRef: null here, so the honesty check REJECTED every
        // successful trade's own audit row — the success path threw.
        const record = buildLineageRecord({
          intentId: event.intentId ?? `di_${event.ticketId}`,
          ticketId: event.ticketId,
          userId: event.userId,
          liveCommandId: null,
          event: eventType,
          occurredAtIso: new Date().toISOString(),
          constitutionVersion: 0,
          venueContractRef: event.venueContractRef ?? null,
          detail: event.detail,
          scannerSignalId: null,
          rubyExplanation: null,
        });
        await guidedAttemptEventsRepo.appendGuidedEvent({
          intentId: record.intentId,
          ticketId: record.ticketId,
          userId: record.userId,
          liveCommandId: record.liveCommandId,
          eventType: record.event,
          constitutionVersion: record.constitutionVersion,
          venueContractRef: record.venueContractRef,
          scannerSignalId: record.scannerSignalId,
          rubyExplanation: record.rubyExplanation,
          detail: record.detail,
        });
      } catch (auditErr) {
        // NON-FATAL, deliberately. A ledger failure AFTER the venue accepted an
        // order must not convert a real position into a 500 — the caller would
        // read "error" about an order that exists, the exact falsely-uncertain
        // outcome this phase forbids. The critical facts (EXECUTED + venue ref)
        // are settled onto the TICKET row separately; a ledger gap is
        // detectable and repairable, a fabricated failure is not.
        const { logger } = await import("../logger.js");
        logger.error(
          { event: "GUIDED_LINEAGE_WRITE_FAILED", kind: event.kind, ticketId: event.ticketId, err: auditErr },
          "guided lineage write failed — dispatch outcome is UNAFFECTED; repair the ledger from the ticket row",
        );
      }
    }),

    deliverViaAdapter: async ({ ticket, tier, liveCommandId }) => {
      // Per-request dependency resolution, INSIDE the adapter path.
      const resolution = await resolveDerivDependencies(
        { connectionId: 0, accountRef: ticket.terms.accountRef, requestedVenue: "DERIV_DEMO" },
        {
          authenticatedUserId: ticket.userId,
          configuredTier: configuredTier(),
          killSwitchEngaged: (uid: number) => liveKillSwitchEngaged(uid),
          // Wired REAL (audit: this was a hard false while the service-level
          // check was real — the resolver's post-claim re-check was theatre).
          hasUnresolvedIntent: (uid: number) => derivOrderIntentsRepo.hasUnresolvedIntent(uid),
          // LIVE sources by default. A certificate overrides them; production
          // does not, and previously production got the null stubs — meaning a
          // real dispatch always refused NO_BROKER_CONNECTION.
          ...liveDerivDepSources(args.userId),
          ...overrides.depSources,
        },
      );
      if (!resolution.ok) {
        // A dependency refusal is a DEFINITE pre-transmission failure: no
        // adapter was ever constructed, so nothing can have been sent.
        throw new Error(`DERIV_DEPS_REFUSED:${resolution.refusal}: ${resolution.detail}`);
      }


      const adapter = buildAdapter({
        tier,
        accountIsProvenDemo: resolution.deps.demo.isDemo,
        userId: ticket.userId,
        ticketId: ticket.ticketId,
        accountRef: resolution.deps.accountRef,
        instrument: ticket.terms.instrument,
        side: ticket.terms.side,
        stakeUsd: ticket.terms.stakeUsd,
        multiplier: ticket.terms.multiplier,
        liveCommandId,
        persistIntent: overrides.persistIntent,
        buy: overrides.buyViaCertifiedTransport ?? (async () => {
          const r = await guidedBuy({
            accountId: resolution.deps.accountRef,
            symbol: ticket.terms.instrument,
            currency: "USD",
            side: ticket.terms.side,
            stake: ticket.terms.stakeUsd,
            multiplier: ticket.terms.multiplier,
            ...(ticket.terms.stopLossUsd !== null ? { stopLoss: ticket.terms.stopLossUsd } : {}),
            ...(ticket.terms.takeProfitUsd !== null ? { takeProfit: ticket.terms.takeProfitUsd } : {}),
            // The APPROVED stake is the ceiling. The venue's quote may be at or
            // under it; anything above refuses rather than spending more than
            // the human authorized.
            maxStake: ticket.terms.stakeUsd,
          });
          return r;
        }),
      });

      const r = await adapter.deliver({
        liveRow: {} as never, bridgeUserId: ticket.userId, bridgeConnectionId: resolution.deps.connectionId,
      });
      return { venueContractRef: r.transportRef, intentId: (r as { intentId: string }).intentId };
    },
  };


  // ── GATE 18, before anything can claim the ticket ───────────────────────
  // Pre-claim by design: a refusal here leaves the ticket APPROVED, and once
  // the user accepts the disclosure the same ticket can dispatch.
  const disclosure = await (overrides.disclosureStatus ?? disclosureStatus)(args.userId);
  if (!disclosure.accepted && !disclosure.waivedByOperator) {
    return {
      ok: false, refusal: "TICKET_AUTHORIZATION_REFUSED",
      detail: "DISCLOSURE_NOT_ACCEPTED: the live-trading risk disclosure has not been accepted (and no operator waiver exists); nothing was sent",
      venueContractRef: null, indeterminate: false, intentId: null, claimed: false,
    };
  }

  const outcome = await dispatchGuidedTicket(
    {
      userId: args.userId,
      ticketId: args.ticketId,
      marketCategory: "synthetic_indices",
      conditions: [],
    },
    deps,
  );

  // ── SETTLEMENT ──────────────────────────────────────────────────────────
  // Before this existed, nothing ever moved a ticket out of DISPATCHING or an
  // intent out of NOT_ATTEMPTED — even on success. Two concrete harms:
  //   - a ticket stuck DISPATCHING holds the active-per-instrument slot
  //     forever, and the sweeper rightly refuses to touch it;
  //   - an intent with a REAL contract but no resolution is invisible to
  //     hasUnresolvedIntent (which looks at WRITTEN/UNRECORDED), so the very
  //     exposure that must block the next order... did not.
  // settleDispatchedTicket CASes from DISPATCHING, so pre-claim refusals
  // (ticket still APPROVED) settle nothing — the attempt below is a no-op for
  // them, which is correct: an APPROVED ticket a gate refused may be retried.
  const applySettlement = overrides.applySettlement
    ?? ((o: GuidedDispatchOutcome, ticketId: string) => applyLiveSettlement(o, ticketId, {
      settleDispatchedTicket: (a) => approvalTicketsRepo.settleDispatchedTicket(a),
      markUnrecorded: (i) => derivOrderIntentsRepo.markUnrecorded(i),
      resolveWithVenueContract: (a) => derivOrderIntentsRepo.resolveWithVenueContract(a),
      resolveAsVenueRejected: (i) => derivOrderIntentsRepo.resolveAsVenueRejected(i),
      markRefusedPreTransmission: (i) => derivOrderIntentsRepo.markRefusedPreTransmission(i),
    }));

  try {
    // The claim gate lives HERE, outside the injectable function, because an
    // override replaces applyLiveSettlement WHOLE — gate included. A
    // certificate spy recording "settlements" was therefore recording
    // claim-less ones too, and the mutation re-arming the loser's settlement
    // survived. At the call site the gate binds every implementation.
    if (outcome.claimed) await applySettlement(outcome, args.ticketId);
  } catch (settleErr) {
    // A settlement failure must not rewrite the OUTCOME — the venue result is
    // what it is. Log loudly; the ticket state can be repaired from the ledger.
    const { logger } = await import("../logger.js");
    logger.error(
      { event: "GUIDED_SETTLEMENT_FAILED", ticketId: args.ticketId, err: settleErr },
      "guided settlement failed — outcome reported unchanged; reconcile the ticket row manually",
    );
  }

  return outcome;
}
