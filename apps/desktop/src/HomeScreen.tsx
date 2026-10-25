import { useState } from "react";
import type { Settings } from "./api";
import type { SavedSession, Workflow } from "./workbench";

const launchers = [
  {
    mode: "folder",
    title: "Folder Compare",
    description:
      "Compare local folders and preview safe copies, moves and synchronization.",
  },
  {
    mode: "text",
    title: "Text Compare",
    description:
      "Compare and edit two text files, navigate changes and copy differences.",
  },
  {
    mode: "merge",
    title: "3-Way Merge",
    description:
      "Resolve changes against a common ancestor and save a reviewed output.",
  },
] as const;

export function WorkflowIcon({ mode }: { mode: Workflow }) {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      className="workflow-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      {mode === "folder" ? (
        <>
          <path d="M5 14V8h14l5 6h19v27H5z" />
          <path d="M5 19h38M16 28h16m-5-5 5 5-5 5" />
        </>
      ) : (
        <>
          <path d="M8 5h23l9 9v29H8zM31 5v10h9M15 22h18M15 28h18M15 34h11" />
          {mode === "merge" && <path d="m4 19 8 7-8 7m40-14-8 7 8 7" />}
        </>
      )}
    </svg>
  );
}

export function HomeScreen({
  settings,
  ready,
  busy,
  update,
  openTab,
  openSession,
  savePreferences,
  saveSessions,
}: {
  settings: Settings;
  ready: boolean;
  busy: boolean;
  update: (update: (prior: Settings) => Settings) => void;
  openTab: (
    mode: Workflow,
    paths?: { left?: string; right?: string; base?: string },
  ) => void;
  openSession: (session: SavedSession) => void;
  savePreferences: () => void;
  saveSessions: (sessions: SavedSession[]) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [mode, setMode] = useState<Workflow>("text");
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [base, setBase] = useState("");
  const [recentMode, setRecentMode] = useState<Workflow>("text");
  const [recentSide, setRecentSide] = useState<"left" | "right" | "base">(
    "left",
  );
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  return (
    <section className="home-screen" aria-label="Home">
      <aside className="home-sidebar" aria-label="Sessions and recent paths">
        <div className="sidebar-heading">
          <strong>Sessions</strong>
          <button
            title="Add a named session without opening files"
            aria-label="Add saved session"
            disabled={busy || !ready}
            onClick={() => setAdding(!adding)}
          >
            +
          </button>
        </div>
        <label className="session-search">
          <span className="sr-only">Search sessions and recent paths</span>
          <input
            type="search"
            placeholder="Search sessions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {adding && (
          <form
            className="session-create"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                !name.trim() ||
                settings.sessions.some(
                  (session) =>
                    session.name.toLowerCase() === name.trim().toLowerCase(),
                )
              ) {
                setSessionError("Enter a unique, non-empty session name.");
                return;
              }
              const saved = await saveSessions([
                ...settings.sessions,
                {
                  name: name.trim(),
                  mode,
                  left,
                  right,
                  base: mode === "merge" ? base : "",
                },
              ]);
              if (!saved) return;
              setAdding(false);
              setName("");
              setSessionError("");
            }}
          >
            <label>
              Name
              <input
                required
                maxLength={256}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Workflow
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Workflow)}
              >
                {launchers.map((item) => (
                  <option key={item.mode} value={item.mode}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Left path
              <input
                required
                value={left}
                onChange={(e) => setLeft(e.target.value)}
              />
            </label>
            <label>
              Right path
              <input
                required
                value={right}
                onChange={(e) => setRight(e.target.value)}
              />
            </label>
            {mode === "merge" && (
              <label>
                Base path
                <input
                  required
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                />
              </label>
            )}
            <button
              disabled={busy || !name.trim() || settings.sessions.length >= 100}
            >
              Add session
            </button>
            {sessionError && (
              <p className="error" role="alert">
                {sessionError}
              </p>
            )}
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </form>
        )}
        <h3>Saved sessions</h3>
        {settings.sessions.length === 0 && (
          <p className="metadata">No saved sessions.</p>
        )}
        {settings.sessions.map(
          (session, index) =>
            matches(session.name) && (
              <div className="session-item" key={`${index}-${session.name}`}>
                <button
                  disabled={busy}
                  title={`${session.name}: ${session.left} / ${session.right}`}
                  onClick={() => openSession(session)}
                >
                  {session.name}
                </button>
                <button
                  disabled={busy}
                  aria-label={`Remove saved session ${session.name}`}
                  title="Remove this session from preferences; files are not deleted"
                  onClick={() =>
                    void saveSessions(
                      settings.sessions.filter((_, i) => i !== index),
                    )
                  }
                >
                  −
                </button>
              </div>
            ),
        )}
        <h3>Recent paths</h3>
        <div className="recent-target">
          <label>
            Open as
            <select
              value={recentMode}
              onChange={(e) => {
                setRecentMode(e.target.value as Workflow);
                if (e.target.value !== "merge") setRecentSide("left");
              }}
            >
              {launchers.map((item) => (
                <option key={item.mode} value={item.mode}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Input
            <select
              value={recentSide}
              onChange={(e) =>
                setRecentSide(e.target.value as "left" | "right" | "base")
              }
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
              {recentMode === "merge" && <option value="base">Base</option>}
            </select>
          </label>
        </div>
        {settings.recent.length === 0 && (
          <p className="metadata">Opened files appear here.</p>
        )}
        {settings.recent.map(
          (path) =>
            matches(path) && (
              <div className="session-item" key={path}>
                <button
                  disabled={busy}
                  title={`Open ${path} as ${recentSide} input`}
                  onClick={() => openTab(recentMode, { [recentSide]: path })}
                >
                  {path.split(/[\\/]/).at(-1) || path}
                </button>
                <button
                  disabled={busy}
                  aria-label={`Remove recent path ${path}`}
                  title="Remove this recent entry; the file is not deleted"
                  onClick={() =>
                    update((prior) => ({
                      ...prior,
                      recent: prior.recent.filter((item) => item !== path),
                    }))
                  }
                >
                  −
                </button>
              </div>
            ),
        )}
        <div className="home-preferences">
          <label>
            <input
              type="checkbox"
              checked={settings.contentComparison?.prompt !== false}
              onChange={(event) =>
                update((prior) => ({
                  ...prior,
                  contentComparison: {
                    method: prior.contentComparison?.method ?? "rules",
                    showResults: prior.contentComparison?.showResults ?? true,
                    prompt: event.target.checked,
                  },
                }))
              }
            />
            Ask before comparing selected contents
          </label>
          <button
            disabled={busy || !ready}
            title="Persist current preferences, named sessions and recent paths"
            onClick={savePreferences}
          >
            Save preferences
          </button>
          <button
            title="Switch between light and dark appearance"
            onClick={() =>
              update((prior) => ({
                ...prior,
                theme: prior.theme === "light" ? "dark" : "light",
              }))
            }
          >
            Toggle theme
          </button>
          <p className="metadata">
            Session changes persist when you save preferences. File contents and
            unsaved drafts are not stored.
          </p>
        </div>
      </aside>
      <div className="home-launchers">
        <p>Choose a workspace to begin, or drop paths onto its icon.</p>
        <div className="launcher-grid">
          {launchers.map((item) => (
            <button
              key={item.mode}
              className="workflow-launcher"
              data-workflow={item.mode}
              disabled={!ready || busy}
              title={item.description}
              onClick={() => openTab(item.mode)}
            >
              <WorkflowIcon mode={item.mode} />
              <span>{item.title}</span>
            </button>
          ))}
        </div>
        <p className="home-note">
          Local files. Independent workspaces. Explicit saves.
        </p>
      </div>
    </section>
  );
}
