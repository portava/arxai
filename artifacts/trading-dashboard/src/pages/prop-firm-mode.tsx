// Prop Firm Mode — RETIRED SURFACE.
//
// WHAT WAS WRONG (rank-82 audit finding):
//
//   * This page drove `propFirm`, a single MODULE-LEVEL mutable object in
//     lib/riskGovernor2.ts. No userId anywhere: configure/reset mutated that
//     one object, so one user's Save or Reset changed the challenge rules for
//     EVERY user, and everything vanished on restart with no notice.
//   * "Profit USD" came from propFirmStatus() → pnlSummary() over the
//     process-global in-memory positions Map — the aggregate of all users'
//     simulator positions, presented as the reader's own challenge progress.
//   * It sent `x-security-role: ADMIN` on every write. That header is a
//     dev-only back-compat fallback, so where it is honoured the page granted
//     itself admin authority; where it is not, /prop-firm/configure returned
//     403 and the page discarded the response, showing a silent no-op as a
//     successful save.
//   * App.tsx routes TWO pages both titled "Prop Firm Challenge Mode".
//     /prop-challenge is the real one: per-user, DB-backed and requireUser-
//     gated (routes/propChallenges.ts). The two shared no state, so a user who
//     found both saw two identically named challenges with different balances,
//     different rules and contradictory pass/fail status.
//
// Rather than show numbers that belong to no one, this surface is retired in
// place: no reads of the global object, no writes at all, and a direct route to
// the implementation that is actually per-user. The route stays so existing
// links and bookmarks land on an explanation instead of a 404.

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trophy, ArrowRight } from "lucide-react";

export default function PropFirmMode() {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <Trophy className="h-6 w-6 text-muted-foreground" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Prop Firm Mode (retired)</h1>
          <p className="text-sm text-muted-foreground">
            This page has been replaced by the per-account Prop Firm Challenge.
          </p>
        </div>
        <Badge variant="outline">RETIRED</Badge>
      </div>

      <Card data-testid="prop-firm-mode-retired">
        <CardHeader>
          <CardTitle className="text-base">Why this page is gone</CardTitle>
          <CardDescription>Stated plainly, because the numbers it used to show were not yours.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            This screen edited a single challenge shared by every user of the server: saving or resetting
            here changed the rules for everyone, and the &quot;Profit USD&quot; figure was the combined result of
            all users&apos; simulator positions, not your own. None of it survived a server restart.
          </p>
          <p>
            Your real challenge lives on <strong>Prop Firm Challenge</strong> — one challenge per account,
            stored in the database, and visible only to you.
          </p>
          <Button asChild>
            <a href="/prop-challenge" data-testid="link-prop-challenge">
              Open Prop Firm Challenge <ArrowRight className="h-4 w-4 ml-1" />
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
