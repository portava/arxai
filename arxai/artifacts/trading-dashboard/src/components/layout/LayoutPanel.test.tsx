import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LayoutPanel } from "./LayoutPanel";

afterEach(cleanup);

it("keeps editable work mounted but inaccessible while a stateful panel is collapsed", () => {
  const props = {
    id: "stateful",
    title: "Testing workspace",
    pinned: false,
    onCollapse: () => {},
    onPin: () => {},
    keepMounted: true,
  };
  const body = <input aria-label="Draft parameters" defaultValue="initial" />;
  const view = render(<LayoutPanel {...props} collapsed={false}>{body}</LayoutPanel>);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "edited" } });
  view.rerender(<LayoutPanel {...props} collapsed>{body}</LayoutPanel>);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(input.isConnected).toBe(true);
  expect(input.closest("[hidden]")).not.toBeNull();
  view.rerender(<LayoutPanel {...props} collapsed={false}>{body}</LayoutPanel>);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input.value).toBe("edited");
});

it("retains the existing unmount-on-collapse default for other panels", () => {
  render(<LayoutPanel id="default" title="Default panel" pinned={false} collapsed onCollapse={() => {}} onPin={() => {}}>
    <input aria-label="Unmounted input" />
  </LayoutPanel>);
  expect(screen.queryByLabelText("Unmounted input")).toBeNull();
});
