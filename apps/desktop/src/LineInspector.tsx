import { useEffect, useState } from "react";
import { native } from "./api";
import { errorMessage, type DiffSpan } from "./comparison";
import { RefinedRegion } from "./RefinedRegion";

export interface InspectorLine {
  kind: DiffSpan["kind"];
  minor?: boolean;
  left: number | null;
  right: number | null;
}

export function LineInspector({
  row,
  left,
  right,
  index,
  count,
  select,
  layout,
  onLayout,
}: {
  row: InspectorLine | undefined;
  left: string;
  right: string;
  index: number;
  count: number;
  select: (index: number) => void;
  layout: { collapsed: boolean; height: number };
  onLayout: (layout: { collapsed: boolean; height: number }) => void;
}) {
  const [result, setResult] = useState<{
    left: string;
    right: string;
    spans?: DiffSpan[];
    error?: string;
  } | null>(null);
  const hasRow = row !== undefined;
  useEffect(() => {
    if (!hasRow || layout.collapsed) return;
    let disposed = false;
    void native("refine_text", { left, right }).then(
      (spans) => {
        if (!disposed) setResult({ left, right, spans });
      },
      (failure: unknown) => {
        if (!disposed) setResult({ left, right, error: errorMessage(failure) });
      },
    );
    return () => {
      disposed = true;
    };
  }, [left, right, hasRow, layout.collapsed]);
  const current =
    result?.left === left && result.right === right ? result : null;
  return (
    <section className="line-inspector" aria-label="Line-by-line detail">
      <div className="toolbar compact">
        <strong>Line detail</strong>
        <button
          aria-expanded={!layout.collapsed}
          onClick={() => onLayout({ ...layout, collapsed: !layout.collapsed })}
        >
          {layout.collapsed ? "Expand line detail" : "Collapse line detail"}
        </button>
        {!layout.collapsed && (
          <>
            <button
              aria-label="Previous detail line"
              disabled={!row || index <= 0}
              onClick={() => select(index - 1)}
            >
              Previous line
            </button>
            <button
              aria-label="Next detail line"
              disabled={!row || index + 1 >= count}
              onClick={() => select(index + 1)}
            >
              Next line
            </button>
            <label>
              Detail height{" "}
              <select
                aria-label="Detail height"
                value={layout.height}
                onChange={(event) =>
                  onLayout({ ...layout, height: Number(event.target.value) })
                }
              >
                {[80, 140, 220, 320].map((height) => (
                  <option key={height} value={height}>
                    {height} px
                  </option>
                ))}
              </select>
            </label>
            <span>
              {row
                ? `${row.minor ? "Minor " : ""}${row.kind} - aligned line ${index + 1} / ${count}`
                : "No selection / comparison stale"}
            </span>
          </>
        )}
      </div>
      {!layout.collapsed && (
        <div
          className="line-inspector-content"
          style={{ height: layout.height }}
        >
          {!row ? (
            <p>
              Compare to inspect an aligned source line. Drafts are unchanged.
            </p>
          ) : (
            <>
              {current?.error ? (
                <p role="alert">Line detail unavailable: {current.error}</p>
              ) : current?.spans ? (
                <RefinedRegion
                  left={left}
                  right={right}
                  spans={current.spans}
                  labels={[
                    row.left === null
                      ? "Left (missing line)"
                      : `Left ${row.left + 1}`,
                    row.right === null
                      ? "Right (missing line)"
                      : `Right ${row.right + 1}`,
                  ]}
                />
              ) : (
                <p role="status">Refining selected line...</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
