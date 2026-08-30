// HOLD 6 — everything that must hold around the owner's REGISTRATION_KEY_PEPPER press.
//
// Three separate claims, each of which would burn the owner AT the press if it
// were false:
//
//   1. BOOT IS LOUD. With the shield ON and the pepper absent, no human can
//      create an account and no admin can mint a key to fix it. The startup
//      checklist listed the pepper as OPTIONAL, so that state produced a line
//      in `missingOptional` next to OPENAI_API_KEY and no warning at all.
//   2. NOTHING LEAKS THE VALUE. Not a log, not a route, not the checklist.
//   3. THE ROTATION WINDOW ACTUALLY WORKS. REGISTRATION_KEY_PEPPER_PREVIOUS was
//      honoured by findInviteByCode but NOT by acceptInviteTx, so a key issued
//      under the previous pepper validated and then failed inside the
//      registration transaction with INVITE_NOT_FOUND. The whole point of the
//      window — rotate without bricking outstanding keys — did not hold.
//
// Run: pnpm --filter @workspace/api-server run test:registration-key-pepper-press

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import { betaInvitesRepo, betaInvitesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  computeEnvChecklist,
  summarizeEnvChecklist,
} from "../startup/envChecklist.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

const PEPPER = "REGISTRATION_KEY_PEPPER";
const SHIELD = "ARX_BETA_INVITE_REQUIRED";
const PREV = "REGISTRATION_KEY_PEPPER_PREVIOUS";

// ───────────────────────────────────────────────────────────────────────────
// 1. The boot checklist fails loudly on an absent pepper
// ───────────────────────────────────────────────────────────────────────────

/** A minimal env with every unconditionally-required var present, so the only
 *  thing under test is the pepper's own requiredness. */
function baseEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x/y",
    SESSION_SECRET: "s",
    PORT: "8080",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  return env;
}

function pepperItem(env: NodeJS.ProcessEnv) {
  const item = computeEnvChecklist(env).find((i) => i.varName === PEPPER);
  assert.ok(item, "the checklist must still carry a REGISTRATION_KEY_PEPPER row");
  return item;
}

/** Compute + summarize against the same fixture env, as callers do. */
function summaryFor(env: NodeJS.ProcessEnv) {
  return summarizeEnvChecklist(computeEnvChecklist(env), env);
}

/** Source with // and /* *\/ comments stripped, so a guard cannot be tripped by
 *  documentation that merely NAMES the thing it forbids. */
