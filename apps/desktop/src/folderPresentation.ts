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
export interface FolderNode {
  path: string;
  name: string;
  depth: number;
  branch: boolean;
  entry: FolderEntry | null;
  guides: boolean[];
  lastSibling: boolean;
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
): FolderNode[] {
  const compare = (a: FolderNode, b: FolderNode) => {
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
    return (descending ? -order : order) || a.path.localeCompare(b.path);
  };
  const filtered = entries.filter((entry) => matchesFilter(entry, filter));
  if (!tree)
    return filtered
      .map((entry) => ({
        path: entry.relative,
        name: entry.relative,
        depth: 0,
        branch: false,
        entry,
        guides: [],
        lastSibling: true,
      }))
      .sort(compare);
  const actual = new Map(entries.map((entry) => [entry.relative, entry]));
  const nodes = new Map<string, FolderNode>();
  for (const entry of filtered) {
    const segments = entry.relative.split("/");
    for (let index = 0; index < segments.length; index++) {
      const path = segments.slice(0, index + 1).join("/");
      if (!nodes.has(path))
        nodes.set(path, {
          path,
          name: segments[index] ?? path,
          depth: index,
          branch:
            index < segments.length - 1 ||
            actual.get(path)?.isDirectory === true,
          entry: actual.get(path) ?? null,
          guides: [],
          lastSibling: true,
        });
      if (index < segments.length - 1) {
        const parent = nodes.get(path);
        if (parent) parent.branch = true;
      }
    }
  }
  const children = new Map<string, FolderNode[]>();
  for (const node of nodes.values()) {
    const parent = node.path.includes("/")
      ? node.path.slice(0, node.path.lastIndexOf("/"))
      : "";
    const group = children.get(parent) ?? [];
    group.push(node);
    children.set(parent, group);
  }
  const result: FolderNode[] = [];
  const visit = (parent: string, guides: boolean[]) => {
    const siblings = (children.get(parent) ?? []).sort(compare);
    for (const [index, node] of siblings.entries()) {
      const lastSibling = index === siblings.length - 1;
      result.push({ ...node, guides, lastSibling });
      if (!collapsed.has(node.path))
        visit(node.path, [...guides, !lastSibling]);
    }
  };
  visit("", []);
  return result;
}
