---
name: Preview availability
description: Keep development authentication available when feature migrations are deferred.
---

Do not leave the preview API stopped merely because newly imported feature tables have not been migrated. First determine whether existing authentication can run independently, with schema-dependent and other background jobs paused in development.

**Why:** Pausing the entire API after a source import prevented the user from signing in even though the login routes did not require the new feature tables.

**How to apply:** Keep migration approval separate from preview authentication availability. Verify normal unauthenticated identity and rejected-login responses through the shared preview router. Preserve password checks, disabled trading, and the existing preview admin approval; never apply migrations or change production startup as an implicit part of restoring sign-in.
