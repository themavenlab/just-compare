import { describe, expect, it } from "vitest";
import type { FolderEntry } from "./api";
import { canCopy, folderRows } from "./folderPresentation";
import { relatedPaths, sameSummary, sessionWorkflow } from "./workbench";

const entry = (
  relative: string,
  status = "different",
  leftSize: number | null = 2,
  rightSize: number | null = 1,
): FolderEntry => ({
  relative,
  status,
  leftSize,
  rightSize,
  detail: null,
  isDirectory: false,
});

describe("folder presentation", () => {
  const entries = [
    entry("nested/z.txt"),
    entry("a.txt", "same"),
    entry("nested/a.txt", "rightOnly", null),
    entry("other/b.txt", "leftOnly", 8, null),
  ];
  it("retains ancestors while filtering without inventing actionable entries", () => {
    const rows = folderRows(
      entries,
      "rightOnly",
      true,
      new Set(),
      "name",
      false,
    );
    expect(rows.map((row) => row.path)).toEqual(["nested", "nested/a.txt"]);
    expect(rows[0]?.entry).toBeNull();
    expect(rows[1]?.entry?.status).toBe("rightOnly");
  });
  it("sorts siblings and collapses descendants, not selected paths", () => {
    const rows = folderRows(
      entries,
      "all",
      true,
      new Set(["nested"]),
      "name",
      true,
    );
    expect(rows.map((row) => row.path)).toEqual([
      "other",
      "other/b.txt",
      "nested",
      "a.txt",
    ]);
  });
  it("sorts all flat entries numerically by size with missing sizes first", () => {
    const rows = folderRows(
      entries,
      "all",
      false,
      new Set(),
      "leftSize",
      false,
    );
    expect(rows.map((row) => row.path)).toEqual([
      "nested/a.txt",
      "a.txt",
      "nested/z.txt",
      "other/b.txt",
    ]);
  });
  it("checks actual copy direction and rejects same/error sources", () => {
    expect(canCopy(entry("a", "rightOnly", null), "left")).toBe(true);
    expect(canCopy(entry("a", "rightOnly", null), "right")).toBe(false);
    expect(canCopy(entry("a", "leftOnly", 1, null), "right")).toBe(true);
    expect(canCopy(entry("a", "leftOnly", 1, null), "left")).toBe(false);
    expect(canCopy(entry("a", "same"), "right")).toBe(false);
    expect(canCopy(entry("a", "error"), "left")).toBe(false);
  });
  it("flattens 10,000 real entries and collapses only visible hierarchy", () => {
    const large: FolderEntry[] = [];
    for (let directory = 0; directory < 100; directory++) {
      large.push({
        ...entry(`dir${directory}`, "same", null, null),
        isDirectory: true,
      });
      for (let file = 0; file < 99; file++)
        large.push(entry(`dir${directory}/file${file}.txt`));
    }
    expect(
      folderRows(large, "differences", true, new Set(), "name", false),
    ).toHaveLength(10000);
    expect(
      folderRows(
        large,
        "differences",
        true,
        new Set(
          large.filter((row) => row.isDirectory).map((row) => row.relative),
        ),
        "name",
        false,
      ),
    ).toHaveLength(100);
  });
  it("does not introduce unsupported workflows or redundant summary updates", () => {
    expect(() => sessionWorkflow("hex")).toThrow("Unsupported");
    expect(sessionWorkflow("merge")).toBe("merge");
    const summary = {
      title: "a / b",
      dirty: false,
      error: "",
      status: "Ready",
      undoLeft: false,
      undoRight: false,
      differences: 0,
      canSaveOutput: false,
    };
    expect(sameSummary(summary, { ...summary })).toBe(true);
    expect(sameSummary(summary, { ...summary, dirty: true })).toBe(false);
    expect(sameSummary(summary, { ...summary, undoLeft: true })).toBe(false);
    expect(sameSummary(summary, { ...summary, undoRight: true })).toBe(false);
    expect(sameSummary(summary, { ...summary, differences: 1 })).toBe(false);
    expect(sameSummary(summary, { ...summary, canSaveOutput: true })).toBe(
      false,
    );
  });
  it("matches Windows extended/case variants for stale notices without treating Unix backslashes as separators", () => {
    expect(relatedPaths("\\\\?\\C:\\Folder\\file.txt", "c:\\folder")).toBe(
      true,
    );
    expect(relatedPaths("C:\\folder2\\file", "C:\\folder")).toBe(false);
    expect(relatedPaths("/tmp/a\\b", "/tmp/a")).toBe(false);
    expect(relatedPaths("/tmp/a/b", "/tmp/a")).toBe(true);
    expect(
      relatedPaths("\\\\?\\UNC\\server\\share\\a.txt", "\\\\server\\share"),
    ).toBe(true);
    expect(relatedPaths("/", "/tmp/a")).toBe(true);
  });
});
