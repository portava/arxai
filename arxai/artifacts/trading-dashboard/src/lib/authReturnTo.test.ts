import { describe, it, expect, beforeEach } from "vitest";
import { isSafeReturnPath, rememberReturnTo, readReturnTo, clearReturnTo, suppressNextReturnTo } from "./authReturnTo";

describe("authReturnTo", () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it("accepts same-app paths only", () => {
    expect(isSafeReturnPath("/live-chart?symbol=XAUUSD")).toBe(true);
    expect(isSafeReturnPath("/admin/users")).toBe(true);
    expect(isSafeReturnPath("//evil.example")).toBe(false);
    expect(isSafeReturnPath("https://evil.example")).toBe(false);
    expect(isSafeReturnPath("/\\evil")).toBe(false);
    expect(isSafeReturnPath("/")).toBe(false);
    expect(isSafeReturnPath("/login")).toBe(false);
    expect(isSafeReturnPath("/register?invite=x")).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
  });

  it("remembers, reads and clears the requested page", () => {
    rememberReturnTo("/market-scanner");
    expect(readReturnTo()).toBe("/market-scanner");
    clearReturnTo();
    expect(readReturnTo()).toBeNull();
  });

  it("ignores unsafe paths", () => {
    rememberReturnTo("//evil.example");
    expect(readReturnTo()).toBeNull();
  });

  it("does not carry the signed-out user's page to the next sign-in", () => {
    rememberReturnTo("/portfolio");
    suppressNextReturnTo();
    expect(readReturnTo()).toBeNull();
    rememberReturnTo("/portfolio"); // AuthGate's redirect right after sign-out
    expect(readReturnTo()).toBeNull();
    rememberReturnTo("/journal"); // a later genuine deep link
    expect(readReturnTo()).toBe("/journal");
  });
});
