import { Compartment, EditorState, Prec, RangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useLayoutEffect, useRef } from "react";
import { type DiffSpan } from "./comparison";
import { createIconElement, iconSymbols } from "./icons";

export interface IntralineRegion {
  spans: DiffSpan[];
  baseByte: number;
}
const noIntralineRegions: IntralineRegion[] = [];

class Gap extends WidgetType {
  constructor(
    private readonly lines: number,
    readonly copyMarker: CopyArrow | null = null,
  ) {
    super();
  }
  toDOM() {
    const element = document.createElement("div");
    element.style.height = `${this.lines * 18}px`;
    element.className = "alignment-gap";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  get estimatedHeight() {
    return this.lines * 18;
  }

  eq(other: Gap) {
    return (
      this.lines === other.lines &&
      (this.copyMarker === other.copyMarker ||
        (this.copyMarker !== null &&
          other.copyMarker !== null &&
          this.copyMarker.eq(other.copyMarker)))
    );
  }
}

class FoldedLines extends WidgetType {
  constructor(private readonly count: number) {
    super();
  }
  eq(other: FoldedLines) {
    return this.count === other.count;
  }
  toDOM() {
    const element = document.createElement("div");
    element.className = "comparison-fold";
    element.textContent = `${this.count} lines hidden by display filter`;
    element.setAttribute("aria-label", element.textContent);
    return element;
  }
}

class MoveMarker extends WidgetType {
  constructor(
    private readonly direction: "from" | "to",
    private readonly id: number,
  ) {
    super();
  }
  eq(other: MoveMarker) {
    return this.direction === other.direction && this.id === other.id;
  }
  toDOM() {
    const marker = document.createElement("span");
    marker.className = `diff-move-marker diff-move-${this.direction}`;
    marker.textContent =
      this.direction === "from" ? iconSymbols.moveFrom : iconSymbols.moveTo;
    marker.title = `Moved block ${this.id}: ${this.direction}`;
    marker.setAttribute("aria-label", marker.title);
    return marker;
  }
}

class EndOfLineMarker extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }
  eq(other: EndOfLineMarker) {
    return this.label === other.label;
  }
  toDOM() {
    const marker = document.createElement("span");
    marker.className = "cm-visible-eol";
    marker.textContent = `\u21b5${this.label}`;
    marker.setAttribute("aria-label", `Line ending ${this.label}`);
    return marker;
  }
}

class CopyArrow extends GutterMarker {
  constructor(
    private readonly destination: "left" | "right",
    private readonly index: number,
    private readonly deletes: boolean,
    private readonly disabled: boolean,
    private readonly span: DiffSpan,
    private readonly singleLine: boolean,
    private readonly copy: () => void,
  ) {
    super();
  }
  eq(other: GutterMarker) {
    return (
      other instanceof CopyArrow &&
      this.destination === other.destination &&
      this.index === other.index &&
      this.deletes === other.deletes &&
      this.disabled === other.disabled &&
      this.singleLine === other.singleLine &&
      this.span.leftStart === other.span.leftStart &&
      this.span.leftEnd === other.span.leftEnd &&
      this.span.rightStart === other.span.rightStart &&
      this.span.rightEnd === other.span.rightEnd
    );
  }
  toDOM() {
    const button = document.createElement("button");
    const label = `Copy difference ${this.index + 1} to ${this.destination}`;
    button.type = "button";
    button.className = `copy-arrow${this.singleLine ? " single-line-copy" : ""}`;
    button.setAttribute("aria-label", label);
    button.title = `${label}${this.singleLine ? " (single line)" : this.deletes ? " (remove this region from the destination)" : ""}. Changes the draft only; Save writes the file.`;
    button.disabled = this.disabled;
    button.append(
      createIconElement(
        this.destination === "right" ? "copyRight" : "copyLeft",
        "copy-arrow-icon",
      ),
    );
    button.addEventListener("click", this.copy);
    return button;
  }
}

