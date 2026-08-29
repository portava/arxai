import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";
import { useFeatureUnlock, type FeatureKey } from "@/hooks/useFeatureUnlock";

interface FeatureGateProps {
  feature: FeatureKey;
  title: string;
  description: string;
  ctaLabel: string;
  testid?: string;
  children: React.ReactNode;
}

/**
 * Hides a panel until the user explicitly clicks the unlock CTA in this
 * browser session. See useFeatureUnlock for caveats — this is a UI gate,
 * not real auth.
 */
export function FeatureGate({
  feature,
  title,
  description,
  ctaLabel,
  testid,
  children,
}: FeatureGateProps) {
  const { unlocked, unlock } = useFeatureUnlock(feature);

  if (unlocked) return <>{children}</>;

  return (
    <Card className="border-card-border border-dashed" data-testid={testid ?? `gate-${feature}`}>
      <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-border">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
          <Lock size={14} className="text-txt-muted" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="text-sm text-txt-secondary mb-4">{description}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={unlock}
          data-testid={`unlock-${feature}`}
        >
          {ctaLabel}
        </Button>
      </CardContent>
    </Card>
  );
}
