---
name: Recovering a post-merge mass file deletion
description: When a checkpoint/merge silently deletes hundreds of files (blank preview, "Failed to load /src/main.tsx"), how to diagnose and restore safely.
---

# Post-merge mass file deletion recovery

**Symptom:** App stops previewing; vite logs spam `Failed to load url /src/main.tsx (resolved id: ...). Does the file exist?`; `ls` confirms the entry file is physically gone.

**Root cause seen:** A task-agent merge whose branch was based on a stale snapshot can clobber `main` — the auto-checkpoint commit created at "Loop ended" then records a huge `D` (delete) batch. In one incident a single commit deleted 516 frontend files (all under `artifacts/trading-dashboard/`) while only adding 8 + modifying 74; its parent was the last known-good checkpoint.

**Diagnosis steps (all read-only git, allowed):**
- `git show <commit> --stat | tail` — see the deletions(-) magnitude.
- `git show <commit> --diff-filter=D --name-only --format=` — exact deleted paths.
- `git rev-list --parents -n 1 <commit>` — confirm the parent is the good state.
- Confirm deletions are scoped (e.g. all in one artifact dir) and list non-scoped changes to preserve them.

**Recovery (no destructive git — `checkout`/`restore`/`reset` are disallowed for the main agent):**
Restore each deleted path from the good parent using read-only `git show` piped to a file:
```bash
git show <commit> --diff-filter=D --name-only --format= > /tmp/deleted.txt
while IFS= read -r f; do [ -z "$f" ] && continue; mkdir -p "$(dirname "$f")"; git show "<goodParent>:$f" > "$f"; done < /tmp/deleted.txt
```
This is purely additive (deleted files are absent, so nothing is overwritten) and preserves any legitimate in-progress modifications/additions from the bad commit.

**Why surgical, not full revert:** restoring only the `D` paths keeps the possibly-legitimate refactor (the added/modified files) instead of nuking it. Then **typecheck the artifact** to prove the restored-old + kept-new mix is consistent; if it is and the preview renders, stop. Only fall back to a full dir revert if typecheck shows the mix is broken.

**How to apply:** restart the artifact workflow after restoring, verify entry file transforms (`curl localhost:80/src/main.tsx` → 200) + screenshot, then typecheck. Do NOT reach for `git checkout/restore`; use `git show`+write.
