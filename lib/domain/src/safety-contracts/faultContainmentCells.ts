// Capability #33 — FAULT-CONTAINMENT CELLS, declared as a contract.
//
// The platform already partitions failure piecewise (per-user kill switch,
// per-venue adapters + audited gate dispositions, per-symbol allowlists,
// per-connection bridge watchdog, per-allocation freeze, per-strategy
// quarantine). This file makes the partition DELIBERATE: it names the cell
// dimensions, derives a canonical cell key, declares which dependencies are
// intentionally shared across cells (with the honest blast radius of each),
// and provides the pure helpers the blast-radius tests use to PROVE that a
// failure in one cell cannot write outside it.
//
// CONTRACT RULES (test-pinned):
//   * A cell is the tuple (broker, connection, account, symbol, strategy).
//     Any state write tagged with cell dimensions may only touch rows whose
//     dimensions match its own cell on every dimension BOTH sides declare.
//   * Cross-cell influence is allowed ONLY through the declared shared
//     dependencies below — and every one of those is a widening-proof
//     surface: a shared dependency may REFUSE more (global kill switch,
//     probation, DB failure = fail closed), never grant more.
//   * An UNKNOWN dimension value ("this write doesn't say which account")
//     does NOT match anything — an untagged write fails the containment
//     check rather than being treated as harmless.

// ── Cell dimensions ──────────────────────────────────────────────────────────

export const CELL_DIMENSIONS = [
  "broker",      // venue (mt5 | deriv | ...)
  "connection",  // bridge/transport identity (per-user MT5 connection id, deriv session)
  "account",     // user/account identity (per-user isolation rule)
  "symbol",      // instrument
  "strategy",    // strategy/agent identity
] as const;
export type CellDimension = (typeof CELL_DIMENSIONS)[number];

/** A (possibly partial) cell coordinate. Missing/null = "not scoped on this
 *  dimension" for a CELL DECLARATION, but an honest UNKNOWN for a WRITE. */
export type CellCoordinates = Partial<Record<CellDimension, string | null>>;

/** Canonical cell key: stable dimension order, url-ish encoding, explicit
 *  wildcard marker for unscoped dimensions. Deterministic. */
export function faultCellKey(coords: CellCoordinates): string {
  return CELL_DIMENSIONS
    .map((d) => {
      const v = coords[d];
      return `${d}=${v == null ? "*" : encodeURIComponent(v)}`;
    })
    .join("|");
}

// ── Containment check (the blast-radius test primitive) ──────────────────────

export interface ContainmentVerdict {
  contained: boolean;
  violations: string[];
}

/**
 * May a write originating in `originCell` touch state belonging to
 * `targetCell`?
 *
 *   - On every dimension BOTH sides specify: the values must match.
 *   - A dimension the ORIGIN leaves unscoped (null/absent) is a declared
 *     wildcard — allowed only when `originMayFanOut` lists that dimension
 *     (e.g. a platform-scope watchdog legitimately reads every connection).
 *   - A dimension the TARGET specifies but the ORIGIN leaves UNKNOWN without
 *     a declared fan-out is a VIOLATION: an untagged write is never presumed
 *     harmless.
 */
export function checkWriteContainment(args: {
  originCell: CellCoordinates;
  targetCell: CellCoordinates;
  /** Dimensions the origin is explicitly allowed to fan out across (must be
   *  justified by a SHARED_DEPENDENCIES entry or a platform-scope service). */
  originMayFanOut?: readonly CellDimension[];
}): ContainmentVerdict {
  const fanOut = new Set(args.originMayFanOut ?? []);
  const violations: string[] = [];
  for (const d of CELL_DIMENSIONS) {
    const origin = args.originCell[d];
    const target = args.targetCell[d];
    if (target == null) continue; // target unscoped on this dimension — nothing to violate
    if (origin == null) {
      if (!fanOut.has(d)) {
        violations.push(`origin is UNKNOWN on '${d}' but the target is scoped to '${target}' — untagged writes are not presumed harmless`);
      }
      continue;
    }
    if (origin !== target) {
      violations.push(`cross-cell write: origin ${d}='${origin}' → target ${d}='${target}'`);
    }
  }
  return { contained: violations.length === 0, violations };
}

// ── Shared-dependency register (the honest part) ─────────────────────────────

export type SharedFailureDirection =
  | "REFUSES_MORE"   // its failure can only remove authority (fail closed)
  | "OBSERVES_ONLY"; // its failure loses observability, never grants authority

export interface SharedDependency {
  name: string;
  scope: "platform";
  /** What every cell shares. */
  description: string;
  /** The honest blast radius when IT fails. */
  blastRadiusOnFailure: string;
  /** Why sharing it is safe: failure direction is one-way. */
  failureDirection: SharedFailureDirection;
}

