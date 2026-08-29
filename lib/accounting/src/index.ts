// @workspace/accounting — the economic truth spine's PURE domain layer.
//
// #30 double-entry postings (journal.ts), #29 bitemporal append-only
// discipline (effectiveAt/knownAt + reverse-and-repost corrections), and the
// pure half of the broker-statement reconciliation pass (reconciliation.ts),
// ranked by the #31 truth-hierarchy safety contract
// (@workspace/domain/safety-contracts/truthHierarchy).
//
// Nothing in this package performs IO or touches an execution path.

export * from "./accounts.js";
export * from "./journal.js";
export * from "./reconciliation.js";
