import { useState } from "react";
import type { DraftRecovery, Settings } from "./api";
import { Icon } from "./icons";
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
  const name =
    mode === "folder"
      ? "workflowFolder"
      : mode === "merge"
        ? "workflowMerge"
        : "workflowText";
  return <Icon name={name} className="workflow-icon" />;
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
  saveHistory,
  recoveries,
  recoveryReady,
  onSetRecovery,
  onRetryRecoveries,
  onRestoreRecovery,
  onDiscardRecovery,
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
  saveHistory: (
    comparisons: NonNullable<Settings["recentComparisons"]>,
  ) => void;
  recoveries: DraftRecovery[];
  recoveryReady: boolean;
  onSetRecovery: (enabled: boolean) => void;
  onRetryRecoveries: () => void;
  onRestoreRecovery: (record: DraftRecovery) => void;
  onDiscardRecovery: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [mode, setMode] = useState<Workflow>("text");
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [base, setBase] = useState("");
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const recentList = settings.recentComparisons ?? [];
  const modeLabel = { text: "Text", folder: "Folder", merge: "Merge" } as const;
  return (
    <section className="home-screen" aria-label="Home">
      <div className="home-main">
        <div className="home-hero">
          <h2>Start a comparison</h2>
          <p>
            Compare files and folders, merge three ways, and review every change
            before anything is written. Everything stays on this computer.
          </p>
        </div>
        <div className="launcher-grid">
          {launchers.map((item) => (
            <button
              key={item.mode}
              className="workflow-launcher"
              data-workflow={item.mode}
              aria-label={item.title}
              disabled={!ready || busy}
              title={item.description}
              onClick={() => openTab(item.mode)}
            >
              <WorkflowIcon mode={item.mode} />
              <span className="launcher-title">{item.title}</span>
              <span className="launcher-description">{item.description}</span>
            </button>
          ))}
        </div>
        <section className="home-panel" aria-labelledby="recent-heading">
          <div className="home-panel-heading">
            <h3 id="recent-heading">Recent comparisons</h3>
            <button
              className="ghost"
              disabled={busy || !ready || !recentList.length}
              onClick={() => saveHistory([])}
            >
              Clear comparison history
            </button>
          </div>
          {!recentList.length && (
            <p className="metadata empty-panel">
              Completed comparisons appear here.
            </p>
          )}
          {recentList.map(
            (comparison, index) =>
              matches(
                `${comparison.mode} ${comparison.left} ${comparison.right} ${comparison.base}`,
              ) && (
                <div className="session-item" key={index}>
                  <button
                    className="session-open"
                    disabled={busy}
                    title={`${comparison.mode}: ${comparison.left} / ${comparison.right}${comparison.base ? ` / base: ${comparison.base}` : ""}`}
                    onClick={() => openTab(comparison.mode, comparison)}
                  >
                    <span
                      className="session-kind"
                      data-kind={comparison.mode}
                      aria-hidden="true"
                    >
                      {modeLabel[comparison.mode]}
                    </span>
                    <span className="session-names">
                      {comparison.mode}: {comparison.left.split(/[\\/]/).at(-1)}{" "}
                      / {comparison.right.split(/[\\/]/).at(-1)}
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`Remove recent comparison ${index + 1}`}
                    title="Remove history only; source files are not deleted"
                    onClick={() =>
                      saveHistory(recentList.filter((_, i) => i !== index))
                    }
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ),
          )}
        </section>
      </div>
      <aside className="home-sidebar" aria-label="Sessions and recent paths">
        <div className="sidebar-heading">
          <strong>Sessions</strong>
          <button
            className="icon-button"
            title="Add a named session without opening files"
            aria-label="Add saved session"
            disabled={busy || !ready}
            onClick={() => setAdding(!adding)}
          >
            <Icon name="plus" />
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
            <div className="form-actions">
              <button
                className="primary"
                disabled={
                  busy || !name.trim() || settings.sessions.length >= 100
                }
              >
                Add session
              </button>
              <button type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
            {sessionError && (
              <p className="error" role="alert">
                {sessionError}
              </p>
            )}
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
                  className="session-open"
                  disabled={busy}
                  title={`${session.name}: ${session.left} / ${session.right}`}
                  onClick={() => openSession(session)}
                >
                  <Icon name="sessions" />
                  <span className="session-names">{session.name}</span>
                </button>
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={`Remove saved session ${session.name}`}
                  title="Remove this session from preferences; files are not deleted"
                  onClick={() =>
                    void saveSessions(
                      settings.sessions.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Icon name="close" />
                </button>
              </div>
            ),
        )}
        <h3>Draft recovery</h3>
        <div className="home-preferences">
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.recoverDrafts}
              disabled={busy || !ready}
              onChange={(event) => onSetRecovery(event.target.checked)}
            />
            Keep unsaved drafts for up to 7 days
          </label>
          <p className="metadata">
            Opt-in recovery is stored locally, unencrypted, in this app's
            configuration folder. It is not uploaded. Anyone with access to your
            OS account can read it. Restores open unsaved drafts and never write
            to source files. Records expire after 7 days; limits are 20
            workspaces and 64 MiB total.
          </p>
        </div>
        {settings.recoverDrafts && !recoveryReady && (
          <div>
            <p className="metadata" role="status">
              Recovery records have not been loaded.
            </p>
            <button disabled={busy} onClick={onRetryRecoveries}>
              Retry loading recoveries
            </button>
          </div>
        )}
        {settings.recoverDrafts && recoveryReady && (
          <>
            <h3>Recoverable drafts</h3>
            {!recoveries.length && (
              <p className="metadata">No recoverable drafts.</p>
            )}
            {recoveries.map((record) => (
              <div className="recovery-item" key={record.id}>
                <p
                  title={`${record.leftPath} / ${record.rightPath}${record.basePath ? ` / ${record.basePath}` : ""}`}
                >
                  {record.mode === "merge" ? "Merge" : "Text"} draft ·{" "}
                  {record.leftPath.split(/[\\/]/).at(-1) || "Untitled"} /{" "}
                  {record.rightPath.split(/[\\/]/).at(-1) || "Untitled"}
                </p>
                <p className="metadata">
                  Last saved{" "}
                  {new Date(record.updatedAt * 1000).toLocaleString()}
                </p>
                <div>
                  <button
                    disabled={busy}
                    onClick={() => onRestoreRecovery(record)}
                  >
                    Restore draft
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => onDiscardRecovery(record.id)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
        <h3>Preferences</h3>
        <div className="home-preferences">
          <label className="check-row">
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
          <div className="form-actions">
            <button
              title="Switch between light and dark appearance"
              onClick={() =>
                update((prior) => ({
                  ...prior,
                  theme: prior.theme === "light" ? "dark" : "light",
                }))
              }
            >
              <Icon name={settings.theme === "light" ? "moon" : "sun"} />
              Toggle theme
            </button>
            <button
              className="primary"
              disabled={busy || !ready}
              title="Persist current preferences, named sessions and recent paths"
              onClick={savePreferences}
            >
              Save preferences
            </button>
          </div>
          <p className="metadata">
            Most preferences persist when saved; drafts are stored only when
            crash recovery is enabled above.
          </p>
        </div>
      </aside>
    </section>
  );
}