/** Dependencies DELIBERATELY shared across every cell. Each is widening-proof:
 *  its failure can refuse or blind, never grant. Anything cross-cell that is
 *  not on this list is a containment violation by contract. */
export const SHARED_DEPENDENCIES: readonly SharedDependency[] = [
  {
    name: "postgres",
    scope: "platform",
    description: "Single Postgres holds every cell's state (per-row isolation by userId/connection/symbol columns; enforced by query scoping, not separate databases).",
    blastRadiusOnFailure: "ALL cells lose state reads/writes simultaneously — the declared single point of failure. Degraded-mode matrix DATABASE row: posture NONE, broker-side protective orders keep protecting, independent watchdog (#28) alerts from its own connection.",
    failureDirection: "REFUSES_MORE",
  },
  {
    name: "global_kill_switch",
    scope: "platform",
    description: "The platform kill switch and GLOBAL_LIVE_DISABLED master switch apply to every cell at once.",
    blastRadiusOnFailure: "Engaging stops every cell (intended). An UNREADABLE switch fails closed — no cell trades on an unreadable stop button.",
    failureDirection: "REFUSES_MORE",
  },
  {
    name: "recovery_probation",
    scope: "platform",
    description: "Post-outage probation ladder (#34) meters the whole platform's return to authority.",
    blastRadiusOnFailure: "Unreadable probation on a deployed layer refuses dispatch platform-wide (fail closed); a missing layer changes nothing (pre-existing walls stand).",
    failureDirection: "REFUSES_MORE",
  },
  {
    name: "audit_vault",
    scope: "platform",
    description: "Append-only audit/vault ledgers receive every cell's events.",
    blastRadiusOnFailure: "Loss of NEW audit writes (shadow capture is fire-and-forget); no execution authority flows from the vault, so its failure grants nothing.",
    failureDirection: "OBSERVES_ONLY",
  },
  {
    name: "api_server_process",
    scope: "platform",
    description: "One Node process runs every cell's workers and routes (until a true multi-host split, which is an owner infrastructure decision — see docs/WATCHDOG.md).",
    blastRadiusOnFailure: "A process crash stops every cell's automation at once. Broker-side protective orders survive (they live at the venue); the independent watchdog (#28) is a separate process precisely so this failure is detected from outside it.",
    failureDirection: "REFUSES_MORE",
  },
  {
    name: "env_configuration",
    scope: "platform",
    description: "Environment flags (worker opt-outs, master switches) are process-wide.",
    blastRadiusOnFailure: "Misconfiguration disables platform-wide (loudly logged). No env flag can ESCALATE authority by mere presence (rule R2 pins tier meaning to one file).",
    failureDirection: "REFUSES_MORE",
  },
] as const;

/** True when a cross-cell interaction is justified by the shared-dependency
 *  register (by name). The blast-radius tests use this to assert that every
 *  fan-out an engine performs is a DECLARED one. */
export function isDeclaredSharedDependency(name: string): boolean {
  return SHARED_DEPENDENCIES.some((d) => d.name === name);
}

// ── Existing per-cell mechanisms (contract documentation, test-pinned) ───────

export interface CellMechanism {
  dimension: CellDimension;
  mechanism: string;
  location: string;
}

/** The EXISTING partition mechanisms this contract makes deliberate. */
export const CELL_MECHANISMS: readonly CellMechanism[] = [
  { dimension: "broker",     mechanism: "per-venue adapters with audited gate dispositions (a new gate key without a venue disposition fails the build)", location: "lib/domain/src/safety-contracts/venueGateParity.ts + artifacts/api-server/src/lib/live/executionAdapterRegistry.ts" },
  { dimension: "connection", mechanism: "per-connection bridge watchdog with leader-conflict detection; per-user bridge tokens (hashes only)", location: "artifacts/api-server/src/lib/live/bridgeWatchdog.ts" },
  { dimension: "account",    mechanism: "per-user kill switch, arming, capital tier; every MT5/demo/live/assistant query scoped by userId", location: "lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts + repository isolation rule (CLAUDE.md §3)" },
  { dimension: "symbol",     mechanism: "per-symbol allowlists; per-allocation freeze", location: "symbol allowlist gates + artifacts/api-server/src/lib/live/allocationBlown.ts / allocationGate.ts" },
  { dimension: "strategy",   mechanism: "per-strategy quarantine ladder (NONE→SHADOW→RESTRICTED→RETIRED), single-step, terminal retirement", location: "lib/domain/src/continuous-validation/strategyQuarantine.engine.ts" },
] as const;
