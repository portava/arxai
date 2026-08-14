---
name: Preview-as-user loading race
description: Admin-previewing-as-user flags from useTradingMode default false during the initial query window; treat unresolved mode as preview-locked.
---

When gating client-side actions on `useTradingMode().isAdminPreviewingUserMode`, remember that the hook resolves asynchronously and the flag is `false` until the `/api/me/account-mode` query returns. A real admin clicking a button in that first window would bypass the preview block.

**Why:** Inviolable rule on preview-as-user is "no /validate, no /execute, no command/intent rows can ever be produced from a preview session." A `false`-by-default flag during loading silently violates this on the first paint.

**How to apply:** Build a derived `actionsLocked = isAdminPreviewingUserMode || mode.isLoading || !mode.envelope` and use it for every disabled/short-circuit check on buttons and handlers. Only use the raw `isAdminPreviewingUserMode` for things that are safe-when-false (e.g. showing the sky-blue Preview banner, hiding admin developer details). Same pattern applies any time UI safety hinges on an async-resolved role/scope/mode flag.