function codeOnly(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

describe("boot checklist — an absent pepper is REQUIRED-missing, not optional", () => {
  it("is REQUIRED in production", () => {
    const item = pepperItem(baseEnv({ NODE_ENV: "production" }));
    assert.equal(item.required, true, "the pepper is optional in production");
    assert.equal(item.present, false);
    assert.ok(
      typeof item.requiredBecause === "string" && item.requiredBecause.length > 0,
      "a conditionally-required var must say WHY — an operator cannot act on a bare name",
    );
  });

  it("is REQUIRED whenever the shield is ON, in any environment", () => {
    // .replit ships ARX_BETA_INVITE_REQUIRED = "true". With the shield on, an
    // absent pepper kills signup in development just as completely.
    const item = pepperItem(baseEnv({ NODE_ENV: "development", [SHIELD]: "true" }));
    assert.equal(item.required, true);
    assert.match(String(item.requiredBecause), /shield is ON/i);
  });

  it("lands in missingRequired — the list the boot log warns on", () => {
    const summary = summaryFor(baseEnv({ [SHIELD]: "true" }));
    assert.ok(
      summary.missingRequired.includes(PEPPER),
      "an absent pepper must reach missingRequired; missingOptional produces no warning at all",
    );
    assert.ok(
      !summary.missingOptional.includes(PEPPER),
      "the pepper must not also be reported as optional",
    );
    assert.ok(
      typeof summary.missingRequiredReasons[PEPPER] === "string",
      "the reason must travel with the summary, not only with the item",
    );
  });

  it("raises registrationShieldBlocked for exactly the fatal combination", () => {
    const blocked = summaryFor(baseEnv({ [SHIELD]: "true", [PEPPER]: undefined }));
    assert.equal(blocked.registrationShieldBlocked, true,
      "shield ON + pepper absent is the state where nobody can sign up");

    const pepperSet = summaryFor(baseEnv({ [SHIELD]: "true", [PEPPER]: "x".repeat(48) }));
    assert.equal(pepperSet.registrationShieldBlocked, false);

    const shieldOff = summaryFor(baseEnv({ [SHIELD]: undefined, [PEPPER]: undefined }));
    assert.equal(shieldOff.registrationShieldBlocked, false,
      "with the shield off the gate never runs, so this is not the blocked state");
  });

  it("reads the shield as a VALUE, agreeing with the repository that enforces it", () => {
    // isBetaInviteGateEnabled() is `=== "true"`. A presence-only read here would
    // report the shield ON for ARX_BETA_INVITE_REQUIRED="false" and produce a
    // blocker for a deployment that is fine.
    const item = pepperItem(baseEnv({ NODE_ENV: "development", [SHIELD]: "false" }));
    assert.equal(item.required, false,
      "ARX_BETA_INVITE_REQUIRED=false must not be read as the shield being on");
  });

  it("is NOT required in a plain development env with the shield off", () => {
    // The fail-closed refusal is still correct there; it just is not a launch
    // blocker, and crying wolf in dev is how a real blocker gets ignored.
    const item = pepperItem(baseEnv({ NODE_ENV: "development", [SHIELD]: undefined }));
    assert.equal(item.required, false);
    assert.equal(item.requiredBecause, null);
  });

  it("did not change any other var's requiredness", () => {
    const items = computeEnvChecklist(baseEnv());
    const req = items.filter((i) => i.required).map((i) => i.varName).sort();
    assert.deepEqual(req, ["DATABASE_URL", "NODE_ENV", "PORT", "REGISTRATION_KEY_PEPPER", "SESSION_SECRET"]);
  });
});

describe("boot checklist — the startup path actually says it out loud", () => {
  const indexSrc = readFileSync(resolve(ROOT, "artifacts/api-server/src/index.ts"), "utf8");

  it("logs the blocked shield at ERROR, not WARN or INFO", () => {
    const at = indexSrc.indexOf("registrationShieldBlocked");
    assert.ok(at > 0, "index.ts must consult summary.registrationShieldBlocked");
    const guard = indexSrc.indexOf("if (summary.registrationShieldBlocked)");
    assert.ok(guard > 0, "the blocked state must be branched on explicitly");
    const block = indexSrc.slice(guard, guard + 1400);
    assert.ok(/logger\.error\(/.test(block),
      "REGISTRATION SHIELD BLOCKED must be logged at ERROR — a warn is lost in startup noise");
    assert.ok(/redeploy/i.test(block),
      "the log must name the redeploy step; a set secret does not reach a published build without it");
  });

  it("surfaces a dedicated launch blocker, not just a generic missing-var one", () => {
    const src = readFileSync(resolve(ROOT, "artifacts/api-server/src/routes/adminLaunchReadiness.ts"), "utf8");
    assert.ok(src.includes("REGISTRATION_SHIELD_BLOCKED"),
      "the readiness panel must name this state specifically");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Nothing logs or returns the value
// ───────────────────────────────────────────────────────────────────────────

describe("the pepper value never leaves the process", () => {
  it("the checklist reports presence only — never the value or its length", () => {
    const secret = "a-very-distinctive-pepper-value-for-this-test-only";
    const env = baseEnv({ [PEPPER]: secret, [SHIELD]: "true" });
    const items = computeEnvChecklist(env);
    const summary = summarizeEnvChecklist(items, env);
    const serialized = JSON.stringify({ items, summary });
    assert.ok(!serialized.includes(secret), "the checklist serialized the pepper value");
    assert.ok(!serialized.includes(String(secret.length)),
      "the checklist leaked the pepper's length — a length is still an oracle");
    const item = items.find((i) => i.varName === PEPPER)!;
    assert.equal(item.present, true);
    assert.equal(typeof item.present, "boolean", "presence must be a boolean, not a value");
  });

  it("no source file interpolates the pepper into a log, a response or a message", () => {
    // A CI-guard-shaped check: a unit test cannot see a leak in a file it does
    // not import. Reading the pepper is fine; putting the READ VALUE somewhere
    // it can be observed is not.
    const files = [
      "artifacts/api-server/src/index.ts",
      "artifacts/api-server/src/lib/startup/envChecklist.ts",
      "artifacts/api-server/src/routes/adminBetaControl.ts",
      "artifacts/api-server/src/routes/adminLaunchReadiness.ts",
      "artifacts/api-server/src/routes/auth.ts",
      "lib/db/src/repositories/betaInvites.ts",
      "scripts/src/preflightRegistrationKeyPepper.ts",
      "scripts/src/verifySecretProvisioning.ts",
    ];
    // `process.env.REGISTRATION_KEY_PEPPER` / `env["REGISTRATION_KEY_PEPPER"]`
    // appearing inside a template literal, a console call or a res.json.
    const leakShapes = [
      /console\.(log|error|warn|info)\([^)]*(process\.env\S*REGISTRATION_KEY_PEPPER|pc\.pepper|\bpepper\.pepper)/,
      /logger\.\w+\([^)]*(process\.env\S*REGISTRATION_KEY_PEPPER|pc\.pepper)/,
      /res\.(json|send)\([^)]*(process\.env\S*REGISTRATION_KEY_PEPPER|pc\.pepper)/,
      /\$\{\s*(process\.env\[?["']?REGISTRATION_KEY_PEPPER|pc\.pepper)/,
    ];
    for (const f of files) {
      const src = codeOnly(f);
      for (const rx of leakShapes) {
        assert.ok(!rx.test(src), `${f} appears to emit the pepper value (${rx})`);
      }
    }
  });

  it("the pre-flight never selects a hash column", () => {
    // The stored hash is not the pepper, but it is the other half of the
    // offline brute force. The pre-flight has no reason to read it.
    const src = codeOnly("scripts/src/preflightRegistrationKeyPepper.ts");
    assert.ok(!/invite_code_hash/i.test(src), "the pre-flight reads invite_code_hash");
    assert.ok(!/\binvite_code\b(?!_)/i.test(src), "the pre-flight reads the legacy plaintext column");
  });

  it("the post-set verification refuses to print the value it holds", () => {
    const src = codeOnly("scripts/src/verifyRegistrationKeyPepperProvisioned.ts");
    // It holds `pepperValue` in memory to prove no response body contains it.
    // That is the one legitimate use; it must never reach output.
    assert.ok(!/console\.\w+\([^)]*pepperValue(?!\.length)/.test(src),
      "the verification prints pepperValue");
    assert.ok(src.includes("pepperValue.length"),
      "the >= 32 shape check is the intended use of the length");
  });

  it("the post-set verification refuses to print the LENGTH either", () => {
    // The lookahead above deliberately exempts `.length`, which is right for
    // the `>= 32` comparison and WRONG for output: the script used to
    // interpolate the real length into its PASS label, and on Replit that line
    // persists in workflow and deploy logs. A length narrows an offline search,
    // so the comparison may use it and no emitted string may carry it.
    const src = codeOnly("scripts/src/verifyRegistrationKeyPepperProvisioned.ts");
    assert.ok(!/\$\{[^}]*pepperValue\.length/.test(src),
      "the verification interpolates the pepper's real length into an emitted string");
    assert.ok(!/console\.\w+\([^)]*pepperValue\.length/.test(src),
      "the verification passes the pepper's real length to console");
    // The check itself must survive — this test must not be satisfiable by
    // deleting the length assertion.
    assert.ok(/pepperValue\.length\s*>=\s*32/.test(src),
      "the >= 32 length check is gone");
  });

  it("no doc routes the pepper through setEnvVars", () => {
    // The operational memory doc opened with "NEVER set the pepper via
    // setEnvVars — shared env vars are written INTO the git-tracked .replit"
    // and then, two paragraphs down under "Activation in dev", told the reader
    // to do exactly that. A future agent reading only the nearest heading
    // re-runs the 2026-08-16 leak. Every surviving mention must be a
    // prohibition.
    for (const rel of [
      ".agents/memory/registration-key-pepper-operational.md",
      "docs/REGISTRATION_KEY_PEPPER_RUNBOOK.md",
    ]) {
      const doc = readFileSync(resolve(ROOT, rel), "utf8");
      doc.split("\n").forEach((line, i) => {
        if (!/setEnvVars|userenv\.shared/.test(line)) return;
        assert.ok(/\bnever\b|\bnot\b|\bdo not\b/i.test(line),
          `${rel}:${i + 1} mentions setEnvVars without forbidding it: ${line.trim()}`);
      });
    }
  });

  it("the post-set verification cannot leave a residual account behind", () => {
    // Its header promises every row it writes is deleted in a finally. Each
    // cleanup DELETE used to carry its own `.catch(() => {})`, so a blocked
    // `DELETE FROM users` was invisible and the verdict — which keys solely on
    // `failures === 0` — still printed PROVISIONED AND WORKING. The runbook
    // directs a second run with ARX_QA_BASE_URL, where the pool points at the
    // live database, so that residue would be a real account in production.
    const src = codeOnly("scripts/src/verifyRegistrationKeyPepperProvisioned.ts");
    // Nothing between the users DELETE and the end of its statement may be a
    // `.catch(...)` — that is exactly the shape that hid the failure.
    assert.ok(!/"DELETE FROM users[^"]*"[^;]*\.catch\(/.test(src),
      "the users cleanup delete still swallows its own failure");
    assert.ok(/async function cleanupDelete\(/.test(src),
      "the reporting cleanup-delete helper is gone");
    assert.ok(/cleanupDelete\(\s*"DELETE FROM users/.test(src),
      "the users delete does not go through the reporting helper");
    // Reporting the delete is not enough on its own — absence has to be
    // re-read, and an unreadable re-read has to fail rather than pass.
    assert.ok(/residual account remains/.test(src),
      "there is no post-delete residual-account assertion");
    assert.ok(/could not confirm .*is gone/.test(src),
      "an unreadable residual check does not fail the run");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The rotation window works at the point that matters
// ───────────────────────────────────────────────────────────────────────────

/** Extract the bound parameter values from a drizzle condition. */
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object") return out;
  const n = node as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
  if (n.constructor?.name === "Param") out.push(n.value);
  if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) boundValues(c, out);
  return out;
}

interface FakeRow {
  id: number; status: string; email: string | null;
  keyPrefix: string | null; inviteCode: string | null;
  roleGrant: string | null; expiresAt: Date | null;
  inviteCodeHash: string;
}

/** A transaction stand-in that answers only from an in-memory row set, so the
 *  tier order acceptInviteTx actually uses is observable without a database. */
function fakeTx(rows: FakeRow[]) {
  const selectedHashes: string[] = [];
  const tx = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_q: unknown): Promise<any> => ({ rows: [{ c: 0 }] }),
    select: () => ({
      from: () => ({
        where: (cond: unknown) => ({
          limit: async (_n: number): Promise<FakeRow[]> => {
            const want = boundValues(cond).filter((v): v is string => typeof v === "string");
            for (const w of want) selectedHashes.push(w);
            const hit = rows.find((r) => want.includes(r.inviteCodeHash));
            return hit ? [hit] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: async (): Promise<FakeRow[]> => {
            const id = boundValues(cond).find((v) => typeof v === "number");
            const row = rows.find((r) => r.id === id);
            if (!row) return [];
            Object.assign(row, patch);
            return [row];
          },
        }),
      }),
    }),
  };
  return { tx, selectedHashes };
}

function hashUnder(pepper: string, rawKey: string): string {
  return createHash("sha256")
    .update(betaInvitesRepo.normalizeArxKey(rawKey) + pepper, "utf8")
    .digest("hex");
}

function rowFor(hash: string): FakeRow {
  return {
    id: 4242, status: "PENDING", email: null,
    keyPrefix: "ARX-AAAA", inviteCode: null, roleGrant: null,
    expiresAt: null, inviteCodeHash: hash,
  };
}

/** Run `fn` with a specific current/previous pepper pair, restoring both. */
async function withPeppers<T>(
  current: string | null, previous: string | null, fn: () => Promise<T>,
): Promise<T> {
  const prevCur = process.env[PEPPER];
  const prevPrev = process.env[PREV];
  if (current === null) delete process.env[PEPPER]; else process.env[PEPPER] = current;
  if (previous === null) delete process.env[PREV]; else process.env[PREV] = previous;
  try {
    return await fn();
  } finally {
    if (prevCur === undefined) delete process.env[PEPPER]; else process.env[PEPPER] = prevCur;
    if (prevPrev === undefined) delete process.env[PREV]; else process.env[PREV] = prevPrev;
  }
}

const CURRENT = "current-pepper-for-this-test-only-0000000000";
const PREVIOUS = "previous-pepper-for-this-test-only-111111111";
const RAW_KEY = "ARX-AAAA-BBBB-CCCC";

describe("candidate hashes — the single source of truth for the peppered tiers", () => {
  it("is EMPTY when the current pepper is absent, whatever PREVIOUS says", async () => {
    await withPeppers(null, PREVIOUS, async () => {
      assert.deepEqual(
        betaInvitesRepo.registrationKeyPepperedHashCandidates(RAW_KEY), [],
        "a stale secret must never stand in for a missing primary",
      );
    });
  });

  it("is the current pepper alone when no window is open", async () => {
    await withPeppers(CURRENT, null, async () => {
      const c = betaInvitesRepo.registrationKeyPepperedHashCandidates(RAW_KEY);
      assert.deepEqual(c, [hashUnder(CURRENT, RAW_KEY)]);
    });
  });

  it("is current-then-previous, in that order, while a window is open", async () => {
    await withPeppers(CURRENT, PREVIOUS, async () => {
      const c = betaInvitesRepo.registrationKeyPepperedHashCandidates(RAW_KEY);
      assert.deepEqual(c, [hashUnder(CURRENT, RAW_KEY), hashUnder(PREVIOUS, RAW_KEY)]);
    });
  });

  it("normalizes the raw code the same way the minter does", async () => {
    await withPeppers(CURRENT, null, async () => {
      const messy = " arx aaaa.bbbb__cccc ";
      assert.deepEqual(
        betaInvitesRepo.registrationKeyPepperedHashCandidates(messy),
        betaInvitesRepo.registrationKeyPepperedHashCandidates(RAW_KEY),
        "a pasted key with odd separators must reach the same hash",
      );
    });
  });
});

describe("acceptInviteTx honours the rotation window", () => {
  it("accepts a key stored under the PREVIOUS pepper while the window is open", async () => {
    // THE REGRESSION. Before the fix acceptInviteTx hashed with the current
    // pepper only, so this key validated and then failed here with
    // INVITE_NOT_FOUND, rolling the whole registration back.
    await withPeppers(CURRENT, PREVIOUS, async () => {
      const { tx } = fakeTx([rowFor(hashUnder(PREVIOUS, RAW_KEY))]);
      const r = await betaInvitesRepo.acceptInviteTx(tx, {
        inviteCode: RAW_KEY, email: "holder@arx.test", userId: 7,
        auditFn: async () => {},
      });
      assert.equal(r.ok, true,
        `a previous-pepper key must redeem during the window (got ${r.ok ? "ok" : r.error})`);
      assert.equal(r.ok && r.invite.status, "ACCEPTED");
      assert.equal(r.ok && r.invite.acceptedUserId, 7);
    });
  });

  it("still accepts a key stored under the CURRENT pepper, tried first", async () => {
    await withPeppers(CURRENT, PREVIOUS, async () => {
      const { tx, selectedHashes } = fakeTx([rowFor(hashUnder(CURRENT, RAW_KEY))]);
      const r = await betaInvitesRepo.acceptInviteTx(tx, {
        inviteCode: RAW_KEY, email: "holder@arx.test", userId: 8,
        auditFn: async () => {},
      });
      assert.equal(r.ok, true);
      assert.equal(selectedHashes[0], hashUnder(CURRENT, RAW_KEY),
        "the current pepper must be tried first");
    });
  });

  it("refuses a previous-pepper key once the window is CLOSED", async () => {
    // Unsetting PREVIOUS is what ends the migration. It must actually end it.
    await withPeppers(CURRENT, null, async () => {
      const { tx } = fakeTx([rowFor(hashUnder(PREVIOUS, RAW_KEY))]);
      const r = await betaInvitesRepo.acceptInviteTx(tx, {
        inviteCode: RAW_KEY, email: "holder@arx.test", userId: 9,
        auditFn: async () => {},
      });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, "INVITE_NOT_FOUND");
    });
  });

  it("refuses everything when the current pepper is absent, window or not", async () => {
    await withPeppers(null, PREVIOUS, async () => {
      const { tx, selectedHashes } = fakeTx([rowFor(hashUnder(PREVIOUS, RAW_KEY))]);
      const r = await betaInvitesRepo.acceptInviteTx(tx, {
        inviteCode: RAW_KEY, email: "holder@arx.test", userId: 10,
        auditFn: async () => {},
      });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, "PEPPER_MISSING");
      assert.deepEqual(selectedHashes, [], "no lookup may run at all without the current pepper");
    });
  });

  it("validation and acceptance read the SAME candidate list", () => {
    // They drifted once, silently, and the drift only showed up mid-signup.
    // Pin that both call sites go through the shared helper.
    const src = readFileSync(resolve(ROOT, "lib/db/src/repositories/betaInvites.ts"), "utf8");
    const calls = src.match(/registrationKeyPepperedHashCandidates\(/g) ?? [];
    assert.ok(calls.length >= 3,
      `expected the shared helper to be defined and used by both lookup paths (found ${calls.length} occurrences)`);
    const acceptAt = src.indexOf("export async function acceptInviteTx");
    assert.ok(acceptAt > 0);
    const acceptEnd = src.indexOf("export function inviteErrorMessage", acceptAt);
    assert.ok(acceptEnd > acceptAt, "could not bound the acceptInviteTx body");
    const acceptBody = src.slice(acceptAt, acceptEnd);
    assert.ok(acceptBody.includes("registrationKeyPepperedHashCandidates("),
      "acceptInviteTx must use the shared candidate list, not hash inline");
    assert.ok(!acceptBody.includes("pc.pepper"),
      "acceptInviteTx must not hash the pepper inline again — that is how the tiers drifted");
  });
});

describe("findInviteByCode keeps its fail-closed shape", () => {
  it("exposes the previous pepper only as a non-empty value", async () => {
    await withPeppers(CURRENT, "   ", async () => {
      assert.equal(betaInvitesRepo.getRegistrationKeyPepperPrevious(), null,
        "whitespace must not open a rotation window");
      assert.deepEqual(
        betaInvitesRepo.registrationKeyPepperedHashCandidates(RAW_KEY),
        [hashUnder(CURRENT, RAW_KEY)],
      );
    });
  });

  it("the ARX-format fail-closed guard is still in the lookup", () => {
    const src = readFileSync(resolve(ROOT, "lib/db/src/repositories/betaInvites.ts"), "utf8");
    const at = src.indexOf("export async function findInviteByCode");
    const body = src.slice(at, src.indexOf("export async function findInvitesByEmail"));
    assert.ok(body.includes("looksLikeArxKey(code)"),
      "an ARX-shaped code must never fall through to the legacy tiers without a pepper");
  });

  it("hashRegistrationKeyPeppered still throws rather than degrading", () => {
    return withPeppers(null, null, async () => {
      assert.throws(
        () => betaInvitesRepo.hashRegistrationKeyPeppered("ARX-AAAA-BBBB-CCCC"),
        /REGISTRATION_KEY_PEPPER_MISSING/,
      );
    });
  });
});
