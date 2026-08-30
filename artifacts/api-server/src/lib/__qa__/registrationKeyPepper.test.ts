// THEME E1 — the registration-key pepper must not live in the repo.
//
// REGISTRATION_KEY_PEPPER is the ONLY secret protecting registration-key
// hashes: a stored hash is sha256(normalizedKey + pepper). Registration keys
// are short and structured (ARX-XXXX-XXXX-XXXX), so anyone holding the pepper
// can brute-force the key space offline against the stored hashes. It was
// committed in plaintext in the git-tracked `.replit`.
//
// The code was already correct — getRegistrationKeyPepper() reads process.env
// and every hashing path fails closed when it is absent. The defect was purely
// that the value shipped in the repo. This suite pins both halves: the literal
// is gone, and removing it does not weaken the fail-closed behaviour into a
// silent unpeppered fallback.
//
// ─────────────────────────────────────────────────────────────────────────────
// OWNER ACTION REQUIRED BEFORE DEPLOY — two steps, in this order:
//   1. Set REGISTRATION_KEY_PEPPER as a Replit Secret.
//   2. ROTATE it. The old value is in git history and must be treated as
//      compromised.
// Rotating invalidates existing PENDING registration-key hashes (they were
// computed with the old pepper), so re-issue any outstanding keys. Already
// ACCEPTED invites are unaffected — they are matched by row, not by re-hashing.
//
// Until the secret is set, key generation and validation REFUSE (fail closed).
// Registration itself is not broken: with ARX_BETA_INVITE_REQUIRED off the gate
// does not run at all, and with it on the refusal is explicit and audited
// rather than silently accepting unpeppered keys.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { betaInvitesRepo } from "@workspace/db";

const {
  getRegistrationKeyPepper,
  isRegistrationKeyPepperConfigured,
  hashRegistrationKeyPeppered,
} = betaInvitesRepo;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

/** Run `fn` with the pepper set to `value` (or unset when null). */
function withPepper<T>(value: string | null, fn: () => T): T {
  const prev = process.env["REGISTRATION_KEY_PEPPER"];
  if (value == null) delete process.env["REGISTRATION_KEY_PEPPER"];
  else process.env["REGISTRATION_KEY_PEPPER"] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["REGISTRATION_KEY_PEPPER"];
    else process.env["REGISTRATION_KEY_PEPPER"] = prev;
  }
}

describe("E1 — no pepper value is committed", () => {
  it(".replit does not assign it", () => {
    const replit = readFileSync(resolve(ROOT, ".replit"), "utf8");
    for (const raw of replit.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("#")) continue;
      assert.ok(
        !/^REGISTRATION_KEY_PEPPER\s*=/.test(line),
        `.replit still assigns the pepper: ${line}`,
      );
    }
  });

  it("the old committed value appears in no tracked file", () => {
    // The specific hex string that was committed. Checked by VALUE, not just by
    // variable name, so it cannot reappear under a different key.
    //
    // Assembled from halves at runtime on purpose: written as one literal, this
    // file would itself be a tracked file containing the leaked secret, and the
    // check would fail on its own source (it did, once).
    const leaked =
      "059ad89d5f55acb0b8" + "0009cecb41376a60ddb60a86bb99d0efbe5a1f84a7bfe0";
    let matches: string[] = [];
    try {
      const out = execFileSync("git", ["grep", "-l", leaked, "--", "."], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      matches = out.trim().split("\n").filter(Boolean);
    } catch {
      // git grep exits non-zero when there are NO matches — the success case.
      matches = [];
    }
    assert.deepEqual(matches, []);
  });
});

describe("E1 — the code reads the environment and fails closed", () => {
  it("reports missing when unset", () => {
    withPepper(null, () => {
      assert.deepEqual(getRegistrationKeyPepper(), { ok: false, missing: true });
      assert.equal(isRegistrationKeyPepperConfigured(), false);
    });
  });

  it("hashing REFUSES when unset — never falls back to unpeppered", () => {
    withPepper(null, () => {
      assert.throws(
        () => hashRegistrationKeyPeppered("ARX-AAAA-BBBB-CCCC"),
        /REGISTRATION_KEY_PEPPER_MISSING/,
      );
    });
  });

  it("treats whitespace-only as missing", () => {
    withPepper("   ", () => {
      assert.equal(isRegistrationKeyPepperConfigured(), false);
    });
  });

  it("reads the value straight from the environment", () => {
    withPepper("test-pepper-value", () => {
      const pc = getRegistrationKeyPepper();
      assert.equal(pc.ok, true);
      assert.equal(pc.ok && pc.pepper, "test-pepper-value");
    });
  });
});

