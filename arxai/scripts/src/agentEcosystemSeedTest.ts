// Agent Ecosystem seed test (Layer 1).
//
// Two halves:
//   A. HTTP gate proof (through the shared proxy): the admin registry endpoint
//      rejects BOTH an anonymous caller AND an authenticated non-admin user.
//   B. DB state proof (scripts may import libs): the idempotent boot seed has
//      populated exactly 14 core agents with the correct Shadow/Active defaults
//      and no duplicate agent keys (idempotency is structurally guaranteed by
//      the unique agent_key index — re-running the seed can never duplicate).
//
// Run: pnpm --filter @workspace/scripts run test:agent-seed

import { db, agentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CORE_AGENTS } from "@workspace/domain/agent-system";

const BASE = "http://localhost:80";
const EMAIL = process.env["QA_OWNER_EMAIL"];
const PASSWORD = process.env["QA_OWNER_PASSWORD"];

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`, extra ?? ""); failures++; }
}

function cookieFromRes(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(/,(?=[^;]+=)/).map((c) => c.split(";")[0]?.trim()).filter(Boolean).join("; ");
}

async function main() {
  console.log("Agent Ecosystem seed test");

  // ── A. HTTP admin-gate proof ──────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/admin/agent-ecosystem/agents`);
  check("anonymous list rejected (401/403)", anon.status === 401 || anon.status === 403, anon.status);

  const anonCon = await fetch(`${BASE}/api/admin/agent-ecosystem/constitution`);
  check("anonymous constitution rejected (401/403)", anonCon.status === 401 || anonCon.status === 403, anonCon.status);

  if (EMAIL && PASSWORD) {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (login.ok) {
      const cookie = cookieFromRes(login);
      const asUser = await fetch(`${BASE}/api/admin/agent-ecosystem/agents`, { headers: { cookie } });
      check("authenticated non-admin user rejected (403)", asUser.status === 403, asUser.status);
      const seedAsUser = await fetch(`${BASE}/api/admin/agent-ecosystem/seed`, {
        method: "POST", headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ reason: "should be denied" }),
      });
      check("non-admin cannot seed (403)", seedAsUser.status === 403, seedAsUser.status);
    } else {
      console.log("  SKIP  non-admin login (QA user login failed)");
    }
  } else {
    console.log("  SKIP  non-admin gate (QA creds not set)");
  }

  // ── B. DB seeded-state proof ──────────────────────────────────────────────
  const coreRows = await db.select().from(agentsTable).where(eq(agentsTable.isCore, true));
  check("exactly 14 core agents seeded", coreRows.length === 14, coreRows.length);

  const keys = coreRows.map((r) => r.agentKey);
  const uniqueKeys = new Set(keys);
  check("no duplicate core agent keys (idempotent)", uniqueKeys.size === keys.length, keys.length - uniqueKeys.size);

  const expectedKeys = new Set(CORE_AGENTS.map((a) => a.agentKey));
  check("all expected core keys present", [...expectedKeys].every((k) => uniqueKeys.has(k)),
    [...expectedKeys].filter((k) => !uniqueKeys.has(k)));

  const byKey = new Map(coreRows.map((r) => [r.agentKey, r]));
  const newAgentKeys = ["SCALP_AI", "SCANNER_AI", "EXIT_TP_AI", "TRADE_REVIEW_AI",
    "TRAFFIC_CONTROLLER", "IMMUNE_SYSTEM", "LEARNING_CAMP", "AGENT_FACTORY", "PROMOTION_BOARD"];
  const mappedKeys = ["STRUCT", "RISK", "PRECISION", "EXEC"];

  let shadowOk = true;
  for (const k of newAgentKeys) {
    const a = byKey.get(k);
    if (!a || a.currentStatus !== "SHADOW" || a.authorityWeight !== 0 || a.liveInfluenceAllowed !== false) {
      shadowOk = false; console.error(`    new agent not shadow/0%/noinfluence: ${k}`,
        a && { status: a.currentStatus, w: a.authorityWeight, live: a.liveInfluenceAllowed });
    }
  }
  check("all new agents start SHADOW @ 0% authority, no live influence", shadowOk);

  let mappedOk = true;
  for (const k of mappedKeys) {
    const a = byKey.get(k);
    if (!a || a.currentStatus !== "ACTIVE") { mappedOk = false; console.error(`    mapped agent not ACTIVE: ${k}`, a?.currentStatus); }
  }
  check("mapped council agents start ACTIVE", mappedOk);

  // Ruby is the household lead and ACTIVE.
  const ruby = byKey.get("RUBY");
  check("Ruby seeded as ACTIVE lead", !!ruby && ruby.currentStatus === "ACTIVE" && ruby.department === "RUBY_HOUSEHOLD");

  // Parent links resolved (every non-Ruby core agent parents to Ruby).
  const rubyId = ruby?.id;
  const parented = coreRows.filter((r) => r.agentKey !== "RUBY").every((r) => r.parentAgentId === rubyId);
  check("non-Ruby core agents parent to Ruby", parented);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll agent-ecosystem seed checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
