import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { defaults, native, type Settings } from "./api";
import { CommandMenu } from "./CommandMenu";
import { errorMessage } from "./comparison";
import { ComparisonWorkspace } from "./ComparisonWorkspace";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { HomeScreen } from "./HomeScreen";
import {
  sameSummary,
  sessionWorkflow,
  type SavedSession,
  type Workflow,
  type WorkspaceController,
  type WorkspaceSummary,
  type WorkspaceTab,
} from "./workbench";

const workflows = [
  ["text", "Text Compare"],
  ["folder", "Folder Compare"],
  ["merge", "3-Way Merge"],
] as const;

export function App() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [settingsAvailable, setSettingsAvailable] = useState(!isTauri());
  const [ready, setReady] = useState(!isTauri());
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [active, setActive] = useState<string | null>(tabs[0]?.id ?? null);
  const [owner, setOwner] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, WorkspaceSummary>>(
    {},
  );
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [confirmation, setConfirmation] = useState<{
    message: string;
    decide: (approved: boolean) => void;
  } | null>(null);
  const approvalPending = useRef(false);
  const confirmAction = useCallback((message: string): Promise<boolean> => {
    if (approvalPending.current)
      return Promise.reject(new Error("Another approval is already pending."));
    approvalPending.current = true;
    return new Promise((resolve) => {
      setConfirmation({
        message,
        decide: (approved) => {
          approvalPending.current = false;
          setConfirmation(null);
          resolve(approved);
        },
      });
    });
  }, []);
  const controllers = useRef(new Map<string, WorkspaceController>());
  const operation = useRef<string | null>(null);
  const previewOwner = useRef<string | null>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const latest = useRef({ active, tabs });
  useEffect(() => {
    latest.current = { active, tabs };
  }, [active, tabs]);
  const acquire = useCallback((id: string) => {
    if (operation.current) return false;
    operation.current = id;
    setOwner(id);
    return true;
  }, []);
  const release = useCallback((id: string) => {
    if (operation.current === id) {
      operation.current = null;
      setOwner(null);
    }
  }, []);
  const register = useCallback(
    (id: string, controller: WorkspaceController | null) => {
      if (controller) controllers.current.set(id, controller);
      else controllers.current.delete(id);
    },
    [],
  );
  const report = useCallback((id: string, summary: WorkspaceSummary) => {
    setSummaries((prior) =>
      sameSummary(prior[id], summary) ? prior : { ...prior, [id]: summary },
    );
  }, []);
  const discardPreview = useCallback((id: string) => {
    if (previewOwner.current === id) previewOwner.current = null;
  }, []);
  const claimPreview = useCallback(
    async (id: string) => {
      const previous = previewOwner.current;
      if (
        previous &&
        !(await confirmAction(
          "Replace the pending sync preview? The old preview will no longer be executable.",
        ))
      )
        return false;
      if (previous) controllers.current.get(previous)?.clearPreview();
      previewOwner.current = id;
      return true;
    },
    [confirmAction],
  );
  const diskChanged = useCallback((paths: string[]) => {
    for (const [id, controller] of controllers.current)
      if (id !== operation.current) controller.diskChanged(paths);
  }, []);
  const confirmGitExit = useCallback(
    async (id: string) => {
      if (
        ![...controllers.current].some(
          ([other, controller]) => other !== id && controller.dirty(),
        )
      )
        return true;
      return confirmAction(
        "Save and accept the Git merge, then close the app? Unsaved edits in other tabs will be discarded.",
      );
    },
    [confirmAction],
  );
  const openTab = useCallback(
    (
      mode: Workflow,
      paths: Partial<
        Pick<WorkspaceTab, "left" | "right" | "base" | "parent" | "folderRules">
      > = {},
    ) => {
      const tab: WorkspaceTab = {
        id: crypto.randomUUID(),
        mode,
        left: "",
        right: "",
        base: "",
        gitOutput: "",
        parent: null,
        ...paths,
      };
      setTabs((prior) => [...prior, tab]);
      setActive(tab.id);
    },
    [],
  );
  const openSession = useCallback(
    (session: SavedSession) => {
      try {
        const mode = sessionWorkflow(session.mode);
        if (mode === "merge" && !session.base)
          throw new Error(
            "This merge session has no base path; open the base explicitly.",
          );
        openTab(mode, {
          left: session.left,
          right: session.right,
          base: session.base ?? "",
          ...(session.folderRules ? { folderRules: session.folderRules } : {}),
        });
      } catch (failure) {
        setError(errorMessage(failure));
      }
    },
    [openTab],
  );
  async function saveHomeSessions(sessions: SavedSession[]) {
    if (!acquire("home-sessions")) {
      setError("Wait for the active operation to finish.");
      return false;
    }
    try {
      if (
        sessions.length < settings.sessions.length &&
        !(await confirmAction(
          "Remove this saved session? Source files and open tabs are not changed.",
        ))
      )
        return false;
      await native("write_settings", { settings: { ...settings, sessions } });
      setSettings((prior) => ({ ...prior, sessions }));
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      release("home-sessions");
    }
  }
  async function closeWindow() {
    const id = latest.current.active ?? "window-close";
    if (!acquire(id)) {
      setError(
        "Wait for the active operation to finish or cancel it before closing.",
      );
      return;
    }
    try {
      if (
        [...controllers.current.values()].some((controller) =>
          controller.dirty(),
        ) &&
        !(await confirmAction("Discard unsaved edits in all tabs and close?"))
      )
        return;
      await getCurrentWindow().destroy();
    } finally {
      release(id);
    }
  }
  async function closeTab(id: string) {
    const currentTabs = latest.current.tabs;
    const tab = currentTabs.find((item) => item.id === id);
    if (tab?.gitOutput) {
      await closeWindow();
      return;
    }
    if (!acquire(id)) {
      setError(
        "Wait for the active operation to finish or cancel it before closing a tab.",
      );
      return;
    }
    try {
      const controller = controllers.current.get(id);
      if (
        controller?.dirty() &&
        !(await confirmAction("Discard unsaved edits and close this tab?"))
      )
        return;
      if (
        previewOwner.current === id &&
        !(await confirmAction(
          "Discard this tab's pending sync preview and close?",
        ))
      )
        return;
      await controller?.dispose();
      discardPreview(id);
      controllers.current.delete(id);
      const index = currentTabs.findIndex((tab) => tab.id === id);
      setTabs((prior) => prior.filter((tab) => tab.id !== id));
      if (latest.current.active === id)
        setActive(
          currentTabs[index + 1]?.id ?? currentTabs[index - 1]?.id ?? null,
        );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      release(id);
    }
  }
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const cleanup: (() => void)[] = [];
    void (async () => {
      try {
        try {
          const initial = await native("read_settings");
          if (!disposed) {
            setSettings(initial);
            setSettingsAvailable(true);
          }
        } catch (failure) {
          if (!disposed) setError(errorMessage(failure));
        }
        const args = await native("launch_arguments");
        if (disposed) return;
        let tab: WorkspaceTab = {
          id: crypto.randomUUID(),
          mode: "text",
          left: "",
          right: "",
          base: "",
          gitOutput: "",
          parent: null,
        };
        if (args[0] === "git-diff" && args.length === 3)
          tab = { ...tab, left: args[1] ?? "", right: args[2] ?? "" };
        else if (args[0] === "git-merge" && args.length === 5)
          tab = {
            ...tab,
            mode: "merge",
            base: args[1] ?? "",
            left: args[2] ?? "",
            right: args[3] ?? "",
            gitOutput: args[4] ?? "",
          };
        else if (args[0] === "gui" && args.length === 3)
          tab = {
            ...tab,
            mode: "folder",
            left: args[1] ?? "",
            right: args[2] ?? "",
          };
        else if (args.length) throw new Error("Unsupported desktop arguments.");
        setTabs(args.length ? [tab] : []);
        setActive(args.length ? tab.id : null);
        setReady(true);
      } catch (failure) {
        if (!disposed) {
          setError(errorMessage(failure));
          setReady(true);
        }
      }
    })();
    void (async () => {
      try {
        const close = await getCurrentWindow().onCloseRequested(
          async (event) => {
            event.preventDefault();
            try {
              await closeWindow();
            } catch (failure) {
              setError(errorMessage(failure));
            }
          },
        );
        if (disposed) close();
        else cleanup.push(close);
        const drop = await getCurrentWindow().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          if (operation.current) {
            setError("Wait for the active operation before dropping paths.");
            return;
          }
          const id = latest.current.active;
          const controller = id ? controllers.current.get(id) : null;
          if (controller)
            void controller
              .drop(event.payload.paths)
              .catch((failure) => setError(errorMessage(failure)));
          else {
            const position = event.payload.position;
            const target = document
              .elementFromPoint(
                position.x / devicePixelRatio,
                position.y / devicePixelRatio,
              )
              ?.closest<HTMLElement>("[data-workflow]");
            const workflow = target?.dataset.workflow;
            if (
              workflow !== "text" &&
              workflow !== "folder" &&
              workflow !== "merge"
            ) {
              setError(
                "Drop paths onto a Home workflow icon to choose how they are opened.",
              );
              return;
            }
            const paths = event.payload.paths;
            const maximum = workflow === "merge" ? 3 : 2;
            if (paths.length < 1 || paths.length > maximum) {
              setError(`This workflow accepts one to ${maximum} paths.`);
              return;
            }
            openTab(workflow, {
              left: paths[workflow === "merge" ? 1 : 0] ?? "",
              right: paths[workflow === "merge" ? 2 : 1] ?? "",
              base: workflow === "merge" ? (paths[0] ?? "") : "",
            });
          }
        });
        if (disposed) drop();
        else cleanup.push(drop);
        const progress = await listen<[string, number]>(
          "operation-progress",
          (event) => {
            const id = operation.current;
            if (id)
              controllers.current
                .get(id)
                ?.progress(event.payload[0], event.payload[1]);
          },
        );
        if (disposed) progress();
        else cleanup.push(progress);
      } catch (failure) {
        if (!disposed) setError(errorMessage(failure));
      }
    })();
    return () => {
      disposed = true;
      for (const unlisten of cleanup) unlisten();
    };
    // Native listeners belong to the shell; they route through current tab/controller refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => {
    tabStrip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
      const name = event.key.toLowerCase();
      if (event.key !== "Tab" && name !== "w" && event.key !== "Enter") return;
      event.preventDefault();
      if (approvalPending.current) return;
      const state = latest.current;
      if (name === "w") {
        if (state.active) void closeTab(state.active);
      } else if (event.key === "Enter") {
        if (state.active) controllers.current.get(state.active)?.command("run");
      } else if (state.tabs.length) {
        const index = state.tabs.findIndex((tab) => tab.id === state.active);
        const next =
          index < 0
            ? event.shiftKey
              ? state.tabs.length - 1
              : 0
            : (index + (event.shiftKey ? -1 : 1) + state.tabs.length) %
              state.tabs.length;
        const id = state.tabs[next]?.id;
        if (id) {
          setActive(id);
          tabStrip.current
            ?.querySelector<HTMLElement>(`[data-tab="${id}"]`)
            ?.focus();
        }
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
    // Global shortcuts use the same current controllers as native shell events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function command(name: string) {
    if (active) controllers.current.get(active)?.command(name);
  }
  const blocked = !!owner;
  return (
    <div className="workbench-shell">
      <header className="shell-header sr-only">
        <h1>Compare Workbench</h1>
        <span>Phase 1 / local files</span>
      </header>
      <nav className="menubar" aria-label="Application commands">
        <CommandMenu
          label="File"
          commands={[
            ...workflows.map(([mode, label]) => ({
              label: `New ${label}`,
              run: () => openTab(mode),
              disabled: !ready || blocked,
            })),
            {
              label: "Open left...",
              run: () => command("browse:left"),
              disabled: !active || blocked,
            },
            {
              label: "Open right...",
              run: () => command("browse:right"),
              disabled: !active || blocked,
            },
            {
              label: "Save left",
              run: () => command("save:left"),
              disabled:
                !active ||
                blocked ||
                tabs.find((tab) => tab.id === active)?.mode === "folder",
            },
            {
              label: "Save right",
              run: () => command("save:right"),
              disabled:
                !active ||
                blocked ||
                tabs.find((tab) => tab.id === active)?.mode === "folder",
            },
            {
              label: "Close tab",
              run: () => {
                if (active) void closeTab(active);
              },
              disabled: !active || blocked,
            },
            {
              label: "Save merge output",
              run: () => command("save-output"),
              disabled: blocked || !active || !summaries[active]?.canSaveOutput,
            },
          ]}
        />
        <CommandMenu
          label="Edit"
          commands={[
            {
              label: "Undo left",
              run: () => command("undo:left"),
              disabled: !active || blocked || !summaries[active]?.undoLeft,
            },
            {
              label: "Undo right",
              run: () => command("undo:right"),
              disabled: !active || blocked || !summaries[active]?.undoRight,
            },
          ]}
        />
        <CommandMenu
          label="Session"
          commands={[
            {
              label: "New Text Compare",
              run: () => openTab("text"),
              disabled: blocked,
            },
            {
              label: "New Folder Compare",
              run: () => openTab("folder"),
              disabled: blocked,
            },
            {
              label: "New 3-Way Merge",
              run: () => openTab("merge"),
              disabled: blocked,
            },
            {
              label: "Save Session...",
              run: () => command("save-session"),
              disabled: !active || blocked || !settingsAvailable,
            },
            {
              label: "Saved Sessions...",
              run: () => command("sessions"),
              disabled: !active || blocked,
            },
            {
              label: "File-format Profiles...",
              run: () => command("profiles"),
              disabled: !active || blocked,
            },
            ...settings.sessions.map((session) => ({
              label: `Open ${session.name}`,
              run: () => openSession(session),
              disabled: blocked,
            })),
          ]}
        />
        <CommandMenu
          label="Actions"
          commands={[
            {
              label: "Compare / scan / merge",
              run: () => command("run"),
              disabled: !active || blocked,
            },
            {
              label: "Swap sides",
              run: () => command("swap"),
              disabled: !active || blocked,
            },
            {
              label: "Previous difference",
              run: () => command("previous"),
              disabled: !active || blocked || !summaries[active]?.differences,
            },
            {
              label: "Next difference",
              run: () => command("next"),
              disabled: !active || blocked || !summaries[active]?.differences,
            },
          ]}
        />
        <CommandMenu
          label="View"
          commands={[
            {
              label: "Aligned view and range details",
              run: () => command("details"),
              disabled: tabs.find((tab) => tab.id === active)?.mode !== "text",
            },
            {
              label: "Difference legend",
              run: () => command("legend"),
              disabled: tabs.find((tab) => tab.id === active)?.mode !== "text",
            },
            {
              label: "Comparison rules",
              run: () => command("rules"),
              disabled:
                !active ||
                tabs.find((tab) => tab.id === active)?.mode === "merge",
            },
            {
              label: "Preferences",
              run: () => command("preferences"),
              disabled: !active,
            },
            {
              label: "Toggle theme",
              run: () =>
                setSettings((prior) => ({
                  ...prior,
                  theme: prior.theme === "light" ? "dark" : "light",
                })),
            },
          ]}
        />
        <CommandMenu
          label="Help"
          commands={[
            {
              label: "Keyboard shortcuts",
              run: () =>
                setInfo(
                  "Shortcuts: Ctrl+Enter run; Ctrl+S save focused editor; Alt+Up/Down differences; Ctrl+Tab switch tabs; Ctrl+W close tab; arrow keys navigate menus and folder rows.",
                ),
            },
            {
              label: "About Phase 1",
              run: () =>
                setInfo(
                  "Original local text/folder/merge workbench. Copies in text edit drafts; folder actions require previews. No uploads. Not complete Beyond Compare parity.",
                ),
            },
          ]}
        />
        <div className="new-comparisons" aria-label="New comparison">
          {workflows.map(([mode, label]) => (
            <button
              key={mode}
              disabled={!ready || blocked}
              onClick={() => openTab(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>
      <div className="tabbar">
        <button onClick={() => setActive(null)} aria-pressed={active === null}>
          Home
        </button>
        <button
          aria-label="Scroll tabs left"
          onClick={() => tabStrip.current?.scrollBy({ left: -240 })}
        >
          {"\u2039"}
        </button>
        <div
          className="tabstrip"
          role="tablist"
          aria-label="Comparisons"
          ref={tabStrip}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const index = tabs.findIndex((tab) => tab.id === active);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
            const id = tabs[next]?.id;
            if (id) {
              setActive(id);
              tabStrip.current
                ?.querySelector<HTMLElement>(`[data-tab="${id}"]`)
                ?.focus();
            }
          }}
        >
          {tabs.map((tab) => (
            <div
              className={`tab ${active === tab.id ? "active-tab" : ""}`}
              key={tab.id}
            >
              <button
                role="tab"
                id={`tab-${tab.id}`}
                data-tab={tab.id}
                aria-controls={`panel-${tab.id}`}
                aria-selected={active === tab.id}
                tabIndex={active === tab.id ? 0 : -1}
                title={`${workflows.find(([mode]) => mode === tab.mode)?.[1]}: ${summaries[tab.id]?.title ?? "Loading"}`}
                onClick={() => setActive(tab.id)}
              >
                <span className="tab-kind">
                  {tab.mode === "folder"
                    ? "Folder"
                    : tab.mode === "merge"
                      ? "Merge"
                      : "Text"}
                </span>
                {summaries[tab.id]?.error ? "! " : ""}
                {summaries[tab.id]?.dirty ? "* " : ""}
                {summaries[tab.id]?.title ?? "Loading"}
              </button>
              <button
                className="tab-close"
                aria-label={`Close ${summaries[tab.id]?.title ?? "comparison"}`}
                disabled={blocked}
                onClick={() => void closeTab(tab.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>
        <button
          aria-label="Scroll tabs right"
          onClick={() => tabStrip.current?.scrollBy({ left: 240 })}
        >
          {"\u203a"}
        </button>
      </div>
      {error && (
        <div className="shell-message" role="alert">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {owner && owner !== active && (
        <div className="background-job" role="status">
          {summaries[owner]?.title}: {summaries[owner]?.status ?? "Working..."}
          <button
            onClick={() => {
              setActive(owner);
            }}
          >
            Show operation
          </button>
          <button
            onClick={() =>
              void controllers.current
                .get(owner)
                ?.cancel()
                .catch((failure) => setError(errorMessage(failure)))
            }
          >
            Cancel operation
          </button>
        </div>
      )}
      {info && (
        <div className="shell-message" role="status">
          {info}
          <button onClick={() => setInfo("")}>Dismiss help</button>
        </div>
      )}
      {tabs
        .filter((tab) => tab.id !== active && summaries[tab.id]?.error)
        .map((tab) => (
          <div className="shell-message" role="alert" key={tab.id}>
            {summaries[tab.id]?.title}: {summaries[tab.id]?.error}
            <button onClick={() => setActive(tab.id)}>
              Show failed operation
            </button>
          </div>
        ))}
      <div className="workspace-host">
        {active === null && (
          <HomeScreen
            settings={settings}
            ready={ready && settingsAvailable}
            busy={blocked}
            update={setSettings}
            openTab={openTab}
            openSession={openSession}
            saveSessions={saveHomeSessions}
            savePreferences={() => {
              void native("write_settings", { settings })
                .then(() => setInfo("Preferences saved."))
                .catch((failure) => setError(errorMessage(failure)));
            }}
          />
        )}
        {tabs.map((tab) => (
          <section
            key={tab.id}
            id={`panel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab.id}`}
            className="workspace-slot"
            aria-hidden={active !== tab.id}
            inert={active !== tab.id}
            style={{ visibility: active === tab.id ? "visible" : "hidden" }}
          >
            {tab.parent && tabs.some((parent) => parent.id === tab.parent) && (
              <button
                className="return-folder"
                onClick={() => setActive(tab.parent)}
              >
                Return to folder comparison
              </button>
            )}
            <ComparisonWorkspace
              tab={tab}
              onHome={() => setActive(null)}
              confirmGitExit={confirmGitExit}
              sharedSettings={settings}
              settingsReady={settingsAvailable}
              updateSettings={setSettings}
              globalBusy={blocked}
              active={active === tab.id}
              acquire={acquire}
              release={release}
              register={register}
              report={report}
              openTab={openTab}
              openSession={openSession}
              claimPreview={claimPreview}
              discardPreview={discardPreview}
              diskChanged={diskChanged}
              confirmAction={confirmAction}
            />
          </section>
        ))}
      </div>
      {confirmation && (
        <ConfirmationDialog
          message={confirmation.message}
          decide={confirmation.decide}
        />
      )}
    </div>
  );
}
