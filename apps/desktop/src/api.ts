import { invoke, isTauri } from "@tauri-apps/api/core";
import type { DiffSpan } from "./comparison";

export function alignmentGaps(spans: DiffSpan[], side: "left" | "right") {
  const result: { line: number; count: number }[] = [];
  for (const span of spans) {
    const own =
      side === "left"
        ? span.leftEnd - span.leftStart
        : span.rightEnd - span.rightStart;
    const other =
      side === "left"
        ? span.rightEnd - span.rightStart
        : span.leftEnd - span.leftStart;
    if (other > own) {
      const line = side === "left" ? span.leftEnd : span.rightEnd;
      const previous = result.at(-1);
      if (previous?.line === line) previous.count += other - own;
      else result.push({ line, count: other - own });
    }
  }
  return result;
}

export interface DocumentView {
  id: string;
  path: string;
  text: string;
  encoding: string;
  bom: boolean;
}
export interface Settings {
  version: number;
  theme: "light" | "dark";
  recent: string[];
  recentFolders?: string[];
  recentComparisons?: RecentComparison[];
  lineDetail?: { collapsed: boolean; height: number };
  sessions: {
    name: string;
    left: string;
    right: string;
    mode: string;
    base?: string;
    folderRules?: FolderRules;
  }[];
  folderRules?: FolderRules;
  contentComparison?: {
    method: "binary" | "rules" | "crc";
    showResults: boolean;
    prompt: boolean;
  };
  ignoreCase: boolean;
  ignoreWhitespace: boolean;
  ignoreLineEndings: boolean;
  unimportantPatterns: string[];
  formats: {
    suffix: string;
    ignoreCase: boolean;
    ignoreWhitespace: boolean;
    ignoreLineEndings: boolean;
    patterns: string[];
  }[];
}
export interface RecentComparison {
  mode: "text" | "folder" | "merge";
  left: string;
  right: string;
  base: string;
}
export const defaults: Settings = {
  version: 1,
  theme: "light",
  recent: [],
  sessions: [],
  ignoreCase: false,
  ignoreWhitespace: false,
  ignoreLineEndings: false,
  unimportantPatterns: [],
  formats: [],
};
export interface FolderEntry {
  relative: string;
  status: string;
  leftSize: number | null;
  rightSize: number | null;
  detail: string | null;
  isDirectory: boolean;
  leftModified?: number | null;
  rightModified?: number | null;
  leftRelative?: string | null;
  rightRelative?: string | null;
  newer?: "left" | "right" | null;
  newerMixed?: boolean;
  error?: string | null;
  importance?: string;
}
export interface Preview {
  id: string;
  operations: { relative: string; action: string }[];
}
export interface Outcome {
  relative: string;
  error: string | null;
}
export type LocalActionRequest =
  | { kind: "batch"; requests: LocalActionRequest[] }
  | {
      kind: "copyTo" | "moveTo";
      source: string;
      destination: string;
      overwrite?: boolean;
    }
  | {
      kind: "copy" | "move";
      sources: string[];
      destination: string;
      overwrite?: boolean;
    }
  | { kind: "recycle"; sources: string[] }
  | { kind: "rename"; source: string; name: string }
  | { kind: "createDirectory"; parent: string; name: string }
  | { kind: "setReadOnly"; sources: string[]; readonly: boolean }
  | { kind: "touch"; sources: string[]; modifiedMs: number };
export interface LocalOperation {
  action: { kind: string; readonly?: boolean; modifiedMs?: number };
  source: string | null;
  destination: string | null;
  entryCount: number;
  entries: {
    action: { kind: string };
    source: string | null;
    destination: string | null;
    directory: boolean;
    replacesExisting: boolean;
  }[];
}
export interface LocalPreview {
  id: string;
  operations: LocalOperation[];
}

export interface FolderRules {
  compareSize: boolean;
  compareModified: boolean;
  timestampToleranceMs: number;
  timezoneOffsetMinutes: number;
  ignoreDst: boolean;
  compareFilenameCase: boolean;
  alignCase: boolean;
  alignExtensions: boolean;
  compareReadonly: boolean;
  compareArchive: boolean;
  compareSystem: boolean;
  compareHidden: boolean;
  content: "none" | "binary" | "rules" | "crc";
  quickTest: "none" | "size" | "modified";
  quickTestPolicy: "override" | "skip" | "requireAll";
  textRules: {
    ignoreCase: boolean;
    ignoreWhitespace: boolean;
    ignoreLineEndings: boolean;
    unimportant: string[];
    unicodeNormalization: boolean;
  };
  executableVersion: boolean;
}
export const defaultFolderRules: FolderRules = {
  compareSize: false,
  compareModified: false,
  timestampToleranceMs: 2000,
  timezoneOffsetMinutes: 0,
  ignoreDst: false,
  compareFilenameCase: false,
  alignCase: false,
  alignExtensions: false,
  compareReadonly: false,
  compareArchive: false,
  compareSystem: false,
  compareHidden: false,
  content: "binary",
  quickTest: "none",
  quickTestPolicy: "requireAll",
  textRules: {
    ignoreCase: false,
    ignoreWhitespace: false,
    ignoreLineEndings: false,
    unimportant: [],
    unicodeNormalization: false,
  },
  executableVersion: false,
};
export type Block =
  | { kind: "resolved"; text: string }
  | { kind: "conflict"; base: string; left: string; right: string };

