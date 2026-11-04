import { Link, useLocation } from "wouter";
import { Compass, ArrowLeft, Home, Search } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { normalizeProductRole, productRoleHomePath } from "@/lib/productRole";

// In-app 404. Renders inside the app shell, so it uses the app's theme tokens
// and gives the user a way forward (home, back, search) instead of a dead end.
export default function NotFound() {
  const [location] = useLocation();
  const { user } = useCurrentUser();
  const home = user ? productRoleHomePath(normalizeProductRole(user.role)) : "/";
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;

  function openSearch() {
    // CommandPalette listens for Ctrl/Cmd+K.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true, bubbles: true }));
  }

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center p-4" data-testid="page-not-found">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <Compass className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-xl font-bold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          There is no page at <code className="rounded bg-muted px-1 py-0.5 text-xs" data-testid="not-found-path">{location}</code>. It may have moved or been removed.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href={home} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90" data-testid="not-found-home">
            <Home className="h-4 w-4" /> Go to home
          </Link>
          {canGoBack && (
            <button type="button" onClick={() => window.history.back()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted" data-testid="not-found-back">
              <ArrowLeft className="h-4 w-4" /> Go back
            </button>
          )}
          <button type="button" onClick={openSearch} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted" data-testid="not-found-search">
            <Search className="h-4 w-4" /> Search pages
          </button>
        </div>
      </div>
    </div>
  );
}
