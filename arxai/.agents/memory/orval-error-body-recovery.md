---
name: Orval hook error-body recovery
description: How to surface non-OK JSON fields (blockReason, autoDisarmed, error) after migrating raw fetch() to generated Orval React Query hooks.
---

When migrating a raw `fetch()` UI handler (one that read fields like
`blockReason` / `autoDisarmed` / `error` off a **non-OK** JSON body without
throwing) to a generated Orval mutation hook, the shared `customFetch` mutator
THROWS `ApiError` on any non-OK response, with the parsed error body attached as
`ApiError.data`.

**How to apply:** use `mutateAsync(...)` in a `try/catch`; in the catch read
`(e as { data?: { blockReason?: string; error?: string } | null }).data` to
recover the same fields, falling back to `(e as Error).message`. Success-path
fields (e.g. `autoDisarmed`) come off the typed 200 payload returned by
`mutateAsync`. Per-row in-flight UX (e.g. admin grant/revoke keyed by userId)
must stay in local `Record<id, boolean>` state — a single shared mutation hook's
`isPending` is global, not per-row.

**Why:** `customFetch` (`lib/api-client-react/src/custom-fetch.ts`) only returns
the parsed body on `response.ok`; otherwise it throws. Reading `.ok` off the
resolved value (old raw-fetch pattern) silently breaks once on hooks.

Cookies: hooks omit explicit `credentials:"include"`, but same-origin `/api/...`
calls send cookies by default — no regression vs the old explicit include.
