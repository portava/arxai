---
name: Post-merge db push hygiene
description: How scripts/post-merge.sh must run the Drizzle schema push so automatic post-merge setup doesn't hang or time out.
---

# Post-merge db push hygiene

`scripts/post-merge.sh` runs automatically after every task merge with **stdin
closed** (`/dev/null`) and a configurable timeout (in `.replit` `[postMerge]`).

Two rules:

1. Use the non-interactive push: `pnpm --filter @workspace/db run push-force`
   (which is `drizzle-kit push --force`), **never** the plain `push`. Interactive
   `drizzle-kit push` prompts on ambiguous changes (e.g. column renames); with
   stdin closed it gets EOF and the script hangs/fails.
2. The timeout must budget for `pnpm install` **plus** the schema push, with
   generous headroom. A clean run is ~15–23s, but `drizzle-kit push`'s "Pulling
   schema from database" introspection can spike under merge-time DB load and is
   **growing with the schema** — it has been observed at ~169s, then ~348s (total
   run ~369s). Set **600000ms**.

**Why:** a schema-adding merge first timed out at 20s (ran ~22.7s); later a merge
timed out at 180000ms because the schema-introspection step spiked to ~169s under
load even though the push itself succeeded ("[✓] Changes applied"); then a
*test-only* merge (no schema change at all) timed out again at 300000ms because
introspection spiked to ~348s (install 21s + push ~348s = ~369s). The
introspection time is variable and NOT proportional to what the merge changes —
it tracks total schema size + DB load — and it is trending up as the schema
grows, so the budget must stay generous and may need further raising over time.

**How to set:** direct edits to `.replit` are blocked; the `[postMerge]` timeout
can only be changed via `setPostMergeConfig({ scriptPath, timeoutMs })` (a
code_execution callback). Confirm with `getPostMergeConfig()`.

**How to apply:** When a merged/upcoming task adds DB tables (e.g. the Investor
Portal tables) and post-merge setup fails, first check it's `push-force` + a
generous timeout before suspecting the migration itself.
