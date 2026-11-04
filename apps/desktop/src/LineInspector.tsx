import { useEffect, useState } from "react";
import { native } from "./api";
import { errorMessage, type DiffSpan } from "./comparison";
import { Icon } from "./icons";
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
  layout,
  onLayout,
  onCopyLine,
}: {
  row: InspectorLine | undefined;
  left: string;
  right: string;
  layout: { collapsed: boolean; height: number };
  onLayout: (layout: { collapsed: boolean; height: number }) => void;
  onCopyLine: (source: "left" | "right") => void;
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
      <div className="toolbar compact inspector-bar">
        <strong>Line detail</strong>
        <button
          className="icon-button"
          aria-expanded={!layout.collapsed}
          aria-label={
            layout.collapsed ? "Expand line detail" : "Collapse line detail"
          }
          title={
            layout.collapsed ? "Expand line detail" : "Collapse line detail"
          }
          onClick={() => onLayout({ ...layout, collapsed: !layout.collapsed })}
        >
          <Icon name={layout.collapsed ? "chevronUp" : "chevronDown"} />
        </button>
      </div>
      {!layout.collapsed && (
        <div className="line-inspector-content">
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
                  onCopyToRight={() => onCopyLine("left")}
                  onCopyToLeft={() => onCopyLine("right")}
                  disableCopyToRight={row.kind === "equal" || row.left === null}
                  disableCopyToLeft={row.kind === "equal" || row.right === null}
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
