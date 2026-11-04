import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Home, Shield } from "lucide-react";
import { ARXShellFrame } from "./ARXShellFrame";

const route = vi.hoisted(() => ({ value: "/risk-command-center" }));

vi.mock("wouter", () => ({
  useLocation: () => [route.value, vi.fn()] as const,
  Link: ({ children, href, ...props }: React.PropsWithChildren<{ href: string; [key: string]: unknown }>) =>
    <a href={href} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
  SheetContent: ({ children, side, className }: React.PropsWithChildren<{ side?: string; className?: string }>) =>
    <div role="dialog" data-side={side} className={className}>{children}</div>,
  SheetHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

beforeEach(() => { route.value = "/risk-command-center"; });

describe("shared ARX shell on specialist routes", () => {
  it("keeps the current page highlighted with layout, safety and emergency controls", () => {
    render(<ARXShellFrame
      variant="page"
      title="Risk"
      eyebrow="ARX · TRADING WORKSPACE"
      dockItems={[
        { id: "cockpit", label: "Cockpit", icon: Home, href: "/" },
        { id: "risk", label: "Risk", icon: Shield, href: "/risk-command-center" },
      ]}
      mobileTrayItems={[{ id: "risk", label: "Risk", shortLabel: "Risk", icon: Shield, href: "/risk-command-center" }]}
      allToolsOpen={false}
      onAllToolsOpenChange={vi.fn()}
      mobileToolsOpen={false}
      onMobileToolsOpenChange={vi.fn()}
      layoutMenuContent={<button type="button">Dock expanded</button>}
      headerActions={<a href="/emergency" data-testid="shell-emergency-stop">Emergency Stop</a>}
      safetyNotice={<div data-testid="shell-safety-notice">Live mode and safety status</div>}
    >
      <div>Risk page content</div>
    </ARXShellFrame>);

    expect(screen.getByTestId("shell-dock-risk").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("shell-tray-risk").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("shell-emergency-stop")).toBeTruthy();
    expect(screen.getByTestId("shell-safety-notice")).toBeTruthy();
    expect(screen.getByText("Risk page content")).toBeTruthy();
    expect(screen.getByText("Layout")).toBeTruthy();
  });

  it("opens the role-filtered All tools content without leaving the page", () => {
    const onAllToolsOpenChange = vi.fn();
    render(<ARXShellFrame
      variant="page"
      title="Market Scanner"
      dockItems={[{ id: "scanner", label: "Market Scanner", icon: Home, href: "/market-scanner" }]}
      allToolsContent={<button type="button">Risk Command Center</button>}
      allToolsOpen
      onAllToolsOpenChange={onAllToolsOpenChange}
      mobileToolsOpen={false}
      onMobileToolsOpenChange={vi.fn()}
    >
      <div>Scanner content</div>
    </ARXShellFrame>);

    expect(screen.getByRole("dialog").getAttribute("data-side")).toBe("right");
    expect(screen.getByText("Risk Command Center")).toBeTruthy();
  });
});
