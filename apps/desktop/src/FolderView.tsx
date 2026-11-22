import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FolderEntry, FolderEntryKind } from "./api";
import {
  canCopy,
  folderRows,
  formatSize,
  rowKey,
  type FolderSort,
} from "./folderPresentation";
import { Icon } from "./icons";
import { VirtualList } from "./VirtualList";

export type FolderSide = "left" | "right";
export function FolderView({
  entries,
  filter,
  kindFilter,
  excludedFiles,
  excludedDirectories,
  busy,
  selected,
  onSelect,
  openPair,
  onAction,
  registerCommands,
}: {
  entries: FolderEntry[];
  filter: string;
  kindFilter: "all" | "files" | "folders";
  excludedFiles: ReadonlySet<string>;
  excludedDirectories: ReadonlySet<string>;
  busy: boolean;
  selected: ReadonlySet<string>;
  onSelect: (keys: readonly string[], checked: boolean) => void;
  openPair: (entry: FolderEntry) => void;
  onAction: (action: string, entries: FolderEntry[], side: FolderSide) => void;
  registerCommands: (controller: ((name: string) => void) | null) => void;
}) {
  const [tree, setTree] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const branches = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of entries) {
      if (entry.isDirectory) keys.add(`d:${entry.relative}`);
      const parts = entry.relative.split("/");
      for (let i = 1; i < parts.length; i++)
        keys.add(`d:${parts.slice(0, i).join("/")}`);
    }
    return keys;
  }, [entries]);
  const collapsed = useMemo(
    () => new Set([...branches].filter((key) => !expanded.has(key))),
    [branches, expanded],
  );
  const [sort, setSort] = useState<FolderSort>("name");
  const [descending, setDescending] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [side, setSide] = useState<FolderSide>("left");
  const [menu, setMenu] = useState<{
    entry: FolderEntry;
    side: FolderSide;
    key: string;
    x: number;
    y: number;
  } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const anchorPath = useRef<string | null>(null);
  const id = useId();
  const rows = useMemo(
    () =>
      folderRows(
        entries,
        filter,
        tree,
        collapsed,
        sort,
        descending,
        kindFilter,
        excludedFiles,
        excludedDirectories,
      ),
    [
      entries,
      filter,
      tree,
      collapsed,
      sort,
      descending,
      kindFilter,
      excludedFiles,
      excludedDirectories,
    ],
  );
  const latest = useRef({
    rows,
    selected,
    onSelect,
    onAction,
    side,
    branches,
  });
  useLayoutEffect(() => {
    latest.current = {
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
        selected: currentSelection,
        onSelect: select,
        onAction: action,
        side: currentSide,
      } = latest.current;
      const selectedEntries = new Map<string, FolderEntry>();
      for (const row of currentRows)
        if (
          row.entry &&
          currentSelection.has(row.key) &&
          row.entry.status !== "error"
        )
          selectedEntries.set(rowKey(row.entry), row.entry);
      if (name === "tree") setTree(true);
      else if (name === "flat") setTree(false);
      else if (name === "expand") setExpanded(new Set(latest.current.branches));
      else if (name === "collapse") setExpanded(new Set());
      else if (
        name === "selectAll" ||
        name === "selectNone" ||
        name === "selectInvert"
      ) {
        const selectable = currentRows
          .filter((row) => row.entry && row.entry.status !== "error")
          .map((row) => row.key);
        if (name === "selectInvert") {
          select(
            selectable.filter((key) => !currentSelection.has(key)),
            true,
          );
          select(
            selectable.filter((key) => currentSelection.has(key)),
            false,
          );
        } else select(selectable, name === "selectAll");
      } else if (name) {
        action(name, [...selectedEntries.values()], currentSide);
      }
    });
    return () => registerCommands(null);
  }, [registerCommands]);
  const focusedIndex = rows.findIndex((row) => row.key === focused);
  function toggle(key: string) {
    setExpanded((prior) => {
      const next = new Set(prior);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function openable(entry: FolderEntry) {
    return (
      !busy &&
      entry.status !== "error" &&
      entry.leftKind === "file" &&
      entry.rightKind === "file" &&
      entry.leftSize !== null &&
      entry.rightSize !== null
    );
  }
  function entryKind(entry: FolderEntry, activeSide: FolderSide) {
    return activeSide === "left" ? entry.leftKind : entry.rightKind;
  }
  function commands(
    entry: FolderEntry,
    activeSide: FolderSide,
    key: string,
  ): MenuCommand[] {
    const targets = new Map<string, FolderEntry>();
    if (selected.has(key)) {
      for (const row of rows)
        if (row.entry && selected.has(row.key))
          targets.set(rowKey(row.entry), row.entry);
    } else targets.set(rowKey(entry), entry);
    const selectedEntries = [...targets.values()];
    const invoke = (name: string) =>
      onAction(name, selectedEntries, activeSide);
    return [
      {
        label: "Open With",
        run: () => invoke("openWith"),
        disabled: busy || entryKind(entry, activeSide) !== "file",
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
        disabled: busy || selectedEntries.length !== 1,
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
      <ul className="folder-tone-legend" aria-label="Row colour key">
        <li data-tone="leftOnly">Left only</li>
        <li data-tone="rightOnly">Right only</li>
        <li data-tone="different">Different</li>
        <li data-tone="unimportant">Unimportant</li>
        <li data-tone="error">
          <Icon name="error" className="error-icon" /> Error
        </li>
      </ul>
      <div
        className="folder-tree"
        role="region"
        aria-label="Folder comparison entries"
        aria-description="Click to select; Ctrl or Command-click to toggle; Shift-click to select a range. Ctrl+A or Command+A selects all visible entries. Arrow keys navigate, Space toggles selection, and Enter opens a pair or expands a folder."
      >
        <VirtualList
          count={rows.length}
          rowHeight={26}
          fill
          label={tree ? "Paired folder hierarchy" : "Paired folder entries"}
          role={tree ? "tree" : "region"}
          multiselectable={tree}
          activeIndex={focusedIndex}
          activeDescendant={
            tree && focusedIndex >= 0 ? `${id}-${focusedIndex}` : undefined
          }
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            if (
              event.defaultPrevented ||
              target.closest("input,textarea,select") ||
              ((event.key === " " || event.key === "Enter") &&
                target !== event.currentTarget)
            )
              return;
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "a"
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (!busy)
                onSelect(
                  rows
                    .filter((row) => row.entry && row.entry.status !== "error")
                    .map((row) => row.key),
                  true,
                );
              return;
            }
            const index = focusedIndex < 0 ? 0 : focusedIndex;
            const row = rows[index];
            if (
              [
                "ArrowDown",
                "ArrowUp",
                "Home",
                "End",
                "PageDown",
                "PageUp",
              ].includes(event.key)
            ) {
              event.preventDefault();
              const step =
                event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowUp"
                    ? -1
                    : event.key === "PageDown"
                      ? 15
                      : -15;
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? rows.length - 1
                    : Math.max(0, Math.min(rows.length - 1, index + step));
              const nextRow = rows[next];
              if (!nextRow) return;
              setFocused(nextRow.key);
              if (!busy && !event.ctrlKey && !event.metaKey) {
                const anchor =
                  event.shiftKey && anchorPath.current !== null
                    ? Math.max(
                        0,
                        rows.findIndex((r) => r.key === anchorPath.current),
                      )
                    : next;
                if (!event.shiftKey) anchorPath.current = nextRow.key;
                else if (anchorPath.current === null)
                  anchorPath.current = row?.key ?? nextRow.key;
                const range = new Set(
                  rows
                    .slice(Math.min(anchor, next), Math.max(anchor, next) + 1)
                    .filter((r) => r.entry && r.entry.status !== "error")
                    .map((r) => r.key),
                );
                onSelect(
                  [...selected].filter((key) => !range.has(key)),
                  false,
                );
                onSelect([...range], true);
              }
            } else if (row && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              if (side === "left" ? row.leftBranch : row.rightBranch) {
                if ((event.key === "ArrowLeft") !== collapsed.has(row.key))
                  toggle(row.key);
              } else setSide(event.key === "ArrowLeft" ? "left" : "right");
            } else if (row && event.key === "Enter") {
              event.preventDefault();
              if (row.branch) toggle(row.key);
              else if (row.entry && openable(row.entry)) openPair(row.entry);
            } else if (row?.entry && !busy && event.key === " ") {
              event.preventDefault();
              onSelect([row.key], !selected.has(row.key));
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
                key: row.key,
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
                className={`paired-folder-row folder-row ${index % 2 ? "alternate-row" : ""} ${focused === node.key ? "focused-row" : ""} ${selected.has(node.key) ? "selected-folder-row" : ""}`}
                data-status={entry?.status ?? "ancestor"}
                data-tone={node.tone ?? "ancestor"}
                data-relative={node.path}
                data-row-key={node.key}
                id={`${id}-${index}`}
                role={tree ? "treeitem" : undefined}
                aria-level={tree ? node.depth + 1 : undefined}
                aria-expanded={
                  tree && node.branch ? !collapsed.has(node.key) : undefined
                }
                aria-selected={tree ? selected.has(node.key) : undefined}
              >
                {(["left", "right"] as const).map((pane) => {
                  const kind: FolderEntryKind | null = entry
                    ? entryKind(entry, pane)
                    : null;
                  const sideBranch =
                    pane === "left" ? node.leftBranch : node.rightBranch;
                  const sideIsDirectory =
                    kind === "directory" || (kind === null && sideBranch);
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
                      className={`folder-side-columns folder-side ${node.tone ?? ""} ${missing ? "missing" : ""}`}
                      data-pane={pane}
                      key={pane}
                      aria-label={`${pane === "left" ? "Left" : "Right"}: ${node.path}${kind ? ` (${kind})` : ""}`}
                      onClick={(event) => {
                        if (
                          (event.target as HTMLElement).closest("button,input")
                        )
                          return;
                        if (!missing) setSide(pane);
                        if (entry && !busy && entry.status !== "error") {
                          if (event.shiftKey && focusedIndex >= 0) {
                            onSelect(
                              rows
                                .slice(
                                  Math.min(index, focusedIndex),
                                  Math.max(index, focusedIndex) + 1,
                                )
                                .filter(
                                  (row) =>
                                    row.entry && row.entry.status !== "error",
                                )
                                .map((row) => row.key),
                              true,
                            );
                          } else if (event.ctrlKey || event.metaKey)
                            onSelect([node.key], !selected.has(node.key));
                          else {
                            onSelect(
                              [...selected].filter((key) => key !== node.key),
                              false,
                            );
                            onSelect([node.key], true);
                          }
                        }
                        setFocused(node.key);
                        if (!event.shiftKey) anchorPath.current = node.key;
                        element.current
                          ?.querySelector<HTMLElement>(".virtual")
                          ?.focus({ preventScroll: true });
                      }}
                      onDoubleClick={(event) => {
                        if (
                          (event.target as HTMLElement).closest("button,input")
                        )
                          return;
                        if (tree && sideBranch) toggle(node.key);
                        else if (entry && openable(entry)) openPair(entry);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (!entry || missing) return;
                        setSide(pane);
                        setFocused(node.key);
                        setMenu({
                          entry,
                          side: pane,
                          key: node.key,
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
                        {tree && sideBranch ? (
                          <button
                            className="tree-toggle"
                            disabled={missing}
                            aria-label={`${collapsed.has(node.key) ? "Expand" : "Collapse"} ${node.path} ${pane}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle(node.key);
                              setFocused(node.key);
                              element.current
                                ?.querySelector<HTMLElement>(".virtual")
                                ?.focus({ preventScroll: true });
                            }}
                          >
                            <Icon
                              name={
                                collapsed.has(node.key)
                                  ? "chevronRight"
                                  : "chevronDown"
                              }
                              className="tree-toggle-icon"
                            />
                          </button>
                        ) : tree ? (
                          <span className="tree-spacer" />
                        ) : null}
                        {!missing && (
                          <Icon
                            className={`entry-icon ${entry?.status === "error" ? "error-icon" : kind === "link" ? "link-icon" : sideIsDirectory ? "folder-icon" : "file-icon"}`}
                            name={
                              entry?.status === "error"
                                ? "error"
                                : kind === "link"
                                  ? "link"
                                  : sideIsDirectory
                                    ? tree && !collapsed.has(node.key)
                                      ? "openFolder"
                                      : "folder"
                                    : "file"
                            }
                          />
                        )}
                        <span className="file-name">
                          {missing
                            ? ""
                            : tree
                              ? relative.split("/").at(-1)
                              : relative}
                        </span>
                        {entry?.status === "error" && (
                          <span className="sr-only"> (error)</span>
                        )}
                      </span>
                      <span className="file-size">
                        {missing || sideIsDirectory
                          ? ""
                          : (() => {
                              const size =
                                pane === "left"
                                  ? entry?.leftSize
                                  : entry?.rightSize;
                              return size == null ? "" : formatSize(size);
                            })()}
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
                            title="Copy to the other side"
                            disabled={
                              busy ||
                              !canCopy(
                                entry,
                                pane === "left" ? "right" : "left",
                              )
                            }
                            onClick={() => onAction("copySide", [entry], pane)}
                          >
                            {pane === "left" ? (
                              <Icon name="copyRight" />
                            ) : (
                              <Icon name="copyLeft" />
                            )}
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
          commands={commands(menu.entry, menu.side, menu.key)}
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
