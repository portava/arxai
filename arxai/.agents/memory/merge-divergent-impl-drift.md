---
name: Merge drift between two divergent implementations of one feature
description: When the platform merges two branches that both built the same feature, the on-disk helper can end up with an orphan API while runtime consumers expect a different one — app won't boot. How to detect and resolve.
---

# Merge drift: orphan helper API vs runtime consumers

Symptom: after a merge, `pnpm run build`/app boot fails (proxy 502) and a
package typecheck/CI harness throws `does not provide an export named X` /
`has no exported member Y`. The failing imports point at a single shared helper
file (e.g. a `lib/.../somethingReconcile.ts`).

Root cause: two agents/tasks each implemented the SAME feature with different
public APIs. The merge took one branch's helper file but the OTHER branch's
runtime consumers (routes/runners) + tests. The helper on disk is an **orphan**
(its only consumer is the parallel branch's test); the real runtime app imports
the other API → boot break.

**Why:** stale-based / non-3-way merges resolve a conflicted file to one side
without re-checking that its callers came from the same side. The breakage is
invisible until something actually loads the app (a standalone pure test of the
orphan can still pass).

**How to apply (resolution recipe):**
1. List the helper's current exports (`rg '^export (function|const|type|interface)'`).
2. Grep BOTH API surfaces across the repo (excluding the helper itself) to find
   every consumer of each. The API the **runtime app** (routes → runners) uses
   is canonical; the one used only by a single test file is the orphan.
3. Confirm the runtime consumers are byte-identical to a known-good commit
   (`git --no-optional-locks diff --stat <goodSha> HEAD -- <runner> <route> <test>`
   → empty diff means they were built against that commit's helper).
4. Restore the helper from that good commit with **read-only git**, never
   checkout/restore: `git --no-optional-locks show <sha>:<path> > <path>`.
5. Delete the orphan duplicate test and re-point its npm script to the surviving
   test that matches the restored API.
6. Re-typecheck (libs + api-server + scripts), run the pure + DB tests, the
   in-process CI suite, `ci:guards`, then **restart the api-server workflow and
   curl `/api/healthz` (expect 200)** — a green typecheck alone does not prove
   the app boots.

Related: `merge-mass-deletion-recovery.md` (a different post-merge failure —
mass file deletion rather than API divergence).
