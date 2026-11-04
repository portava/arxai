import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Search } from "lucide-react";
import { SidePanelArea } from "./SidePanelArea";
import { LayoutPanel } from "./LayoutPanel";
import { RouteLayoutPanel } from "./RouteLayoutPanel";
import { useRoutePanelLayout } from "./useRoutePanelLayout";
import { readRoutePanelLayout, routePanelLayoutKey } from "./shellLayoutModel";
import { railPanels, revealPanel, sideIsRailed } from "./sidePanelModel";
import { applyWorkspacePreset } from "../dashboard/commandWorkspaceModel";

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { id: 91001 } }) }));
const panels = ["scanner", "heat", "clock"].map(id => ({ id, title: id, icon: Search }));
function Harness({ route = "/unit-desk", side = "left" }: { route?: string; side?: "left" | "right" | "bottom" }) {
  const { layout, setLayout } = useRoutePanelLayout(route, panels.map(panel => panel.id));
  return <><div data-route-layout-slot />
    <SidePanelArea side={side} panels={panels} layout={layout} onChange={setLayout}>
      {panels.map(panel => <LayoutPanel key={panel.id} {...panel}
        collapsed={layout.collapsed.includes(panel.id)} pinned={layout.pinned.includes(panel.id)}
        onCollapse={() => {}} onPin={() => setLayout({ ...layout, pinned: [panel.id] })}>
        <input aria-label={`${panel.id} draft`} defaultValue="" />
      </LayoutPanel>)}
    </SidePanelArea></>;
}
const panel = (id: string) => document.getElementById(`workspace-${id}`)!;

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("shared side areas", () => {
  it("collapses to icons, expands, and focuses a selected panel without losing its draft", async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("scanner draft"), { target: { value: "keep this" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse left tools" }));
    expect(panel("scanner").dataset.panelState).toBe("closing");
    await waitFor(() => expect(panels.every(item => panel(item.id).hidden)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open scanner" }));
    expect(panel("scanner").hidden).toBe(false);
    expect(panel("heat").hidden).toBe(true);
    expect((screen.getByLabelText("scanner draft") as HTMLInputElement).value).toBe("keep this");
    await waitFor(() => expect(document.activeElement).toBe(panel("scanner")));
    expect(screen.getByRole("dialog", { name: "scanner" }).getAttribute("aria-modal")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Keep scanner open" }));
    expect(screen.queryByTestId("panel-peek-backdrop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close scanner" }));
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Expand left tools" }));
    expect(panels.every(item => !panel(item.id).hidden)).toBe(true);
  });

  it("sends individual panels to the rail and auto-collapses when the last one goes", async () => {
    render(<Harness />);
    for (const item of panels) fireEvent.click(screen.getByRole("button", { name: `Close ${item.title}` }));
    await waitFor(() => expect(panels.every(item => panel(item.id).hidden)).toBe(true));
    expect(screen.getByRole("button", { name: "Expand left tools" })).toBeTruthy();
    expect(document.querySelector(".arx-side-area")?.getAttribute("data-railed")).toBe("true");
  });

  it("never rails pinned panels, including a whole-column request", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Pin scanner" }));
    expect((screen.getByRole("button", { name: "Close scanner" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Collapse left tools" }));
    expect(panel("scanner").hidden).toBe(false);
    await waitFor(() => expect(panel("heat").hidden).toBe(true));
    expect(document.querySelector(".arx-side-area")?.getAttribute("data-railed")).toBe("false");
  });

  it("restores per-user/per-route rail preferences across remount and route changes", async () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse left tools" }));
    first.unmount();
    const second = render(<Harness />);
    expect(panel("scanner").hidden).toBe(true);
    second.rerender(<Harness route="/another-route" />);
    await waitFor(() => expect(panel("scanner").hidden).toBe(false));
    second.rerender(<Harness route="/unit-desk" />);
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    expect(readRoutePanelLayout(localStorage, 91002, "/unit-desk", ["scanner"]).railed).toBeUndefined();
  });

  it("exposes the same saved side behavior for specialist route side panels", async () => {
    render(<RouteLayoutPanel routeKey="/unit-specialist" id="details" title="Details" icon={Search} side="right">Details content</RouteLayoutPanel>);
    fireEvent.click(screen.getByRole("button", { name: "Close Details" }));
    await waitFor(() => expect(panel("details").hidden).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open Details" }));
    expect(panel("details").hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem(routePanelLayoutKey(91001, "/unit-specialist"))!).peek).toBe("details");
    fireEvent.click(screen.getByRole("button", { name: "Keep Details open" }));
    expect(JSON.parse(localStorage.getItem(routePanelLayoutKey(91001, "/unit-specialist"))!).railed).not.toContain("details");
  });

  it("uses Layout menu controls and leaves mobile focus presentation unrailed", async () => {
    localStorage.setItem(routePanelLayoutKey(91001, "/unit-desk"), JSON.stringify({ collapsed: [], pinned: [], railed: ["scanner", "heat", "clock"] }));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    render(<Harness />);
    expect(panel("scanner").hidden).toBe(false);
    expect(screen.queryByRole("group", { name: "Left tools" })).toBeNull();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Shown" }));
    expect(panel("scanner").hidden).toBe(false);
  });

  it("dismisses peeks outside or with Escape and returns focus to the rail", async () => {
    render(<Harness/>);
    fireEvent.click(screen.getByRole("button", { name: "Close scanner" }));
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open scanner" }));
    fireEvent.pointerDown(screen.getByTestId("panel-peek-backdrop"));
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open scanner" })));
    fireEvent.click(screen.getByRole("button", { name: "Open scanner" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    expect(screen.queryByTestId("panel-peek-backdrop")).toBeNull();
  });

  it("persists peek and dock states, isolated from another route and user", async () => {
    const first = render(<Harness/>);
    fireEvent.click(screen.getByRole("button", { name: "Close scanner" }));
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open scanner" }));
    first.unmount();
    const second = render(<Harness/>);
    expect(screen.getByRole("dialog", { name: "scanner" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep scanner open" }));
    second.unmount();
    const third = render(<Harness/>);
    expect(panel("scanner").hidden).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    third.rerender(<Harness route="/elsewhere"/>);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open scanner" })).toBeNull());
    expect(readRoutePanelLayout(localStorage, 91002, "/unit-desk", ["scanner"]).peek).toBeUndefined();
  });

  it("closes immediately under reduced motion and supports a bottom rail", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<Harness side="bottom"/>);
    for (const item of panels) fireEvent.click(screen.getByRole("button", { name: `Close ${item.title}` }));
    expect(panel("clock").hidden).toBe(true);
    expect(panel("clock").dataset.panelState).toBe("closed");
    expect(panel("clock").dataset.reducedMotion).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Open clock" }));
    expect(panel("clock").dataset.panelEdge).toBe("bottom");
    fireEvent.click(screen.getByRole("button", { name: "Pin clock" }));
    expect(panel("clock").hidden).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not consume Escape belonging to an existing nested modal", async () => {
    render(<Harness/>);
    fireEvent.click(screen.getByRole("button", { name: "Close scanner" }));
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open scanner" }));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    vi.spyOn(dialog, "getClientRects").mockReturnValue([{ width: 100 }] as unknown as DOMRectList);
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel("scanner").getAttribute("role")).toBe("dialog");
    dialog.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(panel("scanner").hidden).toBe(true));
  });
});

it("keeps presets, source sanitization and pinned rails consistent", () => {
  const initial = { collapsed: [], pinned: ["risk"], railed: [], preset: "Analyze" as const };
  const analyzed = applyWorkspacePreset(initial, "Analyze");
  expect(analyzed.railed).toEqual(["order", "positions", "chart-details"]);
  expect(sideIsRailed(analyzed, ["ruby", "risk", "order"])).toBe(false);
  expect(applyWorkspacePreset({ ...analyzed, peek: "positions" }, "Trade").railed).toEqual(["intelligence", "ruby", "chart-details"]);
  expect(applyWorkspacePreset({ ...analyzed, peek: "positions" }, "Trade").peek).toBeUndefined();
  expect(revealPanel(railPanels(initial, ["risk", "order"], true), "order").railed).toEqual([]);
  localStorage.setItem(routePanelLayoutKey(91001, "/bad"), JSON.stringify({ collapsed: [], pinned: ["risk"], railed: ["risk", "order", "unknown"] }));
  expect(readRoutePanelLayout(localStorage, 91001, "/bad", ["risk", "order"]).railed).toEqual(["order"]);
});
