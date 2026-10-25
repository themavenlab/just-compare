import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
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
  native,
  textLines,
  type Block,
  type DocumentView,
  type FolderEntry,
  type FolderRules,
  type LocalActionRequest,
  type LocalPreview,
  type Preview,
} from "./api";
import { CodeEditor } from "./CodeEditor";
import { CommandMenu } from "./CommandMenu";
import { errorMessage, type DiffSpan } from "./comparison";
import {
  differenceFilters,
  matchesFilter,
  matchesName,
} from "./folderPresentation";
import { FolderRulesDialog } from "./FolderRulesDialog";
import { FolderView, type FolderSide } from "./FolderView";
import { RefinedRegion } from "./RefinedRegion";
import { ToolButton } from "./ToolButton";
import { VirtualList } from "./VirtualList";
import {
  fileName,
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
  document: DocumentView | null;
  path: string;
  history: string[];
}
const editor = (text = ""): Editor => ({
  text,
  original: text,
  document: null,
  path: "",
  history: [],
});
type Editors = Record<Side, Editor>;

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
      Pick<WorkspaceTab, "left" | "right" | "base" | "parent" | "folderRules">
    >,
  ) => void;
  openSession: (session: SavedSession) => void;
  diskChanged: (paths: string[]) => void;
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
  diskChanged,
  confirmAction,
  confirmGitExit,
  onHome,
}: WorkspaceProps) {
  const [editors, setEditors] = useState<Editors>({
    left: {
      ...editor(),
      path: tab.left,
    },
    right: {
      ...editor(),
      path: tab.right,
    },
    base: { ...editor(), path: tab.base },
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
  const [current, setCurrent] = useState(0);
  const [refinement, setRefinement] = useState<DiffSpan[] | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [folderStale, setFolderStale] = useState(false);
  const [staleSides, setStaleSides] = useState<Side[]>([]);
  const [staleOutput, setStaleOutput] = useState(false);
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
  const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null);
  const [overwriteAction, setOverwriteAction] = useState(false);
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [output, setOutput] = useState("");
  const [outputSaved, setOutputSaved] = useState("");
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
  function folderCommand(name: string) {
    folderController.current?.(name);
  }
  function controllersCommand(name: string) {
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
    gitOutput,
    mode,
    busy,
  });
  useEffect(() => {
    latest.current = { editors, output, outputSaved, gitOutput, mode, busy };
  }, [editors, output, outputSaved, gitOutput, mode, busy]);

  function invalidate() {
    revision.current += 1;
    setSpans(null);
    setRefinement(null);
    setBlocks(null);
    setChoices({});
    setError("");
    setNotice("");
  }
  function invalidateFolders() {
    setDiskSpace({ left: "", right: "" });
    setNativeFolderRoots({ left: "", right: "" });
    discardPreview(tab.id);
    setPreview(null);
    setLocalPreview(null);
    setFolders([]);
    setHasScanned(false);
    setFolderStale(false);
    setSelectedFiles([]);
    setError("");
    setNotice("");
  }
  function change(side: Side, text: string) {
    invalidate();
    setEditors((previous) => ({
      ...previous,
      [side]: {
        ...previous[side],
        text,
        history: [...previous[side].history.slice(-49), previous[side].text],
      },
    }));
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
      e.text === e.original ||
      (await confirmAction(`Discard unsaved ${side} edits?`))
    );
  }
  async function load(
    side: Side,
    path: string,
    encoding: string | null = null,
    checkDiscard = true,
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
    invalidate();
    const loaded: Editor = {
      text: document.text,
      original: document.text,
      document,
      path: document.path,
      history: [],
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
  async function openSide(side: Side, encoding: string | null = null) {
    await load(side, editors[side].path, encoding);
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
      },
    };
    invalidate();
    setEditors(inputs);
    if (mode === "text") await compareInputs(inputs, selected);
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
    invalidate();
    setEditors((prior) => ({
      ...prior,
      [side]: {
        ...prior[side],
        text: document.text,
        original: document.text,
        document,
        path: document.path,
      },
    }));
    setNotice(`${side} saved.`);
    setStaleSides((prior) => prior.filter((value) => value !== side));
    diskChanged([document.path]);
    const metadata = await native("path_metadata", { path: document.path });
    setFileMetadata((prior) => ({ ...prior, [side]: metadata }));
  }
  async function compareInputs(
    inputs = editors,
    afterCopy?: DiffSpan,
    includeMinor = minorText,
  ) {
    const request = ++revision.current;
    const jobId = crypto.randomUUID();
    startJob(jobId);
    if (!afterCopy) setSpans(null);
    setRefinement(null);
    const profile = settings.formats.find((f) =>
      (inputs.left.document?.path || inputs.left.path)
        .toLowerCase()
        .endsWith(f.suffix.toLowerCase()),
    );
    const result = await native("compare_text", {
      left: inputs.left.text,
      right: inputs.right.text,
      jobId,
      showMinor: includeMinor,
      options: {
        ignoreCase: profile?.ignoreCase ?? settings.ignoreCase,
        ignoreWhitespace:
          profile?.ignoreWhitespace ?? settings.ignoreWhitespace,
        ignoreLineEndings:
          profile?.ignoreLineEndings ?? settings.ignoreLineEndings,
        patterns: profile?.patterns ?? settings.unimportantPatterns,
      },
    });
    if (request === revision.current) {
      setSpans(result);
      if (afterCopy) {
        const remaining = result.filter((span) => span.kind !== "equal");
        const next = remaining.findIndex(
          (span) => span.leftStart >= afterCopy.leftStart,
        );
        setCurrent(next < 0 ? Math.max(0, remaining.length - 1) : next);
      } else {
        setCurrent(0);
        setNavigation((value) => value + 1);
      }
    }
  }
  const changes = spans?.filter((s) => s.kind !== "equal") ?? [];
  const editorGaps = useMemo(
    () => ({
      left: alignmentGaps(spans ?? [], "left"),
      right: alignmentGaps(spans ?? [], "right"),
    }),
    [spans],
  );
  const selected = changes[current];
  function selectDifference(index: number) {
    if (textFilter === "same") setTextFilter("all");
    setCurrent(index);
    setRefinement(null);
    setNavigation((value) => value + 1);
  }
  async function copyDifference(source: "left" | "right", span: DiffSpan) {
    const destination = source === "left" ? "right" : "left";
    const text = copyRange(
      editors[source].text,
      editors[destination].text,
      source === "left" ? span.leftStart : span.rightStart,
      source === "left" ? span.leftEnd : span.rightEnd,
      destination === "left" ? span.leftStart : span.rightStart,
      destination === "left" ? span.leftEnd : span.rightEnd,
    );
    const inputs = {
      ...editors,
      [destination]: {
        ...editors[destination],
        text,
        history: [
          ...editors[destination].history.slice(-49),
          editors[destination].text,
        ],
      },
    };
    revision.current += 1;
    setRefinement(null);
    setBlocks(null);
    setChoices({});
    setEditors(inputs);
    try {
      await compareInputs(inputs, span);
    } catch (failure) {
      setSpans(null);
      throw failure;
    } finally {
      rootElement.current
        ?.closest('[aria-hidden="false"]')
        ?.querySelector<HTMLElement>(
          `.cm-content[aria-label="${destination === "left" ? "Left text" : "Right text"}"]`,
        )
        ?.focus({ preventScroll: true });
    }
    setNotice(
      `Copied to ${destination} draft. Differences refreshed; Save writes the file.`,
    );
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

  async function scan(requestedRoots = folderRoots) {
    discardPreview(tab.id);
    setPreview(null);
    setLocalPreview(null);
    setFolders([]);
    setHasScanned(false);
    setSelectedFiles([]);
    setProgress(0);
    const roots =
      requestedRoots.left && requestedRoots.right
        ? await native("normalize_folder_roots", requestedRoots)
        : requestedRoots;
    setNativeFolderRoots(roots);
    rememberRoots(roots);
    setSettings((prior) => ({
      ...prior,
      recent: [...new Set([roots.left, roots.right, ...prior.recent])]
        .filter(Boolean)
        .slice(0, 20),
    }));
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const result = await native("scan_folders", {
      left: roots.left,
      right: roots.right,
      options: folderOptions(),
      rules: folderRules,
      jobId,
    });
    setFolders(result);
    const spaceFor = async (side: FolderSide) => {
      if (!roots[side]) return "";
      try {
        const value = await native("disk_space", { path: roots[side] });
        return `${BigInt(value.availableBytes).toLocaleString()} bytes free`;
      } catch (failure) {
        return `Free space unavailable: ${errorMessage(failure)}`;
      }
    };
    const space = await Promise.all([spaceFor("left"), spaceFor("right")]);
    setDiskSpace({ left: space[0], right: space[1] });
    setHasScanned(true);
    setFolderStale(false);
    setNotice(
      roots.left && roots.right
        ? `Scan complete: ${result.length} file entries.`
        : `Listed ${result.length} entries. Choose the other folder to compare.`,
    );
  }
  function folderOptions() {
    return {
      criterion: "content",
      exclude: exclude.split("\n").filter(Boolean),
    };
  }
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
  async function normalizeFolderRoots() {
    const roots = await native("normalize_folder_roots", folderRoots);
    setNativeFolderRoots(roots);
    return roots;
  }
  async function createPreview(
    syncMode: string,
    selected: string[] | null = null,
    destination: "left" | "right" = "right",
  ) {
    const roots = await normalizeFolderRoots();
    if (!(await claimPreview(tab.id))) return;
    setPreview(null);
    setPreviewDirection(destination);
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const result = await native("preview_sync", {
      left: destination === "right" ? roots.left : roots.right,
      right: destination === "right" ? roots.right : roots.left,
      options: folderOptions(),
      mode: syncMode,
      selected,
      jobId,
    }).catch((failure: unknown) => {
      discardPreview(tab.id);
      throw failure;
    });
    setPreview(result);
  }
  async function previewFile(
    relative: string,
    action: string,
    destination: "left" | "right" = "right",
  ) {
    const roots = await normalizeFolderRoots();
    if (!(await claimPreview(tab.id))) return;
    setPreview(null);
    setPreviewDirection(destination);
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const result = await native("preview_file_action", {
      left: destination === "right" ? roots.left : roots.right,
      right: destination === "right" ? roots.right : roots.left,
      options: folderOptions(),
      relative,
      action,
      jobId,
    }).catch((failure: unknown) => {
      discardPreview(tab.id);
      throw failure;
    });
    setPreview(result);
  }
  async function executePreview() {
    if (
      !preview ||
      !(await confirmAction(
        `Execute these ${preview.operations.length} operations from ${previewDirection === "right" ? "LEFT to RIGHT" : "RIGHT to LEFT"}?\nSource: ${previewDirection === "right" ? folderRoots.left : folderRoots.right}\nDestination: ${previewDirection === "right" ? folderRoots.right : folderRoots.left}\nOverwrites and recycle-bin deletions are included exactly as listed.`,
      ))
    )
      return;
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const id = preview.id;
    discardPreview(tab.id);
    setPreview(null);
    const results = await native("execute_sync", { id, jobId });
    diskChanged([nativeFolderRoots.left, nativeFolderRoots.right]);
    const failures = results.filter((r) => r.error);
    setNotice(
      `Completed ${results.length - failures.length} of ${results.length} operations.`,
    );
    if (failures.length)
      throw new Error(
        failures.map((f) => `${f.relative}: ${f.error}`).join("\n"),
      );
    await scan();
  }
  async function mergeInputs() {
    if (
      output !== outputSaved &&
      !(await confirmAction("Replace unsaved merge output with a new merge?"))
    )
      return;
    const result = await native("merge_text", {
      base: editors.base.text,
      left: editors.left.text,
      right: editors.right.text,
      gitSession: !!gitOutput,
    });
    setBlocks(result);
    setChoices({});
    setOutput(
      result
        .filter(
          (b): b is Extract<Block, { kind: "resolved" }> =>
            b.kind === "resolved",
        )
        .map((b) => b.text)
        .join(""),
    );
  }
  async function resolve(index: number, text: string) {
    const generated =
      blocks
        ?.map((b, i) => (b.kind === "resolved" ? b.text : (choices[i] ?? "")))
        .join("") ?? "";
    if (
      output !== generated &&
      !(await confirmAction(
        "Replace manual output edits with this conflict resolution?",
      ))
    )
      return;
    const updated = { ...choices, [index]: text };
    setChoices(updated);
    setOutput(
      blocks
        ?.map((b, i) => (b.kind === "resolved" ? b.text : (updated[i] ?? "")))
        .join("") ?? "",
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
    initialized.current = true;
    void attempt(async () => {
      if (mode === "folder") {
        setFolderRoots({ left: tab.left, right: tab.right });
        if (tab.left || tab.right)
          await scan({ left: tab.left, right: tab.right });
      } else {
        const inputs = { ...editors };
        if (tab.base) await load("base", tab.base);
        if (tab.left)
          inputs.left = (await load("left", tab.left)) ?? inputs.left;
        if (tab.right)
          inputs.right = (await load("right", tab.right)) ?? inputs.right;
        if (mode === "text" && tab.left && tab.right)
          await compareInputs(inputs);
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
  const title =
    titleLeft || titleRight
      ? `${titleLeft || "Untitled"} / ${titleRight || "Untitled"}`
      : mode === "folder"
        ? "Folder Compare"
        : mode === "merge"
          ? "3-Way Merge"
          : "Text Compare";
  const dirty =
    Object.values(editors).some((e) => e.text !== e.original) ||
    output !== outputSaved;
  const undoLeft = !!editors.left.history.length;
  const undoRight = !!editors.right.history.length;
  const differenceCount = changes.length;
  const canSaveOutput = mode === "merge" && blocks !== null && unresolved === 0;
  useEffect(() => {
    report(tab.id, {
      title,
      dirty,
      error,
      undoLeft,
      undoRight,
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
    differenceCount,
    canSaveOutput,
  ]);
  useLayoutEffect(() => {
    register(tab.id, {
      dirty: () =>
        Object.values(latest.current.editors).some(
          (e) => e.text !== e.original,
        ) || latest.current.output !== latest.current.outputSaved,
      dispose: async () => {
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
        setLocalPreview(null);
      },
      diskChanged: (paths) => {
        const affected = (path: string) =>
          paths.some((changed) => relatedPaths(path, changed));
        const changedSides = (["left", "right", "base"] as const).filter(
          (side) => affected(editors[side].document?.path ?? ""),
        );
        if (changedSides.length)
          setStaleSides((prior) => [...new Set([...prior, ...changedSides])]);
        if (affected(outputDocument?.path ?? "")) setStaleOutput(true);
        if (
          mode === "folder" &&
          (affected(folderRoots.left) ||
            affected(folderRoots.right) ||
            affected(nativeFolderRoots.left) ||
            affected(nativeFolderRoots.right))
        )
          setFolderStale(true);
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
          setLocalPreview(null);
          setNotice(
            "Files changed on disk. Rescan folders or reopen inputs to refresh; drafts are retained.",
          );
        }
      },
      command: (name) => {
        if (name === "run")
          void attempt(() =>
            mode === "folder"
              ? scan()
              : mode === "merge"
                ? mergeInputs()
                : compareInputs(),
          );
        else if (name === "previous" || name === "next") {
          if (changes.length)
            selectDifference(
              (current + (name === "next" ? 1 : -1) + changes.length) %
                changes.length,
            );
        } else if (name === "rules" && mode === "folder") {
          setRulesOpen(true);
        } else if (
          name === "rules" ||
          name === "sessions" ||
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
          <span className={e.text !== e.original ? "badge unsaved" : "badge"}>
            {mode === "folder"
              ? "Folder"
              : e.text !== e.original
                ? "Unsaved"
                : e.document
                  ? "Saved"
                  : "Draft"}
          </span>
        </div>
        <label>
          {mode === "folder" ? "Folder path" : "File path"}
          <input
            aria-label={`${side} path`}
            name={`${side}-path`}
            autoComplete="off"
            spellCheck={false}
            list={`recent-${tab.id}-${side}`}
            placeholder={
              mode === "folder"
                ? "Choose a folder or paste its path..."
                : "Choose a file or paste its path..."
            }
            value={
              mode === "folder" && side !== "base" ? folderRoots[side] : e.path
            }
            disabled={busy}
            onChange={(event) => {
              const path = event.target.value;
              if (mode === "folder" && side !== "base") {
                invalidateFolders();
                setFolderRoots((prior) => ({ ...prior, [side]: path }));
              } else {
                setEditors((prior) => ({
                  ...prior,
                  [side]: { ...prior[side], path },
                }));
              }
            }}
          />
          <datalist id={`recent-${tab.id}-${side}`}>
            {settings.recent.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </label>
        <div className="toolbar compact">
          {mode === "folder" && side !== "base" && (
            <>
              <button
                aria-label={`Back ${side}`}
                title="Navigate back in this side's path history"
                disabled={busy || rootHistory[side].index === 0}
                onClick={() => void attempt(() => navigateHistory(side, -1))}
              >
                {"<"}
              </button>
              <button
                aria-label={`Forward ${side}`}
                title="Navigate forward in this side's path history"
                disabled={
                  busy ||
                  rootHistory[side].index + 1 >= rootHistory[side].paths.length
                }
                onClick={() => void attempt(() => navigateHistory(side, 1))}
              >
                {">"}
              </button>
              <button
                aria-label={`Parent ${side}`}
                title="Navigate to this folder's parent"
                disabled={busy || !folderRoots[side]}
                onClick={() => void attempt(() => navigateParent(side))}
              >
                Up
              </button>
              <button
                aria-label={`Linked parents ${side}`}
                title="Navigate both roots to their parents together"
                disabled={busy || !folderRoots.left || !folderRoots.right}
                onClick={() => void attempt(() => navigateParent(side, true))}
              >
                Both up
              </button>
            </>
          )}
          <button
            aria-label={`Browse ${side}`}
            title={`Choose a ${mode === "folder" ? "folder" : "file"} for the ${side} input`}
            disabled={busy}
            onClick={() => void attempt(() => loadDialog(side))}
          >
            Browse
          </button>
          {mode !== "folder" && (
            <>
              <button
                aria-label={`Open ${side}`}
                title={`Open the typed ${side} file path; dirty drafts require confirmation`}
                disabled={busy || !e.path}
                onClick={() => void attempt(() => openSide(side))}
              >
                Open
              </button>
              <button
                aria-label={`Save ${side}`}
                title={`Save the ${side} draft with stale-file checks (Ctrl+S in this editor)`}
                disabled={busy}
                onClick={() => void attempt(() => saveSide(side))}
              >
                Save
              </button>
              <button
                aria-label={`Save ${side} As`}
                title="Save a new file without overwriting an existing file"
                disabled={busy}
                onClick={() => void attempt(() => saveSide(side, true))}
              >
                Save As
              </button>
              <button
                aria-label={`Undo ${side}`}
                title={`Undo the previous ${side} draft change`}
                disabled={busy || !e.history.length}
                onClick={() => void attempt(() => undoSide(side))}
              >
                Undo
              </button>
              <details className="file-options">
                <summary>More</summary>
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
        {mode !== "folder" && (
          <>
            <p className="metadata">
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
                ? " / disk changed; reopen to refresh"
                : ""}
            </p>
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
                onUndo={() => {
                  if (!busy) void attempt(() => undoSide(side));
                }}
                displayMode={mode === "text" ? textFilter : "all"}
                differences={
                  mode === "text" && side !== "base" ? (spans ?? []) : []
                }
                side={side === "right" ? "right" : "left"}
                selectedDifference={mode === "text" ? selected : undefined}
                onCopyDifference={
                  mode === "text" && side !== "base"
                    ? (span) => void attempt(() => copyDifference(side, span))
                    : undefined
                }
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
  const filteredFolders = folders.filter(
    (row) =>
      peek ||
      (matchesName(row.relative, quickFilter || "*") &&
        (filesVisible === "all" ||
          row.isDirectory === (filesVisible === "folders")) &&
        (showMinor || row.importance !== "unimportant") &&
        !ignored.has(row.relative)),
  );
  const visibleFolders = filteredFolders.filter((row) =>
    matchesFilter(row, peek ? "all" : filter),
  );
  async function openPair(row: FolderEntry) {
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
    setOverwriteAction(false);
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
        discardPreview(tab.id);
        setPreview(null);
        setLocalPreview(null);
        const roots = await normalizeFolderRoots();
        const jobId = crypto.randomUUID();
        startJob(jobId);
        const refreshed = await native("compare_folder_selection", {
          ...roots,
          options: folderOptions(),
          rules: folderRules,
          selected: entries.map((entry) => entry.relative),
          previous: folders,
          jobId,
        });
        setFolders(refreshed);
        setSelectedFiles((prior) =>
          prior.filter((path) =>
            refreshed.some((entry) => entry.relative === path),
          ),
        );
        setNotice(
          `Refreshed ${entries.length} selected entries, their descendants, and affected directory summaries.`,
        );
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
      setExclude((prior) =>
        [
          prior,
          ...entries.map((entry) =>
            entry.relative.replace(/([*?[\]{}\\])/g, "[$1]"),
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      );
      invalidateFolders();
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
          : "",
    );
    setFolderDialog({ action, entries, side });
  }
  async function compareSelectedContents(
    entries: FolderEntry[],
    method: "binary" | "rules" | "crc",
    showResults: boolean,
  ) {
    const roots = await normalizeFolderRoots();
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
      previous: folders,
      jobId,
    });
    setFolders(compared);
    const selectedResults = compared.filter((entry) =>
      entries.some(
        (selected) =>
          selected.relative === entry.relative ||
          (selected.isDirectory &&
            entry.relative.startsWith(`${selected.relative}/`)),
      ),
    );
    if (showResults) setContentResults(selectedResults);
    setFolderDialog(null);
    setNotice(
      `Compared ${selectedResults.length} selected entries. ${selectedResults.filter((entry) => entry.status === "error").length} errors.`,
    );
  }
  async function prepareFolderAction() {
    if (!folderDialog) return;
    const { action, entries, side } = folderDialog;
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
      const expanded = entries.length
        ? folders
            .filter((entry) =>
              entries.some(
                (selected) =>
                  entry.relative === selected.relative ||
                  (selected.isDirectory &&
                    entry.relative.startsWith(`${selected.relative}/`)),
              ),
            )
            .filter(
              (entry) =>
                (side === "left" ? entry.leftSize : entry.rightSize) !== null,
            )
            .map((entry) => entry.relative)
        : null;
      setFolderDialog(null);
      await createPreview(
        dialogValue,
        expanded,
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
      for (const [index, entry] of entries.entries()) {
        if (
          entries.some(
            (parent) =>
              parent !== entry &&
              parent.isDirectory &&
              entry.relative.startsWith(`${parent.relative}/`),
          )
        )
          continue;
        const sourceRelative =
          (side === "left" ? entry.leftRelative : entry.rightRelative) ??
          entry.relative;
        let targetRelative =
          opposite === "left" ? entry.leftRelative : entry.rightRelative;
        if (!targetRelative) {
          const parent = folders
            .filter(
              (candidate) =>
                candidate.isDirectory &&
                entry.relative.startsWith(`${candidate.relative}/`) &&
                (opposite === "left"
                  ? candidate.leftRelative
                  : candidate.rightRelative),
            )
            .sort((a, b) => b.relative.length - a.relative.length)[0];
          targetRelative = parent
            ? `${opposite === "left" ? parent.leftRelative : parent.rightRelative}/${entry.relative.slice(parent.relative.length + 1)}`
            : sourceRelative;
        }
        requests.push({
          kind: action === "copySide" ? "copyTo" : "moveTo",
          source: sources[index]!,
          destination: await join(
            folderRoots[opposite],
            ...targetRelative.split("/"),
          ),
          overwrite: overwriteAction,
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
        overwrite: overwriteAction,
      };
    } else throw new Error("Choose a supported filesystem action.");
    if (!(await claimPreview(tab.id))) return;
    setPreview(null);
    setLocalPreview(null);
    const jobId = crypto.randomUUID();
    startJob(jobId);
    try {
      const result = await native("preview_local_action", { request, jobId });
      setLocalPreview(result);
      setFolderDialog(null);
    } catch (failure) {
      discardPreview(tab.id);
      throw failure;
    }
  }
  async function executeLocalPreview() {
    if (
      !localPreview ||
      !(await confirmAction(
        `Execute exactly these ${localPreview.operations.length} local actions? Recycling has no permanent-delete fallback. Partial effects are not rolled back.`,
      ))
    )
      return;
    const plan = localPreview;
    setLocalPreview(null);
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
    diskChanged(paths);
    setFolderStale(true);
    const failures = results.filter(
      (item) => item.result.status !== "completed",
    );
    setNotice(
      `Completed ${results.length - failures.length} of ${results.length} local actions. Rescan to refresh this listing.`,
    );
    if (failures.length)
      throw new Error(
        failures
          .map(
            (item) =>
              `${item.operation.source ?? item.operation.destination}: ${item.result.message ?? item.result.status}`,
          )
          .join("\n"),
      );
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
          event.key === "Enter" &&
          (mode === "text" || mode === "folder" || mode === "merge")
        ) {
          event.preventDefault();
          void attempt(() =>
            mode === "folder"
              ? scan()
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
          selectDifference(
            (current + (event.key === "ArrowDown" ? 1 : -1) + changes.length) %
              changes.length,
          );
        }
      }}
    >
      {rulesOpen && (
        <FolderRulesDialog
          rules={folderRules}
          exclusions={exclude}
          onClose={() => setRulesOpen(false)}
          onApply={(next, exclusions, makeDefault) => {
            setFolderRules(next);
            setExclude(exclusions);
            invalidateFolders();
            setRulesOpen(false);
            if (makeDefault) {
              updateSettings((prior) => ({ ...prior, folderRules: next }));
              setNotice(
                "Defaults changed for new folder workspaces. Save preferences to persist.",
              );
            }
          }}
        />
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
                  const items = folders.filter((entry) =>
                    folderDialog.entries.some(
                      (selected) =>
                        selected.relative === entry.relative ||
                        (selected.isDirectory &&
                          entry.relative.startsWith(`${selected.relative}/`)),
                    ),
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
          ) : (
            <p>
              No files change until you inspect and approve the exact native
              preview.
            </p>
          )}
          {["copySide", "moveSide", "copyFolder", "moveFolder"].includes(
            folderDialog.action,
          ) && (
            <label>
              <input
                type="checkbox"
                checked={overwriteAction}
                disabled={busy}
                onChange={(event) => setOverwriteAction(event.target.checked)}
              />
              Allow replacement of existing files (every replacement appears in
              the preview)
            </label>
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
                    : "Build an exact native preview; no files change until separate execution approval."
              }
              disabled={busy}
              onClick={() => void attempt(prepareFolderAction)}
            >
              {folderDialog.action === "compareContents"
                ? "Start"
                : folderDialog.action === "copyFilename"
                  ? "Copy"
                  : "Preview"}
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
      {localPreview && (
        <WorkspaceDialog
          title="Local action preview"
          onClose={() => {
            if (!busy) {
              setLocalPreview(null);
              discardPreview(tab.id);
            }
          }}
        >
          <p>
            No files changed. Inspect every source, destination and replacement
            before execution.
          </p>
          <div className="local-preview-entries">
            {localPreview.operations.flatMap((operation) =>
              operation.entries.map((entry, index) => (
                <p key={`${operation.source}-${index}`}>
                  <strong>
                    {entry.action.kind}
                    {entry.replacesExisting ? " (replaces existing)" : ""}
                  </strong>
                  <br />
                  {entry.source ?? "(new)"}
                  <br />
                  {entry.destination ?? "(recycle / metadata change)"}
                </p>
              )),
            )}
          </div>
          <div className="dialog-actions">
            <button
              disabled={busy}
              onClick={() => {
                setLocalPreview(null);
                discardPreview(tab.id);
              }}
            >
              Cancel
            </button>
            <button
              disabled={busy}
              className="primary"
              onClick={() => void attempt(executeLocalPreview)}
            >
              Confirm and execute preview
            </button>
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
        {mode === "folder" && (
          <span className="folder-status-counts">
            {folderStale ? "Results stale / " : ""}
            {visibleFolders.length} visible / {selectedFiles.length} selected /
            L:{" "}
            {folders
              .reduce(
                (sum, entry) =>
                  sum + (!entry.isDirectory ? (entry.leftSize ?? 0) : 0),
                0,
              )
              .toLocaleString()}{" "}
            bytes / R:{" "}
            {folders
              .reduce(
                (sum, entry) =>
                  sum + (!entry.isDirectory ? (entry.rightSize ?? 0) : 0),
                0,
              )
              .toLocaleString()}{" "}
            bytes
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
          Ctrl+Enter: run / Ctrl+S: save focused editor
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
      <details className="session-panel floating-panel" data-panel="sessions">
        <summary>
          Sessions and recent files{" "}
          <span className="metadata">
            ({settings.sessions.length} saved sessions)
          </span>
        </summary>
        <button
          disabled={!settingsReady || busy}
          onClick={() => {
            const name = window.prompt("Session name");
            if (!name) return;
            setSettings((prior) => ({
              ...prior,
              sessions: [
                ...prior.sessions,
                {
                  name,
                  left:
                    mode === "folder" ? folderRoots.left : editors.left.path,
                  right:
                    mode === "folder" ? folderRoots.right : editors.right.path,
                  mode,
                  base: mode === "merge" ? editors.base.path : "",
                  ...(mode === "folder" ? { folderRules } : {}),
                },
              ],
            }));
          }}
        >
          Add current session
        </button>
        <p>Save preferences to persist changes.</p>
        {!settings.sessions.length && !settings.recent.length && (
          <p className="empty-state">
            No saved sessions yet. Open your files, add the current session,
            then save preferences to use it again.
          </p>
        )}
        <button
          disabled={!settingsReady || busy}
          onClick={() => {
            const suffix = window.prompt(
              "File suffix for current compare rules (for example .txt):",
            );
            if (!suffix) return;
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
          }}
        >
          Save current rules as file-format profile
        </button>
        {settings.formats.map((format, index) => (
          <div key={index}>
            <span>
              Profile {format.suffix} (overrides global options for matching
              left-file suffix)
            </span>
            <button
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
        {settings.sessions.map((session, index) => (
          <div key={index}>
            <button disabled={busy} onClick={() => openSession(session)}>
              {session.name}
            </button>
            <button
              onClick={() =>
                setSettings((prior) => ({
                  ...prior,
                  sessions: prior.sessions.filter((_, i) => i !== index),
                }))
              }
            >
              Remove session {index + 1}
            </button>
          </div>
        ))}
        {settings.recent.map((path) => (
          <button
            key={path}
            disabled={busy}
            onClick={() => openTab("text", { left: path })}
          >
            {path}
          </button>
        ))}
      </details>
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
            className="toolbar command-bar compact-command-bar"
            aria-label="Text comparison actions"
          >
            <ToolButton
              label="Home"
              symbol="⌂"
              description="Return to Home, keeping this workspace and unsaved drafts."
              onClick={onHome}
            />
            <ToolButton
              label="Sessions"
              symbol="▣"
              description="Open saved sessions and comparison profiles."
              onClick={() => controllersCommand("sessions")}
            />
            <ToolButton
              label="All"
              symbol="*"
              description="Show every source line."
              aria-pressed={textFilter === "all"}
              onClick={() => setTextFilter("all")}
            />
            <ToolButton
              label="Diffs"
              symbol="≠"
              description="Fold equal lines while retaining complete editable source documents."
              aria-pressed={textFilter === "differences"}
              disabled={!spans}
              onClick={() => setTextFilter("differences")}
            />
            <ToolButton
              label="Same"
              symbol="="
              description="Fold changed lines; hidden text remains in the source document."
              aria-pressed={textFilter === "same"}
              disabled={!spans}
              onClick={() => setTextFilter("same")}
            />
            <ToolButton
              label="Context"
              symbol="⋯"
              description="Show changes with three surrounding equal lines on either side."
              aria-pressed={textFilter === "context"}
              disabled={!spans}
              onClick={() => setTextFilter("context")}
            />
            <ToolButton
              label="Minor"
              symbol="~"
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
              label="Rules"
              symbol="⚙"
              description="Edit comparison rules; changes invalidate existing results."
              onClick={() => controllersCommand("rules")}
            />
            <ToolButton
              label="Format"
              symbol="▤"
              description="Manage comparison-format profiles, not source-code formatting."
              onClick={() => controllersCommand("sessions")}
            />
            <button
              className="primary"
              title="Compare the current drafts (Ctrl+Enter); does not save either file."
              disabled={busy}
              onClick={() => void attempt(() => compareInputs())}
            >
              {busy ? "Comparing..." : "Compare"}
            </button>
            <ToolButton
              label="Reload"
              symbol="↻"
              description="Reopen both file inputs. Dirty drafts require confirmation; failures retain existing text."
              disabled={busy || (!editors.left.path && !editors.right.path)}
              onClick={() =>
                void attempt(async () => {
                  if (!(await discard("left")) || !(await discard("right")))
                    return;
                  if (editors.left.path)
                    await load("left", editors.left.path, null, false);
                  if (editors.right.path)
                    await load("right", editors.right.path, null, false);
                })
              }
            />
            <button
              disabled={busy}
              title="Swap both inputs, their drafts, and metadata without writing files."
              onClick={() => controllersCommand("swap")}
            >
              Swap sides
            </button>
            <button
              aria-label="Previous difference"
              title="Previous difference (Alt+Up)"
              disabled={busy || !changes.length}
              onClick={() =>
                selectDifference(
                  (current - 1 + changes.length) % changes.length,
                )
              }
            >
              Previous
            </button>
            <button
              aria-label="Next difference"
              title="Next difference (Alt+Down)"
              disabled={busy || !changes.length}
              onClick={() => selectDifference((current + 1) % changes.length)}
            >
              Next
            </button>
            <span className="difference-count">
              {spans
                ? changes.length
                  ? `${current + 1} / ${changes.length} differences`
                  : "No differences"
                : "Not compared"}
            </span>
            {selected && (
              <>
                <button
                  aria-label="Copy region to right"
                  title="Copy the selected region into the right draft. Save is separate."
                  disabled={busy}
                  onClick={() =>
                    void attempt(() => copyDifference("left", selected))
                  }
                >
                  Copy to right
                </button>
                <button
                  aria-label="Copy region to left"
                  title="Copy the selected region into the left draft. Save is separate."
                  disabled={busy}
                  onClick={() =>
                    void attempt(() => copyDifference("right", selected))
                  }
                >
                  Copy to left
                </button>
                <button
                  aria-label="Refine selected region"
                  title="Inspect intraline differences within the selected region without editing either draft."
                  disabled={busy}
                  onClick={() =>
                    void attempt(async () =>
                      setRefinement(
                        await native("refine_text", {
                          left: leftLines
                            .slice(selected.leftStart, selected.leftEnd)
                            .map((l) => l.full)
                            .join(""),
                          right: rightLines
                            .slice(selected.rightStart, selected.rightEnd)
                            .map((l) => l.full)
                            .join(""),
                        }),
                      ),
                    )
                  }
                >
                  Intraline detail
                </button>
              </>
            )}
          </div>
          {inputs}
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
              Run Compare to highlight changed lines. Copies refresh differences
              automatically; compare again after manual edits.
            </p>
          )}
          {spans && (
            <section aria-live="polite">
              <h2>{changes.length} changed regions</h2>
              <p className="result-summary">
                {changes.length
                  ? `Difference ${current + 1} of ${changes.length}. Use Previous / Next or Alt+Up / Alt+Down to navigate.`
                  : "No differences under the current comparison rules."}
              </p>
              <div
                className="selected-line-detail"
                aria-label="Selected difference detail"
              >
                <code
                  title={selected ? leftLines[selected.leftStart]?.content : ""}
                >
                  L{" "}
                  {selected
                    ? `${selected.leftStart + 1}: ${leftLines[selected.leftStart]?.content ?? "(no line)"}`
                    : "No selected difference"}
                </code>
                <code
                  title={
                    selected ? rightLines[selected.rightStart]?.content : ""
                  }
                >
                  R{" "}
                  {selected
                    ? `${selected.rightStart + 1}: ${rightLines[selected.rightStart]?.content ?? "(no line)"}`
                    : "No selected difference"}
                </code>
              </div>
              <details className="comparison-details" data-panel="details">
                <summary>Aligned read-only view &amp; range details</summary>
                <VirtualList
                  count={aligned.length}
                  label="Aligned line comparison"
                  render={(index) => {
                    const row = aligned[index];
                    if (!row) return null;
                    return (
                      <div className={`aligned ${row.kind}`}>
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
              {refinement && selected && (
                <RefinedRegion
                  left={leftLines
                    .slice(selected.leftStart, selected.leftEnd)
                    .map((l) => l.full)
                    .join("")}
                  right={rightLines
                    .slice(selected.rightStart, selected.rightEnd)
                    .map((l) => l.full)
                    .join("")}
                  spans={refinement}
                />
              )}
              {refinement && (
                <p>
                  Intraline changed byte ranges:{" "}
                  {refinement
                    .filter((s) => s.kind !== "equal")
                    .map(
                      (s) =>
                        `${s.kind}: left ${s.leftStart}..${s.leftEnd}, right ${s.rightStart}..${s.rightEnd}`,
                    )
                    .join("; ")}
                </p>
              )}
            </section>
          )}
        </>
      )}
      {mode === "folder" && (
        <>
          <div
            className="toolbar command-bar compact-command-bar"
            aria-label="Folder comparison actions"
          >
            <ToolButton
              label="Home"
              symbol="⌂"
              description="Return to Home without closing this workspace."
              onClick={onHome}
            />
            <ToolButton
              label="Sessions"
              symbol="▣"
              description="Open saved sessions and recent paths."
              onClick={() => controllersCommand("sessions")}
            />
            <ToolButton
              label="All"
              symbol="*"
              description="Show all scanned entries."
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <CommandMenu
              label="Diffs"
              description={`Current filter: ${differenceFilters.find(([value]) => value === filter)?.[1] ?? filter}. Comparison and refresh preserve this choice.`}
              commands={differenceFilters.map(([value, label]) => ({
                label,
                run: () => setFilter(value),
              }))}
            />
            <ToolButton
              label="Same"
              symbol="="
              description="Show entries equal under the active rules."
              aria-pressed={filter === "same"}
              onClick={() => setFilter("same")}
            />
            <CommandMenu
              label="Structure"
              commands={[
                { label: "Tree view", run: () => folderCommand("tree") },
                { label: "Flat view", run: () => folderCommand("flat") },
              ]}
            />
            <ToolButton
              label="Minor"
              symbol="~"
              description="Include rule-ignored minor differences in the folder view."
              aria-pressed={showMinor}
              onClick={() => setShowMinor(!showMinor)}
            />
            <ToolButton
              label="Rules"
              symbol="⚙"
              description="Edit folder comparison rules and scan exclusions; applying invalidates the current results."
              disabled={busy}
              onClick={() => setRulesOpen(true)}
            />
            <ToolButton
              label="Copy"
              symbol="↔"
              description="Preview selected entries copied from the active side to the opposite side."
              disabled={busy || !selectedFiles.length}
              onClick={() => folderCommand("copySide")}
            />
            <CommandMenu
              label="Copy options"
              commands={[
                {
                  label: "Preview update left to right",
                  disabled: busy,
                  run: () =>
                    void attempt(() => createPreview("update", null, "right")),
                },
                {
                  label: "Preview update right to left",
                  disabled: busy,
                  run: () =>
                    void attempt(() => createPreview("update", null, "left")),
                },
                {
                  label: "Preview mirror left to right",
                  disabled: busy,
                  run: () =>
                    void attempt(() => createPreview("mirror", null, "right")),
                },
                {
                  label: "Preview mirror right to left",
                  disabled: busy,
                  run: () =>
                    void attempt(() => createPreview("mirror", null, "left")),
                },
              ]}
            />
            <ToolButton
              label="Expand"
              symbol="+"
              description="Expand all scanned folder branches."
              onClick={() => folderCommand("expand")}
            />
            <ToolButton
              label="Collapse"
              symbol="−"
              description="Collapse all folder branches without losing selection."
              onClick={() => folderCommand("collapse")}
            />
            <CommandMenu
              label="Select"
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
            <CommandMenu
              label="Files"
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
            <ToolButton
              label="Refresh"
              aria-label="Scan folders"
              symbol="↻"
              description="Read both roots and refresh their comparison (Ctrl+Enter)."
              disabled={busy}
              onClick={() => void attempt(scan)}
            />
            <ToolButton
              label="Swap"
              symbol="⇄"
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
              symbol="x"
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
            <label className="quick-filter">
              Filters:
              <input
                aria-label="Filename display filter"
                title="Filename patterns separated by semicolons; * and ? are wildcards. Display only, not scan exclusions."
                value={quickFilter}
                onChange={(event) => setQuickFilter(event.target.value)}
              />
            </label>
            <ToolButton
              label="Filters"
              symbol="▽"
              description="Edit native scan exclusions and comparison rules."
              onClick={() => controllersCommand("rules")}
            />
            <ToolButton
              label="Peek"
              symbol="◉"
              description="Temporarily reveal display-filtered and ignored rows, but not excluded or unscanned paths."
              aria-pressed={peek}
              onClick={() => setPeek(!peek)}
            />
          </div>
          {inputs}
          <p className="result-summary">
            {folderStale
              ? "Files changed on disk. These folder results may be stale; rescan to refresh."
              : hasScanned
                ? `${visibleFolders.length} matching entries / ${selectedFiles.length} selected.`
                : "Scan folders to list their contents. Row arrows preview either copy direction; Update and Mirror run left to right."}
          </p>
          {folders.some((entry) => entry.status === "error") && (
            <button
              className="folder-errors"
              onClick={() => setFilter("error")}
            >
              Show {folders.filter((entry) => entry.status === "error").length}{" "}
              comparison errors
            </button>
          )}
          <FolderView
            entries={filteredFolders}
            filter={peek ? "all" : filter}
            busy={busy}
            selected={selectedFiles}
            onSelect={(relative, checked) =>
              setSelectedFiles((prior) =>
                checked
                  ? [...prior.filter((name) => name !== relative), relative]
                  : prior.filter((name) => name !== relative),
              )
            }
            openPair={(row) => void attempt(() => openPair(row))}
            preview={(row, action, destination) =>
              void attempt(() => previewFile(row.relative, action, destination))
            }
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
            <section className="sync-preview" aria-label="Sync preview">
              <h2>Sync preview: {preview.operations.length} operations</h2>
              <p>
                No changes have been made. Execution revalidates this preview;
                no permanent deletion is used.
              </p>
              <p>
                Direction:{" "}
                {previewDirection === "right"
                  ? "LEFT to RIGHT"
                  : "RIGHT to LEFT"}
              </p>
              <p>
                Source:{" "}
                {previewDirection === "right"
                  ? folderRoots.left
                  : folderRoots.right}
              </p>
              <p>
                Destination:{" "}
                {previewDirection === "right"
                  ? folderRoots.right
                  : folderRoots.left}
              </p>
              <VirtualList
                count={preview.operations.length}
                label="Planned operations"
                render={(index) => {
                  const operation = preview.operations[index];
                  return (
                    operation && (
                      <div>
                        {operation.action}: {operation.relative}
                      </div>
                    )
                  );
                }}
              />
              <button
                disabled={busy}
                onClick={() => void attempt(executePreview)}
              >
                Confirm and execute preview
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  discardPreview(tab.id);
                  setPreview(null);
                }}
              >
                Dismiss preview
              </button>
            </section>
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
              {blocks?.map(
                (block, index) =>
                  block.kind === "conflict" && (
                    <article className="conflict" key={index}>
                      <h3>
                        Conflict {index + 1}
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
                        Use left {index + 1}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void attempt(() => resolve(index, block.right))
                        }
                      >
                        Use right {index + 1}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void attempt(() => resolve(index, block.base))
                        }
                      >
                        Use base {index + 1}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void attempt(() => resolve(index, ""))}
                      >
                        Delete conflict {index + 1}
                      </button>
                    </article>
                  ),
              )}
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
