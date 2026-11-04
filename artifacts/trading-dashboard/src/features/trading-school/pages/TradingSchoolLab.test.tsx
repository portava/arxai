import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Progress persistence talks to the API — stub it; keep the real constants.
const markLabAttempted = vi.fn();
vi.mock("../lib/progress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/progress")>();
  return {
    ...actual,
    markLabAttempted: (id: string) => markLabAttempted(id),
    useSchoolProgress: () => ({ ...actual.getProgress(), labsAttempted: ["lab-psychology"] }),
  };
});

import TradingSchoolLab from "./TradingSchoolLab";
import TradingSchoolLabs from "./TradingSchoolLabs";
import { buildPracticeLabs } from "../data/content";
import { SCENARIO_LABS } from "../data/labs";
import { ScenarioQuizLab } from "../components/labs/ScenarioQuizLab";
import { EntryStopTargetLab } from "../components/labs/EntryStopTargetLab";
import { SupportResistanceLab } from "../components/labs/SupportResistanceLab";
import { TradePlanLab } from "../components/labs/TradePlanLab";

function renderAt(path: string, ui: React.ReactElement) {
  const { hook } = memoryLocation({ path, static: true });
  return render(<Router hook={hook}>{ui}</Router>);
}

beforeEach(() => {
  markLabAttempted.mockClear();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => cleanup());

const BODY_TESTID: Record<string, string> = {
  "lab-risk-calculator": "page-school-risk-sim",
  "lab-entry-sl-tp": "lab-entry-sl-tp-body",
  "lab-support-resistance": "lab-sr-body",
  "lab-trade-plan": "lab-trade-plan-body",
};

describe("Practice Labs list", () => {
  it("shows every lab as Available with a link to its lab page and no Coming next", () => {
    renderAt("/school/labs", <TradingSchoolLabs />);
    const labs = buildPracticeLabs();
    expect(labs.length).toBe(10);
    for (const l of labs) {
      const card = screen.getByTestId(`lab-card-${l.id}`);
      expect(card.getAttribute("href")).toBe(`/school/labs/${l.id}`);
      expect(card.textContent).toContain("Available");
      expect(l.status).toBe("available");
    }
    expect(document.body.textContent).not.toContain("Coming next");
    expect(screen.getByTestId("lab-card-lab-psychology").textContent).toContain("Practised");
  });
});

describe("every lab id resolves to a rendered lab", () => {
  for (const lab of buildPracticeLabs()) {
    it(lab.id, () => {
      renderAt(`/school/labs/${lab.id}`, <TradingSchoolLab />);
      const page = screen.getByTestId("page-school-lab");
      expect(page.getAttribute("data-lab-id")).toBe(lab.id);
      const bodyId = BODY_TESTID[lab.id] ?? "lab-quiz";
      expect(screen.getByTestId(bodyId)).toBeTruthy();
      expect(screen.queryByTestId("page-school-lab-missing")).toBeNull();
    });
  }
  it("unknown id shows a not-found state", () => {
    renderAt("/school/labs/lab-nope", <TradingSchoolLab />);
    expect(screen.getByTestId("page-school-lab-missing")).toBeTruthy();
  });
  it("labels practice labs as made-up data", () => {
    renderAt("/school/labs/lab-candle-reading", <TradingSchoolLab />);
    expect(document.body.textContent).toContain("not live market data");
  });
});

describe("ScenarioQuizLab", () => {
  it("gives instant feedback, scores at the end and can try again", () => {
    const lab = SCENARIO_LABS["lab-market-basics"];
    const onComplete = vi.fn();
    render(<ScenarioQuizLab lab={lab} onComplete={onComplete} />);
    const next = () => screen.getByTestId("lab-next") as HTMLButtonElement;
    lab.scenarios.forEach((s, i) => {
      expect(next().disabled).toBe(true);
      // answer the first scenario wrong, the rest right
      const pick = i === 0 ? (s.answerIndex + 1) % s.options.length : s.answerIndex;
      fireEvent.click(screen.getByTestId(`lab-option-${pick}`));
      expect(screen.getByTestId("lab-feedback").textContent).toContain(i === 0 ? "Not quite" : "Correct");
      expect((screen.getByTestId(`lab-option-${pick}`) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(next());
    });
    const n = lab.scenarios.length;
    expect(screen.getByTestId("lab-quiz-score").textContent).toContain(`${n - 1}/${n} correct`);
    expect(onComplete).toHaveBeenCalledWith((n - 1) / n);
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByTestId("lab-quiz-prompt").textContent).toBe(lab.scenarios[0].prompt);
  });

  it("records lab completion through the progress layer", () => {
    renderAt("/school/labs/lab-psychology", <TradingSchoolLab />);
    const lab = SCENARIO_LABS["lab-psychology"];
    for (const s of lab.scenarios) {
      fireEvent.click(screen.getByTestId(`lab-option-${s.answerIndex}`));
      fireEvent.click(screen.getByTestId("lab-next"));
    }
    expect(markLabAttempted).toHaveBeenCalledWith("lab-psychology");
  });
});

describe("EntryStopTargetLab", () => {
  it("shows live R:R and grades placement", () => {
    render(<EntryStopTargetLab />);
    fireEvent.click(screen.getByTestId("check-placement"));
    expect(screen.getByTestId("placement-grade").textContent).toContain("Adjust and check again");
    fireEvent.change(screen.getByTestId("input-stop"), { target: { value: "1.0952" } });
    fireEvent.change(screen.getByTestId("input-target"), { target: { value: "1.1057" } });
    expect(screen.getByTestId("metric-risk").textContent).toBe("35 pips");
    expect(screen.getByTestId("metric-reward").textContent).toBe("70 pips");
    expect(screen.getByTestId("metric-rr").textContent).toBe("1 : 2.00");
    expect(screen.getByTestId("placement-grade").textContent).toContain("every check passes");
  });

  it("drags a line with pointer events", () => {
    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0, left: 0, height: 340, width: 600, bottom: 340, right: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    render(<EntryStopTargetLab />);
    const before = (screen.getByTestId("input-stop") as HTMLInputElement).value;
    fireEvent.pointerDown(screen.getByTestId("drag-stop"), { pointerId: 1, clientY: 200 });
    const svg = document.querySelector("svg")!;
    fireEvent.pointerMove(svg, { pointerId: 1, clientY: 250 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientY: 250 });
    const after = (screen.getByTestId("input-stop") as HTMLInputElement).value;
    expect(after).not.toBe(before);
    expect(Number(after)).toBeLessThan(Number(before));
    rectSpy.mockRestore();
  });
});

describe("SupportResistanceLab", () => {
  const add = (v: string) => {
    fireEvent.change(screen.getByTestId("sr-manual-input"), { target: { value: v } });
    fireEvent.click(screen.getByTestId("sr-manual-add"));
  };
  it("grades placed zones against the reference zones", () => {
    render(<SupportResistanceLab />);
    expect((screen.getByTestId("sr-check") as HTMLButtonElement).disabled).toBe(true);
    add("1.1040");
    add("1.1010");
    fireEvent.click(screen.getByTestId("sr-check"));
    const grade = screen.getByTestId("sr-grade").textContent ?? "";
    expect(grade).toContain("1/2 zones found");
    expect(grade).toContain("missed");
    add("1.0965");
    fireEvent.click(screen.getByTestId("sr-check"));
    expect(screen.getByTestId("sr-grade").textContent).toContain("2/2 zones found · 1 extra");
  });
  it("tapping a placed zone removes it", () => {
    render(<SupportResistanceLab />);
    add("1.1040");
    fireEvent.click(screen.getByTestId("sr-zone-0"));
    expect(screen.queryByTestId("sr-zone-0")).toBeNull();
  });
});

describe("TradePlanLab", () => {
  it("scores the example plan 100 and a sparse plan low, as a checklist score", () => {
    renderAt("/school/labs/lab-trade-plan", <TradePlanLab />);
    fireEvent.click(screen.getByTestId("plan-direction-long"));
    fireEvent.change(screen.getByTestId("plan-risk"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("plan-score-btn"));
    expect(screen.getByTestId("plan-score").textContent).toBe("20");
    fireEvent.click(screen.getByText("Load an example plan"));
    fireEvent.click(screen.getByTestId("plan-score-btn"));
    expect(screen.getByTestId("plan-score").textContent).toBe("100");
    const result = screen.getByTestId("plan-result").textContent ?? "";
    expect(result).toContain("Checklist score");
    expect(document.querySelector('a[href="/trade-plan-builder"]')).toBeTruthy();
  });
});
