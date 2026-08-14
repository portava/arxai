// AdminDiagnosticsGate — T012.
//
// Wraps any page whose UI exposes raw booleans, backend constants, gate
// names, env names, endpoint names, token labels, or other operator-only
// diagnostics. Normal authenticated users see a clean placeholder card;
// admin sessions render the children unchanged. Admin sessions that are
// currently previewing-as-user are treated as user sessions and ALSO
// see the placeholder — diagnostics must never leak through preview mode.
//
// SAFETY: read-only. No mutations, no dispatches. Server still gates
// every diagnostic API independently — this is a UX containment layer,
// not the trust boundary.

import { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldAlert, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useTradingMode } from "@/hooks/useTradingMode";

interface AdminDiagnosticsGateProps {
  pageTitle: string;
  pageDescription?: string;
  userSafeMessage?: string;
  children: ReactNode;
}

export function AdminDiagnosticsGate({
  pageTitle,
  pageDescription,
  userSafeMessage,
  children,
}: AdminDiagnosticsGateProps) {
  const mode = useTradingMode();

  // Loading: render nothing diagnostic-looking while we wait for the
  // resolver. Show a neutral placeholder so the user never glimpses raw
  // internals during the React Query refetch window.
  if (mode.isLoading || !mode.envelope) {
    return (
      <Card data-testid="admin-diag-gate-loading" className="max-w-2xl mx-auto mt-8">
        <CardHeader>
          <CardTitle>{pageTitle}</CardTitle>
          <CardDescription>Checking account permissions…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Admin + NOT previewing-as-user → render diagnostics.
  if (mode.shouldShowAdminDiagnostics && !mode.isAdminPreviewingUserMode) {
    return <>{children}</>;
  }

  // Everyone else (normal users, admin-previewing-user) → clean card.
  return (
    <Card data-testid="admin-diag-gate-blocked" className="max-w-2xl mx-auto mt-8 border-border bg-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-warning" aria-hidden="true" />
          <CardTitle>Admin diagnostics required</CardTitle>
        </div>
        {pageDescription && (
          <CardDescription className="text-txt-secondary">
            {pageDescription} is an operator-only diagnostic surface.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-txt-secondary" data-testid="admin-diag-gate-message">
          {userSafeMessage ??
            "This page exposes internal bridge, gate, and routing diagnostics. " +
              "Your account does not require any action here — bridge and broker setup is " +
              "managed by the operator. Contact your admin if you need a configuration change."}
        </p>
        <div className="rounded-md border border-border bg-background/40 p-3 text-xs text-txt-secondary">
          {mode.isAdminPreviewingUserMode
            ? "Diagnostics are also hidden while previewing as a user. Exit user preview to view operator tools."
            : "No raw account, bridge, or order internals are shown here. Your trading state is reflected on the user-facing pages."}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/my-account">
            <a>
              <Button variant="outline" size="sm" data-testid="admin-diag-gate-back">
                <ArrowLeft className="h-3 w-3 mr-1" aria-hidden="true" /> Back to My Account
              </Button>
            </a>
          </Link>
          <Link href="/help">
            <a>
              <Button variant="ghost" size="sm" data-testid="admin-diag-gate-help">
                Get help
              </Button>
            </a>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
