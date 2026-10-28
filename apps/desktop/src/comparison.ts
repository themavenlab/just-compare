import { invoke, isTauri } from "@tauri-apps/api/core";

export interface CompareOptions {
  ignoreCase: boolean;
  ignoreWhitespace: boolean;
  ignoreLineEndings: boolean;
  patterns?: string[];
}

export interface DiffSpan {
  kind: "equal" | "delete" | "insert" | "replace";
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
  minor?: boolean;
  moved?: {
    id: number;
    direction: "from" | "to";
    counterpartStart: number;
    lineCount: number;
  };
}

export async function compareText(
  left: string,
  right: string,
  options: CompareOptions,
  alignmentAnchors: { left: number; right: number }[] = [],
): Promise<DiffSpan[]> {
  if (!isTauri()) {
    throw new Error(
      "Comparison requires the desktop app. Run npm run desktop:dev.",
    );
  }
  return invoke<DiffSpan[]>("compare_text", {
    left,
    right,
    options: {
      ...options,
      alignmentAnchors,
      patterns: options.patterns ?? [],
    },
    jobId: crypto.randomUUID(),
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Comparison failed with an unexpected error. Retry or check the desktop logs.";
}
