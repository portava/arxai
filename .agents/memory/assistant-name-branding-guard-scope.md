---
name: Assistant-name guard scope
description: What the no-internal-names guard checks for the assistant name and why it has no allowlist.
---

# Assistant-name guard scope

`scripts/src/ci/check-no-internal-names-user-ui.ts` has two halves:

1. Regex patterns over the normal-user frontend (raw `/api/` paths in `<code>`,
   `JSON.stringify` rendered as text, internal tool names, typed-phrase prompts).
   Admin/dev pages, tests, benchmarks and JSX attribute values are excluded.
2. The old-assistant-codename ban: every tracked text file and every tracked
   path, any case, no allowlist (owner, 2026-11-05). The pattern is assembled
   from letters so the guard itself stays clean. Binary files are skipped by a
   NUL-byte check, except that their paths are still checked.

Regression suite: `pnpm --filter @workspace/scripts run test:no-internal-names-ui`.
