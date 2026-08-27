// Phase 6 — the Deriv DEMO venue's disposition for each of the 18 Phase B gates.
//
// Read venueGateParity.ts first for why this file exists. In short: the 18-gate
// wall is MT5-live-shaped, so a second venue must declare, gate by gate, how it
// honours each one — and may never silently skip any.
//
// Six gates are NOT_APPLICABLE, and it matters WHY. Gates 8-10 and 12 are
// toggles on a user-installed MT5 Expert Advisor binary: an EA version, two EA
// input switches, and a terminal-level permission for programmatic orders.
// Deriv has no user-installed client at all — its API is server-side and
// inherently programmatic — so there is no counterpart to check. Declaring
// these NOT_APPLICABLE is not a weakening: their shared intent ("the execution
// channel is authorised and not read-only") is carried by gate 1's
// server-authoritative execution tier and by gate 6's demo allow-list, both of
// which this venue makes STRICTER than the MT5 original.
//
// Gate 6 is the important inversion. On MT5 it BLOCKS anything that is not a
// live/real account. Here it blocks anything that is not provably DEMO, using
// the Phase 5 certified allow-list in newApi/otp.ts, which permits only
// /trading/v1/options/ws/(demo|virtual). An allow-list refuses an unrecognised
// account shape rather than admitting it, which is why this is STRICTER than a
// deny-list would be.

import type { VenueGateParityMap } from "./venueGateParity.js";

export const DERIV_DEMO_VENUE = "deriv_demo" as const;

