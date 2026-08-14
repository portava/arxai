// pgUniqueViolationTest — proves the shared isUniqueViolation helper walks the
// error cause-chain, so a Postgres unique-violation (23505) raised INSIDE a
// db.transaction(...) — where drizzle-orm 0.45.2 wraps the SQLSTATE on
// err.cause.code (possibly nested deeper) — is still recognised as a clean
// DUPLICATE instead of re-surfacing as an unexpected internal error.
//
// This is the regression guard for the in-transaction duplicate-detection path
// shared by adminWaterfall (run/reverse inserts run inside a tx), meAssistant's
// recordAndExecuteRuby, and agentEcosystem's proposeAgentCreationRequest.
//
// Run: pnpm --filter @workspace/scripts run test:pg-unique-violation
import { isUniqueViolation, isPgErrorCode } from "../../artifacts/api-server/src/lib/pgError.js";

type Case = { name: string; err: unknown; expect: boolean };

// A realistic drizzle 0.45.2 wrapper: the driver pg error is nested on .cause.
const wrappedOnce = Object.assign(new Error("Failed query: insert ..."), {
  cause: Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
});
const wrappedTwice = Object.assign(new Error("tx failed"), {
  cause: Object.assign(new Error("query failed"), {
    cause: Object.assign(new Error("pg error"), { code: "23505" }),
  }),
});
// A deeper-than-limit chain must NOT match (the walk is bounded at depth 10).
let deep: { code?: string; cause?: unknown } = { code: "23505" };
for (let i = 0; i < 12; i++) deep = { cause: deep };

const CASES: Case[] = [
  { name: "top-level 23505 (unwrapped, non-tx insert)", err: { code: "23505" }, expect: true },
  { name: "wrapped once on .cause.code (in-tx insert)", err: wrappedOnce, expect: true },
  { name: "wrapped twice (nested deeper)", err: wrappedTwice, expect: true },
  { name: "different SQLSTATE wrapped (23503 FK) is NOT a unique-violation", err: { cause: { code: "23503" } }, expect: false },
  { name: "no code anywhere", err: new Error("boom"), expect: false },
  { name: "null", err: null, expect: false },
  { name: "undefined", err: undefined, expect: false },
  { name: "string error", err: "23505", expect: false },
  { name: "23505 buried past the depth limit is NOT matched", err: deep, expect: false },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const got = isUniqueViolation(c.err);
  if (got === c.expect) { pass++; console.log(`PASS  ${c.name}  (${got})`); }
  else { fail++; console.log(`FAIL  ${c.name}  expected=${c.expect} got=${got}`); }
}

// isPgErrorCode generalises to any SQLSTATE, wrapped or not.
{
  const fk = { cause: { code: "23503" } };
  const ok = isPgErrorCode(fk, "23503") === true && isPgErrorCode(fk, "23505") === false;
  if (ok) { pass++; console.log("PASS  isPgErrorCode matches an arbitrary wrapped SQLSTATE"); }
  else { fail++; console.log("FAIL  isPgErrorCode arbitrary SQLSTATE"); }
}

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);

export {};
