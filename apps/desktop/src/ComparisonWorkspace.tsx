import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  alignmentGaps,
  copyRange,
  defaultFolderRules,
  fitsLiveComparisonBounds,
  native,
  textLines,
  type Block,
  type DocumentView,
  type DraftRecovery,
  type FolderEntry,
  type FolderRowId,
  type FolderRules,
  type LocalActionRequest,
  type LocalPreview,
  type Preview,
  type Settings,
} from "./api";
import { CodeEditor } from "./CodeEditor";
import { CommandMenu } from "./CommandMenu";
import { errorMessage, type DiffSpan } from "./comparison";
import {
  affectedFolders,
  applyFolderPatch,
  countVisibleSelection,
  differenceFilters,
  folderSelectionKeys,
  formatFolderErrorsLabel,
  formatSize,
  hasSelectedAncestor,
  isCurrentFolderGeneration,
  isWithinSelection,
  matchesName,
  parentFolderPath,
  selectionScope,
  targetRelativeFor,
  toggleFolderErrorFilter,
  visibleFolderIndex,
  withoutLinkedSource,
} from "./folderPresentation";
import { FolderRulesDialog } from "./FolderRulesDialog";
import { FolderView, type FolderSide } from "./FolderView";
import { Icon } from "./icons";
import { LineInspector } from "./LineInspector";
import { PathInput } from "./PathInput";
import { TextSearchPanel } from "./TextSearchPanel";
import { ToolButton } from "./ToolButton";
import { VirtualList } from "./VirtualList";
import {
  fileName,
  plainPath,
  relatedPaths,
  type SavedSession,
  type WorkspaceController,
  type WorkspaceSummary,
  type WorkspaceTab,
} from "./workbench";
import { WorkspaceDialog } from "./WorkspaceDialog";

type Side = "left" | "right" | "base";
interface Editor {
  text: string;
  original: string;
  recovered: boolean;
  document: DocumentView | null;
  path: string;
  history: string[];
  future: string[];
}
const editor = (text = ""): Editor => ({
  text,
  original: text,
  recovered: false,
  document: null,
  path: "",
  history: [],
  future: [],
});
function recoveredEditor(text: string | undefined, path: string): Editor {
  return {
    ...editor(text ?? ""),
    recovered: text !== undefined,
    path,
  };
}
type Editors = Record<Side, Editor>;
const noDifferences: DiffSpan[] = [];
type IntralineRegion = {
  spans: DiffSpan[];
  leftBaseByte: number;
  rightBaseByte: number;
};
type Intraline = {
  source: DiffSpan[];
  leftText: string;
  rightText: string;
  regions: IntralineRegion[];
};
const noIntralineRegions: IntralineRegion[] = [];
const maxIntralineRegions = 300;
const maxIntralineChars = 200_000;
interface DiskComparison {
  side: Side;
  draft: string;
  disk: string;
  spans: DiffSpan[];
}

interface WorkspaceProps {
  tab: WorkspaceTab;
  sharedSettings: Settings;
  settingsReady: boolean;
  updateSettings: (update: (prior: Settings) => Settings) => void;
  globalBusy: boolean;
  active: boolean;
  acquire: (id: string) => boolean;
  release: (id: string) => void;
  claimPreview: (id: string) => Promise<boolean>;
  discardPreview: (id: string) => void;
  register: (id: string, controller: WorkspaceController | null) => void;
  report: (id: string, summary: WorkspaceSummary) => void;
  openTab: (
    mode: WorkspaceTab["mode"],
    paths?: Partial<
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
    >,
  ) => void;
  openSession: (session: SavedSession) => void;
  setTabSessionName: (id: string, name: string | null) => void;
  renameSessionTabs: (previous: string, next: string | null) => void;
  diskChanged: (
    paths: string[],
    refreshFolders?: boolean,
    folderRefreshed?: boolean,
  ) => void;
  confirmAction: (message: string) => Promise<boolean>;
  confirmGitExit: (id: string) => Promise<boolean>;
  onHome: () => void;
}

