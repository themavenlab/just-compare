import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { defaults, native, type DraftRecovery, type Settings } from "./api";
import { errorMessage } from "./comparison";
import { ComparisonWorkspace } from "./ComparisonWorkspace";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { HomeScreen, WorkflowIcon } from "./HomeScreen";
import { Icon } from "./icons";
import {
  fileName,
  sameSummary,
  sessionWorkflow,
  type SavedSession,
  type Workflow,
  type WorkspaceController,
  type WorkspaceSummary,
  type WorkspaceTab,
} from "./workbench";
import { WorkspaceDialog } from "./WorkspaceDialog";

const workflows = [
  ["text", "Text Compare"],
  ["folder", "Folder Compare"],
  ["merge", "3-Way Merge"],
] as const;
const recoveryRetentionSeconds = 7 * 24 * 60 * 60;

function recoveryFingerprint(records: DraftRecovery[]) {
  return JSON.stringify(
    records
      .map(
        ({
          id,
          mode,
          leftPath,
          rightPath,
          basePath,
          leftText,
          rightText,
          baseText,
          output,
          choices,
        }) => ({
          id,
          mode,
          leftPath,
          rightPath,
          basePath,
          leftText,
          rightText,
          baseText,
          output,
          choices,
        }),
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [settingsAvailable, setSettingsAvailable] = useState(!isTauri());
  const [recoveries, setRecoveries] = useState<DraftRecovery[]>([]);
  const [recoveryReady, setRecoveryReady] = useState(!isTauri());
  const [ready, setReady] = useState(!isTauri());
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [active, setActive] = useState<string | null>(tabs[0]?.id ?? null);
  const [owner, setOwner] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, WorkspaceSummary>>(
    {},
  );
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [newTabChooser, setNewTabChooser] = useState(false);
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
  const recoveriesRef = useRef(recoveries);
  const recoveryFingerprintRef = useRef("");
  const recoveryWriteAt = useRef(0);
  const recoveryBusy = useRef(false);
  const operation = useRef<string | null>(null);
  const previewOwner = useRef<string | null>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const latest = useRef({
    active,
    tabs,
    recoverDrafts: settings.recoverDrafts,
    recoveryReady,
    ready,
    blocked: !!owner,
  });
  useLayoutEffect(() => {
    latest.current = {
      active,
      tabs,
      recoverDrafts: settings.recoverDrafts,
      recoveryReady,
      ready,
      blocked: !!owner,
    };
  }, [active, tabs, settings.recoverDrafts, recoveryReady, ready, owner]);
  useEffect(() => {
    recoveriesRef.current = recoveries;
  }, [recoveries]);
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
      if (controller) {
        controllers.current.set(id, controller);
        const recovery = controller.recoverySnapshot();
        if (recovery) {
          const pending = recoveriesRef.current.filter(
            (record) => record.id !== recovery.id,
          );
          if (pending.length !== recoveriesRef.current.length) {
            recoveriesRef.current = pending;
            setRecoveries(pending);
          }
        }
      } else controllers.current.delete(id);
    },
    [],
  );
  const report = useCallback((id: string, summary: WorkspaceSummary) => {
    setSummaries((prior) =>
      sameSummary(prior[id], summary) ? prior : { ...prior, [id]: summary },
    );
  }, []);
  const persistRecoveryRecords = useCallback(
    async (records: DraftRecovery[], liveIds: Set<string>) => {
      const fingerprint = recoveryFingerprint(records);
      if (
        fingerprint === recoveryFingerprintRef.current &&
        (liveIds.size === 0 || Date.now() - recoveryWriteAt.current < 60_000)
      )
        return;
      if (recoveryBusy.current)
        throw new Error(
          "Draft recovery is already being updated; retry shortly.",
        );
      recoveryBusy.current = true;
      try {
        const saved = await native("save_recoveries", { recoveries: records });
        recoveryFingerprintRef.current = recoveryFingerprint(saved);
        recoveryWriteAt.current = Date.now();
        const pending = saved.filter((record) => !liveIds.has(record.id));
        recoveriesRef.current = pending;
        setRecoveries(pending);
      } finally {
        recoveryBusy.current = false;
      }
    },
    [],
  );
  const collectRecoveryRecords = useCallback((excludeTabId?: string) => {
    const now = Date.now() / 1000;
    const records = new Map(
      recoveriesRef.current
        .filter((record) => now - record.updatedAt < recoveryRetentionSeconds)
        .map((record) => [record.id, record]),
    );
    const liveIds = new Set<string>();
    for (const [tabId, controller] of controllers.current) {
      if (tabId === excludeTabId) continue;
      const record = controller.recoverySnapshot();
      if (record) {
        records.set(record.id, record);
        liveIds.add(record.id);
      }
    }
    return {
      records: [...records.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      liveIds,
    };
  }, []);
  useEffect(() => {
    if (
      !settings.recoverDrafts ||
      !settingsAvailable ||
      !ready ||
      !recoveryReady
    )
      return;
    const timer = window.setInterval(() => {
      if (recoveryBusy.current || operation.current) return;
      const inventory = collectRecoveryRecords();
      void persistRecoveryRecords(inventory.records, inventory.liveIds).catch(
        (failure) => setError(errorMessage(failure)),
      );
    }, 1500);
    return () => window.clearInterval(timer);
  }, [
    settings.recoverDrafts,
    settingsAvailable,
    ready,
    recoveryReady,
    collectRecoveryRecords,
    persistRecoveryRecords,
  ]);
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
  const diskChanged = useCallback((paths: string[], refreshFolders = false) => {
    for (const [id, controller] of controllers.current)
      if (id !== operation.current)
        controller.diskChanged(paths, refreshFolders);
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
        Pick<
          WorkspaceTab,
          | "left"
          | "right"
          | "base"
          | "parent"
          | "folderRules"
          | "sessionName"
          | "recoveryId"
          | "recovery"
        >
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
          sessionName: session.name,
          ...(session.folderRules ? { folderRules: session.folderRules } : {}),
        });
      } catch (failure) {
        setError(errorMessage(failure));
      }
    },
    [openTab],
  );
  const setTabSessionName = useCallback((id: string, name: string | null) => {
    setTabs((prior) =>
      prior.map((tab) => {
        if (tab.id !== id) return tab;
        const updated = { ...tab };
        if (name) updated.sessionName = name;
        else delete updated.sessionName;
        return updated;
      }),
    );
  }, []);
  const renameSessionTabs = useCallback(
    (previous: string, next: string | null) => {
      setTabs((prior) =>
        prior.map((tab) => {
          if (tab.sessionName !== previous) return tab;
          const updated = { ...tab };
          if (next) updated.sessionName = next;
          else delete updated.sessionName;
          return updated;
        }),
      );
    },
    [],
  );
  const handleShell = useCallback(
    async (args: string[]) => {
      if (!args.length) return;
      if (args[0] === "gui" && args.length === 3) {
        openTab("folder", { left: args[1] ?? "", right: args[2] ?? "" });
        return;
      }
      const action = await native("shell_action", { args });
      if (action.kind === "selected")
        setInfo(
          `Selected for Compare: ${action.path}. Right-click another item of the same type and choose Compare to ${fileName(action.path)}.`,
        );
      else openTab(action.mode, { left: action.left, right: action.right });
    },
    [openTab],
  );
  async function setDraftRecovery(enabled: boolean) {
    if (!acquire("draft-recovery")) {
      setError("Wait for the active operation to finish.");
      return;
    }
    let ownsRecoveryLock = false;
    try {
      const prompt = enabled
        ? "Enable local crash recovery? Unsaved text and non-Git merge drafts will be written to this app's configuration directory for up to seven days. They are not encrypted or uploaded; anyone with access to your OS account can read them."
        : "Disable crash recovery and delete the locally stored recovery drafts?";
      if (!(await confirmAction(prompt))) return;
      if (recoveryBusy.current)
        throw new Error(
          "Draft recovery is already being updated; retry shortly.",
        );
      recoveryBusy.current = true;
      ownsRecoveryLock = true;
      if (enabled) setRecoveryReady(false);
      const updated = await native("set_draft_recovery", { enabled });
      setSettings((prior) => ({
        ...prior,
        recoverDrafts: updated.recoverDrafts,
      }));
      if (enabled) {
        const stored = await native("load_recoveries");
        recoveriesRef.current = stored;
        setRecoveries(stored);
        recoveryFingerprintRef.current = recoveryFingerprint(stored);
        setRecoveryReady(true);
      } else {
        recoveriesRef.current = [];
        setRecoveries([]);
        recoveryFingerprintRef.current = recoveryFingerprint([]);
        setRecoveryReady(true);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      if (ownsRecoveryLock) recoveryBusy.current = false;
      release("draft-recovery");
    }
  }
  async function retryLoadRecoveries() {
    if (recoveryBusy.current) return;
    recoveryBusy.current = true;
    try {
      const stored = await native("load_recoveries");
      recoveriesRef.current = stored;
      setRecoveries(stored);
      recoveryFingerprintRef.current = recoveryFingerprint(stored);
      setRecoveryReady(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      recoveryBusy.current = false;
    }
  }
  async function discardRecovery(id: string) {
    if (!acquire("discard-recovery")) {
      setError("Wait for the active operation to finish.");
      return;
    }
    let ownsRecoveryLock = false;
    try {
      if (!(await confirmAction("Discard this recovered draft?"))) return;
      if (recoveryBusy.current)
        throw new Error(
          "Draft recovery is already being updated; retry shortly.",
        );
      recoveryBusy.current = true;
      ownsRecoveryLock = true;
      const stored = await native("discard_recovery", { id });
      recoveryFingerprintRef.current = recoveryFingerprint(stored);
      const liveIds = new Set(
        [...controllers.current.values()]
          .map((controller) => controller.recoverySnapshot()?.id)
          .filter((value): value is string => value !== undefined),
      );
      const pending = stored.filter((record) => !liveIds.has(record.id));
      recoveriesRef.current = pending;
      setRecoveries(pending);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      if (ownsRecoveryLock) recoveryBusy.current = false;
      release("discard-recovery");
    }
  }
  function restoreRecovery(record: DraftRecovery) {
    openTab(record.mode, {
      left: record.leftPath,
      right: record.rightPath,
      base: record.basePath,
      recoveryId: record.id,
      recovery: record,
    });
  }
  async function changeExplorerIntegration(enabled: boolean | null) {
    if (!acquire("explorer-integration")) {
      setError("Wait for the active operation to finish.");
      return;
    }
    try {
      if (
        enabled !== null &&
        !(await confirmAction(
          enabled
            ? "Add Just Compare right-click commands for this Windows user? Windows 11 shows them under Show more options. No administrator access or file associations are changed."
            : "Remove this installation's Explorer commands and clear its selected compare path? Source files and open tabs are unchanged.",
        ))
      )
        return;
      const installed = await native("explorer_integration", { enabled });
      setInfo(
        installed
          ? "Explorer integration is enabled for this executable."
          : "Explorer integration is not enabled for this executable.",
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      release("explorer-integration");
    }
  }
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
      const retained = new Set(
        sessions.map((session) => session.name.toLowerCase()),
      );
      for (const session of settings.sessions)
        if (!retained.has(session.name.toLowerCase()))
          renameSessionTabs(session.name, null);
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
      if (latest.current.recoverDrafts && latest.current.recoveryReady) {
        const inventory = collectRecoveryRecords();
        await persistRecoveryRecords(inventory.records, inventory.liveIds);
      }
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
      if (settings.recoverDrafts && recoveryReady) {
        const inventory = collectRecoveryRecords(id);
        await persistRecoveryRecords(inventory.records, inventory.liveIds);
      }
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
            if (initial.recoverDrafts) {
              const stored = await native("load_recoveries");
              if (disposed) return;
              recoveriesRef.current = stored;
              setRecoveries(stored);
              recoveryFingerprintRef.current = recoveryFingerprint(stored);
            } else {
              recoveryFingerprintRef.current = recoveryFingerprint([]);
            }
            setRecoveryReady(true);
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
        else if (args.length && !args[0]?.startsWith("shell-"))
          throw new Error("Unsupported desktop arguments.");
        const shell = args[0]?.startsWith("shell-");
        setTabs(args.length && !shell ? [tab] : []);
        setActive(args.length && !shell ? tab.id : null);
        if (shell) await handleShell(args);
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
    if (!isTauri() || !ready) return;
    let disposed = false;
    let draining = false;
    const cleanup: (() => void)[] = [];
    const drain = async () => {
      if (draining || disposed) return;
      draining = true;
      try {
        for (;;) {
          const requests = await native("take_shell_requests", {});
          if (!requests.length || disposed) break;
          for (const args of requests) {
            try {
              await handleShell(args);
            } catch (failure) {
              setError(errorMessage(failure));
            }
          }
        }
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        draining = false;
      }
    };
    void (async () => {
      try {
        const unlisten = await listen("shell-requests", () => {
          void drain();
        });
        if (disposed) {
          unlisten();
          return;
        }
        cleanup.push(unlisten);
        const errors = await listen<string>("shell-error", (event) =>
          setError(event.payload),
        );
        if (disposed) {
          errors();
          return;
        }
        cleanup.push(errors);
        await drain();
      } catch (failure) {
        setError(errorMessage(failure));
      }
    })();
    return () => {
      disposed = true;
      for (const unlisten of cleanup) unlisten();
    };
  }, [ready, handleShell]);
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
      if (event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("dialog"))
        return;
      if (event.key === "F5") {
        event.preventDefault();
        if (latest.current.active)
          controllers.current.get(latest.current.active)?.command("run");
        return;
      }
      if (event.key === "F6") {
        const workspace = document.querySelector<HTMLElement>(
          '.workspace-slot[aria-hidden="false"]',
        );
        if (!workspace) return;
        const focused = document.activeElement?.closest<HTMLElement>(
          '.cm-content[aria-label="Left text"], .cm-content[aria-label="Right text"]',
        );
        const nextLabel =
          focused?.getAttribute("aria-label") === "Left text"
            ? "Right text"
            : "Left text";
        const next = workspace.querySelector<HTMLElement>(
          `.cm-content[aria-label="${nextLabel}"]`,
        );
        if (next) {
          event.preventDefault();
          next.focus();
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const name = event.key.toLowerCase();
      if (
        event.key !== "Tab" &&
        name !== "w" &&
        name !== "n" &&
        name !== "p" &&
        name !== "t" &&
        event.key !== "Enter"
      )
        return;
      event.preventDefault();
      if (approvalPending.current) return;
      const state = latest.current;
      if (name === "w") {
        if (state.active) void closeTab(state.active);
      } else if (name === "n" || name === "p") {
        if (state.active)
          controllers.current
            .get(state.active)
            ?.command(name === "n" ? "next" : "previous");
      } else if (name === "t") {
        if (state.ready && !state.blocked) setNewTabChooser(true);
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
        <h1>Just Compare</h1>
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
            {
              label: "Redo left",
              run: () => command("redo:left"),
              disabled: !active || blocked || !summaries[active]?.redoLeft,
            },
            {
              label: "Redo right",
              run: () => command("redo:right"),
              disabled: !active || blocked || !summaries[active]?.redoRight,
            },
            {
              label: "Find...",
              run: () => command("find"),
              disabled:
                !active ||
                blocked ||
                tabs.find((tab) => tab.id === active)?.mode !== "text",
            },
            {
              label: "Replace...",
              run: () => command("replace"),
              disabled:
                !active ||
                blocked ||
                tabs.find((tab) => tab.id === active)?.mode !== "text",
            },
            {
              label: "Go to Line...",
              run: () => command("goto"),
              disabled:
                !active ||
                blocked ||
                tabs.find((tab) => tab.id === active)?.mode !== "text",
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
              label: "Save Session",
              run: () => command("save-session"),
              disabled: !active || blocked || !settingsAvailable,
            },
            {
              label: "Save Session As...",
              run: () => command("save-session-as"),
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
            {
              label: "Recheck disk",
              run: () => command("recheck-disk"),
              disabled: !active || blocked,
            },
          ]}
        />
        <CommandMenu
          label="Integration"
          commands={[
            {
              label: "Enable Explorer commands...",
              run: () => {
                void changeExplorerIntegration(true);
              },
              disabled: blocked,
            },
            {
              label: "Remove Explorer commands...",
              run: () => {
                void changeExplorerIntegration(false);
              },
              disabled: blocked,
            },
            {
              label: "Check Explorer integration",
              run: () => {
                void changeExplorerIntegration(null);
              },
              disabled: blocked,
            },
            {
              label: "Clear selected compare path",
              run: () => {
                void native("clear_shell_selection", {})
                  .then(() => setInfo("Selected compare path cleared."))
                  .catch((failure) => setError(errorMessage(failure)));
              },
              disabled: blocked,
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
                  "Shortcuts: Ctrl+Enter or F5 run; Ctrl+S save focused editor; Ctrl+Z undo; Ctrl+Y redo; Ctrl+F find; F3 / Shift+F3 next / previous match; Ctrl+H replace; Ctrl+G go to line; Ctrl+N / Ctrl+P next / previous difference (also Alt+Down / Alt+Up); Ctrl+R copy left to right; Ctrl+L copy right to left (Ctrl+A then copy replaces the whole destination); Ctrl+T new comparison; F6 focus the other text pane; Ctrl+Tab switch tabs; Ctrl+W close tab; arrow keys navigate menus and folder rows.",
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
        <div className="menubar-brand" aria-hidden="true">
          <Icon name="workflowMerge" className="brand-mark" />
          Just Compare
        </div>
      </nav>
      <div className="tabbar">
        <button
          className="tab-home"
          onClick={() => setActive(null)}
          aria-pressed={active === null}
          title="Home"
        >
          <Icon name="home" />
          <span>Home</span>
        </button>
        <button
          className="tab-scroll"
          aria-label="Scroll tabs left"
          onClick={() => tabStrip.current?.scrollBy({ left: -240 })}
        >
          <Icon name="chevronLeft" />
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
                <span className="tab-kind" data-kind={tab.mode}>
                  <Icon
                    name={
                      tab.mode === "folder"
                        ? "workflowFolder"
                        : tab.mode === "merge"
                          ? "workflowMerge"
                          : "workflowText"
                    }
                  />
                  <span className="sr-only">
                    {tab.mode === "folder"
                      ? "Folder"
                      : tab.mode === "merge"
                        ? "Merge"
                        : "Text"}
                  </span>
                </span>
                {summaries[tab.id]?.error ? "! " : ""}
                {summaries[tab.id]?.dirty ? (
                  <>
                    <span className="sr-only">* </span>
                    <span
                      className="tab-dirty"
                      aria-hidden="true"
                      title="Unsaved changes"
                    />
                  </>
                ) : null}
                <span className="tab-title">
                  {summaries[tab.id]?.title ?? "Loading"}
                </span>
              </button>
              <button
                className="tab-close"
                aria-label={`Close ${summaries[tab.id]?.title ?? "comparison"}`}
                title="Close tab (Ctrl+W)"
                disabled={blocked}
                onClick={() => void closeTab(tab.id)}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <button
          className="tab-scroll"
          aria-label="Scroll tabs right"
          onClick={() => tabStrip.current?.scrollBy({ left: 240 })}
        >
          <Icon name="chevronRight" />
        </button>
        <button
          className="new-tab-button"
          aria-label="New comparison"
          title="New comparison (Ctrl+T)"
          disabled={!ready || blocked}
          onClick={() => setNewTabChooser(true)}
        >
          <Icon name="plus" />
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
            recoveries={recoveries.filter(
              (record) => !tabs.some((tab) => tab.recoveryId === record.id),
            )}
            recoveryReady={recoveryReady}
            onSetRecovery={(enabled) => void setDraftRecovery(enabled)}
            onRetryRecoveries={() => void retryLoadRecoveries()}
            onRestoreRecovery={restoreRecovery}
            onDiscardRecovery={(id) => void discardRecovery(id)}
            update={setSettings}
            openTab={openTab}
            openSession={openSession}
            saveSessions={saveHomeSessions}
            saveHistory={(recentComparisons) => {
              if (!acquire("home-history")) return;
              void native("write_history", {
                recentFolders: null,
                recentComparisons,
              })
                .then(() =>
                  setSettings((prior) => ({ ...prior, recentComparisons })),
                )
                .catch((failure) => setError(errorMessage(failure)))
                .finally(() => release("home-history"));
            }}
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
              setTabSessionName={setTabSessionName}
              renameSessionTabs={renameSessionTabs}
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
      {newTabChooser && (
        <WorkspaceDialog
          title="New comparison"
          onClose={() => setNewTabChooser(false)}
        >
          <div className="new-comparison-grid">
            {workflows.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className="new-comparison-card"
                disabled={!ready || blocked}
                onClick={() => {
                  setNewTabChooser(false);
                  openTab(mode);
                }}
              >
                <WorkflowIcon mode={mode} />
                <span>New {label}</span>
              </button>
            ))}
          </div>
        </WorkspaceDialog>
      )}
    </div>
  );
}
