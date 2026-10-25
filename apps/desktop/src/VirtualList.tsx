import {
  useEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
} from "react";

export function VirtualList({
  count,
  height = 360,
  rowHeight = 36,
  render,
  label,
  fill = false,
  activeIndex = -1,
  onKeyDown,
  activeDescendant,
  role = "region",
  multiselectable = false,
}: {
  count: number;
  height?: number;
  rowHeight?: number;
  render: (index: number) => ReactNode;
  label: string;
  fill?: boolean;
  activeIndex?: number;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  activeDescendant?: string | undefined;
  role?: "region" | "tree";
  multiselectable?: boolean;
}) {
  const [scroll, setScroll] = useState(0);
  const [measuredHeight, setMeasuredHeight] = useState(height);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fill || !element.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setMeasuredHeight(entry.contentRect.height);
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [fill]);
  useEffect(() => {
    const viewport = element.current;
    if (!viewport || activeIndex < 0) return;
    const top = activeIndex * rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + rowHeight > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = top + rowHeight - viewport.clientHeight;
  }, [activeIndex, rowHeight]);
  const start = Math.min(
    Math.max(0, Math.floor(scroll / rowHeight) - 5),
    Math.max(0, count - 1),
  );
  const end = Math.min(
    count,
    start + Math.ceil((fill ? measuredHeight : height) / rowHeight) + 10,
  );
  return (
    <div
      className="virtual"
      ref={element}
      role={role}
      aria-multiselectable={role === "tree" ? multiselectable : undefined}
      aria-label={label}
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      style={{
        height: fill ? undefined : height,
        flex: fill ? 1 : undefined,
        minHeight: fill ? 0 : undefined,
        overflow: "auto",
      }}
      onKeyDown={onKeyDown}
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
