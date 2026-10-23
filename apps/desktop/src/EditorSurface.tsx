import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./comparison";

class Gap extends WidgetType {
  constructor(private readonly lines: number) {
    super();
  }
  toDOM() {
    const element = document.createElement("div");
    element.style.height = `${this.lines * 21}px`;
    element.className = "alignment-gap";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  get estimatedHeight() {
    return this.lines * 21;
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
  scrollTop,
  onScroll,
}: {
  text: string;
  onChange: (text: string) => void;
  label: string;
  disabled?: boolean;
  path?: string;
  gaps?: { line: number; count: number }[] | undefined;
  selectedLine?: number | undefined;
  scrollTop?: number | undefined;
  onScroll?: ((top: number) => void) | undefined;
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
            "&": { height: "320px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
            ".cm-line": { lineHeight: "21px" },
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
    const instance = view.current;
    if (!instance) return;
    const normalized = text.replace(/\r\n|\r/g, "\n");
    if (instance.state.doc.toString() !== normalized) {
      updating.current = true;
      try {
        instance.dispatch({
          changes: {
            from: 0,
            to: instance.state.doc.length,
            insert: normalized,
          },
        });
      } finally {
        updating.current = false;
      }
    }
  }, [text]);
  useEffect(() => {
    view.current?.dispatch({
      effects: readonly.current.reconfigure(EditorState.readOnly.of(disabled)),
    });
  }, [disabled]);
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const decorations = gaps.map(({ line, count }) => {
      const position =
        line < instance.state.doc.lines
          ? instance.state.doc.line(line + 1).from
          : instance.state.doc.length;
      return Decoration.widget({
        widget: new Gap(count),
        block: true,
        side: line < instance.state.doc.lines ? -1 : 1,
      }).range(position);
    });
    instance.dispatch({
      effects: alignment.current.reconfigure(
        EditorView.decorations.of(Decoration.set(decorations, true)),
      ),
    });
  }, [gaps, text]);
  useEffect(() => {
    const instance = view.current;
    if (instance && selectedLine !== undefined)
      instance.dispatch({
        effects: EditorView.scrollIntoView(
          instance.state.doc.line(
            Math.min(selectedLine + 1, instance.state.doc.lines),
          ).from,
          { y: "center" },
        ),
      });
  }, [selectedLine]);
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