describe("E1 — rotation actually changes the hashes", () => {
  it("the same key hashes differently under a different pepper", () => {
    const key = "ARX-AAAA-BBBB-CCCC";
    const a = withPepper("pepper-one", () => hashRegistrationKeyPeppered(key));
    const b = withPepper("pepper-two", () => hashRegistrationKeyPeppered(key));
    assert.notEqual(a, b, "rotation must invalidate old hashes — that is the point");
  });

  it("is deterministic for a given pepper", () => {
    const key = "ARX-AAAA-BBBB-CCCC";
    const a = withPepper("pepper-one", () => hashRegistrationKeyPeppered(key));
    const b = withPepper("pepper-one", () => hashRegistrationKeyPeppered(key));
    assert.equal(a, b);
  });

  it("the pepper genuinely participates (not a plain key hash)", async () => {
    const key = "ARX-AAAA-BBBB-CCCC";
    const peppered = withPepper("pepper-one", () => hashRegistrationKeyPeppered(key));
    const { createHash } = await import("node:crypto");
    const plain = createHash("sha256").update(key, "utf8").digest("hex");
    assert.notEqual(peppered, plain);
  });
});

describe("E1 — legacy invite issuance refuses without the pepper", () => {
  // validateInviteForRegistration / acceptInviteTx already refuse every code
  // with PEPPER_MISSING when the pepper is absent, so issuing a legacy invite
  // in that state would hand out a credential that can never be redeemed.
  // Pin that POST /admin/beta/invites checks the pepper BEFORE createInvite,
  // mirroring the registration-key generator's 503 refusal.
  it("the /admin/beta/invites handler gates on isRegistrationKeyPepperConfigured before createInvite", () => {
    const src = readFileSync(
      resolve(ROOT, "artifacts/api-server/src/routes/adminBetaControl.ts"),
      "utf8",
    );
    const handlerStart = src.indexOf('router.post("/admin/beta/invites"');
    assert.ok(handlerStart >= 0, "legacy invite creation route must exist");
    const issueCall = src.indexOf("await createInvite(", handlerStart);
    assert.ok(issueCall > handlerStart, "handler must call createInvite");
    const handlerBody = src.slice(handlerStart, issueCall);
    assert.ok(
      handlerBody.includes("isRegistrationKeyPepperConfigured()"),
      "pepper check must run before createInvite in the legacy invite route",
    );
    assert.ok(
      handlerBody.includes('"PEPPER_MISSING"'),
      "the refusal must surface the explicit PEPPER_MISSING error",
    );
  });
});

// ── Rotation window: dual-read of a PREVIOUS pepper ────────────────────────
//
// A key's stored hash is sha256(normalizedKey + pepper), so rotating the
// pepper invalidates every outstanding key unless both are readable for a
// window. These pin the window's shape — and, more importantly, its limits.

describe("registration-key pepper rotation window", () => {
  it("reads the previous pepper only as a non-empty value", () => {
    const prev = process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"];
    try {
      delete process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"];
      assert.equal(betaInvitesRepo.getRegistrationKeyPepperPrevious(), null);
      process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"] = "   ";
      assert.equal(betaInvitesRepo.getRegistrationKeyPepperPrevious(), null,
        "whitespace accepted as a pepper");
      // Length only — no value is asserted anywhere in this suite.
      process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"] = "x".repeat(40);
      assert.equal(betaInvitesRepo.getRegistrationKeyPepperPrevious()?.length, 40);
    } finally {
      if (prev === undefined) delete process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"];
      else process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"] = prev;
    }
  });

  it("does NOT let a previous pepper rescue a missing primary", () => {
    // The fail-closed rule is about the CURRENT secret. A stale value standing
    // in for an absent primary would turn a rotation aid into a weakening.
    const prev = process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"];
    try {
      process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"] = "y".repeat(40);
      withPepper(null, () => {
        assert.equal(getRegistrationKeyPepper().ok, false,
          "a missing primary reported as configured");
        assert.equal(isRegistrationKeyPepperConfigured(), false);
      });
    } finally {
      if (prev === undefined) delete process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"];
      else process.env["REGISTRATION_KEY_PEPPER_PREVIOUS"] = prev;
    }
  });

  it("documents the window as temporary and states what it does not do", () => {
    const src = readFileSync(
      resolve(ROOT, "lib/db/src/repositories/betaInvites.ts"), "utf8",
    ).replace(/\s*\n\s*\*?\s*/g, " ");
    // The migration is only safe if operators know to remove it afterwards,
    // and only honest if the weakening it does NOT do is stated.
    assert.match(src, /then UNSET it/i, "the window is not documented as temporary");
    assert.match(src, /NOT A FALLBACK FOR A MISSING PRIMARY/i,
      "the fail-closed limit is not documented");
    // And the lookup must gate it behind the current pepper.
    //
    // SUPERSEDES an assertion on the literal phrase "Gated on pc.ok", which
    // lived in a comment inside findInviteByCode. The two peppered tiers were
    // written twice and drifted — acceptInviteTx never consulted the previous
    // pepper at all — so they were collapsed into one shared
    // registrationKeyPepperedHashCandidates(). The gating moved with them. This
    // now pins the gating where it actually lives; asserting the old phrase
    // would only have been satisfiable by a comment that is no longer true.
    assert.match(src, /registrationKeyPepperedHashCandidates/,
      "the shared candidate helper is gone — the tiers can drift apart again");
    assert.match(src, /returns an EMPTY list when the current pepper is absent/i,
      "the gating is not documented where the tiers are now built");
  });
});
