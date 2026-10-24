import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
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
  native,
  textLines,
  type Block,
  type DocumentView,
  type FolderEntry,
  type Preview,
  type Settings,
} from "./api";
import { CodeEditor } from "./CodeEditor";
import { errorMessage, type DiffSpan } from "./comparison";
import { FolderView } from "./FolderView";
import { RefinedRegion } from "./RefinedRegion";
import { VirtualList } from "./VirtualList";
import {
  fileName,
  relatedPaths,
  type SavedSession,
  type WorkspaceController,
  type WorkspaceSummary,
  type WorkspaceTab,
} from "./workbench";

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
    paths?: Partial<Pick<WorkspaceTab, "left" | "right" | "base" | "parent">>,
  ) => void;
  openSession: (session: SavedSession) => void;
  diskChanged: (paths: string[]) => void;
  confirmAction: (message: string) => Promise<boolean>;
  confirmGitExit: (id: string) => Promise<boolean>;
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
}: WorkspaceProps) {
  const [editors, setEditors] = useState<Editors>({
    left: {
      ...editor(tab.left ? "" : "First line\nOriginal text\n"),
      path: tab.left,
    },
    right: {
      ...editor(tab.right ? "" : "First line\nUpdated text\n"),
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
  const [nativeFolderRoots, setNativeFolderRoots] = useState({
    left: "",
    right: "",
  });
  const [filter, setFilter] = useState("all");
  const [criterion, setCriterion] = useState("content");
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
    setNativeFolderRoots({ left: "", right: "" });
    discardPreview(tab.id);
    setPreview(null);
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
    setEditors((prior) => ({
      ...prior,
      [side]: {
        text: document.text,
        original: document.text,
        document,
        path: document.path,
        history: [],
      },
    }));
    setStaleSides((prior) => prior.filter((value) => value !== side));
    setSettings((prior) => ({
      ...prior,
      recent: [
        document.path,
        ...prior.recent.filter((p) => p !== document.path),
      ].slice(0, 20),
    }));
  }
  async function loadDialog(side: Side) {
    const path = await open({ multiple: false, directory: mode === "folder" });
    if (typeof path !== "string") return;
    if (mode === "folder") {
      invalidateFolders();
      if (side !== "base")
        setFolderRoots((prior) => ({ ...prior, [side]: path }));
    } else await load(side, path);
  }
  async function openSide(side: Side, encoding: string | null = null) {
    await load(side, editors[side].path, encoding);
  }
  function undoSide(side: Side) {
    const text = editors[side].history.at(-1);
    if (text === undefined) return;
    invalidate();
    setEditors((prior) => ({
      ...prior,
      [side]: {
        ...prior[side],
        text,
        history: prior[side].history.slice(0, -1),
      },
    }));
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
  }
  async function compareInputs(inputs = editors, afterCopy?: DiffSpan) {
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

  async function scan() {
    discardPreview(tab.id);
    setPreview(null);
    setFolders([]);
    setHasScanned(false);
    setSelectedFiles([]);
    setProgress(0);
    const roots = await normalizeFolderRoots();
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const result = await native("scan_folders", {
      left: roots.left,
      right: roots.right,
      options: folderOptions(),
      jobId,
    });
    setFolders(result);
    setHasScanned(true);
    setFolderStale(false);
    setNotice(`Scan complete: ${result.length} file entries.`);
  }
  function folderOptions() {
    return { criterion, exclude: exclude.split("\n").filter(Boolean) };
  }
  async function normalizeFolderRoots() {
    const roots = await native("normalize_folder_roots", folderRoots);
    setNativeFolderRoots(roots);
    return roots;
  }
  async function createPreview(
    syncMode: string,
    selected: string[] | null = null,
  ) {
    const roots = await normalizeFolderRoots();
    if (!(await claimPreview(tab.id))) return;
    setPreview(null);
    setPreviewDirection("right");
    const jobId = crypto.randomUUID();
    startJob(jobId);
    const result = await native("preview_sync", {
      left: roots.left,
      right: roots.right,
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
      } else {
        if (tab.base) await load("base", tab.base);
        if (tab.left) await load("left", tab.left);
        if (tab.right) await load("right", tab.right);
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
            setFolderRoots((prior) => ({
              left: paths[0] ?? prior.left,
              right: paths[1] ?? prior.right,
            }));
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
      clearPreview: () => setPreview(null),
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
          if (busy) return;
          if (mode === "folder") {
            invalidateFolders();
            setFolderRoots((prior) => ({
              left: prior.right,
              right: prior.left,
            }));
          } else {
            invalidate();
            setEditors((prior) => ({
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
        } else {
          const [action, side] = name.split(":");
          if (side !== "left" && side !== "right" && side !== "base") return;
          if (action === "browse") void attempt(() => loadDialog(side));
          else if (action === "save") void attempt(() => saveSide(side));
          else if (action === "undo" && !busy) undoSide(side);
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
        </label>
        <div className="toolbar compact">
          <button
            aria-label={`Browse ${side}`}
            disabled={busy}
            onClick={() => void attempt(() => loadDialog(side))}
          >
            Browse
          </button>
          {mode !== "folder" && (
            <>
              <button
                aria-label={`Open ${side}`}
                disabled={busy || !e.path}
                onClick={() => void attempt(() => openSide(side))}
              >
                Open
              </button>
              <button
                aria-label={`Save ${side}`}
                disabled={busy}
                onClick={() => void attempt(() => saveSide(side))}
              >
                Save
              </button>
              <button
                aria-label={`Save ${side} As`}
                disabled={busy}
                onClick={() => void attempt(() => saveSide(side, true))}
              >
                Save As
              </button>
              <button
                aria-label={`Undo ${side}`}
                disabled={busy || !e.history.length}
                onClick={() => undoSide(side)}
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
            <label>
              {side === "left"
                ? "Left text"
                : side === "right"
                  ? "Right text"
                  : "Base text"}
              <CodeEditor
                text={e.text}
                disabled={busy}
                path={e.path}
                label={
                  side === "left"
                    ? "Left text"
                    : side === "right"
                      ? "Right text"
                      : "Base text"
                }
                onChange={(text) => change(side, text)}
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
            </label>
          </>
        )}
      </section>
    );
  }
  const visibleFolders = folders.filter(
    (row) =>
      filter === "all" ||
      (filter === "differences"
        ? row.status !== "same"
        : row.status === filter),
  );
  async function openPair(row: FolderEntry) {
    const segments = row.relative.split("/");
    const left = await join(folderRoots.left, ...segments);
    const right = await join(folderRoots.right, ...segments);
    openTab("text", { left, right, parent: tab.id });
  }
  function renderFolderSide(
    row: FolderEntry,
    side: "left" | "right",
    name = row.relative,
  ) {
    const size = side === "left" ? row.leftSize : row.rightSize;
    const missing = row.status === (side === "left" ? "rightOnly" : "leftOnly");
    const label = side === "left" ? "Left" : "Right";
    return (
      <div
        className={`folder-file ${missing ? "missing" : row.status}`}
        aria-label={`${label}: ${row.relative}`}
      >
        <span
          className="file-name"
          title={row.detail ? `${row.relative}: ${row.detail}` : row.relative}
        >
          {missing
            ? "Not present"
            : `${row.isDirectory ? "[dir] " : ""}${name}`}
        </span>
        <span className="file-size">
          {missing
            ? "-"
            : row.isDirectory
              ? "Folder"
              : size === null
                ? "Size unavailable"
                : `${size.toLocaleString()} bytes`}
        </span>
      </div>
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
          <details className="advanced-rules floating-panel" data-panel="rules">
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
      )}
      {mode === "text" && (
        <>
          <div
            className="toolbar command-bar"
            aria-label="Text comparison actions"
          >
            <button
              className="primary"
              disabled={busy}
              onClick={() => void attempt(() => compareInputs())}
            >
              {busy ? "Comparing..." : "Compare"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                invalidate();
                setEditors((prior) => ({
                  ...prior,
                  left: prior.right,
                  right: prior.left,
                }));
              }}
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
                  disabled={busy}
                  onClick={() =>
                    void attempt(() => copyDifference("left", selected))
                  }
                >
                  Copy to right
                </button>
                <button
                  aria-label="Copy region to left"
                  disabled={busy}
                  onClick={() =>
                    void attempt(() => copyDifference("right", selected))
                  }
                >
                  Copy to left
                </button>
                <button
                  aria-label="Refine selected region"
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
              <div className="overview">
                {changes.map((span, index) => (
                  <button
                    key={index}
                    aria-label={`Go to difference ${index + 1}`}
                    aria-pressed={index === current}
                    disabled={busy}
                    onClick={() => selectDifference(index)}
                  >
                    {span.leftStart + 1}
                  </button>
                ))}
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
            className="toolbar command-bar"
            aria-label="Folder comparison actions"
          >
            <label>
              Criterion
              <select
                aria-label="Criterion"
                value={criterion}
                disabled={busy}
                onChange={(event) => {
                  setCriterion(event.target.value);
                  invalidateFolders();
                }}
              >
                <option value="content">Content hash</option>
                <option value="size">Size</option>
                <option value="modified">Size and timestamp</option>
              </select>
            </label>
            <details
              className="advanced-rules floating-panel"
              data-panel="rules"
            >
              <summary>Folder rules</summary>
              <label>
                Exclusions (glob per line)
                <textarea
                  aria-label="Exclusions (glob per line)"
                  className="rules"
                  value={exclude}
                  disabled={busy}
                  onChange={(event) => {
                    setExclude(event.target.value);
                    invalidateFolders();
                  }}
                />
              </label>
            </details>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void attempt(scan)}
            >
              Scan folders
            </button>
            <button
              disabled={busy}
              onClick={() => void attempt(() => createPreview("update"))}
            >
              Preview update left to right
            </button>
            <button
              disabled={busy}
              onClick={() => void attempt(() => createPreview("mirror"))}
            >
              Preview mirror left to right
            </button>
            <button
              disabled={busy || !selectedFiles.length}
              onClick={() =>
                void attempt(() => createPreview("update", selectedFiles))
              }
            >
              Preview selected copies
            </button>
            <button
              disabled={busy}
              onClick={() => {
                invalidateFolders();
                setFolderRoots((prior) => ({
                  left: prior.right,
                  right: prior.left,
                }));
              }}
            >
              Swap folder roots
            </button>
            <label>
              Show
              <select
                aria-label="Show"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                {[
                  ["all", "All entries"],
                  ["differences", "Differences"],
                  ["same", "Same"],
                  ["leftOnly", "Left only"],
                  ["rightOnly", "Right only"],
                  ["error", "Errors"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {inputs}
          <p className="result-summary">
            {folderStale
              ? "Files changed on disk. These folder results may be stale; rescan to refresh."
              : hasScanned
                ? `${visibleFolders.length} matching entries / ${selectedFiles.length} selected.`
                : "Scan folders to list their contents. Row arrows preview either copy direction; Update and Mirror run left to right."}
          </p>
          <div className="folder-legend" aria-label="Folder status legend">
            <span className="same">Same</span>
            <span className="different">Different</span>
            <span className="leftOnly">Left only</span>
            <span className="rightOnly">Right only</span>
            <span className="error-state">Error / unavailable</span>
          </div>
          <FolderView
            entries={folders}
            filter={filter}
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
            renderSide={renderFolderSide}
          />
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
