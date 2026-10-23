---
name: Render-proof tests mock hooks, not providers
description: Scanner/card render-proof suites render with NO QueryClientProvider and mock every data hook; adding a new data hook to a component crashes them until you mock it too.
---

# Render-proof component tests mock data hooks, not a QueryClient

Scanner-page (and similar) component render-proof suites — e.g.
`RubyMarketReadCard.test.tsx` (run by `test:scanner-ux`) — deliberately render
the component with **no `QueryClientProvider`** and `vi.mock(...)` every data
hook it uses. They also mock the whole `@workspace/api-client-react` module
exposing ONLY the generated hooks that test references (e.g. just
`useGetMeMarketEdge` + its queryKey).

**The trap:** when you add a new react-query-backed hook to such a component
(e.g. `useSymbolTruth`, which pulls `useGetMeMarketTruth` + `useScannerTruth`),
the suite breaks two ways: (1) runtime crash — the mocked api-client module is
missing the new generated hook AND there's no QueryClient; (2) any assertion
that depended on the old data path fails (e.g. `/updated \d+s ago/` once
freshness moved off `signal.generatedAt` onto a Truth-Snapshot timestamp that's
now null in the unmocked hook).

**Fix:** mock the new hook directly, mirroring the existing
`useScannerReadGate` mock — `const mock = vi.fn(); vi.mock("@/hooks/useX", () =>
({ useX: (...a) => mock(...a) }))` placed BEFORE the component import, with a
default `mockReturnValue` set in `beforeEach` (return realistic shape so render
assertions still pass).

**Why:** these suites are pure render proofs; the hook's real behavior is
proven elsewhere (server/resolver tests). Mocking the hook keeps them
network-free instead of wiring a QueryClient.

**How to apply:** before adding any data hook to a scanner/card component,
grep its `*.test.tsx` for `QueryClientProvider`; if absent, add the hook mock in
the same change or the suite will crash.
