---
name: Radix Tabs activation in jsdom tests
description: Why fireEvent.click won't switch shadcn/Radix Tabs in vitest/jsdom and what to do instead
---

Radix UI `Tabs` (shadcn `components/ui/tabs.tsx`) default to **automatic** activation
(focus-driven). In jsdom a bare `fireEvent.click(trigger)` does NOT move focus, so the
tab never switches and the new TabsContent stays unmounted/hidden — tests that assert
the switched-tab content silently fail while the trigger query itself passes.

**How to apply:** in tests, select a tab with focus + click:
```ts
function selectTab(name: string) {
  const t = screen.getByRole("tab", { name });
  fireEvent.focus(t);   // triggers Radix automatic activation
  fireEvent.click(t);
}
```
(or use `@testing-library/user-event` `userEvent.click`, which focuses too — but this repo
has no user-event dependency, so prefer the focus+click helper).
