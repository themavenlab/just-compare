import type { FolderEntry } from "./api";

export type FolderSort =
  | "name"
  | "status"
  | "leftSize"
  | "rightSize"
  | "leftModified"
  | "rightModified";
export const differenceFilters = [
  ["differences", "Show Differences"],
  ["paired", "Show No Orphans"],
  ["pairedDifferences", "Show Differences but No Orphans"],
  ["orphans", "Show Orphans"],
  ["leftNewer", "Show Left Newer"],
  ["rightNewer", "Show Right Newer"],
  ["leftNewerOrphans", "Show Left Newer and Left Orphans"],
  ["rightNewerOrphans", "Show Right Newer and Right Orphans"],
  ["leftOnly", "Show Left Orphans"],
  ["rightOnly", "Show Right Orphans"],
] as const;

export function formatFolderErrorsLabel(count: number, active = false) {
  const noun = count === 1 ? "comparison error" : "comparison errors";
  return active ? `Showing ${count} ${noun}` : `Show ${count} ${noun}`;
}

export function toggleFolderErrorFilter(
  currentFilter: string,
  previousFilter = "all",
) {
  if (currentFilter === "error") {
    return previousFilter === "error" ? "all" : previousFilter;
  }
  return "error";
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function isCurrentFolderGeneration(current: number, generation: number) {
  return current === generation;
}

function directoriesBySourcePath(
  entries: FolderEntry[],
  sourceSide: "left" | "right",
) {
  const directories = new Map<string, FolderEntry>();
  for (const entry of entries) {
    const kind = sourceSide === "left" ? entry.leftKind : entry.rightKind;
    const relative =
      sourceSide === "left" ? entry.leftRelative : entry.rightRelative;
    if (kind === "directory" && relative) directories.set(relative, entry);
  }
  return directories;
}

export function targetRelativeFor(
  entries: FolderEntry[],
  sourceRelative: string,
  sourceSide: "left" | "right",
  directories = directoriesBySourcePath(entries, sourceSide),
) {
  const targetSide = sourceSide === "left" ? "right" : "left";
  const sourceParts = sourceRelative.split("/");
  const targetParts: string[] = [];
  for (const [index, part] of sourceParts.entries()) {
    const sourcePrefix = sourceParts.slice(0, index + 1).join("/");
    const directory = directories.get(sourcePrefix);
    const targetKind =
      targetSide === "left" ? directory?.leftKind : directory?.rightKind;
    const targetRelative =
      targetSide === "left"
        ? directory?.leftRelative
        : directory?.rightRelative;
    if (targetKind === "directory" && targetRelative) {
      targetParts.splice(0, targetParts.length, ...targetRelative.split("/"));
    } else {
      targetParts.push(part);
    }
  }
  return targetParts.join("/");
}

export interface FolderNode {
  key: string;
  path: string;
  name: string;
  depth: number;
  branch: boolean;
  leftBranch: boolean;
  rightBranch: boolean;
  entry: FolderEntry | null;
  guides: boolean[];
  lastSibling: boolean;
}

// A file and a folder may share a relative path, so the kind is part of the
// identity. Selection, expansion, and React keys all use this value.
export function rowKey(entry: FolderEntry) {
  return `${entry.isDirectory ? "d" : "f"}:${entry.relative}`;
}

export function folderSelectionKeys(entries: FolderEntry[]) {
  return entries.map(rowKey);
}

function excludedByKind(
  entry: FolderEntry,
  excludedFiles: ReadonlySet<string>,
  excludedDirectories: ReadonlySet<string>,
) {
  if (!entry.isDirectory && excludedFiles.has(entry.relative)) return true;
  const parts = entry.relative.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const path = parts.slice(0, index).join("/");
    if (
      excludedDirectories.has(path) &&
      (path !== entry.relative || entry.isDirectory)
    )
      return true;
  }
  return false;
}

export function countFolderEntries(
  entries: FolderEntry[],
  filter: string,
  kindFilter: "all" | "files" | "folders",
  excludedFiles: ReadonlySet<string> = new Set(),
  excludedDirectories: ReadonlySet<string> = new Set(),
) {
  return entries.filter(
    (entry) =>
      !excludedByKind(entry, excludedFiles, excludedDirectories) &&
      matchesFilter(entry, filter) &&
      matchesKindFilter(entry, kindFilter),
  ).length;
}

