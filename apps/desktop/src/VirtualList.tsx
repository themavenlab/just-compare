import { useState, type ReactNode } from "react";

export function VirtualList({
  count,
  height = 360,
  rowHeight = 36,
  render,
  label,
}: {
  count: number;
  height?: number;
  rowHeight?: number;
  render: (index: number) => ReactNode;
  label: string;
}) {
  const [scroll, setScroll] = useState(0);
  const start = Math.min(
    Math.max(0, Math.floor(scroll / rowHeight) - 5),
    Math.max(0, count - 1),
  );
  const end = Math.min(count, start + Math.ceil(height / rowHeight) + 10);
  return (
    <div
      className="virtual"
      role="region"
      aria-label={label}
      tabIndex={0}
      style={{ height, overflow: "auto" }}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
    >
      <div style={{ height: count * rowHeight, position: "relative" }}>
        {Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          return (
            <div
              key={index}
              style={{
                position: "absolute",
                top: index * rowHeight,
                height: rowHeight,
                left: 0,
                right: 0,
              }}
            >
              {render(index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
