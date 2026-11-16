---
name: Cockpit content sizing priority
description: Usable chart and expanded content now take priority over forcing the desktop desk into one viewport.
---

The desktop Cockpit must retain approximately 360px of usable price plot where the viewport permits, while bounding the plot to the visible desk height (normally about 60–70% of viewport height). Expanded panels retain intrinsic content height, except deliberately bounded scrollable detail regions. Scroll when necessary; do not squeeze panels to their headers to meet the older no-page-scroll goal.

**Why:** The owner verified that viewport-forced sizing crushed the plot and hid Review order, world clocks and risk content. Their subsequent request explicitly permits page or column scrolling instead.

**How to apply:** Preserve the chart floor including room for its axes, keep expanded controls accessible, and grow the last eligible panel to fill spare height on tall screens. Earlier strict no-scroll receipts do not override this newer acceptance requirement.

**Upper-bound priority:** Growing a column to fill spare space must not make the price plot unbounded. The owner subsequently reported a roughly 1,500px candle area and asked for a visible-desk ceiling. Keep long AI rationale contained and wrapping rather than letting it enlarge sibling columns.

Desktop panels slide fully into edge rails rather than folding vertically. Rail icons open temporary peeks; Keep open docks them back into the layout. Pinned panels stay open. Review order remains directly reachable.

**Why:** The owner subsequently requested every panel to slide completely closed, with brief peek views and an option to keep them open. This supersedes the earlier expand-and-focus choice.

**How to apply:** Preserve saved per-user/per-page states and pin protection. Respect reduced motion, keep existing dialogs and safety actions usable, and keep mobile focus independent of desktop rail preferences.