export function ComparisonWorkspace({
  tab,
  sharedSettings,
  settingsReady,
  updateSettings,
  globalBusy,
  active,
  acquire,
  release,
  claimPreview,
  discardPreview,
  register,
  report,
  openTab,
  openSession,
  setTabSessionName,
  renameSessionTabs,
  diskChanged,
  confirmAction,
  confirmGitExit,
  onHome,
}: WorkspaceProps) {
  const [editors, setEditors] = useState<Editors>({
    left: recoveredEditor(
      tab.recovery?.leftText,
      tab.recovery?.leftPath ?? tab.left,
    ),
    right: recoveredEditor(
      tab.recovery?.rightText,
      tab.recovery?.rightPath ?? tab.right,
    ),
    base: recoveredEditor(
      tab.recovery?.baseText,
      tab.recovery?.basePath ?? tab.base,
    ),
  });
  const mode = tab.mode;
  const [rules, setRules] = useState(sharedSettings);
  const settings = {
    ...sharedSettings,
    ignoreCase: rules.ignoreCase,
    ignoreWhitespace: rules.ignoreWhitespace,
    ignoreLineEndings: rules.ignoreLineEndings,
    unimportantPatterns: rules.unimportantPatterns,
    formats: rules.formats,
  };
  const settingsSnapshot = useRef(settings);
  useLayoutEffect(() => {
    settingsSnapshot.current = settings;
  });
  function setSettings(update: (prior: Settings) => Settings) {
    const previous = settingsSnapshot.current;
    const next = update(previous);
    settingsSnapshot.current = next;
    setRules(next);
    updateSettings((prior) => ({
      ...prior,
      ...(next.theme !== previous.theme ? { theme: next.theme } : {}),
      ...(next.recent !== previous.recent ? { recent: next.recent } : {}),
      ...(next.recentFolders !== previous.recentFolders
        ? { recentFolders: next.recentFolders }
        : {}),
      ...(next.recentComparisons !== previous.recentComparisons
        ? { recentComparisons: next.recentComparisons }
        : {}),
      ...(next.sessions !== previous.sessions
        ? { sessions: next.sessions }
        : {}),
    }));
  }
  const [error, updateError] = useState("");
  const [notice, updateNotice] = useState("");
  const [working, setWorking] = useState(false);
  const busy = globalBusy;
  const [spans, setSpans] = useState<DiffSpan[] | null>(null);
  const [pendingEdit, setPendingEdit] = useState<number | null>(null);
  const [editRefresh, setEditRefresh] = useState(0);
  const editInFlight = useRef(false);
  const [current, setCurrent] = useState(0);
  const [singleLineCopy, setSingleLineCopy] = useState<{
    side: "left" | "right";
    line: number;
  } | null>(null);
  const [intraline, setIntraline] = useState<Intraline | null>(null);
  const [showIntraline, setShowIntraline] = useState(true);
  const [alignmentAnchors, setAlignmentAnchors] = useState<
    { left: number; right: number }[]
  >([]);
  const alignmentAnchorsRef = useRef(alignmentAnchors);
  const [cursorLines, setCursorLines] = useState<{
    left: number | null;
    right: number | null;
  }>({ left: null, right: null });
  const [suppressSelectedDifference, setSuppressSelectedDifference] =
    useState(false);
  const [activeEditorSide, setActiveEditorSide] = useState<"left" | "right">(
    "left",
  );
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [detailRow, setDetailRow] = useState<number | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [folderTruncated, setFolderTruncated] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [folderStale, setFolderStale] = useState(false);
  const [pendingFolderRefresh, setPendingFolderRefresh] = useState<string[]>(
    [],
  );
  const folderRefreshInFlight = useRef(false);
  const folderScanId = useRef("");
  const folderGeneration = useRef(0);
  const folderJobId = useRef<string | null>(null);
  const [staleSides, setStaleSides] = useState<Side[]>([]);
  const [staleOutput, setStaleOutput] = useState(false);
  const [diskChanges, setDiskChanges] = useState<Side[]>([]);
  const [diskComparison, setDiskComparison] = useState<DiskComparison | null>(
    null,
  );
  const [folderRoots, setFolderRoots] = useState({ left: "", right: "" });
  const [diskSpace, setDiskSpace] = useState({ left: "", right: "" });
  const [rootHistory, setRootHistory] = useState({
    left: { paths: [tab.left], index: 0 },
    right: { paths: [tab.right], index: 0 },
  });
  const [fileMetadata, setFileMetadata] = useState<
    Record<Side, { bytes: number; modified: number | null } | null>
  >({ left: null, right: null, base: null });
  const [nativeFolderRoots, setNativeFolderRoots] = useState({
    left: "",
    right: "",
  });
  const [filter, setFilter] = useState("all");
  const [previousFilter, setPreviousFilter] = useState("all");
  const [prevFolders, setPrevFolders] = useState(folders);
  if (folders !== prevFolders) {
    setPrevFolders(folders);
    if (
      filter === "error" &&
      folders.length > 0 &&
      !folders.some((entry) => entry.status === "error")
    ) {
      setFilter("all");
      setPreviousFilter("all");
    }
  }
  const selectFilter = (nextFilter: string) => {
    setFilter(nextFilter);
    if (nextFilter !== "error") {
      setPreviousFilter(nextFilter);
    }
  };
  const [quickFilter, setQuickFilter] = useState("*.*");
  const [peek, setPeek] = useState(false);
  const [showMinor, setShowMinor] = useState(true);
  const [filesVisible, setFilesVisible] = useState<"all" | "files" | "folders">(
    "all",
  );
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const folderController = useRef<((name: string) => void) | null>(null);
  const registerFolderCommands = useCallback(
    (controller: ((name: string) => void) | null) => {
      folderController.current = controller;
    },
    [],
  );
  const [folderDialog, setFolderDialog] = useState<{
    action: string;
    entries: FolderEntry[];
    side: FolderSide;
  } | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [contentMethod, setContentMethod] = useState<
    "binary" | "rules" | "crc"
  >(sharedSettings.contentComparison?.method ?? "rules");
  const [contentResults, setContentResults] = useState<FolderEntry[] | null>(
    null,
  );
  const [showContentResults, setShowContentResults] = useState(
    sharedSettings.contentComparison?.showResults ?? true,
  );
  const [dontPromptContents, setDontPromptContents] = useState(
    sharedSettings.contentComparison?.prompt === false,
  );
  const [contentHelp, setContentHelp] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [textFilter, setTextFilter] = useState<
    "all" | "differences" | "same" | "context"
  >("all");
  const [minorText, setMinorText] = useState(false);
  const [folderRules, setFolderRules] = useState<FolderRules>(
    tab.folderRules ?? sharedSettings.folderRules ?? defaultFolderRules,
  );
  const [rulesOpen, setRulesOpen] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<
    "save" | "saveAs" | "manage" | null
  >(null);
  const [sessionName, setSessionName] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [sessionRename, setSessionRename] = useState<{
    original: string;
    value: string;
  } | null>(null);
  const [searchMode, setSearchMode] = useState<
    "find" | "replace" | "goto" | null
  >(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchRequest, setSearchRequest] = useState<{
    token: number;
    direction: -1 | 1;
  } | null>(null);
  const searchRequestToken = useRef(0);
  const [searchSelection, setSearchSelection] = useState<{
    side: "left" | "right";
    from: number;
    to: number;
    token: number;
  } | null>(null);
  const searchToken = useRef(0);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [profileSuffix, setProfileSuffix] = useState("");
  const [actionMetadata, setActionMetadata] = useState<
    {
      path: string;
      bytes: number;
      modified: number | null;
      directory: boolean;
      readOnly: boolean;
    }[]
  >([]);
  const [exclude, setExclude] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<Set<string>>(new Set());
  const [excludedDirectories, setExcludedDirectories] = useState<Set<string>>(
    new Set(),
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewKind, setPreviewKind] = useState<
    "selected-update" | "selected-mirror" | "update" | "mirror" | null
  >(null);
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [resolutionHistory, setResolutionHistory] = useState<
    Record<number, string>[]
  >([]);
  const [resolutionFuture, setResolutionFuture] = useState<
    Record<number, string>[]
  >([]);
  const [activeConflict, setActiveConflict] = useState<number | null>(null);
  const conflictElements = useRef<Record<number, HTMLElement | null>>({});
  const [output, setOutput] = useState(tab.recovery?.output ?? "");
  const [outputSaved, setOutputSaved] = useState("");
  const [outputRecovered, setOutputRecovered] = useState(
    !!tab.recovery && tab.mode === "merge",
  );
  const [outputDocument, setOutputDocument] = useState<DocumentView | null>(
    null,
  );
  const gitOutput = tab.gitOutput;
  const [progress, setProgress] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const [split, setSplit] = useState(50);
  const [showLegend, setShowLegend] = useState(false);
  const [previewDirection, setPreviewDirection] = useState<"right" | "left">(
    "right",
  );
  const rootElement = useRef<HTMLElement>(null);
  const initialized = useRef(false);
  const revision = useRef(0);
  const activeJob = useRef<string | null>(null);
  const liveComparisonJob = useRef<string | null>(null);
  const liveCancellation = useRef<Promise<void> | null>(null);
  const hasCompared = useRef(false);
  const [cancellableJob, setCancellableJob] = useState<string | null>(null);
  function startJob(id: string) {
    activeJob.current = id;
    setCancellableJob(id);
  }
  const setNotice = useCallback(
    (message: string) => {
      updateNotice(message);
      if (message)
        setLog((prior) => [
          ...prior.slice(-199),
          `${new Date().toLocaleTimeString()} ${message}`,
        ]);
    },
    [setLog, updateNotice],
  );
  function updateAlignmentAnchors(value: { left: number; right: number }[]) {
    alignmentAnchorsRef.current = value;
    setAlignmentAnchors(value);
  }
  const setError = useCallback(
    (message: string) => {
      updateError(message);
      if (message)
        setLog((prior) => [
          ...prior.slice(-199),
          `${new Date().toLocaleTimeString()} Operation failed; inspect the error banner for details.`,
        ]);
    },
    [setLog, updateError],
  );
  function beginFolderGeneration() {
    const generation = ++folderGeneration.current;
    const jobId = crypto.randomUUID();
    const previousJobId = folderJobId.current;
    folderJobId.current = jobId;
    if (previousJobId) {
      void native("cancel_job", { jobId: previousJobId }).catch((failure) => {
        const message = errorMessage(failure);
        if (message !== "Job is not active.")
          setError(`Could not cancel the previous folder scan: ${message}`);
      });
    }
    return { generation, jobId };
  }
  function finishFolderJob(jobId: string) {
    if (folderJobId.current === jobId) folderJobId.current = null;
  }
  async function cancelLiveComparison() {
    const jobId = liveComparisonJob.current;
    if (!jobId) {
      if (liveCancellation.current) await liveCancellation.current;
      return;
    }
    liveComparisonJob.current = null;
    const cancellation = native("cancel_job", { jobId }).catch((failure) => {
      if (errorMessage(failure) !== "Job is not active.") throw failure;
    });
    liveCancellation.current = cancellation;
    try {
      await cancellation;
    } finally {
      if (liveCancellation.current === cancellation)
        liveCancellation.current = null;
    }
  }
  function folderCommand(name: string) {
    folderController.current?.(name);
  }
  function controllersCommand(name: string) {
    if (name === "recheck-disk") {
      void attempt(recheckDisk);
      return;
    }
    if (name === "find" || name === "replace" || name === "goto") {
      setSearchMode(name);
      return;
    }
    if (
      name === "sessions" ||
      name === "save-session" ||
      name === "save-session-as"
    ) {
      setSessionError("");
      setSessionRename(null);
      setSessionName(name === "save-session" ? (tab.sessionName ?? "") : "");
      setSessionDialog(
        name === "sessions"
          ? "manage"
          : name === "save-session-as"
            ? "saveAs"
            : "save",
      );
      return;
    }
    if (name === "profiles") {
      setProfilesOpen(true);
      return;
    }
    if (name === "swap") {
      swapInputs();
      return;
    }
    if (name === "rules" && mode === "folder") {
      setRulesOpen(true);
      return;
    }
    const panel = rootElement.current?.querySelector<HTMLDetailsElement>(
      `[data-panel="${name}"]`,
    );
    if (panel) {
      panel.open = !panel.open;
      panel.querySelector("summary")?.focus();
    }
  }
  function sessionCommands() {
    return [
      {
        label: "New Text Compare",
        run: () => openTab("text"),
        disabled: busy,
      },
      {
        label: "New Folder Compare",
        run: () => openTab("folder"),
        disabled: busy,
      },
      {
        label: "New 3-Way Merge",
        run: () => openTab("merge"),
        disabled: busy,
      },
      ...settings.sessions.map((session) => ({
        label: `Open ${session.name}`,
        run: () => openSession(session),
        disabled: busy,
      })),
    ];
  }
  async function persistSessions(sessions: SavedSession[]) {
    await native("write_settings", {
      settings: { ...sharedSettings, sessions },
    });
    setSettings((prior) => ({ ...prior, sessions }));
  }
  async function renameSavedSession(original: string, value: string) {
    const name = value.trim();
    if (!name) {
      setSessionError("Enter a session name.");
      return;
    }
    if (
      settings.sessions.some(
        (session) =>
          session.name !== original &&
          session.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      setSessionError("A session with this name already exists.");
      return;
    }
    await persistSessions(
      settings.sessions.map((session) =>
        session.name === original ? { ...session, name } : session,
      ),
    );
    renameSessionTabs(original, name);
    setSessionRename(null);
    setSessionError("");
    setNotice(`Session "${original}" renamed to "${name}".`);
  }
  async function moveSession(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= settings.sessions.length) return;
    const sessions = [...settings.sessions];
    const [session] = sessions.splice(index, 1);
    if (!session) return;
    sessions.splice(target, 0, session);
    await persistSessions(sessions);
  }
  async function saveSession() {
    const updatesCurrent = sessionDialog === "save" && !!tab.sessionName;
    const name = (
      updatesCurrent ? (tab.sessionName ?? "") : sessionName
    ).trim();
    if (!name) {
      setSessionError("Enter a session name.");
      return;
    }
    const currentIndex = settings.sessions.findIndex(
      (session) => session.name === tab.sessionName,
    );
    if (updatesCurrent && currentIndex < 0) {
      setSessionError(
        "This saved session was removed. Use Save Session As to create a new definition.",
      );
      return;
    }
    const duplicateIndex = settings.sessions.findIndex(
      (session) => session.name.toLowerCase() === name.toLowerCase(),
    );
    if (
      !updatesCurrent &&
      duplicateIndex >= 0 &&
      !(await confirmAction(
        `Replace the saved session "${settings.sessions[duplicateIndex]?.name}" with the current paths and rules? Draft contents are never saved.`,
      ))
    )
      return;
    const savedName =
      duplicateIndex >= 0
        ? (settings.sessions[duplicateIndex]?.name ?? name)
        : name;
    const session: SavedSession = {
      name: savedName,
      left: mode === "folder" ? folderRoots.left : editors.left.path,
      right: mode === "folder" ? folderRoots.right : editors.right.path,
      mode,
      base: mode === "merge" ? editors.base.path : "",
      ...(mode === "folder" ? { folderRules } : {}),
    };
    try {
      const index = updatesCurrent ? currentIndex : duplicateIndex;
      const nextSessions =
        index >= 0
          ? settings.sessions.map((saved, i) => (i === index ? session : saved))
          : [...settings.sessions, session];
      await persistSessions(nextSessions);
    } catch (failure) {
      setSessionError(errorMessage(failure));
      throw failure;
    }
    setTabSessionName(tab.id, savedName);
    setSessionDialog(null);
    setNotice(`Session "${savedName}" saved.`);
  }
  function swapInputs() {
    if (busy) return;
    if (mode === "folder") {
      invalidateFolders();
      setFolderRoots((prior) => ({ left: prior.right, right: prior.left }));
    } else {
      invalidate();
      setEditors((prior) => ({
        ...prior,
        left: prior.right,
        right: prior.left,
      }));
      setFileMetadata((prior) => ({
        ...prior,
        left: prior.right,
        right: prior.left,
      }));
      setStaleSides((prior) =>
        prior.map((side) =>
          side === "left" ? "right" : side === "right" ? "left" : side,
        ),
      );
    }
  }
  const latest = useRef({
    editors,
    output,
    outputSaved,
    outputRecovered,
    choices,
    gitOutput,
    mode,
    busy,
  });
  useEffect(() => {
    latest.current = {
      editors,
      output,
      outputSaved,
      outputRecovered,
      choices,
      gitOutput,
      mode,
      busy,
    };
  }, [
    editors,
    output,
    outputSaved,
    outputRecovered,
    choices,
    gitOutput,
    mode,
    busy,
  ]);

  function invalidate(clearComparison = true) {
    revision.current += 1;
    setSuppressSelectedDifference(false);
    setPendingEdit(null);
    if (clearComparison) setSpans(null);
    if (clearComparison) setDetailRow(null);
    setBlocks(null);
    setChoices({});
    setResolutionHistory([]);
    setResolutionFuture([]);
    setActiveConflict(null);
    updateAlignmentAnchors([]);
    setCursorLines({ left: null, right: null });
    setError("");
    setNotice("");
  }
  function invalidateFolders() {
    setDiskSpace({ left: "", right: "" });
    setNativeFolderRoots({ left: "", right: "" });
    discardPreview(tab.id);
    setPreview(null);
    setFolderStale(true);
    setSelectedFiles(new Set());
    setError("");
    setNotice("");
  }
  function change(side: Side, text: string) {
    const refresh = mode === "text";
    invalidate(!refresh);
    if (refresh) setPendingEdit(revision.current);
    if (liveComparisonJob.current)
      void cancelLiveComparison().catch((failure: unknown) =>
        setError(errorMessage(failure)),
      );
    setEditors((previous) => ({
      ...previous,
      [side]: {
        ...previous[side],
        text,
        history: [...previous[side].history.slice(-49), previous[side].text],
        future: [],
      },
    }));
  }
  function navigateText(side: "left" | "right", from: number, to: number) {
    setTextFilter("all");
    setSearchSelection({ side, from, to, token: ++searchToken.current });
  }
  function replaceDrafts(changes: Partial<Record<"left" | "right", string>>) {
    for (const side of ["left", "right"] as const) {
      const text = changes[side];
      if (text !== undefined && text !== editors[side].text) change(side, text);
    }
  }
  async function attempt(operation: () => Promise<void>) {
    if (!acquire(tab.id)) {
      setError("Wait for the active operation to finish.");
      return;
    }
    setError("");
    setNotice("");
    setWorking(true);
    try {
      await operation();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      activeJob.current = null;
      setCancellableJob(null);
      setWorking(false);
      release(tab.id);
    }
  }
  async function discard(side: Side) {
    const e = latest.current.editors[side];
    return (
      (!e.recovered && e.text === e.original) ||
      (await confirmAction(`Discard unsaved ${side} edits?`))
    );
  }
  async function load(
    side: Side,
    path: string,
    encoding: string | null = null,
    checkDiscard = true,
    keepComparison = false,
  ) {
    if (checkDiscard && !(await discard(side))) return;
    const document = await native("open_document", {
      path,
      encoding,
    });
    let metadata;
    try {
      metadata = await native("path_metadata", { path: document.path });
    } catch (failure) {
      await native("close_document", { id: document.id });
      throw failure;
    }
    const previous = latest.current.editors[side].document;
    if (previous) {
      try {
        await native("close_document", { id: previous.id });
      } catch (error) {
        await native("close_document", { id: document.id });
        throw error;
      }
    }
    invalidate(!keepComparison);
    const loaded: Editor = {
      text: document.text,
      original: document.text,
      recovered: false,
      document,
      path: document.path,
      history: [],
      future: [],
    };
    setEditors((prior) => ({
      ...prior,
      [side]: loaded,
    }));
    setStaleSides((prior) => prior.filter((value) => value !== side));
    setFileMetadata((prior) => ({ ...prior, [side]: metadata }));
    setSettings((prior) => ({
      ...prior,
      recent: [
        document.path,
        ...prior.recent.filter((p) => p !== document.path),
      ].slice(0, 20),
    }));
    return loaded;
  }
  async function loadDialog(side: Side) {
    const path = await open({ multiple: false, directory: mode === "folder" });
    if (typeof path !== "string") return;
    if (mode === "folder") {
      invalidateFolders();
      if (side !== "base") {
        const next = { ...folderRoots, [side]: path };
        setFolderRoots(next);
        await scan(next);
      }
    } else await load(side, path);
  }
  async function recordHistory(
    folders: string[],
    comparison: import("./api").RecentComparison | null,
    generation?: number,
  ) {
    const saved = await native("remember_history", {
      folders,
      comparison,
    });
    if (
      generation !== undefined &&
      !isCurrentFolderGeneration(folderGeneration.current, generation)
    )
      return;
    setSettings((prior) => ({
      ...prior,
      recentFolders: saved.recentFolders ?? [],
      recentComparisons: saved.recentComparisons ?? [],
    }));
  }
  async function saveFolderHistory(recentFolders: string[]) {
    await native("write_history", { recentFolders, recentComparisons: null });
    updateSettings((prior) => ({ ...prior, recentFolders }));
  }
  async function chooseFolder(side: FolderSide, path: string) {
    invalidateFolders();
    const roots = { ...folderRoots, [side]: path };
    setFolderRoots(roots);
    await scan(roots);
  }
  async function openSide(side: Side, encoding: string | null = null) {
    await load(side, editors[side].path, encoding);
  }
  async function openRecent(side: Side, path: string) {
    setEditors((prior) => ({ ...prior, [side]: { ...prior[side], path } }));
    await load(side, path);
  }
  async function undoSide(side: Side) {
    const text = editors[side].history.at(-1);
    if (text === undefined) return;
    const inputs = {
      ...editors,
      [side]: {
        ...editors[side],
        text,
        history: editors[side].history.slice(0, -1),
        future: [...editors[side].future.slice(-49), editors[side].text],
      },
    };
    invalidate();
    setEditors(inputs);
    if (mode === "text") await compareInputs(inputs, selected, minorText, true);
  }
  async function redoSide(side: Side) {
    const text = editors[side].future.at(-1);
    if (text === undefined) return;
    const inputs = {
      ...editors,
      [side]: {
        ...editors[side],
        text,
        history: [...editors[side].history.slice(-49), editors[side].text],
        future: editors[side].future.slice(0, -1),
      },
    };
    invalidate();
    setEditors(inputs);
    if (mode === "text") await compareInputs(inputs, selected, minorText, true);
  }
  async function saveSide(side: Side, asNew = false, convert = false) {
    const e = editors[side];
    let destination: string | null = null;
    if (asNew || !e.document)
      destination = await save({
        title: "Save to a new file (existing files are not overwritten)",
      });
    if ((asNew || !e.document) && !destination) return;
    const document = await native("save_document", {
      id: e.document?.id ?? null,
      text: e.text,
      destination,
      convertUtf8: convert,
    });
    discardPreview(tab.id);
    setPreview(null);
    invalidate(mode !== "text");
    const inputs = {
      ...editors,
      [side]: {
        ...editors[side],
        text: document.text,
        original: document.text,
        recovered: false,
        document,
        path: document.path,
      },
    };
    setEditors(inputs);
    setNotice(`${side} saved.`);
    setStaleSides((prior) => prior.filter((value) => value !== side));
    diskChanged([document.path], true);
    const metadata = await native("path_metadata", { path: document.path });
    setFileMetadata((prior) => ({ ...prior, [side]: metadata }));
    if (mode === "text") await compareInputs(inputs, selected, minorText, true);
  }
  const comparedKey = useRef("");
  const failedComparison = useRef({ key: "", count: 0 });
  function comparisonKey(inputs: Editors, includeMinor: boolean) {
    return JSON.stringify([
      inputs.left.text,
      inputs.right.text,
      settings.ignoreCase,
      settings.ignoreWhitespace,
      settings.ignoreLineEndings,
      settings.unimportantPatterns,
      settings.formats,
      includeMinor,
    ]);
  }
  async function compareInputs(
    inputs = editors,
    afterCopy?: DiffSpan,
    includeMinor = minorText,
    preserveViewport = afterCopy !== undefined,
    background = false,
    anchors = alignmentAnchorsRef.current,
    retainCurrent = false,
  ) {
    const request = ++revision.current;
    const jobId = crypto.randomUUID();
    await cancelLiveComparison();
    if (request !== revision.current) return;
    if (background) liveComparisonJob.current = jobId;
    if (!background) {
      setPendingEdit(null);
      startJob(jobId);
    }
    if (!preserveViewport) setSpans(null);
    const profile = settings.formats.find((f) =>
      (inputs.left.document?.path || inputs.left.path)
        .toLowerCase()
        .endsWith(f.suffix.toLowerCase()),
    );
    const result = await native("compare_text", {
      left: inputs.left.text,
      right: inputs.right.text,
      documents: {
        left: inputs.left.document?.id ?? null,
        right: inputs.right.document?.id ?? null,
      },
      jobId,
      showMinor: includeMinor,
      options: {
        alignmentAnchors: anchors,
        ignoreCase: profile?.ignoreCase ?? settings.ignoreCase,
        ignoreWhitespace:
          profile?.ignoreWhitespace ?? settings.ignoreWhitespace,
        ignoreLineEndings:
          profile?.ignoreLineEndings ?? settings.ignoreLineEndings,
        patterns: profile?.patterns ?? settings.unimportantPatterns,
      },
    })
      .catch((failure: unknown) => {
        if (request === revision.current) {
          const failedFor = comparisonKey(inputs, includeMinor);
          failedComparison.current = {
            key: failedFor,
            count:
              failedComparison.current.key === failedFor
                ? failedComparison.current.count + 1
                : 1,
          };
          setSpans(null);
        }
        throw failure;
      })
      .finally(() => {
        if (liveComparisonJob.current === jobId)
          liveComparisonJob.current = null;
        setEditRefresh((value) => value + 1);
      });
    if (request === revision.current) {
      hasCompared.current = true;
      comparedKey.current = comparisonKey(inputs, includeMinor);
      setSpans(result);
      if (!preserveViewport) setSuppressSelectedDifference(false);
      if (afterCopy) {
        const remaining = result.filter((span) => span.kind !== "equal");
        const next = remaining.findIndex(
          (span) => span.leftStart >= afterCopy.leftStart,
        );
        setCurrent(next < 0 ? Math.max(0, remaining.length - 1) : next);
      } else if (!preserveViewport) {
        setCurrent(0);
        setNavigation((value) => value + 1);
      } else if (!retainCurrent) {
        setCurrent((value) =>
          Math.min(
            value,
            Math.max(
              0,
              result.filter((span) => span.kind !== "equal").length - 1,
            ),
          ),
        );
      }
      if (!background && inputs.left.document && inputs.right.document)
        await recordHistory([], {
          mode: "text",
          left: inputs.left.document.path,
          right: inputs.right.document.path,
          base: "",
        });
    }
  }
  async function anchorCurrentLines() {
    const left = cursorLines.left;
    const right = cursorLines.right;
    if (left === null || right === null)
      throw new Error("Place the caret on one line in each text pane first.");
    if (
      left >= textLines(editors.left.text).length ||
      right >= textLines(editors.right.text).length
    )
      throw new Error("Alignment anchors must point to existing source lines.");
    const anchors = [...alignmentAnchorsRef.current, { left, right }].sort(
      (a, b) => a.left - b.left,
    );
    if (
      anchors.some(
        (anchor, index) =>
          index > 0 &&
          (anchors[index - 1]!.left >= anchor.left ||
            anchors[index - 1]!.right >= anchor.right),
      )
    )
      throw new Error("Alignment anchors must be in increasing line order.");
    updateAlignmentAnchors(anchors);
    await compareInputs(editors, undefined, minorText, true, false, anchors);
  }
  async function clearAlignmentAnchors() {
    updateAlignmentAnchors([]);
    await compareInputs(editors, undefined, minorText, true, false, []);
  }
  const refreshEditedComparison = useEffectEvent(async () => {
    if (editInFlight.current || pendingEdit === null) return;
    const edit = pendingEdit;
    editInFlight.current = true;
    const request = revision.current + 1;
    try {
      const oversized =
        !fitsLiveComparisonBounds(editors.left.text) ||
        !fitsLiveComparisonBounds(editors.right.text);
      if (oversized) {
        setDetailRow(null);
        await attempt(() =>
          compareInputs(editors, undefined, minorText, true, false),
        );
        return;
      }
      await compareInputs(editors, undefined, minorText, true, true);
    } catch (failure) {
      if (request === revision.current) setError(errorMessage(failure));
    } finally {
      editInFlight.current = false;
      setPendingEdit((value) => (value === edit ? null : value));
      setEditRefresh((value) => value + 1);
    }
  });
  const oversizedEdit =
    !fitsLiveComparisonBounds(editors.left.text) ||
    !fitsLiveComparisonBounds(editors.right.text);
  useEffect(() => {
    if (pendingEdit === null || busy) return;
    const timer = window.setTimeout(
      () => {
        void refreshEditedComparison();
      },
      oversizedEdit ? 750 : 150,
    );
    return () => window.clearTimeout(timer);
  }, [pendingEdit, busy, editRefresh, oversizedEdit]);
  useEffect(() => {
    if (
      mode !== "text" ||
      !initialized.current ||
      busy ||
      globalBusy ||
      pendingEdit !== null ||
      editInFlight.current ||
      liveComparisonJob.current ||
      !(editors.left.text !== "" || editors.left.path) ||
      !(editors.right.text !== "" || editors.right.path)
    )
      return;
    const key = comparisonKey(editors, minorText);
    if (
      key === failedComparison.current.key &&
      failedComparison.current.count >= 2
    )
      return;
    if (spans !== null && key === comparedKey.current) return;
    const timer = window.setTimeout(() => {
      if (oversizedEdit) void attempt(() => compareInputs());
      else
        void compareInputs(editors, undefined, minorText, true, true).catch(
          (failure: unknown) => setError(errorMessage(failure)),
        );
    }, 200);
    return () => window.clearTimeout(timer);
    // Any result that does not match the current inputs (rules, loads, swaps, dropped late results) is recomputed; a failing input is retried once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    busy,
    globalBusy,
    pendingEdit,
    spans,
    editors,
    settings,
    minorText,
    editRefresh,
  ]);
  useEffect(() => {
    if (
      mode !== "text" ||
      spans === null ||
      pendingEdit !== null ||
      !showIntraline
    )
      return;
    const source = spans;
    const leftText = editors.left.text;
    const rightText = editors.right.text;
    let disposed = false;
    const encoder = new TextEncoder();
    const left = textLines(leftText);
    const right = textLines(rightText);
    const text = (lines: typeof left, start: number, end: number) =>
      lines
        .slice(start, end)
        .map((line) => line.full)
        .join("");
    const baseByte = (lines: typeof left, full: string, index: number) =>
      encoder.encode(full.slice(0, lines[index]?.start ?? full.length)).length;
    const timer = window.setTimeout(() => {
      void (async () => {
        const regions: IntralineRegion[] = [];
        let budget = maxIntralineChars;
        for (const span of source) {
          if (disposed || regions.length >= maxIntralineRegions) break;
          if (span.kind !== "replace") continue;
          const leftRegion = text(left, span.leftStart, span.leftEnd);
          const rightRegion = text(right, span.rightStart, span.rightEnd);
          budget -= leftRegion.length + rightRegion.length;
          if (budget < 0) break;
          try {
            const refined = await native("refine_text", {
              left: leftRegion,
              right: rightRegion,
            });
            regions.push({
              spans: refined,
              leftBaseByte: baseByte(left, leftText, span.leftStart),
              rightBaseByte: baseByte(right, rightText, span.rightStart),
            });
          } catch {
            break;
          }
        }
        if (!disposed) setIntraline({ source, leftText, rightText, regions });
      })();
    }, 50);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    mode,
    spans,
    pendingEdit,
    showIntraline,
    editors.left.text,
    editors.right.text,
  ]);
  const intralineRegions =
    showIntraline &&
    intraline !== null &&
    intraline.source === spans &&
    intraline.leftText === editors.left.text &&
    intraline.rightText === editors.right.text
      ? intraline.regions
      : noIntralineRegions;
  const intralineBySide = useMemo(
    () => ({
      left: intralineRegions.map((region) => ({
        spans: region.spans,
        baseByte: region.leftBaseByte,
      })),
      right: intralineRegions.map((region) => ({
        spans: region.spans,
        baseByte: region.rightBaseByte,
      })),
    }),
    [intralineRegions],
  );
  function intralineRegionsFor(side: "left" | "right") {
    return intralineBySide[side];
  }
  useEffect(() => {
    if (!active || mode !== "text") return;
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && ["f", "h", "g"].includes(key)) {
        event.preventDefault();
        setSearchMode(key === "h" ? "replace" : key === "g" ? "goto" : "find");
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [active, mode]);
  const changes =
    pendingEdit === null
      ? (spans?.filter((s) => s.kind !== "equal") ?? [])
      : [];
  const folderBytes = (side: "left" | "right") =>
    folders.reduce(
      (sum, entry) =>
        sum +
        (entry.isDirectory
          ? 0
          : ((side === "left" ? entry.leftSize : entry.rightSize) ?? 0)),
      0,
    );
  const editorGaps = useMemo(
    () => ({
      left: alignmentGaps(spans ?? [], "left"),
      right: alignmentGaps(spans ?? [], "right"),
    }),
    [spans],
  );
  const selected = suppressSelectedDifference
    ? undefined
    : changes[Math.min(current, changes.length - 1)];
  function copyCurrentDifference(destination: "left" | "right") {
    const target = selected ?? changes[Math.min(current, changes.length - 1)];
    if (busy || mode !== "text" || !target) return;
    const source = destination === "right" ? "left" : "right";
    void attempt(() => copyDifference(source, target));
  }
  function selectDifference(index: number) {
    setSuppressSelectedDifference(false);
    setSingleLineCopy(null);
    if (textFilter === "same") setTextFilter("all");
    setCurrent(index);
    setDetailRow(null);
    setNavigation((value) => value + 1);
  }
  function navigateDifference(direction: -1 | 1) {
    if (!changes.length) return;
    const offset = suppressSelectedDifference
      ? direction === 1
        ? 0
        : -1
      : direction;
    selectDifference((current + offset + changes.length) % changes.length);
  }
  function enterSingleLineCopyMode(side: "left" | "right", line: number) {
    const index = changes.findIndex((span) => {
      const start = side === "left" ? span.leftStart : span.rightStart;
      const end = side === "left" ? span.leftEnd : span.rightEnd;
      return line >= start && line < end;
    });
    if (index < 0) {
      setSingleLineCopy(null);
      return;
    }
    const row = aligned.findIndex((entry) => entry[side] === line);
    setSingleLineCopy({ side, line });
    setSuppressSelectedDifference(false);
    setActiveEditorSide(side);
    setCurrent(index);
    if (row >= 0) setDetailRow(row);
  }
  function copySelectedDifference(destination: "left" | "right") {
    if (busy || mode !== "text") return true;
    const source = destination === "right" ? "left" : "right";
    if (!selected) {
      setNotice("Compare the drafts and select a difference before copying.");
      return true;
    }
    if (singleLineCopy) {
      const row = aligned.find(
        (line) => line[singleLineCopy.side] === singleLineCopy.line,
      );
      const sourceLine = row?.[source];
      if (sourceLine == null) {
        setNotice(
          `The ${source} side has no corresponding line to copy at this position.`,
        );
        return true;
      }
      void attempt(() => copyDifference(source, selected, sourceLine));
    } else void attempt(() => copyDifference(source, selected));
    return true;
  }
  async function copyDifference(
    source: "left" | "right",
    span: DiffSpan,
    singleLine?: number,
  ) {
    const destination = source === "left" ? "right" : "left";
    const focusedSide = activeEditorSide;
    let text: string;
    if (singleLine === undefined) {
      text = copyRange(
        editors[source].text,
        editors[destination].text,
        source === "left" ? span.leftStart : span.rightStart,
        source === "left" ? span.leftEnd : span.rightEnd,
        destination === "left" ? span.leftStart : span.rightStart,
        destination === "left" ? span.leftEnd : span.rightEnd,
      );
    } else {
      const rowIndex = aligned.findIndex((row) => row[source] === singleLine);
      const row = aligned[rowIndex];
      if (!row)
        throw new Error("The selected detail line is no longer aligned.");
      const targetLine = row[destination];
      const insertion =
        targetLine ??
        aligned
          .slice(0, rowIndex)
          .filter((entry) => entry[destination] !== null).length;
      text = copyRange(
        editors[source].text,
        editors[destination].text,
        singleLine,
        singleLine + 1,
        insertion,
        targetLine == null ? insertion : targetLine + 1,
      );
    }
    const inputs = {
      ...editors,
      [destination]: {
        ...editors[destination],
        text,
        history: [
          ...editors[destination].history.slice(-49),
          editors[destination].text,
        ],
        future: [],
      },
    };
    revision.current += 1;
    setBlocks(null);
    setChoices({});
    setEditors(inputs);
    setSuppressSelectedDifference(true);
    try {
      await compareInputs(
        inputs,
        undefined,
        minorText,
        true,
        false,
        undefined,
        true,
      );
    } catch (failure) {
      setSpans(null);
      throw failure;
    } finally {
      rootElement.current
        ?.closest('[aria-hidden="false"]')
        ?.querySelector<HTMLElement>(
          `.cm-content[aria-label="${focusedSide === "left" ? "Left text" : "Right text"}"]`,
        )
        ?.focus({ preventScroll: true });
    }
    setNotice(
      `Copied to ${destination} draft. Differences refreshed; Save writes the file.`,
    );
  }
  function copyInspectorLine(source: "left" | "right") {
    if (!detailLine || detailLine.kind === "equal") return;
    const line = detailLine[source];
    if (line === null) return;
    const span = changes.find((candidate) => {
      const start =
        source === "left" ? candidate.leftStart : candidate.rightStart;
      const end = source === "left" ? candidate.leftEnd : candidate.rightEnd;
      return line >= start && line < end;
    });
    if (span) void attempt(() => copyDifference(source, span, line));
  }
  const leftLines = textLines(editors.left.text);
  const rightLines = textLines(editors.right.text);
  const aligned =
    spans?.flatMap((span) =>
      Array.from(
        {
          length: Math.max(
            span.leftEnd - span.leftStart,
            span.rightEnd - span.rightStart,
          ),
        },
        (_, offset) => ({
          kind: span.kind,
          minor: span.minor ?? false,
          left:
            offset < span.leftEnd - span.leftStart
              ? span.leftStart + offset
              : null,
          right:
            offset < span.rightEnd - span.rightStart
              ? span.rightStart + offset
              : null,
        }),
      ),
    ) ?? [];
  const detailIndex = Math.min(
    detailRow ??
      Math.max(
        0,
        aligned.findIndex((row) =>
          selected
            ? row.left === selected.leftStart ||
              row.right === selected.rightStart
            : true,
        ),
      ),
    Math.max(0, aligned.length - 1),
  );
  const detailLine = aligned[detailIndex];
  async function saveDetailLayout(lineDetail: {
    collapsed: boolean;
    height: number;
  }) {
    await native("write_line_detail", { lineDetail });
    updateSettings((prior) => ({ ...prior, lineDetail }));
  }

  async function scan(
    requestedRoots = folderRoots,
    options = folderOptions(),
    rules = folderRules,
    keepSelection = false,
  ) {
    const { generation, jobId } = beginFolderGeneration();
    discardPreview(tab.id);
    setPreview(null);
    setFolderStale(true);
    if (!keepSelection) setSelectedFiles(new Set());
    setProgress(0);
    try {
      const roots =
        requestedRoots.left && requestedRoots.right
          ? await native("normalize_folder_roots", requestedRoots)
          : requestedRoots;
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
      startJob(jobId);
      const result = await native("scan_folders", {
        left: roots.left,
        right: roots.right,
        options,
        rules,
        jobId,
      });
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
      folderScanId.current = result.scanId;
      setFolders(result.entries);
      setFolderTruncated(result.truncated);
      if (keepSelection) {
        const keys = new Set(folderSelectionKeys(result.entries));
        setSelectedFiles(
          (prior) => new Set([...prior].filter((key) => keys.has(key))),
        );
      }
      if (filter === "error") {
        selectFilter("all");
      }
      setFolderRoots(roots);
      setNativeFolderRoots(roots);
      rememberRoots(roots);
      const spaceFor = async (side: FolderSide) => {
        if (!roots[side]) return "";
        try {
          const value = await native("disk_space", { path: roots[side] });
          return `${formatSize(Number(value.availableBytes))} free`;
        } catch (failure) {
          return `Free space unavailable: ${errorMessage(failure)}`;
        }
      };
      const space = await Promise.all([spaceFor("left"), spaceFor("right")]);
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
      setDiskSpace({ left: space[0], right: space[1] });
      setHasScanned(true);
      setFolderStale(false);
      setNotice(
        roots.left && roots.right
          ? `Scan complete: ${result.entries.length} file entries.`
          : `Listed ${result.entries.length} entries. Choose the other folder to compare.`,
      );
      await recordHistory(
        [roots.left, roots.right],
        roots.left && roots.right
          ? { mode: "folder", ...roots, base: "" }
          : null,
        generation,
      );
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
    } catch (failure) {
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
      throw failure;
    } finally {
      finishFolderJob(jobId);
    }
  }
  async function recheckDisk() {
    if (mode === "folder") {
      const { generation, jobId } = beginFolderGeneration();
      try {
        if (!folderRoots.left && !folderRoots.right)
          throw new Error("Choose a folder before rechecking disk.");
        if (!hasScanned) {
          await scan();
          if (!isCurrentFolderGeneration(folderGeneration.current, generation))
            return;
          return;
        }
        const roots =
          folderRoots.left && folderRoots.right
            ? await native("normalize_folder_roots", folderRoots)
            : folderRoots;
        if (!isCurrentFolderGeneration(folderGeneration.current, generation))
          return;
        startJob(jobId);
        if (!folderScanId.current) {
          await scan(roots, folderOptions(), folderRules, true);
          if (!isCurrentFolderGeneration(folderGeneration.current, generation))
            return;
          setNotice("Folder scan refreshed from disk.");
          return;
        }
        const refreshed = await native("refresh_folder_paths", {
          scanId: folderScanId.current,
          paths: [""],
          jobId,
        });
        if (!isCurrentFolderGeneration(folderGeneration.current, generation))
          return;
        setFolderRoots(roots);
        setNativeFolderRoots(roots);
        const changed =
          refreshed.removed.length > 0 || refreshed.upserted.length > 0;
        if (changed) setFolders(applyFolderPatch(folders, refreshed));
        setFolderStale(false);
        if (changed) {
          discardPreview(tab.id);
          setPreview(null);
          setSelectedFiles(new Set());
        }
        setNotice(
          changed
            ? "Folder contents changed on disk and were refreshed."
            : "No folder changes found on disk.",
        );
      } catch (failure) {
        if (!isCurrentFolderGeneration(folderGeneration.current, generation))
          return;
        throw failure;
      } finally {
        finishFolderJob(jobId);
      }
      return;
    }

    const changed: Side[] = [];
    for (const side of ["left", "right", "base"] as const) {
      const document = editors[side].document;
      if (document && (await native("document_changed", { id: document.id })))
        changed.push(side);
    }
    if (
      !editors.left.document &&
      !editors.right.document &&
      !editors.base.document
    ) {
      setStaleSides([]);
      setDiskChanges([]);
      setDiskComparison(null);
      setNotice("There are no open source files to recheck.");
      return;
    }
    if (!changed.length) {
      setStaleSides([]);
      setDiskChanges([]);
      setDiskComparison(null);
      setNotice("No source file changes found on disk.");
      return;
    }
    setStaleSides(changed);
    setDiskChanges(changed);
    setDiskComparison(null);
    setNotice("Source files changed on disk. Drafts are retained.");
  }
  async function compareWithDisk(side: Side) {
    const source = editors[side];
    const document = source.document;
    if (!document) throw new Error(`The ${side} pane has no open source file.`);
    const disk = await native("open_document", {
      path: document.path,
      encoding: document.encoding,
    });
    try {
      const profile = settings.formats.find((format) =>
        document.path.toLowerCase().endsWith(format.suffix.toLowerCase()),
      );
      const options = {
        ignoreCase: profile?.ignoreCase ?? settings.ignoreCase,
        ignoreWhitespace:
          profile?.ignoreWhitespace ?? settings.ignoreWhitespace,
        ignoreLineEndings:
          profile?.ignoreLineEndings ?? settings.ignoreLineEndings,
        patterns: profile?.patterns ?? settings.unimportantPatterns,
      };
      const jobId = crypto.randomUUID();
      startJob(jobId);
      const spans = await native("compare_text", {
        left: source.text,
        right: disk.text,
        documents: { left: document.id, right: disk.id },
        jobId,
        showMinor: minorText,
        options,
      });
      setDiskComparison({
        side,
        draft: source.text,
        disk: disk.text,
        spans,
      });
    } finally {
      await native("close_document", { id: disk.id });
    }
  }
  async function reloadFromDisk(side: Side) {
    const source = editors[side];
    if (!source.path) throw new Error(`The ${side} pane has no source path.`);
    const loaded = await load(side, source.path);
    if (!loaded) return;
    const inputs = { ...latest.current.editors, [side]: loaded };
    if (mode === "text" && inputs.left.document && inputs.right.document)
      await compareInputs(inputs, undefined, minorText, true);
    if (
      mode === "merge" &&
      inputs.base.document &&
      inputs.left.document &&
      inputs.right.document
    )
      await mergeInputs(inputs);
    setDiskChanges((prior) => prior.filter((value) => value !== side));
    setDiskComparison(null);
  }
  function reviewDiskChange(side: Side) {
    setDiskChanges((prior) => [...new Set([...prior, side])]);
    setDiskComparison(null);
  }
  function folderOptions(
    overrides: {
      exclude?: string[];
      excludeFiles?: string[];
      excludeDirectories?: string[];
    } = {},
  ) {
    return {
      exclude: overrides.exclude ?? exclude.split("\n").filter(Boolean),
      excludeFiles: overrides.excludeFiles ?? [...excludedFiles],
      excludeDirectories: overrides.excludeDirectories ?? [
        ...excludedDirectories,
      ],
    };
  }
  function markStale(reason: string) {
    folderScanId.current = "";
    setFolderStale(true);
    if (reason === "refresh-failed")
      setNotice(
        "Folder refresh failed; results may be stale. Run a full refresh.",
      );
  }
  async function refreshFolderRows(paths: string[]) {
    if (!folderScanId.current) {
      await scan(nativeFolderRoots, folderOptions(), folderRules, true);
      return null;
    }
    const generation = folderGeneration.current;
    const jobId = crypto.randomUUID();
    startJob(jobId);
    try {
      const patch = await native("refresh_folder_paths", {
        scanId: folderScanId.current,
        paths,
        jobId,
      });
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return null;
      const next = applyFolderPatch(folders, patch);
      setFolders(next);
      return next;
    } catch (failure) {
      if (isCurrentFolderGeneration(folderGeneration.current, generation))
        markStale("refresh-failed");
      throw failure;
    } finally {
      finishFolderJob(jobId);
    }
  }
  const runPendingFolderRefresh = useEffectEvent(() => {
    if (
      !pendingFolderRefresh.length ||
      mode !== "folder" ||
      globalBusy ||
      !hasScanned
    )
      return;
    void attempt(async () => {
      const paths = pendingFolderRefresh;
      setPendingFolderRefresh([]);
      folderRefreshInFlight.current = true;
      try {
        const roots = nativeFolderRoots;
        if (!roots.left || !roots.right)
          throw new Error(
            "Both folder roots must be scanned before a saved file can be refreshed.",
          );
        const mapped = await Promise.all(
          paths.map((path) =>
            native("relative_folder_path", { ...roots, path }),
          ),
        );
        const selected = [
          ...new Set(mapped.filter((path): path is string => path !== null)),
        ];
        if (selected.length) await refreshFolderRows(selected);
        const allMapped = mapped.every((path) => path !== null);
        if (!allMapped) markStale("unmapped-change");
        setNotice(
          allMapped
            ? `Refreshed ${selected.length} saved file${selected.length === 1 ? "" : "s"} and affected directory summaries.`
            : "Some saved files could not be mapped to the scanned roots. Results remain stale; run a full refresh to update them.",
        );
      } catch (failure) {
        setPendingFolderRefresh([]);
        throw failure;
      } finally {
        folderRefreshInFlight.current = false;
      }
    });
  });
  useEffect(() => {
    if (!pendingFolderRefresh.length || globalBusy || !hasScanned) return;
    const timer = window.setTimeout(() => runPendingFolderRefresh(), 0);
    return () => window.clearTimeout(timer);
  }, [pendingFolderRefresh, globalBusy, hasScanned]);
  function rememberRoots(roots: Partial<{ left: string; right: string }>) {
    setRootHistory((prior) => {
      const next = { ...prior };
      for (const side of ["left", "right"] as const) {
        const path = roots[side];
        if (path && path !== prior[side].paths[prior[side].index]) {
          const paths = [
            ...prior[side].paths.slice(0, prior[side].index + 1),
            path,
          ].slice(-20);
          next[side] = { paths, index: paths.length - 1 };
        }
      }
      return next;
    });
  }
  async function navigateParent(side: FolderSide, linked = false) {
    const sides = linked ? (["left", "right"] as const) : [side];
    const roots = { ...folderRoots };
    for (const target of sides)
      roots[target] = await native("parent_folder", {
        path: folderRoots[target],
      });
    rememberRoots(folderRoots);
    rememberRoots(roots);
    invalidateFolders();
    setFolderRoots(roots);
    await scan(roots);
  }
  async function navigateHistory(side: FolderSide, delta: number) {
    const history = rootHistory[side];
    const index = history.index + delta;
    const path = history.paths[index];
    if (path === undefined) return;
    invalidateFolders();
    setRootHistory((prior) => ({ ...prior, [side]: { ...history, index } }));
    const roots = { ...folderRoots, [side]: path };
    setFolderRoots(roots);
    await scan(roots);
  }
  async function normalizeFolderRoots(generation?: number, allowStale = false) {
    if (folderStale && !allowStale)
      throw new Error(
        "Folder results are stale. Refresh the current roots before using folder actions.",
      );
    const roots = await native("normalize_folder_roots", folderRoots);
    if (
      generation === undefined ||
      isCurrentFolderGeneration(folderGeneration.current, generation)
    )
      setNativeFolderRoots(roots);
    return roots;
  }
  async function createPreview(
    syncMode: string,
    selected: FolderRowId[] | null = null,
    destination: "left" | "right" = "right",
  ) {
    if (syncMode !== "update" && syncMode !== "mirror")
      throw new Error("Choose Update or Mirror before creating a preview.");
    if (folderTruncated)
      throw new Error(
        "Sync is unavailable because the scan is incomplete. Exclude large folders such as node_modules and scan again.",
      );
    if (!folderScanId.current)
      throw new Error(
        "The folder comparison is out of date. Refresh the comparison before syncing.",
      );
    if (!(await claimPreview(tab.id))) return;
    setPreview(null);
    setPreviewKind(
      selected !== null
        ? syncMode === "mirror"
          ? "selected-mirror"
          : "selected-update"
        : syncMode,
    );
    setPreviewDirection(destination);
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const result = await native("preview_sync", {
      scanId: folderScanId.current,
      mode: syncMode,
      selected,
      destination,
      jobId,
    }).catch((failure: unknown) => {
      discardPreview(tab.id);
      setPreviewKind(null);
      throw failure;
    });
    setPreview(result);
  }
  function dismissPreview() {
    if (busy) return;
    discardPreview(tab.id);
    setPreview(null);
    setPreviewKind(null);
  }
  async function executePreview() {
    if (!preview) return;
    await executeSyncPlan(preview);
  }
  async function executeSyncPlan(plan: Preview) {
    const skippedNote = plan.skipped.length
      ? ` Skipped (${plan.skipped.length}).`
      : "";
    if (!plan.operations.length) {
      discardPreview(tab.id);
      setPreview(null);
      setPreviewKind(null);
      setNotice(
        `Nothing to copy: the destination already matches.${skippedNote}`,
      );
      return;
    }
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const id = plan.id;
    discardPreview(tab.id);
    setPreview(null);
    setPreviewKind(null);
    const results = await native("execute_sync", { id, jobId });
    diskChanged([nativeFolderRoots.left, nativeFolderRoots.right], false, true);
    const failures = results.filter((r) => r.error);
    const affectedRelatives = [
      ...new Set(results.map((r) => parentFolderPath(r.relative))),
    ];
    let refreshError: unknown = null;
    if (affectedRelatives.length) {
      try {
        await refreshFolderRows(affectedRelatives);
      } catch (failure) {
        refreshError = failure;
      }
    }
    setNotice(
      `Completed ${results.length - failures.length} of ${results.length} operations.${skippedNote}`,
    );
    if (failures.length)
      throw new Error(
        failures.map((f) => `${f.relative}: ${f.error}`).join("\n"),
      );
    if (refreshError) throw refreshError;
  }
  async function mergeInputs(inputs = editors, restoring = false) {
    if (
      output !== outputSaved &&
      !restoring &&
      !(await confirmAction("Replace unsaved merge output with a new merge?"))
    )
      return;
    const result = await native("merge_text", {
      base: inputs.base.text,
      left: inputs.left.text,
      right: inputs.right.text,
      gitSession: !!gitOutput,
    });
    setBlocks(result);
    setChoices({});
    setResolutionHistory([]);
    setResolutionFuture([]);
    setActiveConflict(null);
    setOutput(
      result
        .filter(
          (b): b is Extract<Block, { kind: "resolved" }> =>
            b.kind === "resolved",
        )
        .map((b) => b.text)
        .join(""),
    );
    if (inputs.left.document && inputs.right.document && inputs.base.document)
      await recordHistory([], {
        mode: "merge",
        left: inputs.left.document.path,
        right: inputs.right.document.path,
        base: inputs.base.document.path,
      });
  }
  async function resolve(index: number, text: string) {
    if (!blocks) return;
    const generated = blocks
      .map((b, i) => (b.kind === "resolved" ? b.text : (choices[i] ?? "")))
      .join("");
    if (choices[index] === text) return;
    if (
      output !== generated &&
      !(await confirmAction(
        "Replace manual output edits with this conflict resolution?",
      ))
    )
      return;
    const updated = { ...choices, [index]: text };
    setResolutionHistory((prior) => [...prior.slice(-49), choices]);
    setResolutionFuture([]);
    setChoices(updated);
    setOutput(
      blocks
        .map((b, i) => (b.kind === "resolved" ? b.text : (updated[i] ?? "")))
        .join(""),
    );
  }
  async function restoreResolution(direction: "undo" | "redo") {
    if (!blocks) return;
    const source = direction === "undo" ? resolutionHistory : resolutionFuture;
    const previous = source.at(-1);
    if (!previous) return;
    const generated = blocks
      .map((block, index) =>
        block.kind === "resolved" ? block.text : (choices[index] ?? ""),
      )
      .join("");
    if (
      output !== generated &&
      !(await confirmAction(
        "Replace manual output edits with this conflict resolution?",
      ))
    )
      return;
    if (direction === "undo") {
      setResolutionHistory((prior) => prior.slice(0, -1));
      setResolutionFuture((prior) => [...prior.slice(-49), choices]);
    } else {
      setResolutionFuture((prior) => prior.slice(0, -1));
      setResolutionHistory((prior) => [...prior.slice(-49), choices]);
    }
    setChoices(previous);
    setOutput(
      blocks
        .map((block, index) =>
          block.kind === "resolved" ? block.text : (previous[index] ?? ""),
        )
        .join(""),
    );
  }
  function navigateConflict(direction: "previous" | "next") {
    const unresolvedIndexes =
      blocks?.flatMap((block, index) =>
        block.kind === "conflict" && choices[index] === undefined
          ? [index]
          : [],
      ) ?? [];
    if (!unresolvedIndexes.length) return;
    const currentIndex = unresolvedIndexes.indexOf(activeConflict ?? -1);
    const nextIndex =
      currentIndex < 0
        ? direction === "next"
          ? 0
          : unresolvedIndexes.length - 1
        : (currentIndex +
            (direction === "next" ? 1 : -1) +
            unresolvedIndexes.length) %
          unresolvedIndexes.length;
    const nextConflict = unresolvedIndexes[nextIndex];
    if (nextConflict === undefined) return;
    setActiveConflict(nextConflict);
    requestAnimationFrame(() =>
      conflictElements.current[nextConflict]?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      }),
    );
  }
  const unresolved =
    blocks?.filter((b, i) => b.kind === "conflict" && choices[i] === undefined)
      .length ?? 0;
  async function saveOutput() {
    if (!blocks || unresolved)
      throw new Error("Resolve all conflicts before saving output.");
    if (gitOutput && !(await confirmGitExit(tab.id))) return;
    const destination = outputDocument
      ? null
      : gitOutput || (await save({ title: "Save merge output to a new file" }));
    if (!outputDocument && !destination) return;
    const document = await native("save_document", {
      id: outputDocument?.id ?? null,
      text: output,
      destination,
      convertUtf8: false,
    });
    setOutputDocument(document);
    setOutput(document.text);
    setOutputSaved(document.text);
    setOutputRecovered(false);
    setStaleOutput(false);
    setNotice("Merge output saved.");
    diskChanged([document.path]);
    if (gitOutput)
      await native("finish_git_merge", {
        success: true,
        outputId: document.id,
        resolutions: blocks.map((b, i) =>
          b.kind === "resolved" ? null : (choices[i] ?? null),
        ),
      });
  }

  useEffect(() => {
    if (globalBusy || initialized.current) return;
    void attempt(async () => {
      initialized.current = true;
      if (mode === "folder") {
        setFolderRoots({ left: tab.left, right: tab.right });
        if (tab.left || tab.right)
          await scan({ left: tab.left, right: tab.right });
      } else {
        const inputs = { ...editors };
        if (tab.recovery) {
          if (mode === "text") await compareInputs(inputs);
          if (mode === "merge") {
            await mergeInputs(inputs, true);
            setChoices(tab.recovery.choices);
            setOutput(tab.recovery.output);
          }
          return;
        }
        if (tab.base)
          inputs.base = (await load("base", tab.base)) ?? inputs.base;
        if (tab.left)
          inputs.left = (await load("left", tab.left)) ?? inputs.left;
        if (tab.right)
          inputs.right = (await load("right", tab.right)) ?? inputs.right;
        if (mode === "text" && tab.left && tab.right)
          await compareInputs(inputs);
        if (mode === "merge" && tab.base && tab.left && tab.right && !gitOutput)
          await mergeInputs(inputs);
        if (gitOutput) {
          const document = await native("open_git_output");
          if (document) {
            setOutputDocument(document);
            setOutput(document.text);
            setOutputSaved(document.text);
          }
        }
      }
    });
    // Each stable tab initializes once; all subsequent commands use its controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalBusy]);

  const titleLeft = fileName(
    mode === "folder"
      ? folderRoots.left
      : editors.left.document?.path || editors.left.path,
  );
  const titleRight = fileName(
    mode === "folder"
      ? folderRoots.right
      : editors.right.document?.path || editors.right.path,
  );
  const title = tab.sessionName
    ? tab.sessionName
    : titleLeft || titleRight
      ? `${titleLeft || "Untitled"} / ${titleRight || "Untitled"}`
      : mode === "folder"
        ? "Folder Compare"
        : mode === "merge"
          ? "3-Way Merge"
          : "Text Compare";
  const dirty =
    Object.values(editors).some((e) => e.recovered || e.text !== e.original) ||
    outputRecovered ||
    output !== outputSaved;
  const undoLeft = !!editors.left.history.length;
  const undoRight = !!editors.right.history.length;
  const redoLeft = !!editors.left.future.length;
  const redoRight = !!editors.right.future.length;
  const differenceCount = changes.length;
  const canSaveOutput = mode === "merge" && blocks !== null && unresolved === 0;
  useEffect(() => {
    report(tab.id, {
      title,
      dirty,
      error,
      undoLeft,
      undoRight,
      redoLeft,
      redoRight,
      differences: differenceCount,
      canSaveOutput,
      status: working
        ? `Working... ${progress} entries scanned`
        : notice || "Ready",
    });
  }, [
    tab.id,
    title,
    dirty,
    error,
    notice,
    working,
    progress,
    report,
    undoLeft,
    undoRight,
    redoLeft,
    redoRight,
    differenceCount,
    canSaveOutput,
  ]);
  useLayoutEffect(() => {
    register(tab.id, {
      dirty: () =>
        Object.values(latest.current.editors).some(
          (e) => e.recovered || e.text !== e.original,
        ) ||
        latest.current.outputRecovered ||
        latest.current.output !== latest.current.outputSaved,
      dispose: async () => {
        invalidate();
        for (const side of ["left", "right", "base"] as const) {
          const document = latest.current.editors[side].document;
          if (document) {
            await native("close_document", { id: document.id });
            setEditors((prior) => ({
              ...prior,
              [side]: { ...prior[side], document: null },
            }));
          }
        }
        if (outputDocument) {
          await native("close_document", { id: outputDocument.id });
          setOutputDocument(null);
        }
      },
      recoverySnapshot: (): DraftRecovery | null => {
        const current = latest.current;
        if (
          (mode !== "text" && mode !== "merge") ||
          current.gitOutput ||
          !(
            Object.values(current.editors).some(
              (e) => e.recovered || e.text !== e.original,
            ) ||
            current.outputRecovered ||
            current.output !== current.outputSaved
          )
        )
          return null;
        return {
          id: tab.recoveryId ?? tab.id,
          updatedAt: 0,
          mode,
          leftPath:
            current.editors.left.document?.path ?? current.editors.left.path,
          rightPath:
            current.editors.right.document?.path ?? current.editors.right.path,
          basePath:
            current.editors.base.document?.path ?? current.editors.base.path,
          leftText: current.editors.left.text,
          rightText: current.editors.right.text,
          baseText: mode === "merge" ? current.editors.base.text : "",
          output: mode === "merge" ? current.output : "",
          choices: mode === "merge" ? current.choices : {},
        };
      },
      drop: async (paths) => {
        await attempt(async () => {
          if (mode === "folder") {
            invalidateFolders();
            const roots = {
              left: paths[0] ?? folderRoots.left,
              right: paths[1] ?? folderRoots.right,
            };
            setFolderRoots(roots);
            await scan(roots);
          } else {
            if (!(await discard("left")) || !(await discard("right"))) return;
            if (paths[0]) await load("left", paths[0], null, false);
            if (paths[1]) await load("right", paths[1], null, false);
          }
        });
      },
      progress: (jobId, count) => {
        if (activeJob.current === jobId) setProgress(count);
      },
      cancel: async () => {
        const jobId = activeJob.current;
        if (jobId) await native("cancel_job", { jobId });
        else throw new Error("This operation cannot currently be cancelled.");
      },
      clearPreview: () => {
        setPreview(null);
      },
      diskChanged: (paths, refreshFolders = false, folderRefreshed = false) => {
        const affected = (path: string) =>
          paths.some((changed) => relatedPaths(path, changed));
        const changedSides = (["left", "right", "base"] as const).filter(
          (side) => affected(editors[side].document?.path ?? ""),
        );
        if (changedSides.length)
          setStaleSides((prior) => [...new Set([...prior, ...changedSides])]);
        if (affected(outputDocument?.path ?? "")) setStaleOutput(true);
        const affectedFolderRoots =
          mode === "folder" &&
          (affected(folderRoots.left) ||
            affected(folderRoots.right) ||
            affected(nativeFolderRoots.left) ||
            affected(nativeFolderRoots.right));
        if (affectedFolderRoots && !folderRefreshed) {
          const canRefreshSelection =
            refreshFolders &&
            hasScanned &&
            Boolean(nativeFolderRoots.left && nativeFolderRoots.right) &&
            (!folderStale || folderRefreshInFlight.current);
          if (canRefreshSelection) {
            const affectedPaths = paths.filter(
              (path) =>
                relatedPaths(nativeFolderRoots.left, path) ||
                relatedPaths(nativeFolderRoots.right, path),
            );
            setPendingFolderRefresh((prior) => [
              ...new Set([...prior, ...affectedPaths]),
            ]);
          } else {
            markStale("external-change");
          }
        }
        if (
          affected(folderRoots.left) ||
          affected(folderRoots.right) ||
          affected(nativeFolderRoots.left) ||
          affected(nativeFolderRoots.right) ||
          Object.values(editors).some((e) =>
            affected(e.document?.path ?? ""),
          ) ||
          affected(outputDocument?.path ?? "")
        ) {
          discardPreview(tab.id);
          setPreview(null);
          if (!refreshFolders || !affectedFolderRoots)
            setNotice(
              folderRefreshed
                ? "Files changed. Folder summaries were refreshed; drafts are retained."
                : "Files changed on disk. Rescan folders or reopen inputs to refresh; drafts are retained.",
            );
        }
      },
      command: (name) => {
        if (
          name === "sessions" ||
          name === "save-session" ||
          name === "save-session-as" ||
          name === "recheck-disk" ||
          name === "profiles" ||
          name === "find" ||
          name === "replace" ||
          name === "goto"
        )
          controllersCommand(name);
        else if (name === "run")
          void attempt(() =>
            mode === "folder"
              ? scan(undefined, undefined, undefined, true)
              : mode === "merge"
                ? mergeInputs()
                : compareInputs(),
          );
        else if (name === "previous" || name === "next") {
          navigateDifference(name === "next" ? 1 : -1);
        } else if (name === "rules" && mode === "folder") {
          setRulesOpen(true);
        } else if (
          name === "rules" ||
          name === "preferences" ||
          name === "details"
        ) {
          const panel = rootElement.current?.querySelector<HTMLDetailsElement>(
            `[data-panel="${name}"]`,
          );
          if (panel) {
            panel.open = !panel.open;
            panel.querySelector("summary")?.focus();
          }
        } else if (name === "legend") setShowLegend((prior) => !prior);
        else if (name === "save-output") void attempt(saveOutput);
        else if (name === "swap") {
          swapInputs();
        } else {
          const [action, side] = name.split(":");
          if (side !== "left" && side !== "right" && side !== "base") return;
          if (action === "browse") void attempt(() => loadDialog(side));
          else if (action === "save") void attempt(() => saveSide(side));
          else if (action === "undo" && !busy)
            void attempt(() => undoSide(side));
          else if (action === "redo" && !busy)
            void attempt(() => redoSide(side));
        }
      },
    });
  });
  useEffect(() => () => register(tab.id, null), [register, tab.id]);

  function renderEditor(side: Side) {
    const e = editors[side];
    return (
      <section className="editor" key={side}>
        <div className="pane-heading">
          <h3 title={e.document?.path || e.path}>
            {side === "base"
              ? "Base / common ancestor"
              : side === "left"
                ? "Left"
                : "Right"}
            {mode !== "folder" &&
              `: ${fileName(e.document?.path || e.path) || "Untitled"}`}
          </h3>
          <span
            className={
              e.recovered || e.text !== e.original ? "badge unsaved" : "badge"
            }
          >
            {mode === "folder"
              ? "Folder"
              : e.recovered || e.text !== e.original
                ? "Unsaved"
                : e.document
                  ? "Saved"
                  : "Draft"}
          </span>
        </div>
        <div className="path-row">
          <div className="path-label">
            <span className="sr-only">
              {mode === "folder" && side !== "base"
                ? "Folder path"
                : "File path"}
            </span>
            {mode === "folder" && side !== "base" ? (
              <PathInput
                kind="folder"
                side={side}
                value={folderRoots[side]}
                recent={settings.recentFolders ?? []}
                disabled={busy}
                onPathChange={(path) => {
                  invalidateFolders();
                  setFolderRoots((prior) => ({ ...prior, [side]: path }));
                }}
                onChoose={(path) =>
                  void attempt(() => chooseFolder(side, path))
                }
                onSaveHistory={(paths) =>
                  void attempt(() => saveFolderHistory(paths))
                }
              />
            ) : (
              <PathInput
                kind="file"
                side={side}
                value={e.path}
                recent={settings.recent}
                disabled={busy}
                onPathChange={(path) =>
                  setEditors((prior) => ({
                    ...prior,
                    [side]: { ...prior[side], path },
                  }))
                }
                onChoose={(path) => {
                  // PathInput calls onChoose only from click/keyboard handlers.
                  // eslint-disable-next-line react-hooks/refs
                  void attempt(() => openRecent(side, path));
                }}
              />
            )}
          </div>
          <div className="toolbar compact">
            {mode === "folder" && side !== "base" && (
              <>
                <button
                  aria-label={`Back ${side}`}
                  title="Navigate back in this side's path history"
                  disabled={busy || rootHistory[side].index === 0}
                  onClick={() => void attempt(() => navigateHistory(side, -1))}
                >
                  <Icon name="chevronLeft" />
                </button>
                <button
                  aria-label={`Forward ${side}`}
                  title="Navigate forward in this side's path history"
                  disabled={
                    busy ||
                    rootHistory[side].index + 1 >=
                      rootHistory[side].paths.length
                  }
                  onClick={() => void attempt(() => navigateHistory(side, 1))}
                >
                  <Icon name="chevronRight" />
                </button>
                <button
                  aria-label={`Parent ${side}`}
                  title="Navigate to this folder's parent"
                  disabled={busy || !folderRoots[side]}
                  onClick={() => void attempt(() => navigateParent(side))}
                >
                  <Icon name="arrowUp" />
                  <span className="btn-text">Up</span>
                </button>
                <button
                  aria-label={`Linked parents ${side}`}
                  title="Navigate both roots to their parents together"
                  disabled={busy || !folderRoots.left || !folderRoots.right}
                  onClick={() => void attempt(() => navigateParent(side, true))}
                >
                  <Icon name="arrowUp" />
                  <span className="btn-text">Both up</span>
                </button>
              </>
            )}
            <button
              aria-label={`Browse ${side}`}
              title={`Choose a ${mode === "folder" ? "folder" : "file"} for the ${side} input`}
              disabled={busy}
              onClick={() => void attempt(() => loadDialog(side))}
            >
              <Icon name="openFolder" />
              <span className="btn-text">Browse</span>
            </button>
            {mode !== "folder" && (
              <>
                <button
                  aria-label={`Open ${side}`}
                  title={`Open the typed ${side} file path; dirty drafts require confirmation`}
                  disabled={busy || !e.path}
                  onClick={() => void attempt(() => openSide(side))}
                >
                  <Icon name="check" />
                  <span className="btn-text">Open</span>
                </button>
                <button
                  aria-label={`Save ${side}`}
                  title={`Save the ${side} draft with stale-file checks (Ctrl+S in this editor)`}
                  disabled={busy}
                  onClick={() => void attempt(() => saveSide(side))}
                >
                  <Icon name="save" />
                  <span className="btn-text">Save</span>
                </button>
                <button
                  aria-label={`Save ${side} As`}
                  title="Save a new file without overwriting an existing file"
                  disabled={busy}
                  onClick={() => void attempt(() => saveSide(side, true))}
                >
                  <Icon name="saveAs" />
                  <span className="btn-text">Save As</span>
                </button>
                <button
                  aria-label={`Undo ${side}`}
                  title={`Undo the previous ${side} draft change`}
                  disabled={busy || !e.history.length}
                  onClick={() => void attempt(() => undoSide(side))}
                >
                  <Icon name="undo" />
                  <span className="btn-text">Undo</span>
                </button>
                <button
                  aria-label={`Redo ${side}`}
                  title={`Redo the previous ${side} draft change`}
                  disabled={busy || !e.future.length}
                  onClick={() => void attempt(() => redoSide(side))}
                >
                  <Icon name="redo" />
                  <span className="btn-text">Redo</span>
                </button>
                <details className="file-options">
                  <summary>
                    <Icon name="more" />
                    <span className="btn-text">More</span>
                  </summary>
                  <div className="toolbar compact">
                    <button
                      disabled={busy || !e.path}
                      onClick={() =>
                        void attempt(async () => {
                          const encoding = window.prompt(
                            "Encoding label (for example windows-1252 or utf-16le):",
                          );
                          if (encoding) await openSide(side, encoding);
                        })
                      }
                    >
                      Encoding...
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void attempt(async () => {
                          if (
                            await confirmAction(
                              "Convert to UTF-8 and save to a new file?",
                            )
                          )
                            await saveSide(side, true, true);
                        })
                      }
                    >
                      UTF-8 copy
                    </button>
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
        {mode !== "folder" && (
          <>
            <div className="metadata">
              <span>
                {fileMetadata[side]
                  ? `${fileMetadata[side]?.bytes.toLocaleString()} bytes / ${fileMetadata[side]?.modified == null ? "time unavailable" : new Date(fileMetadata[side]!.modified!).toLocaleString()} / `
                  : ""}
                {e.document?.encoding ?? "UTF-8 draft"}{" "}
                {e.document?.bom ? "/ BOM" : ""} /{" "}
                {(e.document?.text ?? e.text).includes("\r\n")
                  ? "CRLF"
                  : (e.document?.text ?? e.text).includes("\r")
                    ? "CR"
                    : "LF"}{" "}
                {e.text !== e.original ? "/ unsaved" : ""}
                {staleSides.includes(side)
                  ? " / disk changed; draft retained"
                  : ""}
              </span>
              {staleSides.includes(side) && (
                <button
                  aria-label={`Review ${side} disk change`}
                  disabled={busy}
                  onClick={() => reviewDiskChange(side)}
                >
                  Review disk change
                </button>
              )}
            </div>
            <div className="editor-content">
              <span className="sr-only">
                {side === "left"
                  ? "Left text"
                  : side === "right"
                    ? "Right text"
                    : "Base text"}
              </span>
              <CodeEditor
                text={e.text}
                disabled={busy}
                label={
                  side === "left"
                    ? "Left text"
                    : side === "right"
                      ? "Right text"
                      : "Base text"
                }
                onChange={(text) => change(side, text)}
                selection={
                  side !== "base" && searchSelection?.side === side
                    ? searchSelection
                    : undefined
                }
                onSelectLine={
                  mode === "text" && side !== "base" && pendingEdit === null
                    ? (line) => {
                        setActiveEditorSide(side);
                        setCursorLines((prior) => ({ ...prior, [side]: line }));
                        const index = aligned.findIndex(
                          (row) => row[side] === line,
                        );
                        if (index >= 0) setDetailRow(index);
                      }
                    : undefined
                }
                onLineNumberClick={
                  mode === "text" && side !== "base"
                    ? (line) => enterSingleLineCopyMode(side, line)
                    : undefined
                }
                onEditorContentClick={
                  mode === "text" && side !== "base"
                    ? () => setSingleLineCopy(null)
                    : undefined
                }
                onCopyDirection={
                  mode === "text" && side !== "base"
                    ? (destination) => copySelectedDifference(destination)
                    : undefined
                }
                onUndo={() => {
                  if (!busy) void attempt(() => undoSide(side));
                }}
                onRedo={() => {
                  if (!busy) void attempt(() => redoSide(side));
                }}
                displayMode={mode === "text" ? textFilter : "all"}
                showWhitespace={mode === "text" && showWhitespace}
                intralineRegions={
                  mode === "text" && side !== "base"
                    ? intralineRegionsFor(side)
                    : undefined
                }
                differences={
                  mode === "text" && side !== "base"
                    ? (spans ?? noDifferences)
                    : noDifferences
                }
                side={side === "right" ? "right" : "left"}
                selectedDifference={mode === "text" ? selected : undefined}
                onCopyDifference={
                  mode === "text" && side !== "base" && pendingEdit === null
                    ? (span, line) =>
                        void attempt(() => copyDifference(side, span, line))
                    : undefined
                }
                singleLineCopy={singleLineCopy ?? undefined}
                gaps={
                  mode === "text" && side !== "base"
                    ? editorGaps[side]
                    : undefined
                }
                selectedLine={
                  mode === "text" && side !== "base" && selected
                    ? side === "left"
                      ? selected.leftStart
                      : selected.rightStart
                    : undefined
                }
                moveCaretOnNavigation={
                  side !== "base" && side === activeEditorSide
                }
                navigation={navigation}
                scrollTop={
                  mode === "text" && side !== "base" ? scrollTop : undefined
                }
                onScroll={
                  mode === "text" && side !== "base" ? setScrollTop : undefined
                }
              />
            </div>
          </>
        )}
      </section>
    );
  }
  const filteredFolders = useMemo(
    () =>
      folders.filter(
        (row) =>
          peek ||
          (matchesName(row.relative, quickFilter || "*") &&
            (showMinor || row.importance !== "unimportant") &&
            !ignored.has(row.relative)),
      ),
    [folders, peek, quickFilter, showMinor, ignored],
  );
  const visibleIndex = useMemo(
    () =>
      visibleFolderIndex(
        filteredFolders,
        peek ? "all" : filter,
        peek ? "all" : filesVisible,
        excludedFiles,
        excludedDirectories,
      ),
    [
      filteredFolders,
      peek,
      filter,
      filesVisible,
      excludedFiles,
      excludedDirectories,
    ],
  );
  const visibleFolderCount = visibleIndex.size;
  const selectedVisibleCount = useMemo(
    () => countVisibleSelection(selectedFiles, visibleIndex),
    [selectedFiles, visibleIndex],
  );
  async function openPair(row: FolderEntry) {
    if (row.leftKind !== "file" || row.rightKind !== "file")
      throw new Error("Only file-to-file pairs can be opened in Text Compare.");
    const left = await join(
      folderRoots.left,
      ...(row.leftRelative ?? row.relative).split("/"),
    );
    const right = await join(
      folderRoots.right,
      ...(row.rightRelative ?? row.relative).split("/"),
    );
    openTab("text", { left, right, parent: tab.id });
  }
  function folderAction(
    action: string,
    entries: FolderEntry[],
    side: FolderSide,
  ) {
    if (busy) {
      setError("Wait for the active operation to finish.");
      return;
    }
    if (
      folderStale &&
      ![
        "compareContents",
        "copyFilename",
        "ignored",
        "openWith",
        "reveal",
      ].includes(action)
    ) {
      setError(
        "Folder results are stale. Refresh the current roots before using this action.",
      );
      return;
    }
    if (
      action === "openWith" &&
      entries.some(
        (entry) =>
          (side === "left" ? entry.leftKind : entry.rightKind) !== "file",
      )
    ) {
      setError("Open With requires a file on the selected side.");
      return;
    }
    if (!entries.length && action !== "mkdir" && action !== "synchronize") {
      setError("Select one or more folder entries first.");
      return;
    }
    if (
      action === "compareContents" &&
      sharedSettings.contentComparison?.prompt === false
    ) {
      const preference = sharedSettings.contentComparison;
      void attempt(() =>
        compareSelectedContents(
          entries,
          preference.method,
          preference.showResults,
        ),
      );
      return;
    }
    if (action === "refresh") {
      void attempt(async () => {
        if (folderStale)
          throw new Error(
            "The roots or rules changed. Run a full refresh before refreshing a selection.",
          );
        const generation = folderGeneration.current;
        try {
          discardPreview(tab.id);
          setPreview(null);
          await normalizeFolderRoots(generation);
          if (!isCurrentFolderGeneration(folderGeneration.current, generation))
            return;
          const refreshedRows = await refreshFolderRows(
            entries.map((entry) => entry.relative),
          );
          if (!isCurrentFolderGeneration(folderGeneration.current, generation))
            return;
          if (refreshedRows) {
            const refreshedKeys = new Set(folderSelectionKeys(refreshedRows));
            setSelectedFiles(
              (prior) =>
                new Set([...prior].filter((key) => refreshedKeys.has(key))),
            );
          }
          setNotice(
            `Refreshed ${entries.length} selected entries, their descendants, and affected directory summaries.`,
          );
        } catch (failure) {
          if (!isCurrentFolderGeneration(folderGeneration.current, generation))
            return;
          throw failure;
        }
      });
      return;
    }
    if (action === "attributes") {
      void attempt(async () => {
        const metadata = await Promise.all(
          entries.map(async (entry) => {
            const relative =
              side === "left" ? entry.leftRelative : entry.rightRelative;
            if (!relative) throw new Error(`The ${side} entry is missing.`);
            const path = await join(folderRoots[side], ...relative.split("/"));
            return { path, ...(await native("path_metadata", { path })) };
          }),
        );
        setActionMetadata(metadata);
        setDialogValue(
          metadata.every((item) => item.readOnly)
            ? "readonly"
            : metadata.every((item) => !item.readOnly)
              ? "writable"
              : "",
        );
        setFolderDialog({ action, entries, side });
      });
      return;
    }
    if (action === "synchronize") {
      setDialogValue("update");
      setFolderDialog({ action, entries, side });
      return;
    }
    if (action === "ignored") {
      setIgnored((prior) => {
        const next = new Set(prior);
        for (const entry of entries)
          if (next.has(entry.relative)) next.delete(entry.relative);
          else next.add(entry.relative);
        return next;
      });
      setNotice(
        "Display-ignore state changed. Peek reveals hidden rows; native write checks are unchanged.",
      );
      return;
    }
    if (action === "exclude") {
      const nextFiles = new Set(excludedFiles);
      const nextDirectories = new Set(excludedDirectories);
      for (const entry of entries) {
        const kind = side === "left" ? entry.leftKind : entry.rightKind;
        if (kind === "file") nextFiles.add(entry.relative);
        else if (kind === "directory") nextDirectories.add(entry.relative);
      }
      if (
        nextFiles.size === excludedFiles.size &&
        nextDirectories.size === excludedDirectories.size
      ) {
        setError(`The ${side} side has no file or folder entry to exclude.`);
        return;
      }
      setExcludedFiles(nextFiles);
      setExcludedDirectories(nextDirectories);
      invalidateFolders();
      void attempt(() =>
        scan(
          folderRoots,
          folderOptions({
            excludeFiles: [...nextFiles],
            excludeDirectories: [...nextDirectories],
          }),
        ),
      );
      return;
    }
    if (action === "openWith" || action === "reveal") {
      void attempt(async () => {
        const paths = await Promise.all(
          entries.map(async (entry) => {
            if ((side === "left" ? entry.leftSize : entry.rightSize) === null)
              throw new Error(`The ${side} entry is missing.`);
            return join(
              folderRoots[side],
              ...(
                (side === "left" ? entry.leftRelative : entry.rightRelative) ??
                entry.relative
              ).split("/"),
            );
          }),
        );
        if (action === "reveal") {
          if (paths.length !== 1)
            throw new Error("Select one entry to reveal in the file manager.");
          await native("reveal_path", { path: paths[0]! });
        } else {
          if (paths.length !== 1)
            throw new Error("Select one file to open with an application.");
          const application = await open({
            title: "Select an application executable",
            multiple: false,
            directory: false,
          });
          if (
            typeof application === "string" &&
            (await confirmAction(
              "Open the selected file with this external application? The application receives the file path.",
            ))
          )
            await native("open_with", { path: paths[0]!, application });
        }
      });
      return;
    }
    setDialogValue(
      action === "touch"
        ? new Date(
            new Date().getTime() - new Date().getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : action === "copyFilename"
          ? "paths"
          : action === "rename"
            ? ((side === "left"
                ? entries[0]?.leftRelative
                : entries[0]?.rightRelative
              )
                ?.split("/")
                .at(-1) ?? "")
            : "",
    );
    setFolderDialog({ action, entries, side });
  }
  async function compareSelectedContents(
    entries: FolderEntry[],
    method: "binary" | "rules" | "crc",
    showResults: boolean,
  ) {
    const generation = folderGeneration.current;
    try {
      const roots = await normalizeFolderRoots(generation, true);
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
      const jobId = crypto.randomUUID();
      startJob(jobId);
      const compared = await native("compare_folder_selection", {
        ...roots,
        options: folderOptions(),
        rules: {
          ...folderRules,
          content: method,
          quickTest: "none",
          quickTestPolicy: "override",
          compareSize: false,
          compareModified: false,
        },
        selected: entries.map((entry) => entry.relative),
        jobId,
      });
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
      const selectedScope = selectionScope(entries);
      const underSelection = (relative: string) =>
        isWithinSelection(relative, selectedScope);
      const comparedRows = compared.entries.filter((entry) =>
        underSelection(entry.relative),
      );
      setFolders((prior) =>
        applyFolderPatch(
          prior.filter((entry) => !underSelection(entry.relative)),
          { removed: [], upserted: comparedRows },
        ),
      );
      setFolderTruncated(compared.truncated);
      const selectedResults = comparedRows.filter((entry) =>
        isWithinSelection(entry.relative, selectedScope),
      );
      if (showResults) setContentResults(selectedResults);
      setFolderDialog(null);
      setNotice(
        `Compared ${selectedResults.length} selected entries. ${selectedResults.filter((entry) => entry.status === "error").length} errors.`,
      );
    } catch (failure) {
      if (!isCurrentFolderGeneration(folderGeneration.current, generation))
        return;
      throw failure;
    }
  }
  async function prepareFolderAction() {
    if (!folderDialog) return;
    const { action, side } = folderDialog;
    const transfersEntries =
      action === "copySide" ||
      action === "moveSide" ||
      action === "copyFolder" ||
      action === "moveFolder";
    const { entries, skipped: skippedLinks } = transfersEntries
      ? withoutLinkedSource(folderDialog.entries, side)
      : { entries: folderDialog.entries, skipped: 0 };
    if (transfersEntries && folderDialog.entries.length > 0 && !entries.length)
      throw new Error("Links are not copied.");
    if (action === "copyFilename") {
      const values = await Promise.all(
        entries.map(async (entry) => {
          const relative =
            side === "left" ? entry.leftRelative : entry.rightRelative;
          if (!relative) throw new Error(`The ${side} entry is missing.`);
          return dialogValue === "names"
            ? relative.split("/").at(-1)!
            : dialogValue === "relative"
              ? relative
              : join(folderRoots[side], ...relative.split("/"));
        }),
      );
      await navigator.clipboard.writeText(values.join("\n"));
      setNotice(`Copied ${values.length} ${dialogValue} to the clipboard.`);
      setFolderDialog(null);
      return;
    }
    if (action === "compareContents") {
      await compareSelectedContents(entries, contentMethod, showContentResults);
      updateSettings((prior) => ({
        ...prior,
        contentComparison: {
          method: contentMethod,
          showResults: showContentResults,
          prompt: !dontPromptContents,
        },
      }));
      return;
    }
    if (action === "synchronize") {
      if (
        entries.some(
          (entry) =>
            (entry.leftRelative && entry.leftRelative !== entry.relative) ||
            (entry.rightRelative && entry.rightRelative !== entry.relative),
        )
      )
        throw new Error(
          "Aligned names require an explicit Copy to Folder destination; synchronization does not guess alternate destination names.",
        );
      const selectedRows = entries.length
        ? entries.map((entry) => ({
            relative: entry.relative,
            isDirectory: entry.isDirectory,
          }))
        : null;
      setFolderDialog(null);
      await createPreview(
        dialogValue,
        selectedRows,
        side === "left" ? "right" : "left",
      );
      return;
    }
    const sources = await Promise.all(
      entries.map((entry) => {
        if ((side === "left" ? entry.leftSize : entry.rightSize) === null)
          throw new Error(`Selected entry is missing on the ${side}.`);
        return join(
          folderRoots[side],
          ...(
            (side === "left" ? entry.leftRelative : entry.rightRelative) ??
            entry.relative
          ).split("/"),
        );
      }),
    );
    let request: LocalActionRequest;
    let includedThroughParent = 0;
    const source = sources[0];
    if (action === "recycle") request = { kind: "recycle", sources };
    else if (action === "rename" && source && sources.length === 1)
      request = { kind: "rename", source, name: dialogValue };
    else if (action === "mkdir")
      request = {
        kind: "createDirectory",
        parent: entries[0]?.isDirectory && source ? source : folderRoots[side],
        name: dialogValue,
      };
    else if (action === "attributes") {
      if (!["readonly", "writable"].includes(dialogValue))
        throw new Error(
          "Choose the read-only attribute to apply to the mixed selection.",
        );
      request = {
        kind: "setReadOnly",
        sources,
        readonly: dialogValue === "readonly",
      };
    } else if (action === "touch") {
      const modifiedMs = new Date(dialogValue).getTime();
      if (!Number.isSafeInteger(modifiedMs) || modifiedMs < 0)
        throw new Error(
          "Choose a valid timestamp on or after January 1, 1970.",
        );
      request = { kind: "touch", sources, modifiedMs };
    } else if (action === "copySide" || action === "moveSide") {
      const opposite = side === "left" ? "right" : "left";
      const requests: LocalActionRequest[] = [];
      const sourceDirectories = new Map(
        folders.flatMap((entry) => {
          const sourceKind = side === "left" ? entry.leftKind : entry.rightKind;
          const sourceRelative =
            side === "left" ? entry.leftRelative : entry.rightRelative;
          return sourceKind === "directory" && sourceRelative
            ? [[sourceRelative, entry] as const]
            : [];
        }),
      );
      const selectedScope = selectionScope(entries);
      for (const [index, entry] of entries.entries()) {
        if (hasSelectedAncestor(entry.relative, selectedScope)) {
          includedThroughParent += 1;
          continue;
        }
        const sourceRelative =
          (side === "left" ? entry.leftRelative : entry.rightRelative) ??
          entry.relative;
        const alignedTargetRelative =
          opposite === "left" ? entry.leftRelative : entry.rightRelative;
        const targetRelative =
          alignedTargetRelative ??
          targetRelativeFor(folders, sourceRelative, side, sourceDirectories);
        requests.push({
          kind: action === "copySide" ? "copyTo" : "moveTo",
          source: sources[index]!,
          destination: await join(
            folderRoots[opposite],
            ...targetRelative.split("/"),
          ),
          overwrite: true,
        });
      }
      request = { kind: "batch", requests };
    } else if (action === "copyFolder" || action === "moveFolder") {
      const destination = dialogValue;
      if (!destination) throw new Error("Choose a destination folder first.");
      request = {
        kind: action === "copyFolder" ? "copy" : "move",
        sources,
        destination,
        overwrite: true,
      };
    } else throw new Error("Choose a supported filesystem action.");
    if (!(await claimPreview(tab.id))) return;
    setPreview(null);
    const jobId = crypto.randomUUID();
    startJob(jobId);
    let result: LocalPreview;
    try {
      result = await native("preview_local_action", { request, jobId });
    } catch (failure) {
      discardPreview(tab.id);
      throw failure;
    }
    setFolderDialog(null);
    const skipNotes = [
      skippedLinks ? `Links are not copied; ${skippedLinks} skipped.` : "",
      includedThroughParent
        ? `${includedThroughParent} items are included through their parent folder.`
        : "",
      ...result.skipped.map(
        (skip) =>
          `Batch item ${skip.requestIndex + 1} skipped: ${skip.message}`,
      ),
    ].filter(Boolean);
    const skipSuffix = skipNotes.length ? ` ${skipNotes.join(" ")}` : "";
    if (!result.operations.length) {
      discardPreview(tab.id);
      setNotice(
        `Nothing to change: the destination already matches.${skipSuffix}`,
      );
      return;
    }
    const { failures } = await executeLocalPlan(result, skipSuffix);
    if (failures.length) throw new Error(failures.join("\n"));
  }
  async function executeLocalPlan(plan: LocalPreview, skipSuffix = "") {
    discardPreview(tab.id);
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const results = await native("execute_local_action", {
      id: plan.id,
      jobId,
    });
    const paths = plan.operations.flatMap((operation) =>
      [operation.source, operation.destination].filter(
        (path): path is string => path !== null,
      ),
    );
    diskChanged(paths, false, true);
    const affected = affectedFolders(
      results.map((item) => item.operation),
      nativeFolderRoots,
    );
    let refreshError: unknown = null;
    const refreshPaths = affected.folders;
    if (refreshPaths.length) {
      try {
        await refreshFolderRows(refreshPaths);
      } catch (failure) {
        refreshError = failure;
      }
    }
    if (affected.unmapped) markStale("unmapped-change");
    const failures = results
      .filter((item) => item.result.status !== "completed")
      .map(
        (item) =>
          `${item.operation.source ?? item.operation.destination}: ${item.result.message ?? item.result.status}`,
      );
    if (refreshError) {
      const message = errorMessage(refreshError);
      if (failures.length) failures.push(message);
      else throw refreshError;
    }
    setNotice(
      `Completed ${results.length - failures.length} of ${results.length} local actions.${skipSuffix}`,
    );
    return { total: results.length, failures };
  }
  const inputs = (
    <section
      className={`panes ${mode === "merge" ? "three" : mode === "folder" ? "folder-inputs" : ""}`}
      aria-label={mode === "folder" ? "Folder inputs" : "Text inputs"}
      style={
        mode === "text"
          ? ({ "--pane-left": `${split}%` } as CSSProperties)
          : undefined
      }
    >
      {mode === "text" && (
        <nav className="difference-rail" aria-label="Difference overview">
          {changes.map((span, index) => (
            <button
              key={index}
              aria-label={`Go to difference ${index + 1}`}
              title={`Difference ${index + 1}: left line ${span.leftStart + 1}, right line ${span.rightStart + 1}`}
              aria-pressed={index === current}
              disabled={busy}
              style={{
                top: `${(100 * Math.min(span.leftStart, span.rightStart)) / Math.max(leftLines.length, rightLines.length, 1)}%`,
              }}
              onClick={() => selectDifference(index)}
            />
          ))}
        </nav>
      )}
      {mode === "merge" && renderEditor("base")}
      {renderEditor("left")}
      {mode === "text" && (
        <div
          className="pane-divider"
          role="separator"
          aria-label="Resize comparison panes"
          aria-orientation="vertical"
          tabIndex={0}
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={split}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setSplit((prior) =>
                Math.max(
                  25,
                  Math.min(75, prior + (event.key === "ArrowLeft" ? -2 : 2)),
                ),
              );
            }
          }}
          onPointerDown={(event) =>
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const box =
              event.currentTarget.parentElement?.getBoundingClientRect();
            if (box)
              setSplit(
                Math.max(
                  25,
                  Math.min(75, ((event.clientX - box.left) / box.width) * 100),
                ),
              );
          }}
          onPointerUp={(event) =>
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        />
      )}
      {renderEditor("right")}
    </section>
  );
  return (
    <main
      ref={rootElement}
      className={`comparison-workspace ${mode}-workspace`}
      id={`workspace-${tab.id}`}
      aria-label={`${mode} comparison workspace`}
      onKeyDownCapture={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("dialog")
        )
          return;
        if (busy || !active) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          ["f", "h", "g"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          const key = event.key.toLowerCase();
          setSearchMode(
            key === "h" ? "replace" : key === "g" ? "goto" : "find",
          );
          return;
        }
        if (mode === "text" && event.key === "F3") {
          event.preventDefault();
          const direction = event.shiftKey ? -1 : 1;
          setSearchMode("find");
          setSearchRequest({
            token: ++searchRequestToken.current,
            direction,
          });
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key === "Enter" &&
          (mode === "text" || mode === "folder" || mode === "merge")
        ) {
          event.preventDefault();
          void attempt(() =>
            mode === "folder"
              ? scan(undefined, undefined, undefined, true)
              : mode === "merge"
                ? mergeInputs()
                : compareInputs(),
          );
        } else if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          const label =
            event.target instanceof HTMLElement
              ? event.target.closest("[aria-label]")?.getAttribute("aria-label")
              : null;
          if (mode === "merge" && label === "Merge output")
            void attempt(saveOutput);
          else if (label === "Left text") void attempt(() => saveSide("left"));
          else if (label === "Right text")
            void attempt(() => saveSide("right"));
          else if (label === "Base text") void attempt(() => saveSide("base"));
        } else if (
          mode === "text" &&
          event.altKey &&
          changes.length &&
          (event.key === "ArrowDown" || event.key === "ArrowUp")
        ) {
          event.preventDefault();
          navigateDifference(event.key === "ArrowDown" ? 1 : -1);
        } else if (
          mode === "text" &&
          event.altKey &&
          changes.length &&
          (event.key === "ArrowRight" || event.key === "ArrowLeft")
        ) {
          event.preventDefault();
          copyCurrentDifference(event.key === "ArrowRight" ? "right" : "left");
        }
      }}
    >
      {rulesOpen && (
        <FolderRulesDialog
          rules={folderRules}
          exclusions={exclude}
          excludedFiles={[...excludedFiles]}
          excludedDirectories={[...excludedDirectories]}
          onClose={() => setRulesOpen(false)}
          onApply={(
            next,
            exclusions,
            filePaths,
            directoryPaths,
            makeDefault,
          ) => {
            const options = folderOptions({
              exclude: exclusions.split("\n").filter(Boolean),
              excludeFiles: filePaths,
              excludeDirectories: directoryPaths,
            });
            setFolderRules(next);
            setExclude(exclusions);
            setExcludedFiles(new Set(filePaths));
            setExcludedDirectories(new Set(directoryPaths));
            invalidateFolders();
            setRulesOpen(false);
            if (folderRoots.left || folderRoots.right)
              void attempt(() => scan(folderRoots, options, next));
            if (makeDefault) {
              updateSettings((prior) => ({ ...prior, folderRules: next }));
              setNotice(
                "Defaults changed for new folder workspaces. Save preferences to persist.",
              );
            }
          }}
        />
      )}
      {(diskChanges.length > 0 || diskComparison) && (
        <WorkspaceDialog
          title="Source files changed on disk"
          onClose={() => {
            setDiskChanges([]);
            setDiskComparison(null);
          }}
        >
          <div className="session-form">
            {diskComparison ? (
              <>
                <p>
                  Comparing the current {diskComparison.side} draft with the
                  current disk snapshot. Neither version was changed.
                </p>
                <div className="disk-diff-regions">
                  {diskComparison.spans
                    .filter((span) => span.kind !== "equal")
                    .map((span, index) => {
                      const draft = textLines(diskComparison.draft)
                        .slice(span.leftStart, span.leftEnd)
                        .map((line) => line.content)
                        .join("\n");
                      const disk = textLines(diskComparison.disk)
                        .slice(span.rightStart, span.rightEnd)
                        .map((line) => line.content)
                        .join("\n");
                      return (
                        <section
                          className="disk-diff-region"
                          key={`${span.leftStart}:${span.rightStart}:${index}`}
                        >
                          <h3>Changed region {index + 1}</h3>
                          <div>
                            <section>
                              <h4>Draft</h4>
                              <pre>{draft || "(no lines)"}</pre>
                            </section>
                            <section>
                              <h4>On disk</h4>
                              <pre>{disk || "(no lines)"}</pre>
                            </section>
                          </div>
                        </section>
                      );
                    })}
                  {!diskComparison.spans.some(
                    (span) => span.kind !== "equal",
                  ) && (
                    <p>
                      No visible differences under the active comparison rules.
                      The source snapshot still changed, so saving remains
                      protected.
                    </p>
                  )}
                </div>
                <div className="dialog-actions">
                  <button onClick={() => setDiskComparison(null)}>
                    Back to changed files
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  Editor drafts are retained. Choose how to handle each changed
                  source:
                </p>
                {diskChanges.map((side) => (
                  <section className="disk-change-row" key={side}>
                    <div>
                      <strong>{side}</strong>
                      <span className="metadata">
                        {editors[side].path}
                        {editors[side].text !== editors[side].original
                          ? " — unsaved draft"
                          : ""}
                      </span>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => void attempt(() => reloadFromDisk(side))}
                    >
                      Reload {side} from Disk
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void attempt(() => compareWithDisk(side))}
                    >
                      Compare {side} with Disk
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setDiskChanges((prior) =>
                          prior.filter((value) => value !== side),
                        );
                        setNotice(
                          `${side} draft kept. Saving over the changed source is blocked; use Save As or Reload.`,
                        );
                      }}
                    >
                      Keep {side} Draft
                    </button>
                  </section>
                ))}
              </>
            )}
          </div>
        </WorkspaceDialog>
      )}
      {folderDialog && (
        <WorkspaceDialog
          title={
            folderDialog.action === "compareContents"
              ? "Compare Contents"
              : folderDialog.action === "synchronize"
                ? "Synchronize"
                : `${folderDialog.action} - ${folderDialog.side} side`
          }
          onClose={() => {
            if (!working) setFolderDialog(null);
          }}
        >
          <p>
            {folderDialog.entries.length} selected entries on the{" "}
            {folderDialog.side} side. Directory operations include descendants.
          </p>
          <p className="metadata">
            {folderDialog.entries
              .slice(0, 5)
              .map((entry) => entry.relative)
              .join(", ")}
            {folderDialog.entries.length > 5 ? " ..." : ""}
          </p>
          {folderDialog.action === "compareContents" ? (
            <>
              <div className="selection-totals">
                {(["left", "right"] as const).map((side) => {
                  const dialogScope = selectionScope(folderDialog.entries);
                  const items = folders.filter((entry) =>
                    isWithinSelection(entry.relative, dialogScope),
                  );
                  const available = items.filter(
                    (entry) =>
                      (side === "left" ? entry.leftSize : entry.rightSize) !==
                      null,
                  );
                  return (
                    <div key={side}>
                      <strong>{side}</strong>
                      <p>
                        {available.filter((entry) => !entry.isDirectory).length}{" "}
                        files /{" "}
                        {available.filter((entry) => entry.isDirectory).length}{" "}
                        folders
                      </p>
                      <p>
                        {available
                          .reduce(
                            (sum, entry) =>
                              sum +
                              (entry.isDirectory
                                ? 0
                                : ((side === "left"
                                    ? entry.leftSize
                                    : entry.rightSize) ?? 0)),
                            0,
                          )
                          .toLocaleString()}{" "}
                        bytes
                      </p>
                    </div>
                  );
                })}
              </div>
              <fieldset>
                <legend>Compare contents of selected files and folders</legend>
                <label title="Compare IEEE CRC-32 checksums and sizes. Checksum collisions are possible; write-safety validation always uses independent BLAKE3 snapshots.">
                  <input
                    type="radio"
                    name="selected-content-method"
                    checked={contentMethod === "crc"}
                    onChange={() => setContentMethod("crc")}
                    disabled={busy}
                  />
                  CRC comparison
                </label>
                <label>
                  <input
                    type="radio"
                    name="selected-content-method"
                    checked={contentMethod === "binary"}
                    onChange={() => setContentMethod("binary")}
                    disabled={busy}
                  />
                  Binary comparison
                </label>
                <label>
                  <input
                    type="radio"
                    name="selected-content-method"
                    checked={contentMethod === "rules"}
                    onChange={() => setContentMethod("rules")}
                    disabled={busy}
                  />
                  Rules-based comparison
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showContentResults}
                    onChange={(event) =>
                      setShowContentResults(event.target.checked)
                    }
                    disabled={busy}
                  />
                  Show results dialog
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={dontPromptContents}
                    onChange={(event) =>
                      setDontPromptContents(event.target.checked)
                    }
                    disabled={busy}
                  />
                  Don't show again (read-only content options only)
                </label>
              </fieldset>
              <p className="metadata">
                Metadata is enumerated within both bounded roots; only selected
                file contents are compared. Rules-based text limits and decoding
                failures are reported per item.
              </p>
              <button
                disabled={busy}
                onClick={() => setContentHelp(!contentHelp)}
              >
                Help
              </button>
              {contentHelp && (
                <p>
                  CRC compares sizes and IEEE CRC-32 checksums, which can
                  collide. Binary compares bytes. Rules-based comparison decodes
                  supported text and uses the active text rules. Errors are
                  reported per entry; sources are never modified. Save
                  preferences to persist the prompt choice. Restore the prompt
                  from Home.
                </p>
              )}
            </>
          ) : folderDialog.action === "synchronize" ? (
            <label>
              Mode
              <select
                aria-label="Synchronization mode"
                value={dialogValue}
                onChange={(event) => setDialogValue(event.target.value)}
              >
                <option value="update">Update to opposite side</option>
                <option value="mirror">
                  Mirror to opposite side (recycles orphans)
                </option>
              </select>
            </label>
          ) : folderDialog.action === "copyFilename" ? (
            <label>
              Clipboard representation
              <select
                aria-label="Clipboard representation"
                value={dialogValue}
                onChange={(event) => setDialogValue(event.target.value)}
              >
                <option value="paths">Full paths</option>
                <option value="names">File names</option>
                <option value="relative">Relative paths</option>
              </select>
            </label>
          ) : folderDialog.action === "attributes" ? (
            <>
              <div className="content-results">
                {actionMetadata.map((item) => (
                  <p key={item.path}>
                    {item.path}:{" "}
                    {item.directory
                      ? "directory"
                      : `${item.bytes.toLocaleString()} bytes`}{" "}
                    / {item.readOnly ? "read-only" : "writable"} /{" "}
                    {item.modified === null
                      ? "timestamp unavailable"
                      : new Date(item.modified).toLocaleString()}
                  </p>
                ))}
              </div>
              <p>
                Change only the read-only attribute of the selected entries.
                Hard-link aliases may share this attribute.
              </p>
              <label>
                Read-only
                <select
                  value={dialogValue}
                  onChange={(event) => setDialogValue(event.target.value)}
                >
                  <option value="" disabled>
                    Choose an attribute value
                  </option>
                  <option value="writable">Clear read-only</option>
                  <option value="readonly">Set read-only</option>
                </select>
              </label>
            </>
          ) : ["rename", "mkdir", "touch", "copyFolder", "moveFolder"].includes(
              folderDialog.action,
            ) ? (
            <label>
              {folderDialog.action === "touch"
                ? "Modification time (local timezone)"
                : folderDialog.action === "rename" ||
                    folderDialog.action === "mkdir"
                  ? "New name"
                  : "Destination folder"}
              <input
                autoFocus
                aria-label="Action value"
                type={
                  folderDialog.action === "touch" ? "datetime-local" : "text"
                }
                value={dialogValue}
                disabled={busy}
                onChange={(event) => setDialogValue(event.target.value)}
              />
              {folderDialog.action.endsWith("Folder") && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void open({ directory: true, multiple: false })
                      .then((path) => {
                        if (typeof path === "string") setDialogValue(path);
                      })
                      .catch((failure) => setError(errorMessage(failure)))
                  }
                >
                  Browse...
                </button>
              )}
            </label>
          ) : folderDialog.action === "copySide" ||
            folderDialog.action === "moveSide" ||
            folderDialog.action === "copyFolder" ||
            folderDialog.action === "moveFolder" ? (
            <p>
              Existing files with the same name on the other side are replaced
              when you click Start.
            </p>
          ) : folderDialog.action === "recycle" ? (
            <p>
              Selected entries are sent to the Recycle Bin when you click Start.
              The listing refreshes automatically.
            </p>
          ) : (
            <p>
              Click Start to apply this change now. The listing refreshes
              automatically.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button disabled={busy} onClick={() => setFolderDialog(null)}>
              Cancel
            </button>
            <button
              className="primary"
              title={
                folderDialog.action === "compareContents"
                  ? "Compare selected contents without changing files."
                  : folderDialog.action === "copyFilename"
                    ? "Copy the selected names or paths to the clipboard."
                    : folderDialog.action === "copySide" ||
                        folderDialog.action === "moveSide" ||
                        folderDialog.action === "copyFolder" ||
                        folderDialog.action === "moveFolder"
                      ? "Copy or move now; existing files with the same name are replaced."
                      : folderDialog.action === "recycle"
                        ? "Send the selected entries to the Recycle Bin now."
                        : folderDialog.action === "synchronize"
                          ? "Build a sync preview; no files change until you apply it."
                          : "Apply this change now; the listing refreshes automatically."
              }
              disabled={busy}
              onClick={() => void attempt(prepareFolderAction)}
            >
              {folderDialog.action === "synchronize"
                ? "Preview"
                : folderDialog.action === "copyFilename"
                  ? "Copy"
                  : "Start"}
            </button>
            {working && cancellableJob && (
              <button
                onClick={() =>
                  void native("cancel_job", { jobId: cancellableJob }).catch(
                    (failure) => setError(errorMessage(failure)),
                  )
                }
              >
                Stop
              </button>
            )}
          </div>
        </WorkspaceDialog>
      )}
      {contentResults && (
        <WorkspaceDialog
          title="Content comparison results"
          onClose={() => setContentResults(null)}
        >
          <div className="content-results">
            {contentResults.map((entry) => (
              <p key={entry.relative}>
                <strong>{entry.relative}</strong>: {entry.status}{" "}
                {entry.detail ?? ""}
              </p>
            ))}
          </div>
          <div className="dialog-actions">
            <button onClick={() => setContentResults(null)}>Close</button>
          </div>
        </WorkspaceDialog>
      )}
      <div className="workspace-heading">
        <h2 className="sr-only">
          {mode === "folder"
            ? "Compare folders"
            : mode === "merge"
              ? "Merge three files"
              : "Compare text"}
        </h2>
        <details
          className="preferences floating-panel"
          data-panel="preferences"
        >
          <summary>Preferences</summary>
          <div className="toolbar compact">
            <button
              disabled={busy}
              onClick={() =>
                setSettings((prior) => ({
                  ...prior,
                  theme: prior.theme === "light" ? "dark" : "light",
                }))
              }
            >
              Toggle theme
            </button>
            <button
              disabled={busy || !settingsReady}
              onClick={() =>
                void attempt(async () => {
                  await native("write_settings", { settings });
                  updateSettings(() => settings);
                  setNotice("Preferences saved.");
                })
              }
            >
              Save preferences
            </button>
          </div>
          <p className="metadata">
            Save preferences to persist the theme, rules, profiles, and
            sessions.
          </p>
        </details>
      </div>
      <div className="status-bar" role="status">
        <span>
          {notice ||
            (working ? `Working... ${progress} entries scanned` : "Ready")}
        </span>
        {mode === "folder" && folderTruncated && (
          <span className="folder-truncated" role="alert">
            Showing the first 250,000 items. Exclude folders such as
            node_modules to see everything.
          </span>
        )}
        {mode === "folder" && (
          <span className="folder-status-counts">
            {folderStale ? "Results stale / " : ""}
            {visibleFolderCount} visible / {selectedVisibleCount} selected / L:{" "}
            {formatSize(folderBytes("left"))} / R:{" "}
            {formatSize(folderBytes("right"))}
            {(diskSpace.left || diskSpace.right) && (
              <span
                className="folder-disk-space"
                title={`Available space at last scan. Left: ${diskSpace.left}. Right: ${diskSpace.right}.`}
              >
                {" / Free L: "}
                {diskSpace.left || "no folder"}
                {" / R: "}
                {diskSpace.right || "no folder"}
              </span>
            )}
          </span>
        )}
        <span className="shortcut-hint">
          Ctrl+Enter: run / Ctrl+S: save / Ctrl+F: find
        </span>
        {working && cancellableJob && (
          <button
            onClick={() => {
              const jobId = activeJob.current;
              if (!jobId) return;
              void native("cancel_job", { jobId }).catch((e) =>
                setError(errorMessage(e)),
              );
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {(sessionDialog === "save" || sessionDialog === "saveAs") && (
        <WorkspaceDialog
          title={
            sessionDialog === "saveAs" ? "Save Session As" : "Save Session"
          }
          onClose={() => {
            if (!busy) setSessionDialog(null);
          }}
        >
          <form
            className="session-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void attempt(saveSession);
            }}
          >
            <label>
              Session name
              <input
                autoFocus
                value={sessionName}
                disabled={busy}
                maxLength={200}
                readOnly={sessionDialog === "save" && !!tab.sessionName}
                onChange={(event) => {
                  setSessionName(event.target.value);
                  setSessionError("");
                }}
                aria-invalid={!!sessionError}
                aria-describedby={
                  sessionError ? "session-save-error" : undefined
                }
              />
            </label>
            <p className="metadata">
              Saves this{" "}
              {mode === "folder"
                ? "folder"
                : mode === "merge"
                  ? "merge"
                  : "text"}{" "}
              comparison's paths{mode === "folder" ? " and folder rules" : ""}.
              Draft contents are not saved.
            </p>
            <dl className="session-paths">
              {(
                [
                  "left",
                  "right",
                  ...(mode === "merge" ? (["base"] as const) : []),
                ] as const
              ).map((side) => (
                <div key={side}>
                  <dt>{side}</dt>
                  <dd>
                    {mode === "folder" && side !== "base"
                      ? folderRoots[side] || "Not selected"
                      : editors[side].path || "Blank draft"}
                  </dd>
                </div>
              ))}
            </dl>
            {sessionError && (
              <p id="session-save-error" className="error" role="alert">
                {sessionError}
              </p>
            )}
            <footer className="dialog-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setSessionDialog(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || !settingsReady}
              >
                {sessionDialog === "save" && tab.sessionName
                  ? "Update"
                  : "Save"}
              </button>
            </footer>
          </form>
        </WorkspaceDialog>
      )}
      {sessionDialog === "manage" && (
        <WorkspaceDialog
          title="Saved Sessions"
          onClose={() => {
            if (!busy) setSessionDialog(null);
          }}
        >
          <div className="session-form">
            <button
              disabled={busy || !settingsReady}
              onClick={() => controllersCommand("save-session-as")}
            >
              Save current session as...
            </button>
            {sessionError && (
              <p className="error" role="alert">
                {sessionError}
              </p>
            )}
            {!settings.sessions.length && (
              <p className="empty-state">
                No saved sessions. Save a comparison to open it again later.
              </p>
            )}
            <div className="session-list">
              {settings.sessions.map((session, index) => (
                <div key={session.name} className="saved-session-row">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setSessionDialog(null);
                      openSession(session);
                    }}
                  >
                    {session.name}
                  </button>
                  <span className="metadata">{session.mode}</span>
                  {sessionRename?.original === session.name ? (
                    <>
                      <input
                        aria-label={`Rename session ${session.name}`}
                        value={sessionRename.value}
                        maxLength={200}
                        disabled={busy}
                        onChange={(event) => {
                          setSessionRename({
                            original: session.name,
                            value: event.target.value,
                          });
                          setSessionError("");
                        }}
                      />
                      <button
                        disabled={busy || !settingsReady}
                        onClick={() =>
                          void attempt(() =>
                            renameSavedSession(
                              session.name,
                              sessionRename.value,
                            ),
                          )
                        }
                      >
                        Save name
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setSessionRename(null)}
                      >
                        Cancel rename
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={busy || !settingsReady}
                      aria-label={`Rename saved session ${session.name}`}
                      onClick={() => {
                        setSessionRename({
                          original: session.name,
                          value: session.name,
                        });
                        setSessionError("");
                      }}
                    >
                      Rename
                    </button>
                  )}
                  <button
                    disabled={busy || !settingsReady || index === 0}
                    aria-label={`Move session ${session.name} up`}
                    onClick={() => void attempt(() => moveSession(index, -1))}
                  >
                    Up
                  </button>
                  <button
                    disabled={
                      busy ||
                      !settingsReady ||
                      index === settings.sessions.length - 1
                    }
                    aria-label={`Move session ${session.name} down`}
                    onClick={() => void attempt(() => moveSession(index, 1))}
                  >
                    Down
                  </button>
                  <button
                    disabled={busy || !settingsReady}
                    aria-label={`Remove session ${session.name}`}
                    onClick={() =>
                      void attempt(async () => {
                        if (
                          !(await confirmAction(
                            `Remove saved session "${session.name}"? Source files and open tabs are not changed.`,
                          ))
                        )
                          return;
                        await persistSessions(
                          settings.sessions.filter((_, i) => i !== index),
                        );
                        renameSessionTabs(session.name, null);
                        setNotice(`Session "${session.name}" removed.`);
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <details>
              <summary>Recent files</summary>
              <div className="session-list">
                {settings.recent.map((path) => (
                  <button
                    key={path}
                    disabled={busy}
                    onClick={() => {
                      setSessionDialog(null);
                      openTab("text", { left: path });
                    }}
                  >
                    {path}
                  </button>
                ))}
              </div>
            </details>
          </div>
        </WorkspaceDialog>
      )}
      {profilesOpen && (
        <WorkspaceDialog
          title="File-format Profiles"
          onClose={() => setProfilesOpen(false)}
        >
          <form
            className="session-form"
            onSubmit={(event) => {
              event.preventDefault();
              const suffix = profileSuffix.trim();
              if (!suffix || busy) return;
              invalidate();
              setSettings((prior) => ({
                ...prior,
                formats: [
                  ...prior.formats.filter((f) => f.suffix !== suffix),
                  {
                    suffix,
                    ignoreCase: prior.ignoreCase,
                    ignoreWhitespace: prior.ignoreWhitespace,
                    ignoreLineEndings: prior.ignoreLineEndings,
                    patterns: prior.unimportantPatterns,
                  },
                ],
              }));
              setProfileSuffix("");
            }}
          >
            <label>
              File suffix
              <input
                autoFocus
                required
                placeholder=".txt"
                value={profileSuffix}
                onChange={(event) => setProfileSuffix(event.target.value)}
              />
            </label>
            <button disabled={!settingsReady || busy}>
              Save current rules as file-format profile
            </button>
            <p className="metadata">
              Profiles override comparison options for matching left-file
              suffixes. Save preferences to persist profile changes.
            </p>
            {settings.formats.map((format, index) => (
              <div key={index} className="saved-session-row">
                <span>Profile {format.suffix}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    invalidate();
                    setSettings((prior) => ({
                      ...prior,
                      formats: prior.formats.filter((_, i) => i !== index),
                    }));
                  }}
                >
                  Remove profile {format.suffix}
                </button>
              </div>
            ))}
          </form>
        </WorkspaceDialog>
      )}
      {mode === "text" && (
        <details className="text-rules floating-panel" data-panel="rules">
          <summary>Comparison rules</summary>
          <section className="toolbar" aria-label="Comparison options">
            <span className="toolbar-label">Compare rules</span>
            {(
              [
                ["ignoreCase", "Ignore case"],
                ["ignoreWhitespace", "Ignore whitespace"],
                ["ignoreLineEndings", "Ignore EOL style"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={settings[key]}
                  disabled={busy}
                  onChange={(event) => {
                    invalidate();
                    setSettings((prior) => ({
                      ...prior,
                      [key]: event.target.checked,
                    }));
                  }}
                />
                {label}
              </label>
            ))}
            <details className="advanced-rules">
              <summary>Advanced rules</summary>
              <label>
                Unimportant regex rules (one per line)
                <textarea
                  className="rules"
                  value={settings.unimportantPatterns.join("\n")}
                  disabled={busy}
                  onChange={(event) => {
                    invalidate();
                    setSettings((prior) => ({
                      ...prior,
                      unimportantPatterns: event.target.value
                        .split("\n")
                        .filter(Boolean),
                    }));
                  }}
                />
              </label>
              <p className="metadata">
                File-format profiles override these rules for matching left-file
                suffixes.
              </p>
            </details>
          </section>
        </details>
      )}
      {mode === "text" && (
        <>
          <div
            className="toolbar command-bar compact-command-bar text-toolbar"
            aria-label="Text comparison actions"
          >
            <div className="tool-group" role="group" aria-label="Workspace">
              <ToolButton
                label="Home"
                icon="home"
                iconOnly
                description="Return to Home, keeping this workspace and unsaved drafts."
                onClick={onHome}
              />
              <CommandMenu
                label="Sessions"
                icon="sessions"
                description="Start a new comparison or open a saved session."
                commands={sessionCommands()}
              />
            </div>
            <div className="tool-group" role="group" aria-label="Show lines">
              <ToolButton
                label="All"
                icon="all"
                description="Show every source line."
                aria-pressed={textFilter === "all"}
                onClick={() => setTextFilter("all")}
              />
              <ToolButton
                label="Diffs"
                icon="differences"
                description="Fold equal lines while retaining complete editable source documents."
                aria-pressed={textFilter === "differences"}
                disabled={!spans}
                onClick={() => setTextFilter("differences")}
              />
              <ToolButton
                label="Same"
                icon="same"
                description="Fold changed lines; hidden text remains in the source document."
                aria-pressed={textFilter === "same"}
                disabled={!spans}
                onClick={() => setTextFilter("same")}
              />
              <ToolButton
                label="Context"
                icon="context"
                description="Show changes with three surrounding equal lines on either side."
                aria-pressed={textFilter === "context"}
                disabled={!spans}
                onClick={() => setTextFilter("context")}
              />
            </div>
            <div className="tool-group" role="group" aria-label="Highlights">
              <ToolButton
                label="Minor"
                icon="minor"
                description="Show raw differences ignored by the active comparison rules, without changing source text."
                aria-pressed={minorText}
                disabled={busy}
                onClick={() => {
                  setMinorText(!minorText);
                  void attempt(() =>
                    compareInputs(editors, undefined, !minorText),
                  );
                }}
              />
              <ToolButton
                label="Whitespace / EOL"
                icon="whitespace"
                iconOnly
                description="Mark spaces and tabs and show each source line ending without changing text."
                aria-pressed={showWhitespace}
                onClick={() => setShowWhitespace((value) => !value)}
              />
              <ToolButton
                label="Inline changes"
                icon="inline"
                iconOnly
                description="Color the changed characters inside changed lines."
                aria-pressed={showIntraline}
                onClick={() => setShowIntraline((value) => !value)}
              />
            </div>
            <div className="tool-group" role="group" aria-label="Alignment">
              <ToolButton
                label="Anchor lines"
                icon="anchor"
                iconOnly
                description={
                  cursorLines.left === null || cursorLines.right === null
                    ? "Place the caret on a line in each pane to pair them as an ephemeral alignment anchor."
                    : `Pair left line ${cursorLines.left + 1} with right line ${cursorLines.right + 1}; anchors clear when text changes.`
                }
                disabled={
                  busy ||
                  cursorLines.left === null ||
                  cursorLines.right === null
                }
                onClick={() => void attempt(anchorCurrentLines)}
              />
              <ToolButton
                label={`Clear anchors${alignmentAnchors.length ? ` (${alignmentAnchors.length})` : ""}`}
                icon="clear"
                iconOnly
                description="Remove manual line-pair anchors and compare automatically aligned text."
                disabled={busy || !alignmentAnchors.length}
                onClick={() => void attempt(clearAlignmentAnchors)}
              />
            </div>
            <div className="tool-group" role="group" aria-label="Tools">
              <ToolButton
                label="Rules"
                icon="settings"
                iconOnly
                description="Edit comparison rules; changes invalidate existing results."
                onClick={() => controllersCommand("rules")}
              />
              <ToolButton
                label="Format"
                icon="format"
                iconOnly
                description="Manage comparison-format profiles, not source-code formatting."
                onClick={() => controllersCommand("profiles")}
              />
              <ToolButton
                label="Find / Replace"
                icon="search"
                description="Search either text pane, replace with preview and Undo, or go to a source line (Ctrl+F)."
                onClick={() => controllersCommand("find")}
              />
              <ToolButton
                label="Reload"
                icon="refresh"
                iconOnly
                description="Reopen both file inputs and refresh differences without resetting the viewport. Dirty drafts require confirmation."
                disabled={busy || (!editors.left.path && !editors.right.path)}
                onClick={() =>
                  void attempt(async () => {
                    if (!(await discard("left")) || !(await discard("right")))
                      return;
                    const inputs = { ...editors };
                    try {
                      if (editors.left.path)
                        inputs.left =
                          (await load(
                            "left",
                            editors.left.path,
                            null,
                            false,
                            true,
                          )) ?? inputs.left;
                      if (editors.right.path)
                        inputs.right =
                          (await load(
                            "right",
                            editors.right.path,
                            null,
                            false,
                            true,
                          )) ?? inputs.right;
                      await compareInputs(inputs, selected, minorText, true);
                    } catch (failure) {
                      setSpans(null);
                      throw failure;
                    }
                  })
                }
              />
              <ToolButton
                label="Swap sides"
                icon="swap"
                iconOnly
                description="Swap both inputs, their drafts, and metadata without writing files."
                disabled={busy}
                onClick={() => controllersCommand("swap")}
              />
            </div>
            <div
              className="tool-group primary-group"
              role="group"
              aria-label="Differences"
            >
              <ToolButton
                label="Previous difference"
                icon="arrowUp"
                iconOnly
                description="Previous difference (Alt+Up)"
                disabled={busy || !changes.length}
                onClick={() => navigateDifference(-1)}
              />
              <ToolButton
                label="Next difference"
                icon="arrowDown"
                iconOnly
                description="Next difference (Alt+Down)"
                disabled={busy || !changes.length}
                onClick={() => navigateDifference(1)}
              />
              <span className="difference-count">
                {spans
                  ? changes.length
                    ? suppressSelectedDifference
                      ? `${changes.length} differences; select Previous or Next`
                      : `${current + 1} / ${changes.length} differences`
                    : "No differences"
                  : "Not compared"}
              </span>
              <ToolButton
                className="copy-action"
                label="Copy region to left"
                icon="copyLeft"
                description="Copy the current difference into the left draft (Alt+Left). Save is separate."
                disabled={busy || !changes.length}
                onClick={() => copyCurrentDifference("left")}
              >
                Copy to left
              </ToolButton>
              <ToolButton
                className="copy-action"
                label="Copy region to right"
                icon="copyRight"
                description="Copy the current difference into the right draft (Alt+Right). Save is separate."
                disabled={busy || !changes.length}
                onClick={() => copyCurrentDifference("right")}
              >
                Copy to right
              </ToolButton>
            </div>
          </div>
          {searchMode && (
            <TextSearchPanel
              texts={{ left: editors.left.text, right: editors.right.text }}
              mode={searchMode}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              searchRequest={searchRequest}
              onModeChange={setSearchMode}
              onClose={() => setSearchMode(null)}
              onNavigate={navigateText}
              onReplace={replaceDrafts}
            />
          )}
          {inputs}
          <LineInspector
            row={pendingEdit === null ? detailLine : undefined}
            left={
              detailLine?.left == null
                ? ""
                : (leftLines[detailLine.left]?.full ?? "")
            }
            right={
              detailLine?.right == null
                ? ""
                : (rightLines[detailLine.right]?.full ?? "")
            }
            layout={
              sharedSettings.lineDetail ?? { collapsed: false, height: 140 }
            }
            onLayout={(layout) => void attempt(() => saveDetailLayout(layout))}
            onCopyLine={copyInspectorLine}
          />
          {spans && (
            <p className={`diff-legend ${showLegend ? "show-legend" : ""}`}>
              <span className="legend-replace">Changed</span>
              <span className="legend-insert">Added on right</span>
              <span className="legend-delete">Removed from right</span>
              <span>Blue edge: selected difference</span>
              <span>Gutter arrows: copy that region to the other draft</span>
            </p>
          )}
          {!spans && (
            <p className="empty-state">
              Open or paste text on both sides; differences update automatically
              as you type.
            </p>
          )}
          {spans && (
            <section aria-live="polite">
              <h2>
                {pendingEdit === null
                  ? `${changes.length} changed regions`
                  : "Refreshing comparison..."}
              </h2>
              <p className="result-summary">
                {pendingEdit !== null
                  ? "Updating differences for the latest edits. Files are not saved."
                  : changes.length
                    ? `Difference ${current + 1} of ${changes.length}. Use Previous / Next or Alt+Up / Alt+Down to navigate.`
                    : "No differences under the current comparison rules."}
              </p>
              <details className="comparison-details" data-panel="details">
                <summary>Aligned read-only view &amp; range details</summary>
                <VirtualList
                  count={pendingEdit === null ? aligned.length : 0}
                  label="Aligned line comparison"
                  render={(index) => {
                    const row = aligned[index];
                    if (!row) return null;
                    return (
                      <div className={`aligned ${row.kind}`}>
                        <button
                          aria-label={`Inspect aligned line ${index + 1}`}
                          onClick={() => setDetailRow(index)}
                        >
                          Detail
                        </button>
                        <code>
                          {row.left === null
                            ? ""
                            : `${row.left + 1}  ${leftLines[row.left]?.content ?? ""}`}
                        </code>
                        <code>
                          {row.right === null
                            ? ""
                            : `${row.right + 1}  ${rightLines[row.right]?.content ?? ""}`}
                        </code>
                      </div>
                    );
                  }}
                />
                <table>
                  <caption>
                    Line ranges use zero-based, end-exclusive offsets.
                  </caption>
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Left lines</th>
                      <th>Right lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spans.slice(0, 100).map((span, index) => (
                      <tr key={index}>
                        <td>{span.kind}</td>
                        <td>
                          {span.leftStart}..{span.leftEnd}
                        </td>
                        <td>
                          {span.rightStart}..{span.rightEnd}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {spans.length > 100 && (
                  <p>
                    Range table shows first 100 regions; aligned view and
                    navigation cover all regions.
                  </p>
                )}
              </details>
            </section>
          )}
        </>
      )}
      {mode === "folder" && (
        <>
          <div
            className="toolbar command-bar compact-command-bar folder-toolbar"
            aria-label="Folder comparison actions"
          >
            <div className="tool-group" role="group" aria-label="Workspace">
              <ToolButton
                label="Home"
                icon="home"
                iconOnly
                description="Return to Home without closing this workspace."
                onClick={onHome}
              />
              <CommandMenu
                label="Sessions"
                icon="sessions"
                description="Start a new comparison or open a saved session."
                commands={sessionCommands()}
              />
            </div>
            <div className="tool-group" role="group" aria-label="Show entries">
              <ToolButton
                label="All"
                icon="all"
                description="Show all scanned entries."
                aria-pressed={filter === "all"}
                onClick={() => selectFilter("all")}
              />
              <CommandMenu
                label="Diffs"
                icon="differences"
                description={`Current filter: ${differenceFilters.find(([value]) => value === filter)?.[1] ?? (filter === "error" ? "Comparison Errors" : filter)}. Comparison and refresh preserve this choice.`}
                commands={differenceFilters.map(([value, label]) => ({
                  label,
                  run: () => selectFilter(value),
                }))}
              />
              <ToolButton
                label="Same"
                icon="same"
                description="Show entries equal under the active rules."
                aria-pressed={filter === "same"}
                onClick={() => selectFilter("same")}
              />
              <CommandMenu
                label="Structure"
                icon="folder"
                commands={[
                  { label: "Tree view", run: () => folderCommand("tree") },
                  { label: "Flat view", run: () => folderCommand("flat") },
                ]}
              />
              <CommandMenu
                label="Files"
                icon="file"
                commands={[
                  ["all", "Files and folders"],
                  ["files", "Files only"],
                  ["folders", "Folders only"],
                ].map(([value, label]) => ({
                  label: label ?? "",
                  run: () =>
                    setFilesVisible(value as "all" | "files" | "folders"),
                }))}
              />
            </div>
            <div className="tool-group" role="group" aria-label="Highlights">
              <ToolButton
                label="Minor"
                icon="minor"
                description="Include rule-ignored minor differences in the folder view."
                aria-pressed={showMinor}
                onClick={() => setShowMinor(!showMinor)}
              />
              <ToolButton
                label="Peek"
                icon="peek"
                iconOnly
                description="Temporarily reveal display-filtered and ignored rows, but not excluded or unscanned paths."
                aria-pressed={peek}
                onClick={() => setPeek(!peek)}
              />
              <ToolButton
                label="Expand"
                icon="expand"
                iconOnly
                description="Expand all scanned folder branches."
                onClick={() => folderCommand("expand")}
              />
              <ToolButton
                label="Collapse"
                icon="collapse"
                iconOnly
                description="Collapse all folder branches without losing selection."
                onClick={() => folderCommand("collapse")}
              />
              <CommandMenu
                label="Select"
                icon="check"
                commands={[
                  {
                    label: "All visible",
                    run: () => folderCommand("selectAll"),
                    disabled: busy,
                  },
                  {
                    label: "None visible",
                    run: () => folderCommand("selectNone"),
                    disabled: busy,
                  },
                  {
                    label: "Invert visible",
                    run: () => folderCommand("selectInvert"),
                    disabled: busy,
                  },
                ]}
              />
            </div>
            <div className="tool-group" role="group" aria-label="Filters">
              <label className="quick-filter">
                <Icon name="filters" className="tool-symbol" />
                <span className="sr-only">Filters:</span>
                <input
                  aria-label="Filename display filter"
                  placeholder="Filter names, e.g. *.ts;*.md"
                  title="Filename patterns separated by semicolons; * and ? are wildcards. Display only, not scan exclusions."
                  value={quickFilter}
                  onChange={(event) => setQuickFilter(event.target.value)}
                />
              </label>
              <ToolButton
                label="Rules"
                icon="settings"
                description="Edit folder comparison rules and scan exclusions; applying scans chosen roots."
                disabled={busy}
                onClick={() => setRulesOpen(true)}
              />
            </div>
            <div
              className="tool-group primary-group"
              role="group"
              aria-label="Compare and copy"
            >
              <ToolButton
                label="Copy"
                icon="copy"
                description="Preview selected entries copied from the active side to the opposite side."
                disabled={busy || !selectedVisibleCount}
                onClick={() => folderCommand("copySide")}
              />
              <CommandMenu
                label="Copy options"
                icon="chevronDown"
                commands={[
                  {
                    label: "Preview update left to right",
                    disabled: busy || folderTruncated,
                    run: () =>
                      void attempt(() =>
                        createPreview("update", null, "right"),
                      ),
                  },
                  {
                    label: "Preview update right to left",
                    disabled: busy || folderTruncated,
                    run: () =>
                      void attempt(() => createPreview("update", null, "left")),
                  },
                  {
                    label: "Preview mirror left to right",
                    disabled: busy || folderTruncated,
                    run: () =>
                      void attempt(() =>
                        createPreview("mirror", null, "right"),
                      ),
                  },
                  {
                    label: "Preview mirror right to left",
                    disabled: busy || folderTruncated,
                    run: () =>
                      void attempt(() => createPreview("mirror", null, "left")),
                  },
                ]}
              />
              <ToolButton
                label="Swap"
                icon="swap"
                iconOnly
                description="Swap folder roots and discard stale results."
                disabled={busy}
                onClick={() => {
                  invalidateFolders();
                  setFolderRoots((prior) => ({
                    left: prior.right,
                    right: prior.left,
                  }));
                }}
              />
              <ToolButton
                label="Stop"
                icon="stop"
                iconOnly
                description={
                  working && cancellableJob
                    ? "Request cancellation. Completed writes are not rolled back."
                    : "No cancellable operation is active in this workspace."
                }
                disabled={!working || !cancellableJob}
                onClick={() => {
                  if (cancellableJob)
                    void native("cancel_job", { jobId: cancellableJob }).catch(
                      (failure) => setError(errorMessage(failure)),
                    );
                }}
              />
              <ToolButton
                className="accent-action"
                label="Refresh"
                aria-label="Scan folders"
                icon="refresh"
                description="Read both roots and refresh their comparison (Ctrl+Enter)."
                disabled={busy}
                onClick={() => void attempt(scan)}
              />
            </div>
          </div>
          {inputs}
          <p className="result-summary">
            {folderStale
              ? "Files changed on disk. These folder results may be stale; rescan to refresh."
              : hasScanned
                ? `${visibleFolderCount} matching entries / ${selectedVisibleCount} selected.`
                : "Scan folders to list their contents. Row arrows preview either copy direction; Update and Mirror run left to right."}
          </p>
          {folders.some((entry) => entry.status === "error") &&
            (() => {
              const errorCount = folders.filter(
                (entry) => entry.status === "error",
              ).length;
              const isFilteringErrors = filter === "error";
              return (
                <div
                  className={`folder-errors-banner${isFilteringErrors ? " active" : ""}`}
                  role="status"
                >
                  <button
                    type="button"
                    className={`folder-errors${isFilteringErrors ? " active" : ""}`}
                    aria-pressed={isFilteringErrors}
                    onClick={() =>
                      setFilter(toggleFolderErrorFilter(filter, previousFilter))
                    }
                    title={
                      isFilteringErrors
                        ? "Clear comparison error filter and restore previous view"
                        : `Filter view to show only ${errorCount} comparison ${errorCount === 1 ? "error" : "errors"}`
                    }
                  >
                    <Icon name="error" className="tool-symbol" />
                    <span>
                      {formatFolderErrorsLabel(errorCount, isFilteringErrors)}
                    </span>
                  </button>
                  {isFilteringErrors && (
                    <button
                      type="button"
                      className="folder-errors-clear"
                      onClick={() => selectFilter("all")}
                      title="Clear error filter and show all entries"
                    >
                      Show all entries
                    </button>
                  )}
                </div>
              );
            })()}
          <FolderView
            key={`${nativeFolderRoots.left}\0${nativeFolderRoots.right}`}
            entries={filteredFolders}
            filter={peek ? "all" : filter}
            kindFilter={peek ? "all" : filesVisible}
            excludedFiles={excludedFiles}
            excludedDirectories={excludedDirectories}
            busy={busy}
            selected={selectedFiles}
            onSelect={(keys, checked) =>
              setSelectedFiles((prior) => {
                const next = new Set(prior);
                for (const key of keys)
                  if (checked) next.add(key);
                  else next.delete(key);
                return next;
              })
            }
            openPair={(row) => void attempt(() => openPair(row))}
            registerCommands={registerFolderCommands}
            onAction={folderAction}
          />
          {showLog && (
            <section className="activity-log" aria-label="Activity log">
              <div className="log-controls">
                <button
                  title="Hide the activity log"
                  onClick={() => setShowLog(false)}
                >
                  Hide log
                </button>
                <button
                  title="Clear only this in-memory activity log"
                  onClick={() => setLog([])}
                >
                  Clear
                </button>
                <button
                  title="Export this log to a new text file; existing files are not overwritten"
                  disabled={busy}
                  onClick={() =>
                    void attempt(async () => {
                      const destination = await save({
                        title: "Export activity log to a new file",
                      });
                      if (destination) {
                        const document = await native("save_document", {
                          id: null,
                          text: log.join("\n"),
                          destination,
                          convertUtf8: false,
                        });
                        await native("close_document", { id: document.id });
                        setNotice("Activity log exported.");
                      }
                    })
                  }
                >
                  Save log...
                </button>
              </div>
              <pre>{log.join("\n") || "No operations yet."}</pre>
            </section>
          )}
          {!showLog && (
            <button className="show-log" onClick={() => setShowLog(true)}>
              Show activity log
            </button>
          )}
          {preview && (
            <WorkspaceDialog
              title={
                previewKind === "mirror" || previewKind === "selected-mirror"
                  ? `Mirror ${previewDirection === "right" ? "left to right" : "right to left"}`
                  : previewKind === "selected-update"
                    ? `Synchronize selected entries ${previewDirection === "right" ? "left to right" : "right to left"}`
                    : `Update ${previewDirection === "right" ? "left to right" : "right to left"}`
              }
              onClose={dismissPreview}
              className="sync-preview-dialog"
            >
              <div className="sync-preview-content">
                <div className="sync-preview-summary">
                  <strong>
                    {preview.operations.length} planned{" "}
                    {preview.operations.length === 1
                      ? "operation"
                      : "operations"}
                  </strong>
                  <span className="sync-preview-direction">
                    {previewDirection === "right"
                      ? "LEFT → RIGHT"
                      : "RIGHT → LEFT"}
                  </span>
                </div>
                <dl className="sync-preview-paths">
                  <div>
                    <dt>Source</dt>
                    <dd>
                      <code>
                        {previewDirection === "right"
                          ? plainPath(folderRoots.left)
                          : plainPath(folderRoots.right)}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Destination</dt>
                    <dd>
                      <code>
                        {previewDirection === "right"
                          ? plainPath(folderRoots.right)
                          : plainPath(folderRoots.left)}
                      </code>
                    </dd>
                  </div>
                </dl>
                <p className="sync-preview-note">
                  No files have been changed. Applying this preview revalidates
                  the listed plan before making any changes.
                </p>
                {(previewKind === "mirror" ||
                  previewKind === "selected-mirror") && (
                  <p className="sync-preview-warning">
                    Mirror can send destination-only files and folders to the
                    Recycle Bin. Those operations are listed below; no permanent
                    deletion is used.
                  </p>
                )}
                {preview.operations.some(
                  (operation) => operation.action === "overwrite",
                ) && (
                  <p className="sync-preview-warning">
                    Operations marked “Replace” overwrite existing destination
                    files.
                  </p>
                )}
                <section
                  className="sync-preview-operations"
                  aria-label="Planned changes"
                >
                  <h3>Planned changes</h3>
                  {preview.operations.length ? (
                    <VirtualList
                      count={preview.operations.length}
                      height={240}
                      rowHeight={38}
                      label="Planned sync operations"
                      render={(index) => {
                        const operation = preview.operations[index];
                        if (!operation) return null;
                        const actionLabel =
                          operation.action === "copy"
                            ? "Copy"
                            : operation.action === "overwrite"
                              ? "Replace"
                              : operation.action === "mkdir"
                                ? "Create folder"
                                : operation.action === "trash"
                                  ? "Send file to Recycle Bin"
                                  : operation.action === "trashDirectory"
                                    ? "Send folder to Recycle Bin"
                                    : operation.action;
                        return (
                          <div className="sync-preview-operation">
                            <strong>{actionLabel}</strong>
                            <span title={operation.relative}>
                              {operation.relative}
                            </span>
                          </div>
                        );
                      }}
                    />
                  ) : (
                    <p className="sync-preview-empty">
                      No changes are needed for this direction.
                    </p>
                  )}
                </section>
                {preview.skipped.length > 0 && (
                  <section
                    className="sync-preview-operations"
                    aria-label="Skipped rows"
                  >
                    <h3>Skipped ({preview.skipped.length})</h3>
                    <VirtualList
                      count={preview.skipped.length}
                      height={120}
                      rowHeight={38}
                      label="Skipped sync rows"
                      render={(index) => {
                        const row = preview.skipped[index];
                        if (!row) return null;
                        return (
                          <div className="sync-preview-operation">
                            <strong>{row.reason}</strong>
                            <span title={row.relative}>{row.relative}</span>
                          </div>
                        );
                      }}
                    />
                  </section>
                )}
                <div className="dialog-actions">
                  <button disabled={busy} onClick={dismissPreview}>
                    Cancel
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !preview.operations.length}
                    onClick={() => void attempt(executePreview)}
                  >
                    {previewKind === "mirror" ||
                    previewKind === "selected-mirror"
                      ? "Apply mirror"
                      : previewKind === "selected-update"
                        ? "Apply selected sync"
                        : "Apply update"}
                  </button>
                </div>
              </div>
            </WorkspaceDialog>
          )}
        </>
      )}
      {mode === "merge" && (
        <>
          <div className="toolbar command-bar">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void attempt(mergeInputs)}
            >
              Merge three inputs
            </button>
            <span className="metadata">
              Saving stays disabled until every conflict is resolved.
            </span>
            <button
              aria-label="Previous unresolved conflict"
              disabled={busy || unresolved === 0}
              onClick={() => navigateConflict("previous")}
            >
              Previous conflict
            </button>
            <button
              aria-label="Next unresolved conflict"
              disabled={busy || unresolved === 0}
              onClick={() => navigateConflict("next")}
            >
              Next conflict
            </button>
            <button
              aria-label="Undo conflict resolution"
              disabled={busy || !resolutionHistory.length}
              onClick={() => void attempt(() => restoreResolution("undo"))}
            >
              Undo resolution
            </button>
            <button
              aria-label="Redo conflict resolution"
              disabled={busy || !resolutionFuture.length}
              onClick={() => void attempt(() => restoreResolution("redo"))}
            >
              Redo resolution
            </button>
          </div>
          {inputs}
          {(blocks || output || outputDocument) && (
            <section>
              {blocks ? (
                <h2>{unresolved} unresolved conflicts</h2>
              ) : (
                <p>
                  Inputs changed. Generate a new merge before saving; previous
                  output is retained below.
                </p>
              )}
              {blocks?.map((block, index) => {
                if (block.kind !== "conflict") return null;
                const number = blocks
                  .slice(0, index + 1)
                  .filter((item) => item.kind === "conflict").length;
                return (
                  <article
                    className={`conflict${activeConflict === index ? " conflict-active" : ""}`}
                    key={index}
                    ref={(element) => {
                      conflictElements.current[index] = element;
                    }}
                    aria-current={activeConflict === index ? "true" : undefined}
                  >
                    <h3>
                      Conflict {number}
                      {choices[index] !== undefined ? " (resolved)" : ""}
                    </h3>
                    <pre>BASE: {block.base}</pre>
                    <pre>LEFT: {block.left}</pre>
                    <pre>RIGHT: {block.right}</pre>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void attempt(() => resolve(index, block.left))
                      }
                    >
                      Use left {number}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void attempt(() => resolve(index, block.right))
                      }
                    >
                      Use right {number}
                    </button>
                    <button
                      disabled={busy}
                      title="Append left conflict content, then right conflict content; repeated lines are retained."
                      onClick={() =>
                        void attempt(() =>
                          resolve(index, block.left + block.right),
                        )
                      }
                    >
                      Use both {number}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void attempt(() => resolve(index, block.base))
                      }
                    >
                      Use base {number}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void attempt(() => resolve(index, ""))}
                    >
                      Delete conflict {number}
                    </button>
                  </article>
                );
              })}
              <label>
                Merge output
                <CodeEditor
                  text={output}
                  label="Merge output"
                  disabled={busy}
                  onChange={setOutput}
                />
              </label>
              <button
                disabled={busy || !blocks || !!unresolved}
                onClick={() => void attempt(saveOutput)}
              >
                Save merge output
              </button>
              {staleOutput && (
                <p className="metadata">
                  Output changed on disk. Saving revalidates the snapshot;
                  reopen the merge in a new tab to refresh it.
                </p>
              )}
              {gitOutput && (
                <p>
                  Git output: {gitOutput}. Closing without saving a resolved
                  merge reports cancellation.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
