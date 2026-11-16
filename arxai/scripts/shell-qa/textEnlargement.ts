// Test-only browser CSSOM enlargement. Never imported by the application.
export function enlargeFixtureText() {
  const declarations: { style: CSSStyleDeclaration; value: string; priority: string }[] = [];
  const collect = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if ("style" in rule && (rule as CSSStyleRule).style.fontSize) {
        const style = (rule as CSSStyleRule).style;
        const value = style.fontSize;
        // Relative/inherited sizes already follow their doubled parent.
        if (!/^(inherit|unset|revert|revert-layer)$/.test(value) && !/^[\d.]+(?:em|%)$/.test(value)) {
          declarations.push({ style, value, priority: style.getPropertyPriority("font-size") });
        }
      }
      if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) collect(sheet.cssRules);
  const bodyFont = document.body.style.fontSize;
  const baselineBody = parseFloat(getComputedStyle(document.body).fontSize);
  const baselines = new WeakMap<HTMLElement, number>();
  for (const el of document.querySelectorAll<HTMLElement>("body, body *")) {
    if (el instanceof HTMLElement) baselines.set(el, parseFloat(getComputedStyle(el).fontSize));
  }
  const restore = () => {
    for (const { style, value, priority } of declarations) style.setProperty("font-size", value, priority);
    document.body.style.fontSize = bodyFont;
  };
  const apply = () => {
    // Reapply from immutable declaration values, never from enlarged computed
    // values. This also preserves media queries and newly mounted portal CSS.
    for (const { style, value, priority } of declarations) {
      style.setProperty("font-size", value === "initial" ? "32px" : `calc((${value}) * 2)`, priority);
    }
    document.body.style.fontSize = `${baselineBody * 2}px`;
    for (const el of document.querySelectorAll<HTMLElement>("body, body *")) {
      if (!(el instanceof HTMLElement)) continue;
      // Existing baselines are immutable. Newly mounted portals use the same
      // already-scaled CSS declarations; their production sizes are half.
      if (!baselines.has(el)) baselines.set(el, parseFloat(getComputedStyle(el).fontSize) / 2);
      el.dataset.fixtureBaseFont = String(baselines.get(el));
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "data-dock-mode"] });
  return () => { observer.disconnect(); restore(); };
}
