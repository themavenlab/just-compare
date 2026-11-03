import { Fragment } from "react";
import { type DiffSpan } from "./comparison";
import { Icon } from "./icons";

export function RefinedRegion({
  left,
  right,
  spans,
  labels,
  onCopyToRight,
  onCopyToLeft,
  disableCopyToRight = false,
  disableCopyToLeft = false,
}: {
  left: string;
  right: string;
  spans: DiffSpan[];
  labels?: [string, string];
  onCopyToRight?: () => void;
  onCopyToLeft?: () => void;
  disableCopyToRight?: boolean;
  disableCopyToLeft?: boolean;
}) {
  const decoder = new TextDecoder();
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  return (
    <section aria-label="Intraline highlight" className="panes">
      {(["left", "right"] as const).map((side) => (
        <Fragment key={side}>
          {labels && (
            <span className="inspector-source">
              {labels[side === "left" ? 0 : 1]}
            </span>
          )}
          <pre>
            {labels && side === "left" && onCopyToRight && (
              <button
                type="button"
                className="inspector-copy-arrow"
                aria-label="Copy detail line to right"
                title="Copy this left detail line to the right draft"
                disabled={disableCopyToRight}
                onClick={onCopyToRight}
              >
                <Icon name="copyRight" />
              </button>
            )}
            {labels && side === "right" && onCopyToLeft && (
              <button
                type="button"
                className="inspector-copy-arrow"
                aria-label="Copy detail line to left"
                title="Copy this right detail line to the left draft"
                disabled={disableCopyToLeft}
                onClick={onCopyToLeft}
              >
                <Icon name="copyLeft" />
              </button>
            )}
            {spans.map((span, index) => {
              const text = decoder.decode(
                side === "left"
                  ? a.subarray(span.leftStart, span.leftEnd)
                  : b.subarray(span.rightStart, span.rightEnd),
              );
              return span.kind === "equal" ? (
                <span key={index}>{text}</span>
              ) : (
                <mark key={index}>{text}</mark>
              );
            })}
          </pre>
        </Fragment>
      ))}
    </section>
  );
}
