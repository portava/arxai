// THEME E2 — pause/resume must not launder a dead key back into ACCEPTED.
//
// THE HOLE
//   `pauseInvite(id)` flipped ANY row to PAUSED by id alone — no status guard.
//   `resumeInvite(id)` is guarded (`status = PAUSED`) but sets status to
//   ACCEPTED unconditionally.
//
//   Chain them and a REVOKED key comes back to life:
//       REVOKED --pause--> PAUSED --resume--> ACCEPTED
//   Same for EXPIRED. An admin revoking a key had that revocation silently
//   reversible through two ordinary-looking clicks, and the audit trail reads
//   as a routine pause/resume rather than as an un-revoke.
//
// THE FIX
//   Guard the pause transition on the CURRENT status. Pause is only meaningful
//   for an ACCEPTED invite — that is what resume restores it to, and what
//   isUserPausedOrRevoked() is checking for. Restricting pause to ACCEPTED
//   closes the cycle: ACCEPTED <-> PAUSED, with no entry from REVOKED, EXPIRED
//   or PENDING.
//
//   Pausing a PENDING invite is now refused too. It was never coherent: resume
//   would have marked an unaccepted invite ACCEPTED, granting access nobody
//   claimed. REVOKE remains the tool for withdrawing an unaccepted invite.
//
// These are pure repository-level assertions on the SQL predicate; no DB is
// touched. The behavioural round-trip is covered by qaPrivateBeta10 (T9/T10).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");
const REPO = resolve(ROOT, "lib/db/src/repositories/betaInvites.ts");

function repoSource(): string {
  return readFileSync(REPO, "utf8");
}

function fnBody(name: string): string {
  const src = repoSource();
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start > -1, `${name} must exist`);
  const end = src.indexOf("\n}", start);
  assert.ok(end > start);
  return src.slice(start, end);
}

describe("E2 — pause is guarded on the current status", () => {
  it("does not update by id alone", () => {
    const body = fnBody("pauseInvite");
    const idOnly = /\.where\(\s*eq\(betaInvitesTable\.id,\s*id\)\s*\)/.test(body);
    assert.ok(
      !idOnly,
      "an id-only predicate lets ANY row be paused, including REVOKED and EXPIRED",
    );
  });

  it("requires the row to be ACCEPTED", () => {
    const body = fnBody("pauseInvite");
    assert.ok(/and\(/.test(body), "the predicate must be a conjunction");
    assert.ok(
      /eq\(betaInvitesTable\.status,\s*"ACCEPTED"\)/.test(body),
      "only an ACCEPTED invite may be paused — that is what resume restores",
    );
    assert.ok(/eq\(betaInvitesTable\.id,\s*id\)/.test(body), "still scoped to the row");
  });

  it("still writes the pause bookkeeping", () => {
    const body = fnBody("pauseInvite");
    assert.ok(/status:\s*"PAUSED"/.test(body));
    assert.ok(/pausedAt:/.test(body));
    assert.ok(/resumedAt:\s*null/.test(body));
  });
});

describe("E2 — resume stays guarded (unchanged)", () => {
  it("only a PAUSED row may resume", () => {
    const body = fnBody("resumeInvite");
    assert.ok(/eq\(betaInvitesTable\.status,\s*"PAUSED"\)/.test(body));
  });

  it("restores ACCEPTED", () => {
    const body = fnBody("resumeInvite");
    assert.ok(/status:\s*"ACCEPTED"/.test(body));
    assert.ok(/resumedAt:/.test(body));
  });
});

describe("E2 — the resurrection chain is closed", () => {
  it("no status other than ACCEPTED can enter PAUSED", () => {
    const body = fnBody("pauseInvite");
    for (const dead of ["REVOKED", "EXPIRED", "PENDING"]) {
      assert.ok(
        !new RegExp(`"${dead}"`).test(body),
        `pauseInvite must not admit ${dead} rows`,
      );
    }
  });

  it("PAUSED is reachable only from ACCEPTED, and resume only returns there", () => {
    // Together these two predicates make {ACCEPTED, PAUSED} a closed cycle:
    // nothing dead can get in, so nothing dead can come out as ACCEPTED.
    assert.ok(/eq\(betaInvitesTable\.status,\s*"ACCEPTED"\)/.test(fnBody("pauseInvite")));
    assert.ok(/eq\(betaInvitesTable\.status,\s*"PAUSED"\)/.test(fnBody("resumeInvite")));
  });
});

describe("E2 — the route reports the refusal honestly", () => {
  it("distinguishes not-found from not-pausable", () => {
    const route = readFileSync(
      resolve(ROOT, "artifacts/api-server/src/routes/adminBetaControl.ts"),
      "utf8",
    );
    const pauseBlock = route.slice(
      route.indexOf('router.post("/admin/beta/invites/:id/pause"'),
      route.indexOf('router.post("/admin/beta/invites/:id/resume"'),
    );
    assert.ok(pauseBlock.length > 0);
    assert.ok(
      /NOT_FOUND_OR_NOT_ACCEPTED/.test(pauseBlock),
      "a bare NOT_FOUND hides that the row exists but is not pausable",
    );
  });
});
