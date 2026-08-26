// The live-evidence harness.
//
// CANNOT SEND AN ORDER. Every probe below is an operation that is structurally
// incapable of creating or closing a position: a quote request, a metadata
// query, a session read, or a deliberately malformed request. Capability
// DEMO_EXECUTION refuses with CAPABILITY_NOT_IMPLEMENTED and there is no code
// path here that reaches mapBuyRequest or mapSellRequest — pinned by a test.
//
// WHY REJECTIONS CAN BE HARVESTED WITHOUT TRADING: a venue error frame has the
// same envelope whatever provoked it. `proposal` with an illegal contract_type
// yields a genuine Deriv rejection with a genuine code and a genuine `details`
// shape, and no contract can result from it. That answers most of "what do
// real rejection shapes look like" at zero order risk.

import { resolveNewApiConfig, describeConfig, type DerivNewApiConfig } from "./restClient.js";
import { fetchAccounts, selectDemoAccount, isDemoAccount, isRealAccount } from "./accounts.js";
import { NewDerivTransport, canSendTradingRequest } from "./transport.js";
import { DerivNewApiError } from "./errors.js";
import { normalizeProposal, normalizeOpenContract } from "./wire.js";
import {
  EVIDENCE_AUTHORIZATION, EVIDENCE_TIERS, EvidenceRefusal, redactFrame,
  assertNoSecrets, type EvidenceArtifact, type EvidenceFrame,
  type EvidenceProbe, type EvidenceTier,
} from "./liveEvidence.js";

/**
 * The probes. Each names the unknown it addresses.
 *
 * `expectRejection` is what ARX BELIEVES will happen — it is never used to
 * decide the recorded outcome. The venue decides that; this only lets the
 * report say whether the expectation held, which is itself evidence.
 */
export interface EvidenceProbeSpec {
  name: string;
  question: string;
  payload: Record<string, unknown>;
  expectRejection: boolean;
}

export const READ_ONLY_PROBES: EvidenceProbeSpec[] = [
  {
    name: "baseline_ping",
    question: "Q0: envelope shape of a successful reply",
    payload: { ping: 1 },
    expectRejection: false,
  },
  {
    name: "valid_proposal",
    question: "Q3: the proposal shape a buy would price against",
    payload: {
      proposal: 1, underlying_symbol: "R_100", contract_type: "MULTUP",
      amount: 1, basis: "stake", currency: "USD", multiplier: 100,
    },
    expectRejection: false,
  },
  {
    name: "proposal_illegal_contract_type",
    question: "Q4: rejection code + details shape for an invalid enum value",
    payload: {
      proposal: 1, underlying_symbol: "R_100", contract_type: "NOT_A_CONTRACT",
      amount: 1, basis: "stake", currency: "USD", multiplier: 100,
    },
    expectRejection: true,
  },
  {
    name: "proposal_missing_required_field",
    question: "Q4: rejection shape when a required field is absent",
    payload: { proposal: 1, underlying_symbol: "R_100", currency: "USD" },
    expectRejection: true,
  },
  {
    name: "proposal_surplus_key",
    question: "Q4: rejection shape for additionalProperties:false (the live InputValidationFailed)",
    payload: {
      proposal: 1, underlying_symbol: "R_100", contract_type: "MULTUP",
      amount: 1, basis: "stake", currency: "USD", multiplier: 100,
      not_a_real_field: 1,
    },
    expectRejection: true,
  },
  {
    name: "contracts_for_unknown_symbol",
    question: "Q4: rejection shape for an unknown instrument",
    payload: { contracts_for: "NOT_A_SYMBOL" },
    expectRejection: true,
  },
  {
    name: "unknown_operation",
    question: "Q4: rejection shape for an operation Deriv does not implement",
    payload: { this_operation_does_not_exist: 1 },
    expectRejection: true,
  },
  {
    name: "open_contract_unknown_id",
    question: "Q1/Q4: how the venue answers about a contract that does not exist",
    payload: { proposal_open_contract: 1, contract_id: 1 },
    expectRejection: true,
  },
];

/** Operations that could create or close a position. Never sendable here. */
const CAPITAL_COMMITTING = ["buy", "sell", "buy_contract_for_multiple_accounts",
  "sell_expired", "cashier", "transfer_between_accounts", "topup_virtual"];

/**
 * Refuse any payload that could move capital.
 *
 * Independent of the probe list, so adding a probe cannot smuggle one in. The
 * read-only certification has its own separate gate; duplicating the rule here
 * rather than sharing one keeps each instrument's guarantee standing on its
 * own code.
 */
