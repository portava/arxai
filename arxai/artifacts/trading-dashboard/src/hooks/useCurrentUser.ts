import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Per-user identity client. Reads /api/me; null when logged out.
// All requests use credentials: "include" so the httpOnly arx_user_session
// cookie is sent. Identity itself is never written to localStorage.
//
// Fresh First-Load invariant — on logout we drop every per-user UI artifact
// that could leak User A's context to User B on a shared browser:
//   • highroll.activeSymbol / highroll.recentSymbols (last symbol + history)
//   • highroll.chartSymbol                          (TradingView chart symbol)
//   • highroll.onboarding.firstrun.dismissed.v1     (tour-dismissed flag)
//   • arx.nav.recent.v1                             (recent visited routes)
// User-scoped keys like `arx_feature_unlocks_v1:<userId>` are already
// per-user and intentionally preserved.
const CROSS_USER_LOCALSTORAGE_KEYS = [
  "highroll.activeSymbol",
  "highroll.recentSymbols",
  "highroll.chartSymbol",
  "highroll.onboarding.firstrun.dismissed.v1",
  "arx.nav.recent.v1",
] as const;

function clearCrossUserLocalStorage(): void {
  if (typeof window === "undefined") return;
  for (const k of CROSS_USER_LOCALSTORAGE_KEYS) {
    try { window.localStorage.removeItem(k); } catch { /* noop */ }
  }
}

export interface CurrentUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ME_KEY = ["me"] as const;
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const url = (p: string) => `${BASE}${p}`;

async function fetchMe(): Promise<CurrentUser | null> {
  const r = await fetch(url("/api/me"), { credentials: "include" });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`/api/me failed: ${r.status}`);
  const body = (await r.json()) as { user: CurrentUser };
  return body.user;
}

export function useCurrentUser() {
  const q = useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: 30_000,
    retry: false,
  });
  return {
    user: q.data ?? null,
    isLoading: q.isLoading,
    isSignedIn: !!q.data,
    refetch: q.refetch,
  };
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { email: string; password: string }) => {
      const r = await fetch(url("/api/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(vars),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Sign in failed.");
      }
      return (await r.json()) as { user: CurrentUser };
    },
    onSuccess: (data) => qc.setQueryData(ME_KEY, data.user),
  });
}

export interface RegisterError extends Error {
  field?: string;
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { email: string; password: string; name?: string; registrationKey?: string }) => {
      const r = await fetch(url("/api/auth/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(vars),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string; field?: string };
        const err: RegisterError = new Error(body.message ?? "Registration failed.");
        err.field = body.field;
        throw err;
      }
      return (await r.json()) as { user: CurrentUser };
    },
    onSuccess: (data) => qc.setQueryData(ME_KEY, data.user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch(url("/api/auth/user-logout"), {
        method: "POST",
        credentials: "include",
      });
    },
    onSuccess: () => {
      qc.setQueryData(ME_KEY, null);
      // Drop every cached query — they were scoped to the previous user.
      qc.clear();
      // Also drop every cross-user localStorage artifact (selected symbol,
      // chart symbol, recent symbols, recent nav, tour-dismissed). This is
      // the only way to guarantee that the NEXT user logging in on the same
      // browser sees a Fresh First-Load state — no leftover trading context,
      // no stale empty/non-empty heuristics, no other user's preferences.
      clearCrossUserLocalStorage();
    },
  });
}
