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
  sessions: {
    name: string;
    left: string;
    right: string;
    mode: string;
    base?: string;
  }[];
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
}
export interface Preview {
  id: string;
  operations: { relative: string; action: string }[];
}
export interface Outcome {
  relative: string;
  error: string | null;
}
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
  compare_text: {
    args: {
      left: string;
      right: string;
      jobId: string;
      options: CompareOptions;
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
    };
    result: FolderEntry[];
  };
  normalize_folder_roots: {
    args: { left: string; right: string };
    result: { left: string; right: string };
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