export function assertNoOrderPossible(payload: Record<string, unknown>): void {
  for (const k of CAPITAL_COMMITTING) {
    if (k in payload) {
      throw new EvidenceRefusal(`evidence capture refused a capital-committing operation: ${k}`);
    }
  }
}

/**
 * Refuse anything not PROVABLY a demo account.
 *
 * Redundant with selectDemoAccount, which already filters to demo accounts —
 * and that redundancy is the point: this is the last check before a live
 * credential is used, and it must not depend on an upstream helper keeping its
 * current behaviour. Exported so it is DIRECTLY testable; left inline it was
 * unreachable through the normal path, which made it exactly the kind of
 * unfireable guard this codebase has been removing.
 *
 * Both directions asserted: "not real" alone would accept an account whose
 * type the venue omitted.
 */
export function assertProvablyDemo(account: { accountId: string; accountType: string | null }): void {
  if (isRealAccount(account as never) || !isDemoAccount(account as never)) {
    throw new EvidenceRefusal(
      `refused: account ...${account.accountId.slice(-4)} is not provably a demo account`
      + ` (type=${account.accountType ?? "unstated"})`,
    );
  }
}

export interface CaptureOptions {
  tier?: EvidenceTier;
  authorization?: string;
  fetchImpl?: typeof fetch;
  transportFactory?: (c: DerivNewApiConfig, onFrame: NonNullable<ConstructorParameters<typeof NewDerivTransport>[3]>) => NewDerivTransport;
  accountId?: string | null;
  probes?: EvidenceProbeSpec[];
  nowMs?: () => number;
}

/**
 * Capture venue evidence.
 *
 * Returns an artifact rather than throwing on probe failure: a rejection IS
 * the evidence, so a probe that fails has succeeded at its job.
 */
export async function captureVenueEvidence(
  opts: CaptureOptions = {},
): Promise<EvidenceArtifact> {
  const now = opts.nowMs ?? (() => Date.now());
  const tier = opts.tier ?? EVIDENCE_TIERS.READ_ONLY;

  // TIER GATE, before anything else. DEMO_EXECUTION has no implementation on
  // purpose: this change must not add a path capable of placing a trade.
  if (tier === EVIDENCE_TIERS.DEMO_EXECUTION) {
    throw new EvidenceRefusal(
      "CAPABILITY_NOT_IMPLEMENTED: demo-execution evidence requires placing an order, "
      + "which this harness deliberately cannot do. It is a separate, reviewable change.",
    );
  }
  if (tier !== EVIDENCE_TIERS.READ_ONLY) {
    throw new EvidenceRefusal(`unknown capability tier: ${String(tier)}`);
  }
  if (opts.authorization !== EVIDENCE_AUTHORIZATION.READ_ONLY) {
    throw new EvidenceRefusal(
      "refused: evidence capture contacts the live venue and requires explicit operator intent",
    );
  }

  const config = resolveNewApiConfig();
  if (typeof config === "string") throw new EvidenceRefusal(`cannot capture: ${config}`);
  const d = describeConfig();

  // DEMO ONLY, proven from the venue's own account listing rather than config.
  const accounts = await fetchAccounts(config, opts.fetchImpl);
  const selected = selectDemoAccount(accounts, opts.accountId ?? null);
  if (selected instanceof DerivNewApiError) {
    throw new EvidenceRefusal(`cannot capture: ${selected.code}`);
  }
  const account = selected.account;
  assertProvablyDemo(account);

  const frames: EvidenceFrame[] = [];
  const record = (
    direction: "out" | "in", raw: string,
    meta: { reqId: number | null; op: string | null; atMs: number },
  ): void => {
    frames.push({ direction, raw: redactFrame(raw, config), ...meta });
  };

  const transport = opts.transportFactory
    ? opts.transportFactory(config, record)
    : new NewDerivTransport(config, undefined, opts.fetchImpl, record);

  const probes: EvidenceProbe[] = [];
  let reconnects = 0;

  try {
    await transport.connect(account.accountId);
    if (!canSendTradingRequest(transport.getState())) {
      throw new EvidenceRefusal(`transport is ${transport.getState()}, not ready`);
    }

    for (const spec of (opts.probes ?? READ_ONLY_PROBES)) {
      assertNoOrderPossible(spec.payload);
      const before = transport.getState();
      const startedAtMs = now();
      const mark = frames.length;
      let outcome: EvidenceProbe["outcome"] = "UNKNOWN";
      let derivErrorCode: string | null = null;
      let arxErrorCode: string | null = null;
      let wireWritten: boolean | null = null;
      let replyKeys: string[] = [];
      let nestedKeys: string[] = [];
      let normalizedOk = false;
      let unreadableReason: string | null = null;

      try {
        const reply = await transport.send(spec.payload);
        outcome = "VENUE_REPLY";
        wireWritten = true;
        replyKeys = Object.keys(reply).sort();
        const opKey = Object.keys(spec.payload).find((k) => k !== "req_id" && k !== "subscribe");
        const block = opKey ? (reply as Record<string, unknown>)[opKey] : undefined;
        if (block && typeof block === "object") nestedKeys = Object.keys(block).sort();

        // Read it with ARX's REAL normalizers, so the artifact records whether
        // production code could actually have understood this reply.
        if (opKey === "proposal") {
          const n = normalizeProposal(reply);
          normalizedOk = !(n instanceof DerivNewApiError);
          if (n instanceof DerivNewApiError) unreadableReason = n.detail ?? n.code;
        } else if (opKey === "proposal_open_contract") {
          const n = normalizeOpenContract(reply);
          normalizedOk = !(n instanceof DerivNewApiError);
          if (n instanceof DerivNewApiError) unreadableReason = n.detail ?? n.code;
        } else {
          normalizedOk = true;
        }
      } catch (e) {
        if (e instanceof DerivNewApiError) {
          arxErrorCode = e.code;
          derivErrorCode = e.derivCode;
          wireWritten = e.wireWritten;
          // A venue error frame is adjudication; anything else is unknown.
          outcome = (e.code === "DERIV_NEW_API_TRADING_REJECTED"
            || e.code === "DERIV_NEW_API_REQUEST_REJECTED")
            ? "VENUE_REJECTION"
            : e.wireWritten === false ? "NOT_SENT" : "UNKNOWN";
          unreadableReason = e.detail;
        } else {
          unreadableReason = "non-protocol failure (message withheld)";
        }
      }

      probes.push({
        name: spec.name, op: Object.keys(spec.payload)[0] ?? "unknown",
        outcome, derivErrorCode, arxErrorCode, wireWritten,
        replyKeys, nestedKeys, normalizedOk, unreadableReason,
        transportStateBefore: before, transportStateAfter: transport.getState(),
        reconnectsSoFar: reconnects,
        startedAtMs, elapsedMs: now() - startedAtMs,
        frames: frames.slice(mark),
      });

      // A dropped socket mid-capture is itself worth recording, and the
      // remaining probes are worthless without a session.
      if (!canSendTradingRequest(transport.getState())) {
        try { await transport.reconnect(); reconnects += 1; } catch { break; }
      }
    }
  } finally {
    transport.close();
  }

  const artifact: EvidenceArtifact = {
    artifactVersion: 1,
    tier,
    capturedAtMs: now(),
    config: { mode: d.mode, appIdShape: d.appIdShape, tokenLength: d.patLength },
    accountSuffix: account.accountId.slice(-4),
    accountType: account.accountType,
    probes,
    questions: summarizeQuestions(probes),
  };
  // Before it can reach disk.
  assertNoSecrets(artifact, config);
  return artifact;
}

