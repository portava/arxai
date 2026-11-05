import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Search } from "lucide-react";
import { WorkspacePanel, persistWorkspaceLayout, readWorkspaceLayout } from "./CommandWorkspace";

describe("workspace panel controls", () => {
  it("uses keyboard-focusable buttons to collapse, expand, and pin panels", () => {
    const onCollapse = vi.fn();
    const onPin = vi.fn();
    const { rerender } = render(<WorkspacePanel id="chart" title="Smart Chart" icon={Search} collapsed={false} pinned={false} onCollapse={onCollapse} onPin={onPin}>chart body</WorkspacePanel>);
    const collapse = screen.getByRole("button", { name: "Collapse Smart Chart" });
    expect(collapse.tagName).toBe("BUTTON");
    expect(collapse.getAttribute("type")).toBe("button");
    expect(collapse.tabIndex).toBe(0);
    fireEvent.click(collapse);
    fireEvent.click(screen.getByRole("button", { name: "Pin Smart Chart" }));
    expect(onCollapse).toHaveBeenCalledOnce();
    expect(onPin).toHaveBeenCalledOnce();
    rerender(<WorkspacePanel id="chart" title="Smart Chart" icon={Search} collapsed pinned onCollapse={onCollapse} onPin={onPin}>chart body</WorkspacePanel>);
    const pinnedCollapse = screen.getByRole("button", { name: "Collapse Smart Chart" }) as HTMLButtonElement;
    expect(pinnedCollapse.getAttribute("aria-expanded")).toBe("true");
    expect(pinnedCollapse.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Unpin Smart Chart" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("chart body")).toBeTruthy();
    expect(screen.getByText("PINNED")).toBeTruthy();
    expect(containerPanel(pinnedCollapse).getAttribute("data-collapsed")).toBe("false");
  });

  it("persists layout preferences only and ignores malformed or unknown panel data", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
    };
    persistWorkspaceLayout({ collapsed: ["eleanor"], pinned: ["chart"], preset: "Review" }, storage);
    expect(readWorkspaceLayout(storage)).toEqual({ collapsed: ["eleanor"], pinned: ["chart"], preset: "Review" });
    persistWorkspaceLayout({ collapsed: ["heat"], pinned: ["clock"], preset: "Trade" }, storage);
    expect(readWorkspaceLayout(storage)).toEqual({ collapsed: ["heat"], pinned: ["clock"], preset: "Trade" });
    memory.delete("arx.shell.panel-layout.v1:anonymous:cockpit");
    memory.set("arx.command-workspace.layout.v1", JSON.stringify({ collapsed: ["accounts", "clock"], pinned: ["clock"], preset: "Trade", balance: 9000 }));
    expect(readWorkspaceLayout(storage)).toEqual({ collapsed: [], pinned: ["clock"], preset: "Trade" });
    memory.set("arx.shell.panel-layout.v1:anonymous:cockpit", "{");
    expect(readWorkspaceLayout(storage).preset).toBe("Analyze");
  });

  it("keeps non-focused mobile panels out of view without removing their content", () => {
    const { container, rerender } = render(<WorkspacePanel id="eleanor" title="AI read" icon={Search} collapsed={false} pinned={false} hidden onCollapse={vi.fn()} onPin={vi.fn()}>AI summary</WorkspacePanel>);
    const panel = container.querySelector("#workspace-eleanor") as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(panel.textContent).toContain("AI summary");
    rerender(<WorkspacePanel id="eleanor" title="AI read" icon={Search} collapsed={false} pinned={false} hidden={false} onCollapse={vi.fn()} onPin={vi.fn()}>AI summary</WorkspacePanel>);
    expect(panel.hidden).toBe(false);
    expect(screen.getByText("AI summary")).toBeTruthy();
  });
});

function containerPanel(control: HTMLElement) {
  return control.closest("[data-layout-panel]")!;
}

describe("desktop fill state", () => {
  it("exposes actual collapse state without treating a pinned panel as collapsed", () => {
    const { container, rerender } = render(<WorkspacePanel id="clock" title="Clock" icon={Search} collapsed pinned={false} onCollapse={vi.fn()} onPin={vi.fn()}>clock values</WorkspacePanel>);
    expect(container.querySelector("[data-layout-panel]")?.getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByText("clock values")).toBeNull();
    rerender(<WorkspacePanel id="clock" title="Clock" icon={Search} collapsed pinned onCollapse={vi.fn()} onPin={vi.fn()}>clock values</WorkspacePanel>);
    expect(container.querySelector("[data-layout-panel]")?.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByText("clock values")).toBeTruthy();
  });
});