interface CompareOptions {
  ignoreCase: boolean;
  ignoreWhitespace: boolean;
  ignoreLineEndings: boolean;
  patterns: string[];
}
interface FolderOptions {
  criterion: string;
  exclude: string[];
}
interface Commands {
  take_shell_requests: { args: Record<string, never>; result: string[][] };
  shell_action: {
    args: { args: string[] };
    result:
      | { kind: "selected"; path: string }
      | {
          kind: "compare";
          mode: "text" | "folder";
          left: string;
          right: string;
        };
  };
  clear_shell_selection: { args: Record<string, never>; result: void };
  explorer_integration: { args: { enabled: boolean | null }; result: boolean };
  remember_history: {
    args: {
      folders: string[];
      comparison: RecentComparison | null;
    };
    result: Settings;
  };
  write_history: {
    args: {
      recentFolders: string[] | null;
      recentComparisons: RecentComparison[] | null;
    };
    result: Settings;
  };
  write_line_detail: {
    args: { lineDetail: { collapsed: boolean; height: number } };
    result: void;
  };
  validate_folder_rules: {
    args: { rules: FolderRules; options: FolderOptions };
    result: void;
  };
  parent_folder: { args: { path: string }; result: string };
  path_metadata: {
    args: { path: string };
    result: {
      bytes: number;
      modified: number | null;
      directory: boolean;
      readOnly: boolean;
    };
  };
  reveal_path: { args: { path: string }; result: void };
  open_with: { args: { path: string; application: string }; result: void };
  compare_text: {
    args: {
      left: string;
      right: string;
      jobId: string;
      options: CompareOptions;
      showMinor?: boolean;
      documents?: { left: string | null; right: string | null };
    };
    result: DiffSpan[];
  };
  refine_text: { args: { left: string; right: string }; result: DiffSpan[] };
  open_document: {
    args: { path: string; encoding: string | null };
    result: DocumentView;
  };
  close_document: { args: { id: string }; result: void };
  save_document: {
    args: {
      id: string | null;
      text: string;
      destination: string | null;
      convertUtf8: boolean;
    };
    result: DocumentView;
  };
  scan_folders: {
    args: {
      left: string;
      right: string;
      options: FolderOptions;
      jobId: string;
      rules?: FolderRules;
    };
    result: FolderEntry[];
  };
  preview_local_action: {
    args: { request: LocalActionRequest; jobId: string };
    result: LocalPreview;
  };
  compare_folder_selection: {
    args: {
      left: string;
      right: string;
      options: { criterion: string; exclude: string[] };
      rules: FolderRules;
      selected: string[];
      previous?: FolderEntry[];
      jobId: string;
    };
    result: FolderEntry[];
  };
  execute_local_action: {
    args: { id: string; jobId: string };
    result: {
      operation: LocalOperation;
      result: {
        status: "completed" | "failed" | "cancelled";
        message?: string;
      };
    }[];
  };
  normalize_folder_roots: {
    args: { left: string; right: string };
    result: { left: string; right: string };
  };
  disk_space: {
    args: { path: string };
    result: { availableBytes: string; totalBytes: string };
  };
  preview_sync: {
    args: {
      left: string;
      right: string;
      options: FolderOptions;
      mode: string;
      selected: string[] | null;
      jobId?: string;
    };
    result: Preview;
  };
  preview_file_action: {
    args: {
      left: string;
      right: string;
      options: FolderOptions;
      relative: string;
      action: string;
      jobId?: string;
    };
    result: Preview;
  };
  execute_sync: { args: { id: string; jobId: string }; result: Outcome[] };
  cancel_job: { args: { jobId: string }; result: void };
  merge_text: {
    args: { base: string; left: string; right: string; gitSession: boolean };
    result: Block[];
  };
  read_settings: { args: undefined; result: Settings };
  write_settings: { args: { settings: Settings }; result: void };
  launch_arguments: { args: undefined; result: string[] };
  open_git_output: { args: undefined; result: DocumentView | null };
  finish_git_merge: {
    args: {
      success: boolean;
      outputId: string;
      resolutions: (string | null)[];
    };
    result: void;
  };
}

export function native<C extends keyof Commands>(
  command: C,
  ...args: Commands[C]["args"] extends undefined ? [] : [Commands[C]["args"]]
): Promise<Commands[C]["result"]> {
  if (!isTauri())
    return Promise.reject(
      new Error("This operation requires the native desktop app."),
    );
  return invoke<Commands[C]["result"]>(command, args[0]);
}

export interface TextLine {
  content: string;
  full: string;
  start: number;
  end: number;
}
export function textLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  const expression = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of text.matchAll(expression)) {
    if (!match[0]) break;
    lines.push({
      content: match[1] ?? "",
      full: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return lines;
}
export function copyRange(
  source: string,
  target: string,
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): string {
  const a = textLines(source);
  const b = textLines(target);
  const offset = (lines: TextLine[], index: number, text: string) =>
    lines[index]?.start ?? text.length;
  return (
    target.slice(0, offset(b, targetStart, target)) +
    source.slice(offset(a, sourceStart, source), offset(a, sourceEnd, source)) +
    target.slice(offset(b, targetEnd, target))
  );
}
