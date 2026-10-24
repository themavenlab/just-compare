import type { FolderEntry } from "./api";

export type FolderSort = "name" | "status" | "leftSize" | "rightSize";
export interface FolderNode {
  path: string;
  name: string;
  depth: number;
  branch: boolean;
  entry: FolderEntry | null;
}
export function matchesFilter(entry: FolderEntry, filter: string) {
  return (
    filter === "all" ||
    (filter === "differences"
      ? entry.status !== "same"
      : entry.status === filter)
  );
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
  const visit = (parent: string) => {
    for (const node of (children.get(parent) ?? []).sort(compare)) {
      result.push(node);
      if (!collapsed.has(node.path)) visit(node.path);
    }
  };
  visit("");
  return result;
}
