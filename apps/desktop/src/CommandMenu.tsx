import { useEffect, useRef, useState } from "react";

export interface MenuCommand {
  label: string;
  run: () => void;
  disabled?: boolean;
}
export function CommandMenu({
  label,
  commands,
  position,
  onClose,
}: {
  label: string;
  commands: MenuCommand[];
  position?: { x: number; y: number };
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(position !== undefined);
  const [anchor, setAnchor] = useState(position);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function close(restore = true) {
    setOpen(false);
    onClose?.();
    if (restore) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const menu = container.current;
    menu
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu?.contains(event.target)) {
        setOpen(false);
        onClose?.();
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, onClose]);
  return (
    <div
      className="command-menu"
      ref={container}
      style={
        position
          ? {
              position: "fixed",
              left: Math.min(position.x, window.innerWidth - 240),
              top: Math.min(
                position.y,
                window.innerHeight - commands.length * 32 - 20,
              ),
              zIndex: 30,
            }
          : undefined
      }
    >
      {!position && (
        <button
          ref={trigger}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            const box = trigger.current?.getBoundingClientRect();
            if (box)
              setAnchor({
                x: Math.max(4, Math.min(box.left, window.innerWidth - 240)),
                y: Math.max(
                  4,
                  Math.min(
                    box.bottom,
                    window.innerHeight - commands.length * 32 - 20,
                  ),
                ),
              });
            setOpen((prior) => !prior);
          }}
        >
          {label}
        </button>
      )}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="menu-popup"
          style={
            anchor && !position
              ? { position: "fixed", left: anchor.x, top: anchor.y }
              : undefined
          }
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") event.preventDefault();
              close();
            } else if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }
          }}
        >
          {commands.map((command) => (
            <button
              key={command.label}
              role="menuitem"
              disabled={command.disabled}
              onClick={() => {
                close();
                command.run();
              }}
            >
              {command.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
