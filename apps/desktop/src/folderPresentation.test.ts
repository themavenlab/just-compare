import { describe, expect, it } from "vitest";
import type { FolderEntry, FolderStatus } from "./api";
import {
  canCopy,
  countFolderEntries,
  differenceFilters,
  folderRows,
  folderSelectionKeys,
  formatFolderErrorsLabel,
  formatSize,
  isCurrentFolderGeneration,
  matchesFilter,
  matchesName,
  rowKey,
  targetRelativeFor,
  toggleFolderErrorFilter,
  withoutLinkedSource,
} from "./folderPresentation";
import {
  plainPath,
  relatedPaths,
  sameSummary,
  sessionWorkflow,
} from "./workbench";

const entry = (
  relative: string,
  status: FolderStatus = "different",
  leftSize: number | null = 2,
  rightSize: number | null = 1,
): FolderEntry => ({
  relative,
  status,
  leftSize,
  rightSize,
  detail: null,
  isDirectory: false,
  leftKind: leftSize === null ? null : "file",
  rightKind: rightSize === null ? null : "file",
  leftModified: null,
  rightModified: null,
  leftRelative: null,
  rightRelative: null,
  newer: null,
  newerMixed: false,
  error: null,
  importance:
    status === "same" ? "equal" : status === "error" ? "unknown" : "important",
});

