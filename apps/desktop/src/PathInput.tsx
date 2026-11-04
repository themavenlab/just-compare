import { useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { plainPath } from "./workbench";

const MAX_RECENT = 20;

/** Path field with a recent-path dropdown shared by file and folder inputs. */
export function PathInput({
  kind,
  side,
  value,
  recent,
  disabled,
  onPathChange,
  onChoose,
  onSaveHistory,
}: {
  kind: "file" | "folder";
  side: "left" | "right" | "base";
  value: string;
  recent: string[];
  disabled: boolean;
  onPathChange: (path: string) => void;
  onChoose: (path: string) => void;
  /** Enables per-path removal and clearing; omitted lists are read-only. */
  onSaveHistory?: (paths: string[]) => void;
}) {
  const id = useId();
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(-1);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const noun = kind === "file" ? "files" : "folders";
  const display = kind === "folder" ? plainPath(value) : value;
  const matches = recent
    .filter((path) =>
      plainPath(path).toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    )
    .slice(0, MAX_RECENT);
  const active = index >= 0 && index < matches.length ? index : -1;

  // Fixed positioning keeps the list visible above clipped, compact pane rows.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (field.current) setAnchor(field.current.getBoundingClientRect());
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  function show(next: boolean) {
    setOpen(next);
    setFilter("");
    setIndex(-1);
  }
  function select(path: string) {
    show(false);
    onChoose(path);
  }
  function move(delta: number) {
    if (!open) {
      show(true);
      if (delta > 0 && recent.length) setIndex(0);
      return;
    }
    if (!matches.length) return;
    setIndex((prior) =>
      Math.max(
        0,
        Math.min(matches.length - 1, (prior < 0 ? -1 : prior) + delta),
      ),
    );
  }
  return (
    <div
      className="path-input"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) show(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          show(false);
          input.current?.focus();
          event.stopPropagation();
        }
      }}
    >
      <div className="path-input-field" ref={field}>
        <input
          ref={input}
          role="combobox"
          aria-label={`${side} path`}
          aria-expanded={open}
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={
            open && active >= 0 ? `${id}-${active}` : undefined
          }
          name={`${side}-path`}
          autoComplete="off"
          spellCheck={false}
          placeholder={`Choose a ${kind} or paste its path...`}
          value={display}
          disabled={disabled}
          onChange={(event) => {
            if (open) {
              setFilter(event.target.value);
              setIndex(-1);
            }
            onPathChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const highlighted = open ? matches[active] : undefined;
              if (highlighted !== undefined) select(highlighted);
              else if (kind === "folder" || display) select(display);
            }
          }}
        />
        <button
          type="button"
          className="path-input-toggle"
          aria-label={`Recent ${side} ${noun}`}
          title={`Show recently opened ${noun}`}
          aria-expanded={open}
          aria-controls={id}
          disabled={disabled}
          onClick={() => {
            show(!open);
            input.current?.focus();
          }}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      {open && (
        <div
          className="path-history"
          style={
            anchor
              ? {
                  top: anchor.bottom + 2,
                  left: anchor.left,
                  width: anchor.width,
                }
              : { visibility: "hidden" }
          }
        >
          <div role="listbox" aria-label={`Recent ${side} ${noun}`} id={id}>
            {matches.map((path, position) => (
              <div className="path-history-row" key={path}>
                <div
                  role="option"
                  id={`${id}-${position}`}
                  aria-selected={active === position}
                  title={plainPath(path)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => select(path)}
                >
                  {plainPath(path)}
                </div>
                {onSaveHistory && (
                  <button
                    type="button"
                    aria-label={`Remove recent ${kind} ${path}`}
                    title={`Remove from history; the ${kind} is not deleted`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() =>
                      onSaveHistory(recent.filter((item) => item !== path))
                    }
                  >
                    <Icon name="close" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {!matches.length && (
            <p className="path-history-empty">
              {recent.length
                ? `No recent ${noun} match.`
                : `No recent ${noun}.`}
            </p>
          )}
          {onSaveHistory && (
            <button
              type="button"
              className="path-history-clear"
              disabled={!recent.length || disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSaveHistory([])}
            >
              Clear {kind} history
            </button>
          )}
        </div>
      )}
    </div>
  );
}
