import { describe, expect, it } from "vitest";
import { compareText, errorMessage } from "./comparison";

describe("comparison boundary", () => {
  it("reports browser mode instead of returning pretend results", async () => {
    await expect(
      compareText("a", "b", {
        ignoreCase: false,
        ignoreWhitespace: false,
        ignoreLineEndings: false,
      }),
    ).rejects.toThrow("requires the desktop app");
  });

  it("preserves useful native and JavaScript errors", () => {
    expect(errorMessage("input exceeds limit")).toBe("input exceeds limit");
    expect(errorMessage(new Error("failed"))).toBe("failed");
    expect(errorMessage(null)).toContain("unexpected error");
  });
});
