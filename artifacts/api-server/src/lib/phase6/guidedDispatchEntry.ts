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
import { DerivExecutionAdapter } from "../deriv/execution/derivExecutionAdapter.js";
import { isIndeterminateDelivery } from "../live/executionAdapter.js";
import {
  approvalTicketsRepo, derivOrderIntentsRepo, tradingConstitutionRepo, guidedAttemptEventsRepo,
} from "@workspace/db";
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
        writeDisposition: "NOT_ATTEMPTED",
      });
      return intentId;
    }),
    buyViaCertifiedTransport: args.buy as never,
  });
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
  const deps: GuidedDispatchDeps = {
    configuredTier: configuredTier(),

    loadActiveConstitution: overrides.loadActiveConstitution ?? (async (userId) =>
      toDomainConstitution(await tradingConstitutionRepo.getActiveConstitution(userId))),

    loadObservedState: overrides.loadObservedState ?? (async () => ({
      // Conservative defaults are NOT safe here, so anything the caller has not
      // wired reads as unusable and the Constitution refuses on
      // CONSTITUTION_MALFORMED rather than trading on assumed-zero loss.
      nowIso: new Date().toISOString(),
      realisedDailyLossUsd: Number.NaN,
      realisedWeeklyLossUsd: Number.NaN,
      openPositionCount: Number.NaN,
      openExposureForSymbolUsd: Number.NaN,
      tradesTakenToday: Number.NaN,
      consecutiveLosses: Number.NaN,
      lastLossAtIso: null,
    })),

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
      // Persist the forensic record. buildLineageRecord REFUSES a dishonest
      // row — an UNKNOWN carrying a contract reference, an EXECUTED without
      // venue evidence, a dry run with a contract, or a credential anywhere in
      // the payload — so a bad write throws here rather than becoming a
      // permanent lie in the ledger.
      const eventType = AUDIT_KIND_TO_EVENT[event.kind];
      if (!eventType) return;   // not a lineage-bearing event
      const record = buildLineageRecord({
        intentId: `di_${event.ticketId}`,
        ticketId: event.ticketId,
        userId: event.userId,
        liveCommandId: null,
        event: eventType,
        occurredAtIso: new Date().toISOString(),
        constitutionVersion: 0,
        venueContractRef: null,
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
    }),

    deliverViaAdapter: async ({ ticket, tier, liveCommandId }) => {
      // Per-request dependency resolution, INSIDE the adapter path.
      const resolution = await resolveDerivDependencies(
        { connectionId: 0, accountRef: ticket.terms.accountRef, requestedVenue: "DERIV_DEMO" },
        {
          authenticatedUserId: ticket.userId,
          configuredTier: configuredTier(),
          loadConnection: async () => null,
          loadAccount: async () => null,
          classifyAccount: async () => null,
          killSwitchEngaged: async () => false,
          hasUnresolvedIntent: async () => false,
          ...overrides.depSources,
        },
      );
      if (!resolution.ok) {
        // A dependency refusal is a DEFINITE pre-transmission failure: no
        // adapter was ever constructed, so nothing can have been sent.
        throw new Error(`DERIV_DEPS_REFUSED:${resolution.refusal}: ${resolution.detail}`);
      }

      // "No transport wired" is a CONFIGURATION fact known before any attempt,
      // so it must refuse here — definitively, pre-transmission — rather than by
      // throwing inside the transport. A throw from the transport is correctly
      // treated as INDETERMINATE (a throw cannot prove non-transmission), and
      // routing a known-unwired build through that path would strand an exposure
      // reservation for an order that provably never existed.
      if (typeof overrides.buyViaCertifiedTransport !== "function") {
        throw new Error(
          "DERIV_TRANSPORT_NOT_WIRED: no certified transport is configured for this venue; " +
          "nothing was sent",
        );
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
        buy: overrides.buyViaCertifiedTransport,
      });

      const r = await adapter.deliver({
        liveRow: {} as never, bridgeUserId: ticket.userId, bridgeConnectionId: resolution.deps.connectionId,
      });
      return { venueContractRef: r.transportRef, intentId: (r as { intentId: string }).intentId };
    },
  };

  return dispatchGuidedTicket(
    {
      userId: args.userId,
      ticketId: args.ticketId,
      marketCategory: "synthetic_indices",
      conditions: [],
    },
    deps,
  );
}
