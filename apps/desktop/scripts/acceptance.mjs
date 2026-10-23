import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { launchNative } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-acceptance-"));
const config = join(root, "config");
await mkdir(config);
let session;
try {
  session = await launchNative(config);
  const { page, call } = session;
  const options = {
    ignoreCase: false,
    ignoreWhitespace: false,
    ignoreLineEndings: false,
    patterns: [],
  };
  const timings = [];
  const left = Array.from(
    { length: 20000 },
    (_, i) => `${i} ${"a".repeat(42)}\n`,
  ).join("");
  const right = left.replace("100 a", "100 b");
  assert.ok(Buffer.byteLength(left) <= 1024 * 1024);
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const spans = await call("compare_text", {
      left,
      right,
      options,
      jobId: `bench-${i}`,
    });
    assert.equal(spans.filter((span) => span.kind !== "equal").length, 1);
    timings.push(performance.now() - start);
  }
  const a = join(root, "a"),
    b = join(root, "b");
  await mkdir(a);
  await mkdir(b);
  for (let i = 0; i < 1000; i++) {
    await writeFile(join(a, `${i}.txt`), "a".repeat(4096));
    await writeFile(join(b, `${i}.txt`), "a".repeat(4096));
  }
  const start = performance.now();
  const rows = await call("scan_folders", {
    left: a,
    right: b,
    options: { criterion: "content", exclude: [] },
    jobId: "folder-bench",
  });
  const scanMs = performance.now() - start;
  assert.equal(rows.length, 1000);
  assert.ok(rows.every((row) => row.status === "same"));
  const cancelStart = performance.now();
  const pending = call("scan_folders", {
    left: a,
    right: b,
    options: { criterion: "content", exclude: [] },
    jobId: "cancel-bench",
  });
  const cancelled = assert.rejects(pending, /cancelled/);
  // Observe the registered job before expecting cancellation; a finished job is not cancelled.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await call("cancel_job", { jobId: "cancel-bench" });
  await cancelled;
  const cancelMs = performance.now() - cancelStart;
  assert.ok(cancelMs < 2500, `Cancellation took ${cancelMs} ms`);
  await page
    .getByRole("textbox", { name: "Left text", exact: true })
    .fill("a\n");
  await page
    .getByRole("textbox", { name: "Right text", exact: true })
    .fill("extra\na\n");
  await page
    .getByRole("textbox", { name: "Right text", exact: true })
    .press("Control+Enter");
  await page
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await page.locator(".alignment-gap").first().waitFor();
  const alignment = await page.evaluate(() => {
    const line = (label) =>
      [
        ...document
          .querySelector(`[aria-label="${label}"]`)
          .querySelectorAll(".cm-line"),
      ]
        .find((node) => node.textContent === "a")
        .getBoundingClientRect().top;
    return Math.abs(line("Left text") - line("Right text"));
  });
  assert.ok(alignment <= 2, `Editable rows differ by ${alignment}px`);
  await page
    .getByRole("button", { name: "Go to difference 1", exact: true })
    .focus();
  await page.keyboard.press("Alt+ArrowDown");
  assert.equal(
    await page
      .getByRole("button", { name: "Go to difference 1", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await page.getByRole("alert").count(), 0);
  const memory = JSON.parse(
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${session.pid} | Select-Object PeakWorkingSet64,WorkingSet64 | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8" },
    ),
  );
  console.log(
    JSON.stringify(
      {
        os: `Windows ${release()}`,
        cpu: cpus()[0].model,
        ramGiB: totalmem() / 1024 ** 3,
        textBytes: Buffer.byteLength(left),
        textLines: 20000,
        compareMs: timings,
        folderFilesPerSide: 1000,
        folderBytesPerFile: 4096,
        scanMs,
        cancelMs,
        alignmentPixels: alignment,
        nativeProcessMemory: memory,
      },
      null,
      2,
    ),
  );
  await call("plugin:window|close", { label: "main" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector("main"))),
    true,
    "Dirty editors must prevent unconfirmed close.",
  );
  await session.close();
  session = null;

  const repo = join(root, "git");
  await mkdir(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "core.autocrlf", "false");
  await writeFile(join(repo, "file.txt"), "a\nb\n");
  git("add", "file.txt"); // Use the index as baseline; no fixture commits or global Git changes.
  await writeFile(join(repo, "file.txt"), "A\nb\n");
  const cli = fileURLToPath(
    new URL("../../../target/debug/compare.exe", import.meta.url),
  ).replaceAll("\\", "/");
  const command = `"${cli}" git-diff "$LOCAL" "$REMOTE"`;
  session = await launchNative(
    config,
    [
      "-c",
      "diff.tool=workbench",
      "-c",
      `difftool.workbench.cmd=${command}`,
      "difftool",
      "--no-prompt",
    ],
    { launcher: "git", cwd: repo },
  );
  await session.page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  await session.destroy();
  assert.equal(await session.waitExit(), 0);
  await session.close();
  session = null;
  const directoryCommand = `"${cli}" gui "$LOCAL" "$REMOTE"`;
  session = await launchNative(
    config,
    [
      "-c",
      "diff.tool=workbench",
      "-c",
      `difftool.workbench.cmd=${directoryCommand}`,
      "difftool",
      "--dir-diff",
      "--no-symlinks",
      "--no-prompt",
    ],
    { launcher: "git", cwd: repo },
  );
  await session.page
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await session.page
    .getByRole("region", { name: "Folder comparison entries" })
    .getByText("file.txt", { exact: true })
    .waitFor();
  await session.destroy();
  assert.equal(await session.waitExit(), 0);
  await session.close();
  session = null;
  const blobs = ["a\nb\n", "A\nb\n", "a\nB\n"].map((text) =>
    execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: text,
      encoding: "utf8",
    }).trim(),
  );
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: repo,
    input:
      `0 ${"0".repeat(40)}\tfile.txt\n` +
      blobs.map((blob, i) => `100644 ${blob} ${i + 1}\tfile.txt\n`).join(""),
  });
  const mergeCommand = `"${cli}" git-merge "$BASE" "$LOCAL" "$REMOTE" "$MERGED"`;
  session = await launchNative(
    config,
    [
      "-c",
      "merge.tool=workbench",
      "-c",
      `mergetool.workbench.cmd=${mergeCommand}`,
      "-c",
      "mergetool.workbench.trustExitCode=true",
      "mergetool",
      "--no-prompt",
      "file.txt",
    ],
    { launcher: "git", cwd: repo },
  );
  await session.page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  await session.page
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await session.page
    .getByRole("heading", { name: "0 unresolved conflicts", exact: true })
    .waitFor();
  await session.page
    .getByRole("button", { name: "Save merge output", exact: true })
    .click();
  assert.equal(await session.waitExit(), 0);
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "A\nB\n");
  assert.equal(git("ls-files", "--unmerged"), "");
  console.log(
    "PASS: editable alignment/shortcuts, bounded native performance/cancellation, real Git difftool/directory mode/mergetool.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true });
}
