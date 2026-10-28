import { useEffect, useId, useRef, useState } from "react";

export interface MenuCommand {
  label: string;
  run: () => void;
  disabled?: boolean;
  disabledReason?: string;
}
export function CommandMenu({
  label,
  commands,
  position,
  onClose,
  description,
}: {
  label: string;
  commands: MenuCommand[];
  position?: { x: number; y: number };
  onClose?: () => void;
  description?: string;
}) {
  const [open, setOpen] = useState(position !== undefined);
  const [anchor, setAnchor] = useState(position);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreTarget = useRef<HTMLElement | null>(null);
  function clampAnchor(x: number, y: number) {
    const height = Math.min(
      commands.length * 22 + 10,
      window.innerHeight * 0.6,
    );
    return {
      x: Math.max(4, Math.min(x, window.innerWidth - 240)),
      y: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    };
  }
  function close(restore = true) {
    setOpen(false);
    onClose?.();
    const target = trigger.current ?? restoreTarget.current;
    restoreTarget.current = null;
    if (restore) target?.focus();
  }
  function focusOutsideMenu(backwards: boolean) {
    const origin = trigger.current ?? restoreTarget.current;
    if (!origin) return;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled):not([aria-disabled="true"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        (element === origin || !container.current?.contains(element)) &&
        element.getClientRects().length > 0,
    );
    const index = candidates.indexOf(origin);
    const next = candidates[index + (backwards ? -1 : 1)];
    if (next) next.focus();
    else origin.blur();
  }
  useEffect(() => {
    if (!open) return;
    const menu = container.current;
    if (!restoreTarget.current) {
      restoreTarget.current =
        trigger.current ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
    }
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu?.contains(event.target)) {
        setOpen(false);
        onClose?.();
        restoreTarget.current = null;
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
              left: clampAnchor(position.x, position.y).x,
              top: clampAnchor(position.x, position.y).y,
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
          title={description ?? `Open ${label} commands`}
          onClick={() => {
            const box = trigger.current?.getBoundingClientRect();
            if (box) setAnchor(clampAnchor(box.left, box.bottom));
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
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            } else if (event.key === "Tab") {
              event.preventDefault();
              focusOutsideMenu(event.shiftKey);
              close(false);
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
              if (!items.length) return;
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
          {commands.map((command, index) => {
            const descriptionId = `${id}-disabled-${index}`;
            const reason = command.disabled
              ? (command.disabledReason ??
                `${command.label} is unavailable for the current selection or operation.`)
              : undefined;
            return (
              <button
                key={command.label}
                role="menuitem"
                aria-disabled={command.disabled || undefined}
                aria-describedby={reason ? descriptionId : undefined}
                title={reason ?? command.label}
                onClick={() => {
                  if (command.disabled) return;
                  close();
                  command.run();
                }}
              >
                {command.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="sr-only">
        {commands.map((command, index) => {
          if (!command.disabled) return null;
          return (
            <span key={command.label} id={`${id}-disabled-${index}`}>
              {command.disabledReason ??
                `${command.label} is unavailable for the current selection or operation.`}
            </span>
          );
        })}
      </div>
    </div>
  );
}
