# Per-release safety cases (#55)

One file per release: `<release-id>.safety-case.md`.

Generate the skeleton (computes the change scope from git):

```bash
pnpm --filter @workspace/scripts run release:safety-case -- --release v1.2.3 [--base <ref>]
```

Then FILL IN every `TBD_REQUIRED` section — new failure modes declared,
replay/shadow evidence links, rollback, approvals — and commit the document
BEFORE tagging. The CI guard `release-safety-case`
(`scripts/src/ci/check-release-safety-case.ts`) refuses a release-tagged build
(a `v*`/`release-*` tag at HEAD, or `ARX_RELEASE_TAG` set) whose safety case is
missing, still carries a placeholder, or names a different commit.

Development builds need nothing from this directory. Green CI with a passing
safety case still never grants live authority (Capital Constitution
Article IV) — this is a floor for releasing, not a grant.
