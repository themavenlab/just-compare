import { Compartment, EditorState, RangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { errorMessage, type DiffSpan } from "./comparison";

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

class CopyArrow extends GutterMarker {
  constructor(
    private readonly destination: "left" | "right",
    private readonly index: number,
    private readonly deletes: boolean,
    private readonly disabled: boolean,
    private readonly span: DiffSpan,
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
    button.className = "copy-arrow";
    button.textContent = this.destination === "right" ? "\u2192" : "\u2190";
    button.setAttribute("aria-label", label);
    button.title = `${label}${this.deletes ? " (remove this region from the destination)" : ""}. Changes the draft only; Save writes the file.`;
    button.disabled = this.disabled;
    button.addEventListener("click", this.copy);
    return button;
  }
}

export function EditorSurface({
  text,
  onChange,
  label,
  disabled = false,
  path = "",
  gaps = [],
  selectedLine,
  navigation = 0,
  scrollTop,
  onScroll,
  differences = [],
  side = "left",
  selectedDifference,
  onCopyDifference,
  displayMode = "all",
}: {
  text: string;
  onChange: (text: string) => void;
  label: string;
  disabled?: boolean;
  path?: string;
  gaps?: { line: number; count: number }[] | undefined;
  selectedLine?: number | undefined;
  navigation?: number;
  scrollTop?: number | undefined;
  onScroll?: ((top: number) => void) | undefined;
  differences?: DiffSpan[];
  side?: "left" | "right";
  selectedDifference?: DiffSpan | undefined;
  onCopyDifference?: ((span: DiffSpan) => void) | undefined;
  displayMode?: "all" | "differences" | "same" | "context";
}) {
  const element = useRef<HTMLDivElement>(null);
  const [syntaxError, setSyntaxError] = useState("");
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const updating = useRef(false);
  const readonly = useRef(new Compartment());
  const language = useRef(new Compartment());
  const alignment = useRef(new Compartment());
  const scrollCallback = useRef(onScroll);
  const copyCallback = useRef(onCopyDifference);
  const copyEnabled = onCopyDifference !== undefined;
  const lastNavigation = useRef(-1);
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
    if (!element.current) return;
    const instance = new EditorView({
      parent: element.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          readonly.current.of(EditorState.readOnly.of(disabled)),
          language.current.of([]),
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
          }),
        ],
      }),
    });
    const scrolled = () =>
      scrollCallback.current?.(instance.scrollDOM.scrollTop);
    instance.scrollDOM.addEventListener("scroll", scrolled);
    view.current = instance;
    return () => {
      view.current = null;
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
    if (!instance) return;
    const top = instance.scrollDOM.scrollTop;
    const left = instance.scrollDOM.scrollLeft;
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
      .map((span, index) => ({
        start: side === "left" ? span.leftStart : span.rightStart,
        end: side === "left" ? span.leftEnd : span.rightEnd,
        marker: new CopyArrow(
          side === "left" ? "right" : "left",
          index,
          side === "left"
            ? span.leftStart === span.leftEnd
            : span.rightStart === span.rightEnd,
          disabled,
          span,
          () => copyCallback.current?.(span),
        ),
      }));
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
    for (const span of differences) {
      if (span.kind === "equal") continue;
      const start = side === "left" ? span.leftStart : span.rightStart;
      const end = side === "left" ? span.leftEnd : span.rightEnd;
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
              class: `diff-line diff-${span.kind}${span.minor ? " diff-minor" : ""}${span === selectedDifference ? " diff-selected" : ""}`,
            },
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
              gutter({
                class: "cm-copy-gutter",
                side: side === "left" ? "after" : "before",
                markers: () => markers,
                widgetMarker: (_view, widget) =>
                  widget instanceof Gap ? widget.copyMarker : null,
              }),
            ]
          : []),
      ]),
    });
    instance.requestMeasure({
      read: () => instance.scrollDOM.querySelectorAll(".cm-gutters"),
      write: (containers) => {
        instance.scrollDOM.scrollTop = top;
        instance.scrollDOM.scrollLeft = left;
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
        effects: EditorView.scrollIntoView(
          instance.state.doc.line(
            Math.min(selectedLine + 1, instance.state.doc.lines),
          ).from,
          { y: "center" },
        ),
      });
    }
  }, [selectedLine, navigation]);
  useEffect(() => {
    if (
      view.current &&
      scrollTop !== undefined &&
      Math.abs(view.current.scrollDOM.scrollTop - scrollTop) > 1
    )
      view.current.scrollDOM.scrollTop = scrollTop;
  }, [scrollTop]);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const extension = /\.[cm]?[jt]sx?$/i.test(path)
          ? (await import("@codemirror/lang-javascript")).javascript({
              jsx: true,
              typescript: true,
            })
          : /\.json$/i.test(path)
            ? (await import("@codemirror/lang-json")).json()
            : [];
        if (!disposed) {
          setSyntaxError("");
          view.current?.dispatch({
            effects: language.current.reconfigure(extension),
          });
        }
      } catch (error) {
        if (!disposed) setSyntaxError(errorMessage(error));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [path]);
  return (
    <>
      <div ref={element} className="code-editor" />
      {syntaxError && <p role="alert">Syntax support failed: {syntaxError}</p>}
    </>
  );
}
