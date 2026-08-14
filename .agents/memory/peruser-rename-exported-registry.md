---
name: Per-user rename of a default-named exported registry
description: How to make a static, exported, test-asserted name-bearing registry per-user without breaking its data contract or internal identifiers.
---

When a personalization/branding rename must make a *static module-scope* array
(nav groups, command-palette items, option lists) reflect a *per-user* dynamic
name:

- Convert the static `const X = [...]` into a factory `buildX(name) => [...]`
  and resolve `name` from the React context hook (e.g. `useAssistantName()`)
  at the *consumption site* (inside the component), not at module scope.
- If the array is **exported and asserted by a test as static data**, keep the
  export: `export const X = buildX(DEFAULT_NAME)` (a default-named snapshot).
  The test inspects structure (length/href/admin flags) which is name-independent,
  so it stays green untouched.
- If a resolver consumes the exported const, give it an **optional items param**
  defaulting to the snapshot: `resolve(opts, items = X)`. Existing one-arg
  callers/tests keep working; the component passes the per-user `buildX(name)`.

**Why:** keeps the change branding-only and non-breaking — preserves the
deterministic test/data contract while still rendering the customized name live.

**Internal-identifier rule:** when a `const` must become a function purely to
inject the dynamic name, KEEP the identifier NAME (e.g. `RUBY_AUTHORITY_OPTIONS`
stays `RUBY_AUTHORITY_OPTIONS`, just becomes `(name) => [...]`). Renaming the
identifier (even casing) violates a "personalization-only, internal identifiers
untouched" constraint and is flagged in review.
