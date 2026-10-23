import { Suspense, lazy, type ReactNode } from "react";
import { Switch, Route, useLocation } from "wouter";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { normalizeProductRole, productRoleHomePath } from "@/lib/productRole";
import { Skeleton } from "@/components/ui/skeleton";

const LoginPage = lazy(() => import("@/pages/login"));
const RegisterPage = lazy(() => import("@/pages/register"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));

// Routes an anonymous visitor is allowed to reach. /reset-password is here so a
// user who forgot their password can follow the emailed reset link while
// logged out (Task #202).
const ANON_ROUTES = new Set(["/login", "/register", "/reset-password"]);

function AuthFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Skeleton className="h-72 w-full max-w-md" />
    </div>
  );
}

// Wraps the entire authenticated app. Anonymous visitors see only /login
// and /register routes. Once signed in, the children (the full Router)
// render. This is the single boundary that keeps private trading data
// off a fresh browser — no MT5, no paper ideas, no AI history, nothing
// loads until /api/me returns a user.
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading } = useCurrentUser();
  const [location, navigate] = useLocation();

  if (isLoading) return <AuthFallback />;

  if (!user) {
    // Allow the public auth routes; redirect anything else to /login.
    if (!ANON_ROUTES.has(location)) {
      // Defer to next tick so React doesn't complain about state-during-render.
      queueMicrotask(() => navigate("/login"));
      return <AuthFallback />;
    }
    return (
      <Suspense fallback={<AuthFallback />}>
        <Switch>
          <Route path="/register" component={RegisterPage} />
          <Route path="/reset-password" component={ResetPasswordPage} />
          <Route path="/login" component={LoginPage} />
          <Route component={LoginPage} />
        </Switch>
      </Suspense>
    );
  }

  // Signed in — bounce away from the public auth routes to the caller's
  // role-based home (admin → admin command center, investor → portal,
  // trader → cockpit). RouteAccessGuard further contains each role.
  if (ANON_ROUTES.has(location)) {
    const home = productRoleHomePath(normalizeProductRole(user.role));
    queueMicrotask(() => navigate(home));
    return <AuthFallback />;
  }

  return <>{children}</>;
}
