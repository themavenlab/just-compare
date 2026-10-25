import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FolderEntry } from "./api";
import { CommandMenu, type MenuCommand } from "./CommandMenu";
import { canCopy, folderRows, type FolderSort } from "./folderPresentation";
import { VirtualList } from "./VirtualList";

export type FolderSide = "left" | "right";
export function FolderView({
  entries,
  filter,
  busy,
  selected,
  onSelect,
  openPair,
  preview,
  onAction,
  registerCommands,
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
    destination: FolderSide,
  ) => void;
  onAction: (action: string, entries: FolderEntry[], side: FolderSide) => void;
  registerCommands: (controller: ((name: string) => void) | null) => void;
}) {
  const [tree, setTree] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const branches = useMemo(() => {
    const paths = new Set<string>();
    for (const entry of entries) {
      if (entry.isDirectory) paths.add(entry.relative);
      const parts = entry.relative.split("/");
      for (let i = 1; i < parts.length; i++)
        paths.add(parts.slice(0, i).join("/"));
    }
    return paths;
  }, [entries]);
  const collapsed = useMemo(
    () => new Set([...branches].filter((path) => !expanded.has(path))),
    [branches, expanded],
  );
  const [sort, setSort] = useState<FolderSort>("name");
  const [descending, setDescending] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [side, setSide] = useState<FolderSide>("left");
  const [menu, setMenu] = useState<{
    entry: FolderEntry;
    side: FolderSide;
    x: number;
    y: number;
  } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const id = useId();
  const rows = useMemo(
    () => folderRows(entries, filter, tree, collapsed, sort, descending),
    [entries, filter, tree, collapsed, sort, descending],
  );
  const latest = useRef({
    entries,
    rows,
    selected,
    onSelect,
    onAction,
    side,
    branches,
  });
  useLayoutEffect(() => {
    latest.current = {
      entries,
      rows,
      selected,
      onSelect,
      onAction,
      side,
      branches,
    };
  });
  useLayoutEffect(() => {
    registerCommands((name) => {
      const {
        rows: currentRows,
        entries: currentEntries,
        selected: currentSelection,
        onSelect: select,
        onAction: action,
        side: currentSide,
      } = latest.current;
      if (name === "tree") setTree(true);
      else if (name === "flat") setTree(false);
      else if (name === "expand") setExpanded(new Set(latest.current.branches));
      else if (name === "collapse") setExpanded(new Set());
      else if (
        name === "selectAll" ||
        name === "selectNone" ||
        name === "selectInvert"
      ) {
        for (const row of currentRows)
          if (row.entry && row.entry.status !== "error")
            select(
              row.path,
              name === "selectAll" ||
                (name === "selectInvert" &&
                  !currentSelection.includes(row.path)),
            );
      } else if (name) {
        action(
          name,
          currentEntries.filter((entry) =>
            currentSelection.includes(entry.relative),
          ),
          currentSide,
        );
      }
    });
    return () => registerCommands(null);
  }, [registerCommands]);
  const focusedIndex = rows.findIndex((row) => row.path === focused);
  function toggle(path: string) {
    setExpanded((prior) => {
      const next = new Set(prior);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function openable(entry: FolderEntry) {
    return (
      !busy &&
      entry.status !== "error" &&
      !entry.isDirectory &&
      entry.leftSize !== null &&
      entry.rightSize !== null
    );
  }
  function commands(entry: FolderEntry, activeSide: FolderSide): MenuCommand[] {
    const targets = selected.includes(entry.relative)
      ? entries.filter((item) => selected.includes(item.relative))
      : [entry];
    const invoke = (name: string) => onAction(name, targets, activeSide);
    return [
      {
        label: "Open With",
        run: () => invoke("openWith"),
        disabled: busy || entry.isDirectory,
      },
      {
        label: "Open pair",
        run: () => openPair(entry),
        disabled: !openable(entry),
      },
      {
        label: "Compare Contents...",
        run: () => invoke("compareContents"),
        disabled: busy,
      },
      {
        label: "Copy to Side...",
        run: () => invoke("copySide"),
        disabled: busy,
      },
      {
        label: "Move to Side...",
        run: () => invoke("moveSide"),
        disabled: busy,
      },
      {
        label: "Copy to Folder...",
        run: () => invoke("copyFolder"),
        disabled: busy,
      },
      {
        label: "Move to Folder...",
        run: () => invoke("moveFolder"),
        disabled: busy,
      },
      { label: "Delete...", run: () => invoke("recycle"), disabled: busy },
      {
        label: "Rename...",
        run: () => invoke("rename"),
        disabled: busy || targets.length !== 1,
      },
      {
        label: "Attributes...",
        run: () => invoke("attributes"),
        disabled: busy,
      },
      { label: "Touch...", run: () => invoke("touch"), disabled: busy },
      { label: "Exclude", run: () => invoke("exclude"), disabled: busy },
      { label: "New Folder...", run: () => invoke("mkdir"), disabled: busy },
      {
        label: "Copy Filename",
        run: () => invoke("copyFilename"),
        disabled: busy,
      },
      { label: "Ignored", run: () => invoke("ignored"), disabled: busy },
      {
        label: "Refresh Selection",
        run: () => invoke("refresh"),
        disabled: busy,
      },
      {
        label: "Synchronize...",
        run: () => invoke("synchronize"),
        disabled: busy,
      },
      { label: "Explorer", run: () => invoke("reveal"), disabled: busy },
    ];
  }
  function sortBy(key: FolderSort) {
    if (sort === key) setDescending(!descending);
    else {
      setSort(key);
      setDescending(false);
    }
  }
  const formatTime = (value: number | null | undefined) =>
    value == null ? "" : new Date(value).toLocaleString();
  return (
    <div className="folder-browser" ref={element}>
      <div className="paired-folder-head">
        {(["left", "right"] as const).map((pane) => (
          <div key={pane} className="folder-side-columns">
            {(["name", `${pane}Size`, `${pane}Modified`] as FolderSort[]).map(
              (key, index) => (
                <button
                  key={key}
                  aria-label={`Sort ${pane} by ${index === 0 ? "name" : index === 1 ? "size" : "modified"}`}
                  onClick={() => sortBy(key)}
                >
                  {["Name", "Size", "Modified"][index]}
                  {sort === key ? (descending ? " v" : " ^") : ""}
                </button>
              ),
            )}
          </div>
        ))}
      </div>
      <div
        className="folder-tree"
        role="region"
        aria-label="Folder comparison entries"
        aria-description="Click to select; Ctrl or Command-click to toggle; Shift-click to select a range. Arrow keys navigate, Space toggles selection, and Enter opens a pair or expands a folder."
      >
        <VirtualList
          count={rows.length}
          rowHeight={18}
          fill
          label={tree ? "Paired folder hierarchy" : "Paired folder entries"}
          role={tree ? "tree" : "region"}
          multiselectable={tree}
          activeIndex={focusedIndex}
          activeDescendant={
            tree && focusedIndex >= 0 ? `${id}-${focusedIndex}` : undefined
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
            } else if (row && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              if (row.branch) {
                if ((event.key === "ArrowLeft") !== collapsed.has(row.path))
                  toggle(row.path);
              } else setSide(event.key === "ArrowLeft" ? "left" : "right");
            } else if (row && event.key === "Enter") {
              event.preventDefault();
              if (row.branch) toggle(row.path);
              else if (row.entry && openable(row.entry)) openPair(row.entry);
            } else if (row?.entry && !busy && event.key === " ") {
              event.preventDefault();
              onSelect(row.path, !selected.includes(row.path));
            } else if (
              row?.entry &&
              !busy &&
              (event.key === "F2" ||
                event.key === "Insert" ||
                event.key === "Delete" ||
                (event.shiftKey && event.key === "F5"))
            ) {
              event.preventDefault();
              onAction(
                event.key === "F2"
                  ? "rename"
                  : event.key === "Insert"
                    ? "mkdir"
                    : event.key === "Delete"
                      ? "recycle"
                      : "refresh",
                [row.entry],
                side,
              );
            } else if (
              row?.entry &&
              (event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10"))
            ) {
              event.preventDefault();
              const box = element.current?.getBoundingClientRect();
              setMenu({
                entry: row.entry,
                side,
                x: box?.left ?? 4,
                y: (box?.top ?? 0) + 40,
              });
            }
          }}
          render={(index) => {
            const node = rows[index];
            if (!node) return null;
            const entry = node.entry;
            return (
              <div
                className={`paired-folder-row folder-row ${index % 2 ? "alternate-row" : ""} ${focused === node.path ? "focused-row" : ""} ${selected.includes(node.path) ? "selected-folder-row" : ""}`}
                data-status={entry?.status ?? "ancestor"}
                data-relative={node.path}
                id={`${id}-${index}`}
                role={tree ? "treeitem" : undefined}
                aria-level={tree ? node.depth + 1 : undefined}
                aria-expanded={
                  tree && node.branch ? !collapsed.has(node.path) : undefined
                }
                aria-selected={tree ? selected.includes(node.path) : undefined}
              >
                {(["left", "right"] as const).map((pane) => {
                  const missing =
                    !!entry &&
                    entry.status !== "error" &&
                    (pane === "left" ? entry.leftSize : entry.rightSize) ===
                      null;
                  const relative =
                    (pane === "left"
                      ? entry?.leftRelative
                      : entry?.rightRelative) ?? node.path;
                  return (
                    <div
                      className={`folder-side-columns folder-side ${entry?.status ?? ""} ${missing ? "missing" : ""}`}
                      key={pane}
                      aria-label={`${pane === "left" ? "Left" : "Right"}: ${node.path}`}
                      onClick={(event) => {
                        if (
                          (event.target as HTMLElement).closest("button,input")
                        )
                          return;
                        setSide(pane);
                        if (entry && !busy && entry.status !== "error") {
                          if (event.shiftKey && focusedIndex >= 0) {
                            for (const row of rows.slice(
                              Math.min(index, focusedIndex),
                              Math.max(index, focusedIndex) + 1,
                            ))
                              if (row.entry && row.entry.status !== "error")
                                onSelect(row.path, true);
                          } else if (event.ctrlKey || event.metaKey)
                            onSelect(node.path, !selected.includes(node.path));
                          else {
                            for (const path of selected)
                              if (path !== node.path) onSelect(path, false);
                            onSelect(node.path, true);
                          }
                        }
                        setFocused(node.path);
                        element.current
                          ?.querySelector<HTMLElement>(".virtual")
                          ?.focus({ preventScroll: true });
                      }}
                      onDoubleClick={(event) => {
                        if (
                          (event.target as HTMLElement).closest("button,input")
                        )
                          return;
                        if (node.branch) toggle(node.path);
                        else if (entry && openable(entry)) openPair(entry);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSide(pane);
                        setFocused(node.path);
                        if (entry)
                          setMenu({
                            entry,
                            side: pane,
                            x: event.clientX,
                            y: event.clientY,
                          });
                      }}
                    >
                      <span
                        className="folder-name-cell"
                        title={
                          entry?.detail
                            ? `${relative}: ${entry.detail}`
                            : relative
                        }
                      >
                        {tree && (
                          <span className="tree-guides" aria-hidden="true">
                            {node.guides.map((continues, level) => (
                              <span
                                key={level}
                                className={`tree-guide${continues ? " continues" : ""}`}
                              />
                            ))}
                            <span
                              className={`tree-elbow${node.lastSibling ? " last-sibling" : ""}`}
                            />
                          </span>
                        )}
                        {tree && node.branch ? (
                          <button
                            disabled={missing}
                            aria-label={`${collapsed.has(node.path) ? "Expand" : "Collapse"} ${node.path} ${pane}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle(node.path);
                            }}
                          >
                            {collapsed.has(node.path) ? "+" : "-"}
                          </button>
                        ) : tree ? (
                          <span className="tree-spacer" />
                        ) : null}
                        {!missing && (
                          <svg
                            className={`entry-icon ${entry?.status === "error" ? "error-icon" : node.branch || entry?.isDirectory ? "folder-icon" : "file-icon"}`}
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                          >
                            {entry?.status === "error" ? (
                              <path d="M8 1 15 14H1ZM8 5v4m0 2v1" />
                            ) : node.branch || entry?.isDirectory ? (
                              <>
                                <path d="M1.5 13.5v-11h5l2 2h6v9Z" />
                                {tree && !collapsed.has(node.path) && (
                                  <path d="m1.5 13.5 2-7h12l-2 7Z" />
                                )}
                              </>
                            ) : (
                              <path d="M3 1.5h6l4 4v9H3Zm6 0v4h4M5 8h6m-6 3h6" />
                            )}
                          </svg>
                        )}
                        <span className="file-name">
                          {missing
                            ? ""
                            : tree
                              ? relative.split("/").at(-1)
                              : relative}
                        </span>
                      </span>
                      <span className="file-size">
                        {missing
                          ? ""
                          : ((pane === "left"
                              ? entry?.leftSize
                              : entry?.rightSize
                            )?.toLocaleString() ?? "")}
                      </span>
                      <span className="file-modified">
                        {missing
                          ? ""
                          : formatTime(
                              pane === "left"
                                ? entry?.leftModified
                                : entry?.rightModified,
                            )}
                      </span>
                      {entry && (
                        <span className="row-hover-actions">
                          <button
                            aria-label={`Copy ${node.path} to ${pane === "left" ? "right" : "left"}`}
                            title="Preview copy to the other side; no immediate changes"
                            disabled={
                              busy ||
                              !canCopy(
                                entry,
                                pane === "left" ? "right" : "left",
                              )
                            }
                            onClick={() =>
                              entry.isDirectory
                                ? onAction("copySide", [entry], pane)
                                : preview(
                                    entry,
                                    "copy",
                                    pane === "left" ? "right" : "left",
                                  )
                            }
                          >
                            {pane === "left" ? "\u2192" : "\u2190"}
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
      </div>
      {menu && (
        <CommandMenu
          label={`Actions for ${menu.entry.relative}`}
          commands={commands(menu.entry, menu.side)}
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