export const DERIV_DEMO_GATE_PARITY: VenueGateParityMap = {
  // 1 — server master switch. Deriv's equivalent is the Phase 6 execution
  // tier, which is server-authoritative and must be set explicitly; presence
  // of an env var alone must never escalate it.
  LIVE_BROKER_EXECUTION_DISABLED: {
    kind: "EQUIVALENT",
    reason:
      "The server-authoritative Phase 6 execution tier must explicitly permit demo guided execution; " +
      "default is dry-run and no environment variable alone can escalate it.",
    enforcedBy: "Phase 6 execution tier (server-resolved, explicit, default TIER_0_DRY_RUN)",
  },

  // 2 — per-user arming. The guided flow's arming act is the user approving a
  // specific unexpired ticket for a specific account and intent.
  USER_NOT_ARMED_FOR_LIVE: {
    kind: "EQUIVALENT",
    reason:
      "No order may dispatch without an APPROVED, unexpired approval ticket scoped to this exact " +
      "user, account and order intent — a per-order arming act, stricter than a standing armed flag.",
    enforcedBy: "Approval Inbox ticket state + expiry + intent scoping",
  },

  // 3 — admin per-user approval. The Constitution is the owner-authority layer
  // that decides which brokers and accounts a user may reach at all.
  USER_NOT_LIVE_APPROVED: {
    kind: "EQUIVALENT",
    reason:
      "The server-authoritative Personal Trading Constitution must list this broker and account as " +
      "allowed for this user; a client cannot loosen it and a downstream setting cannot weaken it.",
    enforcedBy: "Personal Trading Constitution — allowed brokers/accounts (versioned)",
  },

  // 4 — global singleton flag.
  GLOBAL_LIVE_DISABLED: {
    kind: "EQUIVALENT",
    reason:
      "A global guided-execution flag must be enabled server-side; when off, every venue including " +
      "Deriv demo refuses dispatch regardless of per-user state.",
    enforcedBy: "Global guided-execution enablement flag",
  },

  // 5 — kill switch. Reused unchanged, not reimplemented.
  KILL_SWITCH_ENGAGED: {
    kind: "EQUIVALENT",
    reason:
      "The existing per-user kill switch is consulted before dispatch on this venue exactly as on " +
      "MT5; the same engaged switch blocks both venues.",
    enforcedBy: "Existing per-user kill switch (selfTrade/killSwitchGate)",
  },

  // 6 — account type. INVERTED and tightened for the demo tier.
  BRIDGE_NOT_LIVE_ACCOUNT: {
    kind: "STRICTER",
    reason:
      "Inverted for the demo tier: the account must be provably DEMO. Phase 5 enforces this with an " +
      "ALLOW-LIST permitting only /trading/v1/options/ws/(demo|virtual), so an unrecognised account " +
      "shape is refused rather than admitted — stricter than any deny-list.",
    enforcedBy: "Phase 5 certified real-account refusal (newApi/otp.ts allow-list)",
  },

  // 7 — transport liveness.
  EA_HEARTBEAT_STALE: {
    kind: "EQUIVALENT",
    reason:
      "The authenticated Deriv WebSocket session must be open and proven responsive immediately " +
      "before a frame is written; a dead or unproven session refuses dispatch.",
    enforcedBy: "Phase 5 transport session readiness + keepalive",
  },

  // 8 — EA binary version.
  EA_VERSION_TOO_OLD: {
    kind: "NOT_APPLICABLE",
    reason:
      "Gate 8 checks the version of a user-installed MT5 Expert Advisor binary. Deriv has no " +
      "user-installed client whose version could be too old; the API is server-side and versioned " +
      "by Deriv, not by the trader's machine.",
  },

  // 9 — EA input toggle.
  EA_ENABLE_LIVE_EXECUTION_FALSE: {
    kind: "NOT_APPLICABLE",
    reason:
      "Gate 9 reads an input switch compiled into the MT5 Expert Advisor. Deriv exposes no such " +
      "per-client toggle; the equivalent authority is gate 1's server-authoritative execution tier.",
  },

  // 10 — EA input toggle.
  EA_READ_ONLY_MODE_TRUE: {
    kind: "NOT_APPLICABLE",
    reason:
      "Gate 10 reads the MT5 Expert Advisor's ReadOnlyMode input. Deriv has no per-client read-only " +
      "switch this layer can observe, so no honest equivalent check exists to run.",
  },

  // 11 — transport connectivity.
  EA_TERMINAL_NOT_CONNECTED: {
    kind: "EQUIVALENT",
    reason:
      "The transport must report an open, authenticated Deriv session before dispatch; a closed or " +
      "unauthenticated session refuses, mirroring a disconnected MT5 terminal.",
    enforcedBy: "Phase 5 transport authenticated-session state",
  },

  // 12 — terminal permission for programmatic orders.
  EA_ALGO_TRADING_NOT_ALLOWED: {
    kind: "NOT_APPLICABLE",
    reason:
      "Gate 12 reads an MT5 terminal-level permission for automated orders. Every Deriv API order is " +
      "programmatic by construction, so there is no per-terminal switch that could be off.",
  },

  // 13 — instrument allow-list.
  SYMBOL_NOT_ALLOWED: {
    kind: "EQUIVALENT",
    reason:
      "The instrument must appear in the Constitution's allowed-instruments list for this user, " +
      "evaluated server-side against the exact symbol carried by the approved ticket.",
    enforcedBy: "Personal Trading Constitution — allowed instruments",
  },

  // 14 — size ceiling. Lots do not exist here; the ceiling is on stake.
  VOLUME_EXCEEDS_MAX_LIVE_LOT: {
    kind: "EQUIVALENT",
    reason:
      "A Deriv multiplier contract has no lot concept, so the ceiling is expressed as stake and " +
      "multiplier bounds plus max risk per trade — the same intent (cap the size of one order) on " +
      "the venue-neutral notional rather than on MT5 lots.",
    enforcedBy: "Personal Trading Constitution — stake/multiplier bounds, max risk per trade",
  },

  // 15 — realised daily loss cap.
  DAILY_LOSS_LIMIT_REACHED: {
    kind: "EQUIVALENT",
    reason:
      "The Constitution's max daily loss is evaluated server-side from realised demo P/L before " +
      "dispatch, refusing once the cap is met exactly as the MT5 gate does.",
    enforcedBy: "Personal Trading Constitution — max daily loss",
  },

  // 16 — protection required, and READ BACK.
  MISSING_STOP_LOSS: {
    kind: "STRICTER",
    reason:
      "Stop-loss is required by the Constitution AND the attached protection is read back from the " +
      "venue after the order exists (Phase 5 protection readback), so a silently-dropped stop is " +
      "detected rather than assumed — the MT5 gate only checks the request carried one.",
    enforcedBy: "Constitution stop-loss requirement + Phase 5 verifyProtection readback",
  },

  // 17 — protection required, and READ BACK.
  MISSING_TAKE_PROFIT: {
    kind: "STRICTER",
    reason:
      "Take-profit requirement is enforced from the Constitution and, like the stop, verified by " +
      "venue readback after the order exists rather than trusted from the request alone.",
    enforcedBy: "Constitution take-profit requirement + Phase 5 verifyProtection readback",
  },

  // 18 — risk disclosure. Reused, not reimplemented.
  DISCLOSURE_NOT_ACCEPTED: {
    kind: "EQUIVALENT",
    reason:
      "The same append-only risk-disclosure acceptance required for MT5 live dispatch is required " +
      "here before any guided order may dispatch; the existing record is reused, not duplicated.",
    enforcedBy: "Existing live_risk_disclosure_acceptances record",
  },
};