export function EditorSurface({
  text,
  onChange,
  onUndo,
  onRedo,
  label,
  disabled = false,
  gaps = [],
  selectedLine,
  navigation = 0,
  scrollTop,
  onScroll,
  differences = [],
  side = "left",
  selectedDifference,
  onCopyDifference,
  singleLineCopy,
  displayMode = "all",
  showWhitespace = false,
  intralineRegions = noIntralineRegions,
  onSelectLine,
  onLineNumberClick,
  onEditorContentClick,
  selection,
  onCopyDirection,
  moveCaretOnNavigation = false,
}: {
  text: string;
  onChange: (text: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  label: string;
  disabled?: boolean;
  gaps?: { line: number; count: number }[] | undefined;
  selectedLine?: number | undefined;
  navigation?: number;
  scrollTop?: number | undefined;
  onScroll?: ((top: number) => void) | undefined;
  differences?: DiffSpan[];
  side?: "left" | "right";
  selectedDifference?: DiffSpan | undefined;
  onCopyDifference?: ((span: DiffSpan, line?: number) => void) | undefined;
  singleLineCopy?: { side: "left" | "right"; line: number } | undefined;
  displayMode?: "all" | "differences" | "same" | "context";
  showWhitespace?: boolean;
  intralineRegions?: IntralineRegion[] | undefined;
  onSelectLine?: ((line: number) => void) | undefined;
  onLineNumberClick?: ((line: number) => void) | undefined;
  onEditorContentClick?: (() => void) | undefined;
  selection?: { from: number; to: number; token: number } | undefined;
  onCopyDirection?: ((destination: "left" | "right") => boolean) | undefined;
  moveCaretOnNavigation?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const undoCallback = useRef(onUndo);
  const redoCallback = useRef(onRedo);
  const lineCallback = useRef(onSelectLine);
  const lineNumberCallback = useRef(onLineNumberClick);
  const contentClickCallback = useRef(onEditorContentClick);
  const copyDirectionCallback = useRef(onCopyDirection);
  useEffect(() => {
    lineCallback.current = onSelectLine;
  }, [onSelectLine]);
  useEffect(() => {
    lineNumberCallback.current = onLineNumberClick;
  }, [onLineNumberClick]);
  useEffect(() => {
    contentClickCallback.current = onEditorContentClick;
  }, [onEditorContentClick]);
  useEffect(() => {
    copyDirectionCallback.current = onCopyDirection;
  }, [onCopyDirection]);
  const updating = useRef(false);
  const readonly = useRef(new Compartment());
  const alignment = useRef(new Compartment());
  const scrollCallback = useRef(onScroll);
  const copyCallback = useRef(onCopyDifference);
  const copyEnabled = onCopyDifference !== undefined;
  const lastNavigation = useRef(-1);
  const restoringScroll = useRef(false);
  const pairedScroll = useRef(scrollTop);
  useLayoutEffect(() => {
    pairedScroll.current = scrollTop;
  }, [scrollTop]);
  const scrollFrame = useRef<number | null>(null);
  useEffect(() => {
    copyCallback.current = onCopyDifference;
  }, [onCopyDifference]);
  useEffect(() => {
    scrollCallback.current = onScroll;
  }, [onScroll]);
  useEffect(() => {
    callback.current = onChange;
  }, [onChange]);
  useEffect(() => {
    undoCallback.current = onUndo;
  }, [onUndo]);
  useEffect(() => {
    redoCallback.current = onRedo;
  }, [onRedo]);
  useEffect(() => {
    if (!element.current) return;
    const instance = new EditorView({
      parent: element.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          Prec.highest(
            keymap.of([
              {
                key: "Mod-z",
                run: () => {
                  if (!undoCallback.current) return false;
                  undoCallback.current();
                  return true;
                },
              },
              {
                key: "Mod-y",
                run: () => {
                  if (!redoCallback.current) return false;
                  redoCallback.current();
                  return true;
                },
              },
              {
                key: "Mod-r",
                run: () => copyDirectionCallback.current?.("right") ?? false,
              },
              {
                key: "Mod-l",
                run: () => copyDirectionCallback.current?.("left") ?? false,
              },
            ]),
          ),
          readonly.current.of(EditorState.readOnly.of(disabled)),
          alignment.current.of([]),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
            ".cm-line": { lineHeight: "18px" },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !updating.current)
              callback.current(update.state.doc.toString());
            if (
              !updating.current &&
              update.view.hasFocus &&
              (update.selectionSet || update.focusChanged)
            )
              lineCallback.current?.(
                update.state.doc.lineAt(update.state.selection.main.head)
                  .number - 1,
              );
          }),
        ],
      }),
    });
    const handleMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".cm-lineNumbers")) {
        const gutterLabel = Number(
          event.target.closest(".cm-lineNumbers .cm-gutterElement")
            ?.textContent,
        );
        const lineNumber =
          Number.isInteger(gutterLabel) && gutterLabel > 0
            ? gutterLabel
            : instance.state.doc.lineAt(
                instance.posAtCoords({
                  x: event.clientX,
                  y: event.clientY,
                }) ?? instance.state.selection.main.head,
              ).number;
        const line = instance.state.doc.line(
          Math.min(lineNumber, instance.state.doc.lines),
        );
        lineNumberCallback.current?.(line.number - 1);
        instance.dispatch({ selection: { anchor: line.from } });
        requestAnimationFrame(() => instance.focus());
      } else if (event.target.closest(".cm-content")) {
        contentClickCallback.current?.();
      }
    };
    instance.dom.addEventListener("mousedown", handleMouseDown);
    const scrolled = () => {
      if (!restoringScroll.current)
        scrollCallback.current?.(instance.scrollDOM.scrollTop);
    };
    instance.scrollDOM.addEventListener("scroll", scrolled);
    view.current = instance;
    return () => {
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current);
      view.current = null;
      instance.dom.removeEventListener("mousedown", handleMouseDown);
      instance.scrollDOM.removeEventListener("scroll", scrolled);
      instance.destroy();
    };
    // Editor instances own selection/history; later changes are dispatched below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    view.current?.dispatch({
      effects: readonly.current.reconfigure(EditorState.readOnly.of(disabled)),
    });
  }, [disabled]);
  useEffect(() => {
    const instance = view.current;
    if (!instance || !selection) return;
    const from = Math.min(selection.from, instance.state.doc.length);
    const to = Math.min(
      Math.max(selection.to, from),
      instance.state.doc.length,
    );
    instance.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    instance.focus();
  }, [selection]);
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const top = pairedScroll.current ?? instance.scrollDOM.scrollTop;
    const left = instance.scrollDOM.scrollLeft;
    const preserveScroll =
      selectedLine === undefined || lastNavigation.current === navigation;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    restoringScroll.current = preserveScroll;
    const normalized = text.replace(/\r\n|\r/g, "\n");
    const documentChanged = instance.state.doc.toString() !== normalized;
    if (documentChanged) {
      updating.current = true;
      try {
        instance.dispatch({
          changes: {
            from: 0,
            to: instance.state.doc.length,
            insert: normalized,
          },
          selection: {
            anchor: Math.min(
              instance.state.selection.main.anchor,
              normalized.length,
            ),
            head: Math.min(
              instance.state.selection.main.head,
              normalized.length,
            ),
          },
        });
      } finally {
        updating.current = false;
      }
    }
    const hidden = differences.flatMap((span) => {
      const start = side === "left" ? span.leftStart : span.rightStart;
      const end = side === "left" ? span.leftEnd : span.rightEnd;
      if (
        (displayMode === "differences" && span.kind === "equal") ||
        (displayMode === "same" && span.kind !== "equal")
      )
        return end > start ? [{ start, end }] : [];
      if (displayMode === "context" && span.kind === "equal" && end - start > 6)
        return [{ start: start + 3, end: end - 3 }];
      return [];
    });
    const copyMarkers = differences
      .filter((span) => span.kind !== "equal")
      .filter(() => displayMode !== "same")
      .map((span, index) => {
        const start = side === "left" ? span.leftStart : span.rightStart;
        const end = side === "left" ? span.leftEnd : span.rightEnd;
        const singleLine =
          singleLineCopy?.side === side &&
          singleLineCopy.line >= start &&
          singleLineCopy.line < end;
        const markerStart = singleLine ? singleLineCopy.line : start;
        return {
          start: markerStart,
          end: singleLine ? markerStart + 1 : end,
          marker: new CopyArrow(
            side === "left" ? "right" : "left",
            index,
            !singleLine &&
              (side === "left"
                ? span.leftStart === span.leftEnd
                : span.rightStart === span.rightEnd),
            disabled,
            span,
            singleLine,
            () =>
              copyCallback.current?.(
                span,
                singleLine ? markerStart : undefined,
              ),
          ),
        };
      });
    const displayedGaps =
      displayMode === "same"
        ? differences
            .filter(
              (span) =>
                span.kind !== "equal" &&
                (side === "left"
                  ? span.leftEnd === span.leftStart &&
                    span.rightEnd > span.rightStart
                  : span.rightEnd === span.rightStart &&
                    span.leftEnd > span.leftStart),
            )
            .map((span) => ({
              line: side === "left" ? span.leftStart : span.rightStart,
              count: 1,
            }))
        : gaps;
    const decorations = displayedGaps
      .filter(
        ({ line }) =>
          !hidden.some((range) => line >= range.start && line < range.end),
      )
      .map(({ line, count }) => {
        const position =
          line < instance.state.doc.lines
            ? instance.state.doc.line(line + 1).from
            : instance.state.doc.length;
        return Decoration.widget({
          widget: new Gap(
            count,
            copyEnabled
              ? (copyMarkers.find(
                  (entry) => entry.start === line && entry.start === entry.end,
                )?.marker ?? null)
              : null,
          ),
          block: true,
          side: line < instance.state.doc.lines ? -1 : 1,
        }).range(position);
      });
    const bytePositions = new Map<number, number>([[0, 0]]);
    if (intralineRegions.length) {
      let byteOffset = 0;
      let editorOffset = 0;
      for (let index = 0; index < text.length;) {
        const codePoint = text.codePointAt(index);
        if (codePoint === undefined) break;
        const character = String.fromCodePoint(codePoint);
        const byteWidth =
          codePoint <= 0x7f
            ? 1
            : codePoint <= 0x7ff
              ? 2
              : codePoint <= 0xffff
                ? 3
                : 4;
        byteOffset += byteWidth;
        editorOffset += character.length;
        bytePositions.set(byteOffset, editorOffset);
        index += character.length;
        if (character === "\r" && text[index] === "\n") {
          byteOffset += 1;
          bytePositions.set(byteOffset, editorOffset);
          index += 1;
        }
      }
    }
    for (const region of intralineRegions)
      for (const span of region.spans) {
        if (span.kind === "equal") continue;
        const startByte =
          region.baseByte +
          (side === "left" ? span.leftStart : span.rightStart);
        const endByte =
          region.baseByte + (side === "left" ? span.leftEnd : span.rightEnd);
        const from = bytePositions.get(startByte);
        const to = bytePositions.get(endByte);
        if (
          from !== undefined &&
          to !== undefined &&
          to > from &&
          to <= instance.state.doc.length
        )
          decorations.push(
            Decoration.mark({ class: "cm-intraline-change" }).range(from, to),
          );
      }
    if (showWhitespace) {
      let whitespaceMarks = 0;
      for (let number = 1; number <= instance.state.doc.lines; number++) {
        const line = instance.state.doc.line(number);
        const content = line.text;
        const run = /[ \t]+/g;
        for (const match of content.matchAll(run)) {
          const from = line.from + (match.index ?? 0);
          const to = from + match[0].length;
          decorations.push(
            Decoration.mark({
              class: match[0].includes("\t")
                ? "cm-visible-tab"
                : "cm-visible-space",
            }).range(from, to),
          );
          whitespaceMarks += 1;
          if (whitespaceMarks >= 20_000) break;
        }
        if (whitespaceMarks >= 20_000) break;
      }
      const endings = [...text.matchAll(/\r\n|\r|\n/g)];
      endings.forEach((match, index) => {
        if (index >= instance.state.doc.lines) return;
        const label =
          match[0] === "\r\n" ? "CRLF" : match[0] === "\r" ? "CR" : "LF";
        const position = instance.state.doc.line(index + 1).to;
        decorations.push(
          Decoration.widget({
            widget: new EndOfLineMarker(label),
            side: 1,
          }).range(position),
        );
      });
    }
    for (const span of differences) {
      if (span.kind === "equal") continue;
      const start = side === "left" ? span.leftStart : span.rightStart;
      const end = side === "left" ? span.leftEnd : span.rightEnd;
      const moved = span.moved;
      for (
        let line = start;
        line < end && line < instance.state.doc.lines;
        line++
      ) {
        if (hidden.some((range) => line >= range.start && line < range.end))
          continue;
        decorations.push(
          Decoration.line({
            attributes: {
              class: `diff-line diff-${span.kind}${span.minor ? " diff-minor" : ""}${span === selectedDifference ? " diff-selected" : ""}${moved ? ` diff-moved-${moved.direction}` : ""}`,
            },
          }).range(instance.state.doc.line(line + 1).from),
        );
        if (moved)
          decorations.push(
            Decoration.widget({
              widget: new MoveMarker(moved.direction, moved.id),
              side: -1,
            }).range(instance.state.doc.line(line + 1).from),
          );
      }
    }
    for (const range of hidden) {
      const from = instance.state.doc.line(
        Math.min(range.start + 1, instance.state.doc.lines),
      ).from;
      const to =
        range.end < instance.state.doc.lines
          ? instance.state.doc.line(range.end + 1).from
          : instance.state.doc.length;
      if (to > from)
        decorations.push(
          Decoration.replace({
            widget: new FoldedLines(range.end - range.start),
            block: true,
          }).range(from, to),
        );
    }
    const markers = RangeSet.of(
      copyMarkers
        .filter(
          (entry) =>
            entry.start < entry.end && entry.start < instance.state.doc.lines,
        )
        .map((entry) =>
          entry.marker.range(instance.state.doc.line(entry.start + 1).from),
        ),
      true,
    );
    instance.dispatch({
      effects: alignment.current.reconfigure([
        EditorView.decorations.of(Decoration.set(decorations, true)),
        ...(copyEnabled
          ? [
              Prec.highest(
                gutter({
                  class: "cm-copy-gutter",
                  side: "before",
                  markers: () => markers,
                  widgetMarker: (_view, widget) =>
                    widget instanceof Gap ? widget.copyMarker : null,
                }),
              ),
            ]
          : []),
      ]),
    });
    instance.requestMeasure({
      key: alignment.current,
      read: () => instance.scrollDOM.querySelectorAll(".cm-gutters"),
      write: (containers) => {
        if (preserveScroll) {
          // CodeMirror applies block-height scroll anchoring after measure writes.
          // Restore pixels afterward and do not mirror intermediate anchor offsets.
          scrollFrame.current = requestAnimationFrame(() => {
            instance.scrollDOM.scrollTop = top;
            instance.scrollDOM.scrollLeft = left;
            restoringScroll.current = false;
            scrollFrame.current = null;
          });
        }
        // CodeMirror hides gutter containers by default; only copy actions are interactive.
        for (const container of containers) {
          const hasCopyActions =
            container.querySelector(".cm-copy-gutter") !== null;
          container.setAttribute("aria-hidden", String(!hasCopyActions));
          for (const child of container.children) {
            if (!child.classList.contains("cm-copy-gutter"))
              child.setAttribute("aria-hidden", "true");
          }
        }
      },
    });
  }, [
    gaps,
    text,
    differences,
    side,
    selectedDifference,
    disabled,
    copyEnabled,
    displayMode,
    showWhitespace,
    intralineRegions,
    selectedLine,
    singleLineCopy,
    navigation,
  ]);
  useEffect(() => {
    const instance = view.current;
    if (
      instance &&
      selectedLine !== undefined &&
      lastNavigation.current !== navigation
    ) {
      lastNavigation.current = navigation;
      instance.dispatch({
        ...(moveCaretOnNavigation
          ? {
              selection: {
                anchor: instance.state.doc.line(
                  Math.min(selectedLine + 1, instance.state.doc.lines),
                ).from,
              },
            }
          : {}),
        effects: EditorView.scrollIntoView(
          instance.state.doc.line(
            Math.min(selectedLine + 1, instance.state.doc.lines),
          ).from,
          { y: "center" },
        ),
      });
      if (moveCaretOnNavigation) instance.focus();
    }
  }, [selectedLine, navigation, moveCaretOnNavigation]);
  useEffect(() => {
    if (
      view.current &&
      scrollTop !== undefined &&
      Math.abs(view.current.scrollDOM.scrollTop - scrollTop) > 1
    )
      view.current.scrollDOM.scrollTop = scrollTop;
  }, [scrollTop]);
  return <div ref={element} className="code-editor" />;
}
