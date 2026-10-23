import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ARXLogo, ARXLogoMark, ARXWordmark, ARXBrandLockup, ARXIconBadge, ARX_BRAND } from "@/components/brand/ARXLogo";

function Swatch({ name, hex, ink = "white" }: { name: string; hex: string; ink?: "white" | "black" }) {
  return (
    <div
      className="rounded-md border border-zinc-800 p-3 flex flex-col justify-between h-24"
      style={{ background: hex, color: ink === "white" ? "#fff" : "#050B14" }}
      data-testid={`swatch-${name.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <span className="text-xs font-semibold drop-shadow">{name}</span>
      <span className="font-mono text-xs opacity-80">{hex}</span>
    </div>
  );
}

export default function BrandKit() {
  return (
    <div className="space-y-6 p-1" data-testid="page-brand-kit">
      <div className="rounded-lg border border-zinc-800 p-6 bg-gradient-to-b from-[#0F1A2E] to-[#050B14]">
        <ARXBrandLockup mode="dark" size="lg" showDescription />
      </div>

      <Card data-testid="brand-meaning">
        <CardHeader>
          <CardTitle>Brand meaning</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3 text-sm">
          <div className="rounded border border-zinc-800 p-3">
            <div className="text-2xl font-black tracking-wider">A</div>
            <div className="font-semibold">Analyze</div>
            <p className="text-muted-foreground mt-1">{ARX_BRAND.meaning.analyze}</p>
          </div>
          <div className="rounded border border-zinc-800 p-3">
            <div className="text-2xl font-black tracking-wider">R</div>
            <div className="font-semibold">Risk</div>
            <p className="text-muted-foreground mt-1">{ARX_BRAND.meaning.risk}</p>
          </div>
          <div className="rounded border border-zinc-800 p-3">
            <div className="text-2xl font-black tracking-wider"><span className="text-[#1E7BFF]">X</span></div>
            <div className="font-semibold">eXecute</div>
            <p className="text-muted-foreground mt-1">{ARX_BRAND.meaning.execute}</p>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="brand-logo-set">
        <CardHeader>
          <CardTitle>Logo system</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-800 p-4 bg-[#050B14] flex items-center justify-center min-h-[120px]">
            <ARXLogo mode="dark" size="md" />
          </div>
          <div className="rounded border border-zinc-200 p-4 bg-white flex items-center justify-center min-h-[120px]">
            <ARXLogo mode="light" size="md" />
          </div>
          <div className="rounded border border-zinc-800 p-4 bg-[#08111F] flex items-center justify-center min-h-[120px] gap-6">
            <ARXLogoMark size="lg" mode="dark" />
            <ARXLogoMark size="md" mode="dark" />
            <ARXLogoMark size="sm" mode="dark" />
          </div>
          <div className="rounded border border-zinc-800 p-4 bg-[#050B14] flex flex-col items-center justify-center gap-3 min-h-[120px]">
            <ARXWordmark mode="dark" size="lg" />
            <ARXWordmark mode="dark" size="sm" short />
          </div>
          <div className="rounded border border-zinc-800 p-4 bg-[#050B14] flex items-center justify-center min-h-[120px]">
            <ARXIconBadge size="lg" mode="dark" className="p-3" />
          </div>
          <div className="rounded border border-zinc-800 p-4 bg-[#050B14] flex items-center justify-center min-h-[120px]">
            <ARXBrandLockup mode="dark" size="md" showDescription />
          </div>
        </CardContent>
      </Card>

      <Card data-testid="brand-colors">
        <CardHeader>
          <CardTitle>Brand colors</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Swatch name="Primary Dark" hex="#050B14" />
          <Swatch name="Deep Navy" hex="#08111F" />
          <Swatch name="ARX Blue" hex="#1E7BFF" />
          <Swatch name="Electric Cyan" hex="#00B7FF" />
          <Swatch name="White" hex="#F8FAFC" ink="black" />
          <Swatch name="Silver" hex="#C9D3DF" ink="black" />
          <Swatch name="Muted" hex="#8B98A8" ink="black" />
          <Swatch name="Danger" hex="#EF4444" />
          <Swatch name="Success" hex="#22C55E" />
          <Swatch name="Warning" hex="#FACC15" ink="black" />
        </CardContent>
      </Card>

      <Card data-testid="brand-typography">
        <CardHeader>
          <CardTitle>Typography</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p><strong>Logo text:</strong> bold geometric uppercase, wide spacing, sharp angles.</p>
          <p><strong>App UI:</strong> clean sans-serif, readable on mobile, professional trading-terminal feel.</p>
          <p className="text-muted-foreground">Avoid: childish fonts, overly decorative fonts, crypto-meme style.</p>
          <div className="mt-3 grid gap-2">
            <div className="text-3xl font-black tracking-[0.18em] uppercase">ARX AI</div>
            <div className="text-base">Body text — Analyze the market. Control the risk. Execute with discipline.</div>
            <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">SYSTEM_STATUS · OWNER_TESTER · MT5_DEFERRED</div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="brand-tagline">
        <CardHeader>
          <CardTitle>Tagline & lockup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div><strong>Tagline:</strong> {ARX_BRAND.tagline}</div>
          <div><strong>Lockup:</strong> {ARX_BRAND.lockup}</div>
          <div><strong>Description:</strong> {ARX_BRAND.description}</div>
        </CardContent>
      </Card>

      <Card data-testid="brand-usage">
        <CardHeader>
          <CardTitle>Usage rules</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm list-disc pl-5">
            <li>Use <strong>ARX AI</strong> as the full product name.</li>
            <li>Use <strong>ARX</strong> as the short name.</li>
            <li>Keep <strong>eXecute</strong> with capital X when explaining the acronym.</li>
            <li>Use blue only for highlights, active states, the logo X, links, scanner accents, and command-center glow.</li>
            <li>Do not imply guaranteed profits.</li>
            <li>Do not say broker execution is live unless MT5 is connected.</li>
            <li>Do not place the logo on busy or low-contrast backgrounds — use Primary Dark or Deep Navy.</li>
          </ul>
          <div className="mt-3 flex gap-2 flex-wrap">
            <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">Owner Tester Access Active</Badge>
            <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">MT5 Deferred</Badge>
            <Badge className="bg-zinc-500/15 text-zinc-300 border-zinc-500/30">Real broker execution locked</Badge>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="brand-asset-files">
        <CardHeader>
          <CardTitle>Asset files</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <ul className="font-mono text-xs space-y-1">
            <li>/brand/arx-icon.svg</li>
            <li>/brand/arx-wordmark.svg</li>
            <li>/brand/arx-logo-dark.svg</li>
            <li>/brand/arx-logo-light.svg</li>
            <li>/brand/arx-logo-reference.svg</li>
            <li>/favicon.svg</li>
            <li>/site.webmanifest</li>
          </ul>
          <p className="text-xs text-muted-foreground mt-2">
            SVG assets are vector by construction; refine kerning and strokes with a designer for print/marketing exports.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