export function matchesFilter(entry: FolderEntry, filter: string) {
  const paired = entry.leftSize !== null && entry.rightSize !== null;
  const different = entry.status !== "same" && entry.status !== "error";
  if (filter === "all") return true;
  if (entry.status === "error") return filter === "error";
  switch (filter) {
    case "differences":
      return different;
    case "paired":
      return paired;
    case "pairedDifferences":
      return paired && different;
    case "orphans":
      return !paired;
    case "leftNewer":
      return paired && different && entry.newer === "left";
    case "rightNewer":
      return paired && different && entry.newer === "right";
    case "leftNewerOrphans":
      return (
        entry.status === "leftOnly" ||
        (paired && different && entry.newer === "left")
      );
    case "rightNewerOrphans":
      return (
        entry.status === "rightOnly" ||
        (paired && different && entry.newer === "right")
      );
    default:
      return entry.status === filter;
  }
}
export function matchesName(relative: string, patterns: string) {
  return patterns
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .some((pattern) => {
      const expression = pattern === "*.*" ? "*" : pattern;
      const regex = new RegExp(
        `^${expression
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".")}$`,
        "i",
      );
      return regex.test(relative.split("/").at(-1) ?? relative);
    });
}
export function matchesKindFilter(
  entry: FolderEntry,
  filter: "all" | "files" | "folders",
) {
  if (filter === "all") return true;
  if (filter === "folders") return entry.isDirectory;
  return entry.leftKind === "file" || entry.rightKind === "file";
}
export function canCopy(entry: FolderEntry, destination: "left" | "right") {
  if (entry.status === "error" || entry.status === "same") return false;
  return destination === "right"
    ? entry.status !== "rightOnly"
    : entry.status !== "leftOnly";
}
export function folderRows(
  entries: FolderEntry[],
  filter: string,
  tree: boolean,
  collapsed: ReadonlySet<string>,
  sort: FolderSort,
  descending: boolean,
  kindFilter: "all" | "files" | "folders" = "all",
  excludedFiles: ReadonlySet<string> = new Set(),
  excludedDirectories: ReadonlySet<string> = new Set(),
): FolderNode[] {
  const compare = (a: FolderNode, b: FolderNode) => {
    const aFolder = a.branch || a.entry?.isDirectory === true;
    const bFolder = b.branch || b.entry?.isDirectory === true;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    let order: number;
    if (sort === "name")
      order = a.name.localeCompare(b.name, undefined, { numeric: true });
    else if (sort === "status")
      order = (a.entry?.status ?? "").localeCompare(b.entry?.status ?? "");
    else {
      const av = a.entry?.[sort] ?? -1;
      const bv = b.entry?.[sort] ?? -1;
      order = av - bv;
    }
    return (descending ? -order : order) || a.key.localeCompare(b.key);
  };
  const records = entries.filter(
    (entry) => !excludedByKind(entry, excludedFiles, excludedDirectories),
  );
  const filtered = records.filter(
    (entry) =>
      matchesFilter(entry, filter) && matchesKindFilter(entry, kindFilter),
  );
  if (!tree)
    return filtered
      .map((entry) => ({
        key: rowKey(entry),
        path: entry.relative,
        name: entry.relative,
        depth: 0,
        branch: false,
        leftBranch: false,
        rightBranch: false,
        entry,
        guides: [],
        lastSibling: true,
      }))
      .sort(compare);
  const actual = new Map<string, FolderEntry[]>();
  for (const entry of records) {
    const pathEntries = actual.get(entry.relative) ?? [];
    pathEntries.push(entry);
    actual.set(entry.relative, pathEntries);
  }
  const leftBranches = new Set<string>();
  const rightBranches = new Set<string>();
  for (const entry of records) {
    for (const [relative, kind, branches] of [
      [
        entry.leftRelative ?? (entry.leftSize !== null ? entry.relative : null),
        entry.leftKind,
        leftBranches,
      ],
      [
        entry.rightRelative ??
          (entry.rightSize !== null ? entry.relative : null),
        entry.rightKind,
        rightBranches,
      ],
    ] as const) {
      if (relative === null) continue;
      if (kind === "directory") branches.add(relative);
      let parent = relative.includes("/")
        ? relative.slice(0, relative.lastIndexOf("/"))
        : "";
      while (parent) {
        branches.add(parent);
        parent = parent.includes("/")
          ? parent.slice(0, parent.lastIndexOf("/"))
          : "";
      }
    }
  }
  const nodes = new Map<string, FolderNode>();
  const directoryKey = (path: string) => `d:${path}`;
  for (const record of filtered) {
    const segments = record.relative.split("/");
    for (let index = 0; index < segments.length; index++) {
      const path = segments.slice(0, index + 1).join("/");
      const isLeaf = index === segments.length - 1;
      if (isLeaf) {
        nodes.set(rowKey(record), {
          key: rowKey(record),
          path,
          name: segments[index] ?? path,
          depth: index,
          branch: record.isDirectory,
          leftBranch: record.leftKind === "directory",
          rightBranch: record.rightKind === "directory",
          entry: record,
          guides: [],
          lastSibling: true,
        });
        continue;
      }
      const key = directoryKey(path);
      if (nodes.has(key)) continue;
      const leftBranch = leftBranches.has(path);
      const rightBranch = rightBranches.has(path);
      const directory = actual.get(path)?.find((entry) => entry.isDirectory);
      nodes.set(key, {
        key,
        path,
        name: segments[index] ?? path,
        depth: index,
        branch: leftBranch || rightBranch,
        leftBranch,
        rightBranch,
        entry: directory ?? null,
        guides: [],
        lastSibling: true,
      });
    }
  }
  const children = new Map<string, FolderNode[]>();
  for (const node of nodes.values()) {
    const slash = node.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : directoryKey(node.path.slice(0, slash));
    const group = children.get(parent) ?? [];
    group.push(node);
    children.set(parent, group);
  }
  const result: FolderNode[] = [];
  const visit = (parentKey: string, guides: boolean[]) => {
    const siblings = (children.get(parentKey) ?? []).sort(compare);
    for (const [index, node] of siblings.entries()) {
      const lastSibling = index === siblings.length - 1;
      result.push({ ...node, guides, lastSibling });
      if (node.branch && !collapsed.has(node.key))
        visit(node.key, [...guides, !lastSibling]);
    }
  };
  visit("", []);
  return result;
}
