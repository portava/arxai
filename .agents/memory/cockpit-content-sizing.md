---
name: Cockpit content sizing priority
description: Usable chart and expanded content now take priority over forcing the desktop desk into one viewport.
---

The desktop Cockpit must retain approximately 360px of usable price plot where the viewport permits, while bounding the plot to the visible desk height (normally about 60–70% of viewport height). Expanded panels retain intrinsic content height, except deliberately bounded scrollable detail regions. Scroll when necessary; do not squeeze panels to their headers to meet the older no-page-scroll goal.

**Why:** The owner verified that viewport-forced sizing crushed the plot and hid Review order, world clocks and risk content. Their subsequent request explicitly permits page or column scrolling instead.

**How to apply:** Preserve the chart floor including room for its axes, keep expanded controls accessible, and grow the last eligible panel to fill spare height on tall screens. Earlier strict no-scroll receipts do not override this newer acceptance requirement.

**Upper-bound priority:** Growing a column to fill spare space must not make the price plot unbounded. The owner subsequently reported a roughly 1,500px candle area and asked for a visible-desk ceiling. Keep long AI rationale contained and wrapping rather than letting it enlarge sibling columns.

Desktop side-rail interactions use expand-and-focus on both sides, not flyouts. Pinned panels stay shown; rail access to Review order opens the existing reviewed flow directly.

**Why:** The owner requested side collapse as an alternative to vertical folding and allowed either focus expansion or flyouts. Consistent focus expansion avoids introducing another overlay workspace.

**How to apply:** Preserve saved user/route rail choices and pin protection when adjusting layouts. Keep mobile focus independent of desktop rail preferences.
