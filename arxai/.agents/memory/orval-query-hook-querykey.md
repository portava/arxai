---
name: Orval generated query hooks need explicit queryKey
description: When passing query options to a generated useGetX hook, you must also pass queryKey
---

When you supply a `query: {...}` options object to an Orval-generated `useGetX(params, { query })`
hook (e.g. just `refetchInterval`), TypeScript errors with TS2741 "Property 'queryKey' is missing".

**Why:** the generated `UseQueryOptions` makes `queryKey` required once you provide the options object;
the hook only auto-fills it when you omit options entirely.

**How to apply:** import the matching `getGetXQueryKey(params)` helper from `@workspace/api-client-react`
and pass `queryKey: getGetXQueryKey(params)` alongside your other query options.