describe("folder presentation", () => {
  it("tones a paired folder by its descendants without changing its status", () => {
    const folder = (
      relative: string,
      status: FolderStatus = "same",
    ): FolderEntry => ({
      ...entry(relative, status, null, null),
      isDirectory: true,
      leftKind: "directory",
      rightKind: "directory",
      leftSize: 0,
      rightSize: 0,
    });
    const rows = [
      folder("tree"),
      folder("tree/clean"),
      entry("tree/clean/same.txt", "same", 1, 1),
      folder("tree/changed"),
      entry("tree/changed/edit.txt", "different", 1, 2),
      folder("empty-equal"),
      entry("empty-equal/same.txt", "same", 1, 1),
    ];
    const toneOf = (path: string) =>
      folderRows(rows, "all", true, new Set(), "name", false).find(
        (node) => node.path === path,
      )?.tone;
    expect(toneOf("tree")).toBe("different");
    expect(toneOf("tree/clean")).toBe("same");
    expect(toneOf("tree/changed")).toBe("different");
    expect(toneOf("empty-equal")).toBe("same");
    expect(
      folderRows(rows, "all", true, new Set(), "name", false).find(
        (node) => node.path === "tree/changed/edit.txt",
      )?.tone,
    ).toBe("different");
  });

  it("tones an unimportant changed file without changing its status", () => {
    const minor: FolderEntry = {
      ...entry("notes.log", "different", 1, 2),
      importance: "unimportant",
    };
    const rows = [minor, entry("main.txt", "different", 1, 2)];
    const byPath = (flat: boolean) =>
      Object.fromEntries(
        folderRows(rows, "all", !flat, new Set(), "name", false).map((node) => [
          node.path,
          { tone: node.tone, status: node.entry?.status },
        ]),
      );
    for (const flat of [true, false]) {
      const result = byPath(flat);
      expect(result["notes.log"]).toEqual({
        tone: "unimportant",
        status: "different",
      });
      expect(result["main.txt"]).toEqual({
        tone: "different",
        status: "different",
      });
    }
  });

  it("implements every screenshot difference predicate without guessing newer timestamps", () => {
    const rows = [
      entry("equal", "same"),
      { ...entry("left-newer"), newer: "left" as const },
      { ...entry("right-newer"), newer: "right" as const },
      { ...entry("tie"), newer: null },
      entry("left-only", "leftOnly", 2, null),
      entry("right-only", "rightOnly", null, 2),
      entry("error", "error", null, null),
    ];
    const expected: Record<string, string[]> = {
      differences: [
        "left-newer",
        "right-newer",
        "tie",
        "left-only",
        "right-only",
      ],
      paired: ["equal", "left-newer", "right-newer", "tie"],
      pairedDifferences: ["left-newer", "right-newer", "tie"],
      orphans: ["left-only", "right-only"],
      leftNewer: ["left-newer"],
      rightNewer: ["right-newer"],
      leftNewerOrphans: ["left-newer", "left-only"],
      rightNewerOrphans: ["right-newer", "right-only"],
      leftOnly: ["left-only"],
      rightOnly: ["right-only"],
    };
    expect(differenceFilters).toHaveLength(10);
    for (const [filter] of differenceFilters)
      expect(
        rows
          .filter((row) => matchesFilter(row, filter))
          .map((row) => row.relative),
      ).toEqual(expected[filter]);
    expect(
      rows
        .filter((row) => matchesFilter(row, "error"))
        .map((row) => row.relative),
    ).toEqual(["error"]);
    expect(rows.filter((row) => matchesFilter(row, "all"))).toHaveLength(7);
  });
  it("matches display wildcards literally and does not interpret regex input", () => {
    expect(matchesName("nested/README", "*.*")).toBe(true);
    expect(matchesName("nested/a.TXT", "*.txt;*.md")).toBe(true);
    expect(matchesName("nested/a.json", "*.txt;*.md")).toBe(false);
    expect(matchesName("a[1].txt", "a[1].txt")).toBe(true);
    expect(matchesName("a1.txt", "a[1].txt")).toBe(false);
    expect(matchesName("x.ts", "?.ts")).toBe(true);
  });
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
      new Set(["d:nested"]),
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
  it("connects visible siblings and ancestors without dangling final branches", () => {
    const rows = folderRows(
      [
        entry("alpha/inner/one.txt"),
        entry("alpha/inner/two.txt"),
        entry("alpha/last.txt"),
        entry("z.txt"),
      ],
      "all",
      true,
      new Set(),
      "name",
      false,
    );
    expect(
      rows.map(({ path, guides, lastSibling }) => ({
        path,
        guides,
        lastSibling,
      })),
    ).toEqual([
      { path: "alpha", guides: [], lastSibling: false },
      { path: "alpha/inner", guides: [true], lastSibling: false },
      { path: "alpha/inner/one.txt", guides: [true, true], lastSibling: false },
      { path: "alpha/inner/two.txt", guides: [true, true], lastSibling: true },
      { path: "alpha/last.txt", guides: [true], lastSibling: true },
      { path: "z.txt", guides: [], lastSibling: true },
    ]);
  });
  it("recomputes connectors for filtered, sorted and collapsed visible branches", () => {
    const rows = folderRows(
      [entry("a/one.txt"), entry("a/two.txt", "same"), entry("b/three.txt")],
      "differences",
      true,
      new Set(["d:b"]),
      "name",
      true,
    );
    expect(
      rows.map(({ path, guides, lastSibling }) => ({
        path,
        guides,
        lastSibling,
      })),
    ).toEqual([
      { path: "b", guides: [], lastSibling: false },
      { path: "a", guides: [], lastSibling: true },
      { path: "a/one.txt", guides: [false], lastSibling: true },
    ]);
    expect(
      folderRows(entries, "all", false, new Set(), "name", false).every(
        (row) => row.depth === 0 && row.guides.length === 0,
      ),
    ).toBe(true);
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
  it("keeps folders before naturally sorted files in either sort direction", () => {
    const rows = [
      {
        ...entry("file10.txt"),
      },
      {
        ...entry("z-folder", "same", 0, 0),
        isDirectory: true,
        leftKind: "directory" as const,
        rightKind: "directory" as const,
      },
      {
        ...entry("file2.txt"),
      },
      {
        ...entry("a-folder", "same", 0, 0),
        isDirectory: true,
        leftKind: "directory" as const,
        rightKind: "directory" as const,
      },
    ];
    expect(
      folderRows(rows, "all", false, new Set(), "name", false).map(
        (row) => row.path,
      ),
    ).toEqual(["a-folder", "z-folder", "file2.txt", "file10.txt"]);
    expect(
      folderRows(rows, "all", false, new Set(), "name", true).map(
        (row) => row.path,
      ),
    ).toEqual(["z-folder", "a-folder", "file10.txt", "file2.txt"]);
  });
  it("keeps a same-name file and folder as independent rows with their own children", () => {
    const gitFile: FolderEntry = {
      ...entry(".git", "leftOnly", 4, null),
      leftKind: "file",
      rightKind: null,
    };
    const gitFolder: FolderEntry = {
      ...entry(".git", "rightOnly", null, 0),
      isDirectory: true,
      leftKind: null,
      rightKind: "directory",
    };
    const head: FolderEntry = {
      ...entry(".git/HEAD", "rightOnly", null, 1),
      leftKind: null,
      rightKind: "file",
    };
    expect(rowKey(gitFile)).toBe("f:.git");
    expect(rowKey(gitFolder)).toBe("d:.git");
    expect(folderSelectionKeys([gitFile, gitFolder])).toEqual([
      "f:.git",
      "d:.git",
    ]);
    expect(countFolderEntries([gitFile, gitFolder], "all", "all")).toBe(2);
    const rows = folderRows(
      [gitFile, gitFolder, head],
      "all",
      true,
      new Set(),
      "name",
      false,
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect([...byKey.keys()].sort()).toEqual([
      "d:.git",
      "f:.git",
      "f:.git/HEAD",
    ]);
    const folderRow = byKey.get("d:.git");
    const fileRow = byKey.get("f:.git");
    expect(folderRow?.entry).toBe(gitFolder);
    expect(fileRow?.entry).toBe(gitFile);
    expect(folderRow?.branch).toBe(true);
    expect(folderRow?.rightBranch).toBe(true);
    expect(fileRow?.branch).toBe(false);
    expect(fileRow?.rightBranch).toBe(false);
    expect(fileRow?.leftBranch).toBe(false);
    expect(byKey.get("f:.git/HEAD")?.depth).toBe(1);
    expect(
      folderRows(
        [gitFile, gitFolder, head],
        "all",
        true,
        new Set(["d:.git"]),
        "name",
        false,
      ).map((row) => row.key),
    ).not.toContain("f:.git/HEAD");
    expect(canCopy(gitFile, "right")).toBe(true);
    expect(canCopy(gitFolder, "left")).toBe(true);
  });
  it("excludes folder subtrees without hiding a same-name file", () => {
    const folder: FolderEntry = {
      ...entry("hello", "rightOnly", null, 0),
      isDirectory: true,
      leftKind: null,
      rightKind: "directory",
    };
    const file: FolderEntry = entry("hello", "leftOnly", 1, null);
    const child: FolderEntry = {
      ...entry("hello/child.txt", "rightOnly", null, 1),
      rightKind: "file",
    };
    const sibling = entry("hello-world.txt", "leftOnly", 1, null);
    const excludedDirectories = new Set(["hello"]);
    const rows = folderRows(
      [folder, file, child, sibling],
      "all",
      true,
      new Set(),
      "name",
      false,
      "all",
      new Set(),
      excludedDirectories,
    );
    expect(rows.map((row) => [row.key, row.path])).toEqual([
      ["f:hello", "hello"],
      ["f:hello-world.txt", "hello-world.txt"],
    ]);
    expect(
      countFolderEntries(
        [folder, file, child, sibling],
        "all",
        "all",
        new Set(),
        excludedDirectories,
      ),
    ).toBe(2);
  });
  it("checks actual copy direction and rejects same/error sources", () => {
    expect(canCopy(entry("a", "rightOnly", null), "left")).toBe(true);
    expect(canCopy(entry("a", "rightOnly", null), "right")).toBe(false);
    expect(canCopy(entry("a", "leftOnly", 1, null), "right")).toBe(true);
    expect(canCopy(entry("a", "leftOnly", 1, null), "left")).toBe(false);
    expect(canCopy(entry("a", "same"), "right")).toBe(false);
    expect(canCopy(entry("a", "error"), "left")).toBe(false);
  });
  it("drops linked sources from transfers on the copied side only", () => {
    const link: FolderEntry = {
      ...entry("docs", "leftOnly", 0, null),
      leftKind: "link",
      rightKind: null,
    };
    const file = entry("a.txt", "leftOnly", 1, null);
    const kept = withoutLinkedSource([link, file], "left");
    expect(kept.entries).toEqual([file]);
    expect(kept.skipped).toBe(1);
    expect(withoutLinkedSource([link, file], "right").skipped).toBe(0);
    expect(withoutLinkedSource([link], "left").entries).toEqual([]);
  });
  it("flattens 10,000 real entries and collapses only visible hierarchy", () => {
    const large: FolderEntry[] = [];
    for (let directory = 0; directory < 100; directory++) {
      large.push({
        ...entry(`dir${directory}`, "same", null, null),
        isDirectory: true,
        leftKind: "directory",
        rightKind: "directory",
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
        new Set(large.filter((row) => row.isDirectory).map(rowKey)),
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
      redoLeft: false,
      redoRight: false,
      differences: 0,
      canSaveOutput: false,
    };
    expect(sameSummary(summary, { ...summary })).toBe(true);
    expect(sameSummary(summary, { ...summary, dirty: true })).toBe(false);
    expect(sameSummary(summary, { ...summary, undoLeft: true })).toBe(false);
    expect(sameSummary(summary, { ...summary, undoRight: true })).toBe(false);
    expect(sameSummary(summary, { ...summary, redoLeft: true })).toBe(false);
    expect(sameSummary(summary, { ...summary, redoRight: true })).toBe(false);
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
  it("formats sizes for people and hides the extended path prefix for display", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(680)).toBe("680 B");
    expect(formatSize(4000)).toBe("3.9 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(300 * 1024)).toBe("300 KB");
    expect(plainPath("\\\\?\\C:\\a\\b")).toBe("C:\\a\\b");
    expect(plainPath("\\\\?\\UNC\\server\\share")).toBe("\\\\server\\share");
    expect(plainPath("\\\\?\\Volume{1}\\a")).toBe("\\\\?\\Volume{1}\\a");
    expect(plainPath("/tmp/a")).toBe("/tmp/a");
  });
  it("formats singular and plural comparison error labels for inactive and active states", () => {
    expect(formatFolderErrorsLabel(1, false)).toBe("Show 1 comparison error");
    expect(formatFolderErrorsLabel(1, true)).toBe("Showing 1 comparison error");
    expect(formatFolderErrorsLabel(3, false)).toBe("Show 3 comparison errors");
    expect(formatFolderErrorsLabel(3, true)).toBe(
      "Showing 3 comparison errors",
    );
  });
  it("toggles comparison error filter and restores the previous active filter", () => {
    expect(toggleFolderErrorFilter("all", "all")).toBe("error");
    expect(toggleFolderErrorFilter("differences", "differences")).toBe("error");
    expect(toggleFolderErrorFilter("error", "differences")).toBe("differences");
    expect(toggleFolderErrorFilter("error", "all")).toBe("all");
    expect(toggleFolderErrorFilter("error", "error")).toBe("all");
  });
  it("builds targets under existing and case-aligned directory ancestors", () => {
    expect(targetRelativeFor([], "support/github-tracker", "right")).toBe(
      "support/github-tracker",
    );
    const support: FolderEntry = {
      ...entry("support", "same", null, null),
      isDirectory: true,
      leftKind: "directory",
      rightKind: "directory",
      leftRelative: "Support",
      rightRelative: "support",
    };
    expect(
      targetRelativeFor([support], "support/github-tracker", "right"),
    ).toBe("Support/github-tracker");
  });
  it("does not use a same-name target ancestor when it is a file", () => {
    const supportFile: FolderEntry = {
      ...entry("support"),
      leftKind: "file",
      rightKind: "directory",
      leftRelative: "support",
      rightRelative: "support",
    };
    expect(
      targetRelativeFor([supportFile], "support/github-tracker", "left"),
    ).toBe("support/github-tracker");
  });
  it("ignores an older scan result that arrives after a newer one", async () => {
    let currentGeneration = 1;
    let displayed = "previous";
    let resolveOlder!: (result: string) => void;
    const olderScan = new Promise<string>((resolve) => {
      resolveOlder = resolve;
    });
    const applyResult = async (generation: number, result: Promise<string>) => {
      const entries = await result;
      if (isCurrentFolderGeneration(currentGeneration, generation))
        displayed = entries;
    };
    const olderResult = applyResult(currentGeneration, olderScan);

    currentGeneration += 1;
    await applyResult(currentGeneration, Promise.resolve("new result"));
    resolveOlder("stale result");
    await olderResult;

    expect(displayed).toBe("new result");
  });
});
