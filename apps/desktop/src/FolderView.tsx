import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { FolderEntry } from "./api";
import { CommandMenu } from "./CommandMenu";
import { canCopy, folderRows, type FolderSort } from "./folderPresentation";
import { VirtualList } from "./VirtualList";

export function FolderView({
  entries,
  filter,
  busy,
  selected,
  onSelect,
  openPair,
  preview,
  renderSide,
}: {
  entries: FolderEntry[];
  filter: string;
  busy: boolean;
  selected: string[];
  onSelect: (relative: string, checked: boolean) => void;
  openPair: (entry: FolderEntry) => void;
  preview: (
    entry: FolderEntry,
    action: string,
    destination: "left" | "right",
  ) => void;
  renderSide: (
    entry: FolderEntry,
    side: "left" | "right",
    name: string,
  ) => ReactNode;
}) {
  const [tree, setTree] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<FolderSort>("name");
  const [descending, setDescending] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    entry: FolderEntry;
    x: number;
    y: number;
  } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const rows = useMemo(
    () => folderRows(entries, filter, tree, collapsed, sort, descending),
    [entries, filter, tree, collapsed, sort, descending],
  );
  const focusedIndex = rows.findIndex((row) => row.path === focused);
  const toggle = (path: string) =>
    setCollapsed((prior) => {
      const next = new Set(prior);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  function openable(entry: FolderEntry) {
    return (
      !busy &&
      entry.status !== "error" &&
      !entry.isDirectory &&
      entry.leftSize !== null &&
      entry.rightSize !== null
    );
  }
  function commands(entry: FolderEntry) {
    return [
      {
        label: "Open pair",
        disabled: !openable(entry),
        run: () => openPair(entry),
      },
      {
        label: "Copy to right",
        disabled: busy || !canCopy(entry, "right"),
        run: () => preview(entry, "copy", "right"),
      },
      {
        label: "Copy to left",
        disabled: busy || !canCopy(entry, "left"),
        run: () => preview(entry, "copy", "left"),
      },
      {
        label: "Move to right",
        disabled:
          busy ||
          entry.isDirectory ||
          entry.leftSize === null ||
          !canCopy(entry, "right"),
        run: () => preview(entry, "move", "right"),
      },
      {
        label: "Recycle left",
        disabled:
          busy ||
          entry.isDirectory ||
          entry.leftSize === null ||
          entry.status === "error",
        run: () => preview(entry, "trashLeft", "right"),
      },
    ];
  }
  function sortBy(key: FolderSort) {
    if (sort === key) setDescending((prior) => !prior);
    else {
      setSort(key);
      setDescending(false);
    }
  }
  return (
    <div className="folder-browser" ref={element}>
      <div className="folder-view-bar">
        <button aria-pressed={tree} onClick={() => setTree((prior) => !prior)}>
          {tree ? "Tree view" : "Flat view"}
        </button>
        <button onClick={() => setCollapsed(new Set())}>Expand all</button>
        <button
          onClick={() =>
            setCollapsed(
              new Set(rows.filter((row) => row.branch).map((row) => row.path)),
            )
          }
        >
          Collapse all
        </button>
        <span>
          {rows.length} visible / {selected.length} selected
        </span>
      </div>
      <div className="folder-row folder-head">
        <span />
        {(["status", "name", "leftSize", "rightSize"] as const).map((key) => (
          <button
            key={key}
            aria-label={`Sort by ${key}`}
            onClick={() => sortBy(key)}
          >
            {
              {
                status: "Status",
                name: "Name",
                leftSize: "Left size",
                rightSize: "Right size",
              }[key]
            }
            {sort === key
              ? descending
                ? " (descending)"
                : " (ascending)"
              : ""}
          </button>
        ))}
        <span>Copy / compare</span>
      </div>
      <div
        className="folder-tree"
        role="region"
        aria-label="Folder comparison entries"
      >
        <VirtualList
          count={rows.length}
          fill
          label={tree ? "Paired folder hierarchy" : "Paired folder entries"}
          role={tree ? "tree" : "region"}
          activeIndex={focusedIndex}
          activeDescendant={
            tree && focusedIndex >= 0
              ? `${treeId}-${encodeURIComponent(rows[focusedIndex]?.path ?? "")}`
              : undefined
          }
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.target !== event.currentTarget)
              return;
            const index = focusedIndex < 0 ? 0 : focusedIndex;
            const row = rows[index];
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? rows.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          rows.length - 1,
                          index + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                      );
              setFocused(rows[next]?.path ?? null);
            } else if (
              row &&
              (event.key === "ArrowLeft" || event.key === "ArrowRight")
            ) {
              event.preventDefault();
              if (
                row.branch &&
                (event.key === "ArrowLeft"
                  ? !collapsed.has(row.path)
                  : collapsed.has(row.path))
              )
                toggle(row.path);
              else if (event.key === "ArrowLeft")
                setFocused(row.path.slice(0, row.path.lastIndexOf("/")));
            } else if (row && event.key === "Enter") {
              event.preventDefault();
              if (row.branch) toggle(row.path);
              else if (row.entry && openable(row.entry)) openPair(row.entry);
            } else if (
              row?.entry &&
              event.key === " " &&
              !busy &&
              canCopy(row.entry, "right")
            ) {
              event.preventDefault();
              onSelect(row.path, !selected.includes(row.path));
            } else if (
              row?.entry &&
              (event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10"))
            ) {
              event.preventDefault();
              const box = element.current?.getBoundingClientRect();
              setMenu({
                entry: row.entry,
                x: box?.left ?? 0,
                y: (box?.top ?? 0) + 80,
              });
            }
          }}
          render={(index) => {
            const node = rows[index];
            if (!node) return null;
            const entry = node.entry;
            return (
              <div
                className={`folder-row ${focused === node.path ? "focused-row" : ""}`}
                data-status={entry?.status ?? "ancestor"}
                data-relative={node.path}
                id={`${treeId}-${encodeURIComponent(node.path)}`}
                role={tree ? "treeitem" : undefined}
                aria-level={tree ? node.depth + 1 : undefined}
                aria-expanded={
                  tree && node.branch ? !collapsed.has(node.path) : undefined
                }
                aria-selected={tree ? selected.includes(node.path) : undefined}
                onClick={(event) => {
                  setFocused(node.path);
                  if (
                    event.target instanceof HTMLElement &&
                    !event.target.closest("button,input")
                  )
                    element.current
                      ?.querySelector<HTMLElement>(".virtual")
                      ?.focus({ preventScroll: true });
                }}
                onDoubleClick={(event) => {
                  if (
                    event.target instanceof HTMLElement &&
                    event.target.closest("button,input")
                  )
                    return;
                  if (node.branch) toggle(node.path);
                  else if (entry && openable(entry)) openPair(entry);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setFocused(node.path);
                  if (entry)
                    setMenu({ entry, x: event.clientX, y: event.clientY });
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${node.path}`}
                  checked={selected.includes(node.path)}
                  disabled={busy || !entry || !canCopy(entry, "right")}
                  onChange={(event) =>
                    onSelect(node.path, event.target.checked)
                  }
                />
                <span className={`file-status ${entry?.status ?? ""}`}>
                  {entry?.status === "leftOnly"
                    ? "Left only"
                    : entry?.status === "rightOnly"
                      ? "Right only"
                      : entry?.status === "same"
                        ? "Same"
                        : entry?.status === "different"
                          ? "Different"
                          : entry?.status === "error"
                            ? "Error"
                            : "Folder"}
                </span>
                <div
                  className="tree-name"
                  style={{ paddingLeft: node.depth * 14 }}
                  title={node.path}
                >
                  {node.branch ? (
                    <button
                      aria-label={`${collapsed.has(node.path) ? "Expand" : "Collapse"} ${node.path}`}
                      aria-expanded={!collapsed.has(node.path)}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(node.path);
                      }}
                    >
                      {collapsed.has(node.path) ? "+" : "-"}
                    </button>
                  ) : (
                    <span className="tree-spacer" />
                  )}
                  <span>{node.name}</span>
                </div>
                {entry ? (
                  renderSide(entry, "left", node.name)
                ) : (
                  <span className="metadata">Folder</span>
                )}
                {entry ? (
                  renderSide(entry, "right", node.name)
                ) : (
                  <span className="metadata">Folder</span>
                )}
                <div className="row-actions">
                  <button
                    aria-label={`Copy ${node.path} to right`}
                    title={
                      entry?.isDirectory
                        ? "Preview folder creation on right only; use Update to copy its contents."
                        : "Preview copy to right; no immediate disk changes"
                    }
                    disabled={busy || !entry || !canCopy(entry, "right")}
                    onClick={() => {
                      if (entry) preview(entry, "copy", "right");
                    }}
                  >
                    {"\u2192"}
                  </button>
                  <button
                    aria-label={`Copy ${node.path} to left`}
                    title={
                      entry?.isDirectory
                        ? "Preview folder creation on left only; use Update with swapped roots to copy its contents."
                        : "Preview copy to left; no immediate disk changes"
                    }
                    disabled={busy || !entry || !canCopy(entry, "left")}
                    onClick={() => {
                      if (entry) preview(entry, "copy", "left");
                    }}
                  >
                    {"\u2190"}
                  </button>
                  <button
                    disabled={!entry || !openable(entry)}
                    onClick={() => {
                      if (entry) openPair(entry);
                    }}
                  >
                    Open pair
                  </button>
                  {entry && (
                    <CommandMenu
                      label={`Actions for ${node.path}`}
                      commands={commands(entry)}
                    />
                  )}
                </div>
              </div>
            );
          }}
        />
      </div>
      {menu && (
        <CommandMenu
          label={`Actions for ${menu.entry.relative}`}
          commands={commands(menu.entry)}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => {
            setMenu(null);
            element.current?.querySelector<HTMLElement>(".virtual")?.focus();
          }}
        />
      )}
    </div>
  );
}
