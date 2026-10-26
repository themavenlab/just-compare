import { type DiffSpan } from "./comparison";

export function RefinedRegion({
  left,
  right,
  spans,
  labels,
}: {
  left: string;
  right: string;
  spans: DiffSpan[];
  labels?: [string, string];
}) {
  const decoder = new TextDecoder();
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  return (
    <section aria-label="Intraline highlight" className="panes">
      {(["left", "right"] as const).map((side) => (
        <pre key={side}>
          {labels && (
            <span className="inspector-source">
              {labels[side === "left" ? 0 : 1]}:{" "}
            </span>
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
      ))}
    </section>
  );
}