/**
 * State which unknowns this capture actually settled.
 *
 * "answered: false" is the expected result for anything needing an order, and
 * saying so is the point — an artifact that implied it had answered Q1 would
 * be worse than one that admits it did not.
 */
export function summarizeQuestions(probes: EvidenceProbe[]): EvidenceArtifact["questions"] {
  const rejections = probes.filter((p) => p.outcome === "VENUE_REJECTION" && p.derivErrorCode);
  return [
    {
      id: "Q1",
      question: "What exact key/shape does a genuine Deriv sell receipt arrive under?",
      answered: false,
      answer: "NOT ANSWERABLE READ-ONLY: a sell receipt exists only as the reply to a "
        + "sell request, which requires an open contract, which requires a buy.",
    },
    {
      id: "Q2",
      question: "Can Deriv produce a successful sell with no usable receipt?",
      answered: false,
      answer: "NOT SETTLEABLE BY OBSERVATION: observing N sells that carry a receipt "
        + "cannot prove the venue never omits one. The schema already marks the "
        + "receipt optional, and ARX already fails safe when it is absent.",
    },
    {
      id: "Q3",
      question: "What does genuine requote behaviour look like on the wire?",
      answered: false,
      answer: "PARTIAL: the proposal shape a buy prices against is captured, but the "
        + "venue's behaviour when price moves between proposal and buy requires "
        + "sending a buy.",
    },
    {
      id: "Q4",
      question: "What genuine rejection codes/shapes are returned during execution failures?",
      answered: rejections.length > 0,
      answer: rejections.length > 0
        ? `Captured ${rejections.length} genuine venue rejection(s): `
          + `${[...new Set(rejections.map((p) => p.derivErrorCode))].join(", ")}. `
          + "Buy/sell-specific codes still require an order."
        : "No venue rejection was captured.",
    },
  ];
}
