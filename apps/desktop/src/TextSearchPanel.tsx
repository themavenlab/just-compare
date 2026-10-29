import { useEffect, useEffectEvent, useRef, useState } from "react";
import { native, textLines } from "./api";
import { WorkspaceDialog } from "./WorkspaceDialog";

type Side = "left" | "right";
type Scope = Side | "both";
type Direction = -1 | 1;
interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}
interface Match {
  side: Side;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
}
interface ReplacementPreview {
  changes: Partial<Record<Side, string>>;
  count: number;
  samples: { side: Side; line: number; before: string; after: string }[];
}

export function TextSearchPanel({
  texts,
  mode,
  query,
  onQueryChange,
  searchRequest,
  onModeChange,
  onClose,
  onNavigate,
  onReplace,
}: {
  texts: Record<Side, string>;
  mode: "find" | "replace" | "goto";
  query: string;
  onQueryChange: (query: string) => void;
  searchRequest: { token: number; direction: Direction } | null;
  onModeChange: (mode: "find" | "replace" | "goto") => void;
  onClose: () => void;
  onNavigate: (side: Side, from: number, to: number) => void;
  onReplace: (changes: Partial<Record<Side, string>>) => void;
}) {
  const [scope, setScope] = useState<Scope>("both");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [gotoSide, setGotoSide] = useState<Side>("left");
  const [gotoLine, setGotoLine] = useState("1");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<ReplacementPreview | null>(null);
  const lastMatch = useRef<Match | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    lastMatch.current = null;
  }, [query, scope, matchCase, wholeWord, regex]);

  function selectedSides() {
    return scope === "both" ? (["left", "right"] as const) : [scope];
  }

  async function findAll() {
    const options: SearchOptions = { matchCase, wholeWord, regex };
    const results = await Promise.all(
      selectedSides().map(async (side) => ({
        side,
        matches: await native("search_text", {
          text: texts[side],
          query,
          ...options,
        }),
      })),
    );
    return results.flatMap(({ side, matches }) =>
      matches.map(({ start, end, sourceStart, sourceEnd }) => ({
        side,
        start,
        end,
        sourceStart,
        sourceEnd,
      })),
    );
  }

  async function find(direction: Direction) {
    setError("");
    setStatus("");
    try {
      const matches = await findAll();
      if (!matches.length) {
        lastMatch.current = null;
        setStatus("No matches.");
        return null;
      }
      const previous = lastMatch.current;
      const previousIndex = previous
        ? matches.findIndex(
            (match) =>
              match.side === previous.side && match.start === previous.start,
          )
        : -1;
      const index =
        previousIndex < 0
          ? direction > 0
            ? 0
            : matches.length - 1
          : (previousIndex + direction + matches.length) % matches.length;
      const found = matches[index];
      if (!found) return null;
      lastMatch.current = found;
      onNavigate(found.side, found.start, found.end);
      setStatus(
        `Match ${index + 1} of ${matches.length} in the ${found.side} pane.`,
      );
      return found;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return null;
    }
  }
  const navigateFromShortcut = useEffectEvent((direction: Direction) => {
    void find(direction);
  });
  useEffect(() => {
    if (!searchRequest) return;
    const timer = window.setTimeout(
      () => navigateFromShortcut(searchRequest.direction),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [searchRequest]);

  async function replaceNext() {
    const found = await find(1);
    if (!found) return;
    const nextText =
      texts[found.side].slice(0, found.sourceStart) +
      replacement +
      texts[found.side].slice(found.sourceEnd);
    onReplace({ [found.side]: nextText });
    lastMatch.current = {
      ...found,
      end: found.start + replacement.length,
      sourceEnd: found.sourceStart + replacement.length,
    };
    setStatus(
      `Replaced one match in the ${found.side} pane. Undo is available.`,
    );
  }

  async function prepareReplaceAll() {
    setError("");
    setStatus("");
    try {
      const matches = await findAll();
      if (!matches.length) {
        setStatus("No matches to replace.");
        return;
      }
      const changes: Partial<Record<Side, string>> = {};
      for (const side of selectedSides()) {
        const sideMatches = matches.filter((match) => match.side === side);
        if (!sideMatches.length) continue;
        let nextText = texts[side];
        for (const match of [...sideMatches].reverse())
          nextText =
            nextText.slice(0, match.sourceStart) +
            replacement +
            nextText.slice(match.sourceEnd);
        changes[side] = nextText;
      }
      const samples = matches.slice(0, 5).map((match) => {
        const source = texts[match.side];
        const lineStart = Math.max(
          source.lastIndexOf("\n", match.sourceStart - 1),
          source.lastIndexOf("\r", match.sourceStart - 1),
        );
        const lineEndCandidates = [
          source.indexOf("\n", match.sourceEnd),
          source.indexOf("\r", match.sourceEnd),
        ].filter((position) => position >= 0);
        const lineEnd =
          lineEndCandidates.length > 0
            ? Math.min(...lineEndCandidates)
            : source.length;
        const before = source.slice(lineStart + 1, lineEnd);
        const localStart = match.sourceStart - lineStart - 1;
        const localEnd = match.sourceEnd - lineStart - 1;
        return {
          side: match.side,
          line: source.slice(0, match.sourceStart).split(/\r\n|\r|\n/).length,
          before,
          after:
            before.slice(0, localStart) + replacement + before.slice(localEnd),
        };
      });
      setPreview({ changes, count: matches.length, samples });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  function goToLine() {
    setError("");
    const number = Number(gotoLine);
    const editorText = texts[gotoSide].replace(/\r\n|\r/g, "\n");
    const lines = textLines(editorText);
    const lineCount = Math.max(lines.length, 1);
    if (!Number.isInteger(number) || number < 1 || number > lineCount) {
      setError(`Enter a line number from 1 to ${lineCount}.`);
      return;
    }
    const line = lines[number - 1];
    onNavigate(gotoSide, line?.start ?? 0, line?.start ?? 0);
    setStatus(`Moved to line ${number} in the ${gotoSide} pane.`);
  }

  return (
    <section
      className="text-search-panel"
      aria-label="Find, replace and line navigation"
    >
      <div className="search-tabs" role="tablist" aria-label="Text navigation">
        {(["find", "replace", "goto"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={mode === item}
            onClick={() => {
              onModeChange(item);
              if (item !== "goto") input.current?.focus();
            }}
          >
            {item === "goto"
              ? "Go to Line"
              : item === "find"
                ? "Find"
                : "Replace"}
          </button>
        ))}
        <button
          type="button"
          aria-label="Close Find and Replace"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {mode === "goto" ? (
        <form
          className="search-controls"
          onSubmit={(event) => {
            event.preventDefault();
            goToLine();
          }}
        >
          <label>
            Pane
            <select
              value={gotoSide}
              onChange={(event) => setGotoSide(event.target.value as Side)}
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label>
            Line
            <input
              aria-label="Go to line number"
              type="number"
              min="1"
              value={gotoLine}
              onChange={(event) => setGotoLine(event.target.value)}
            />
          </label>
          <button type="submit">Go</button>
        </form>
      ) : (
        <>
          <form
            className="search-controls"
            onSubmit={(event) => {
              event.preventDefault();
              void find(1);
            }}
          >
            <label>
              Find
              <input
                ref={input}
                aria-label="Find text"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </label>
            <label>
              Search in
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as Scope)}
              >
                <option value="both">Both panes</option>
                <option value="left">Left pane</option>
                <option value="right">Right pane</option>
              </select>
            </label>
            <button type="submit">Find Next</button>
            <button type="button" onClick={() => void find(-1)}>
              Find Previous
            </button>
          </form>
          {mode === "replace" && (
            <div className="search-controls">
              <label>
                Replace with
                <input
                  aria-label="Replace with"
                  value={replacement}
                  onChange={(event) => setReplacement(event.target.value)}
                />
              </label>
              <button type="button" onClick={() => void replaceNext()}>
                Replace Next
              </button>
              <button type="button" onClick={() => void prepareReplaceAll()}>
                Preview Replace All...
              </button>
            </div>
          )}
          <div className="search-options">
            <label>
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(event) => setMatchCase(event.target.checked)}
              />
              Match case
            </label>
            <label>
              <input
                type="checkbox"
                checked={wholeWord}
                onChange={(event) => setWholeWord(event.target.checked)}
              />
              Whole word
            </label>
            <label>
              <input
                type="checkbox"
                checked={regex}
                onChange={(event) => setRegex(event.target.checked)}
              />
              Regular expression
            </label>
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="metadata" role="status">
          {status}
        </p>
      )}
      {preview && (
        <WorkspaceDialog
          title="Review Replace All"
          onClose={() => setPreview(null)}
        >
          <div className="session-form">
            <p>
              Replace {preview.count} matches across{" "}
              {Object.keys(preview.changes).length === 2
                ? "both panes"
                : `the ${Object.keys(preview.changes)[0]} pane`}
              . Each affected pane receives one Undo step. Files are not saved.
            </p>
            <ul className="replace-preview">
              {preview.samples.map((sample, index) => (
                <li key={`${sample.side}-${sample.line}-${index}`}>
                  <strong>
                    {sample.side}, line {sample.line}
                  </strong>
                  <del>{sample.before || "(empty line)"}</del>
                  <ins>{sample.after || "(empty line)"}</ins>
                </li>
              ))}
            </ul>
            {preview.count > preview.samples.length && (
              <p className="metadata">
                Showing {preview.samples.length} of {preview.count} matches.
              </p>
            )}
            <footer className="dialog-actions">
              <button type="button" onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  onReplace(preview.changes);
                  setStatus(
                    `Replaced ${preview.count} matches. Undo is available; files are not saved.`,
                  );
                  setPreview(null);
                }}
              >
                Replace All
              </button>
            </footer>
          </div>
        </WorkspaceDialog>
      )}
    </section>
  );
}
