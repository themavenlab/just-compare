import { useId, useState } from "react";
import { Icon } from "./icons";
import { plainPath } from "./workbench";

export function FolderPathInput({
  side,
  value,
  recent,
  disabled,
  change,
  choose,
  onSaveHistory,
}: {
  side: "left" | "right";
  value: string;
  recent: string[];
  disabled: boolean;
  change: (path: string) => void;
  choose: (path: string) => void;
  onSaveHistory: (paths: string[]) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = recent.filter((path) =>
    path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  function select(path: string) {
    setOpen(false);
    choose(path);
  }
  return (
    <div
      className="folder-path-input"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <div className="folder-path-field">
        <input
          role="combobox"
          aria-label={`${side} path`}
          aria-expanded={open}
          aria-controls={id}
          aria-autocomplete="list"
          name={`${side}-path`}
          autoComplete="off"
          spellCheck={false}
          placeholder="Choose a folder or paste its path..."
          value={plainPath(value)}
          disabled={disabled}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setIndex(0);
            } else if (event.key === "Enter") {
              event.preventDefault();
              select(plainPath(value));
            }
          }}
        />
        <button
          type="button"
          aria-label={`Recent ${side} folders`}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            setOpen(!open);
            setQuery("");
            setIndex(0);
          }}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      {open && (
        <div className="folder-history">
          <input
            autoFocus
            aria-label={`Filter recent ${side} folders`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            aria-controls={id}
            aria-activedescendant={
              matches[index] ? `${id}-${index}` : undefined
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((prior) =>
                  Math.max(
                    0,
                    Math.min(
                      matches.length - 1,
                      prior + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              } else if (event.key === "Enter" && matches[index]) {
                event.preventDefault();
                select(matches[index]);
              }
            }}
          />
          <div role="listbox" aria-label={`Recent ${side} folders`} id={id}>
            {matches.map((path, position) => (
              <div className="folder-history-row" key={path}>
                <button
                  role="option"
                  id={`${id}-${position}`}
                  aria-selected={index === position}
                  title={path}
                  onClick={() => select(path)}
                >
                  {plainPath(path)}
                </button>
                <button
                  aria-label={`Remove recent folder ${path}`}
                  onClick={() =>
                    onSaveHistory(recent.filter((item) => item !== path))
                  }
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
          {!matches.length && <p>No recent folders.</p>}
          <button
            disabled={!recent.length || disabled}
            onClick={() => onSaveHistory([])}
          >
            Clear folder history
          </button>
        </div>
      )}
    </div>
  );
}
