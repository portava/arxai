---
name: Shared shell account-provider scope
description: Preserve authorization and context when moving account-dependent Cockpit controls into shared chrome.
---

Account-dependent Cockpit providers must remain behind the existing route guard when controls move into the shared shell.

**Why:** Lifting a provider above the guard can mount account queries even when the route's content is denied. Header placement must not broaden data access.

**How to apply:** Keep provider ownership with the authorized page. When shared chrome needs its controls, preserve that page's React context, for example with a portal, rather than moving the data provider outside authorization.
