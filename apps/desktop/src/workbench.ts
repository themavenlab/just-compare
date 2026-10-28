import type { FolderRules, Settings } from "./api";

export type Workflow = "text" | "folder" | "merge";
export type SavedSession = Settings["sessions"][number];
export interface WorkspaceTab {
  id: string;
  mode: Workflow;
  left: string;
  right: string;
  base: string;
  gitOutput: string;
  parent: string | null;
  folderRules?: FolderRules;
  sessionName?: string;
}
export interface WorkspaceSummary {
  title: string;
  dirty: boolean;
  status: string;
  error: string;
  undoLeft: boolean;
  undoRight: boolean;
  redoLeft: boolean;
  redoRight: boolean;
  differences: number;
  canSaveOutput: boolean;
}
export interface WorkspaceController {
  dirty: () => boolean;
  dispose: () => Promise<void>;
  drop: (paths: string[]) => Promise<void>;
  progress: (jobId: string, count: number) => void;
  cancel: () => Promise<void>;
  clearPreview: () => void;
  diskChanged: (paths: string[], refreshFolders?: boolean) => void;
  command: (name: string) => void;
}
export function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}
export function relatedPaths(a: string, b: string) {
  const normalized = (path: string) => {
    if (/^(?:[a-z]:[\\/]|\\\\)/i.test(path))
      return path
        .replace(/^\\\\\?\\UNC\\/i, "\\\\")
        .replace(/^\\\\\?\\/, "")
        .replaceAll("/", "\\")
        .replace(/\\+$/, "")
        .toLowerCase();
    return path === "/" ? path : path.replace(/\/+$/, "");
  };
  const left = normalized(a),
    right = normalized(b);
  if (!left || !right) return false;
  const separator = /^(?:[a-z]:|\\\\)/i.test(left) ? "\\" : "/";
  return (
    left === right ||
    left.startsWith(
      right.endsWith(separator) ? right : `${right}${separator}`,
    ) ||
    right.startsWith(left.endsWith(separator) ? left : `${left}${separator}`)
  );
}
export function sameSummary(
  a: WorkspaceSummary | undefined,
  b: WorkspaceSummary,
) {
  return (
    a?.title === b.title &&
    a.dirty === b.dirty &&
    a.status === b.status &&
    a.error === b.error &&
    a.undoLeft === b.undoLeft &&
    a.undoRight === b.undoRight &&
    a.redoLeft === b.redoLeft &&
    a.redoRight === b.redoRight &&
    a.differences === b.differences &&
    a.canSaveOutput === b.canSaveOutput
  );
}
export function sessionWorkflow(mode: string): Workflow {
  if (mode === "text" || mode === "folder" || mode === "merge") return mode;
  throw new Error(`Unsupported session workflow: ${mode}`);
}
