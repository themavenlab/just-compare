import { expect, it } from "vitest";
import {
  alignmentGaps,
  copyRange,
  fitsLiveComparisonBounds,
  textLines,
} from "./api";

it("preserves original terminators and does not create phantom lines", () => {
  expect(textLines("a\r\nb\rc\n").map((l) => l.full)).toEqual([
    "a\r\n",
    "b\r",
    "c\n",
  ]);
  expect(textLines("")).toEqual([]);
});
it("aligns insertions without adding fake editable text", () => {
  const spans = [
    {
      kind: "insert" as const,
      leftStart: 0,
      leftEnd: 0,
      rightStart: 0,
      rightEnd: 2,
    },
    {
      kind: "equal" as const,
      leftStart: 0,
      leftEnd: 1,
      rightStart: 2,
      rightEnd: 3,
    },
    {
      kind: "delete" as const,
      leftStart: 1,
      leftEnd: 3,
      rightStart: 3,
      rightEnd: 3,
    },
  ];
  expect(alignmentGaps(spans, "left")).toEqual([{ line: 0, count: 2 }]);
  expect(alignmentGaps(spans, "right")).toEqual([{ line: 3, count: 2 }]);
});
it("copies original ranges including insertion, deletion and EOL", () => {
  expect(copyRange("a\r\nB\r\n", "a\r\nb\r\n", 1, 2, 1, 2)).toBe("a\r\nB\r\n");
  expect(copyRange("a\nb\n", "a\n", 1, 2, 1, 1)).toBe("a\nb\n");
  expect(copyRange("", "a\n", 0, 0, 0, 1)).toBe("");
});
it("bounds automatic comparisons by UTF-8 bytes and logical lines", () => {
  expect(fitsLiveComparisonBounds("a".repeat(256 * 1024))).toBe(true);
  expect(fitsLiveComparisonBounds("a".repeat(256 * 1024 + 1))).toBe(false);
  expect(fitsLiveComparisonBounds("a\n".repeat(5000))).toBe(true);
  expect(fitsLiveComparisonBounds("a\n".repeat(5001))).toBe(false);
});
