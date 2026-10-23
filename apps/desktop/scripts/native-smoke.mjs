import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative } from "./native-harness.mjs";

if (process.platform !== "win32") {
  throw new Error(
    "This smoke runner targets Windows WebView2, not other platforms.",
  );
}

const fixtures = await mkdtemp(join(tmpdir(), "compare-native-"));
const config = join(fixtures, "config");
await mkdir(config);
let session;
try {
  session = await launchNative(config);
  const { page, call } = session;
  await page.getByRole("textbox", { name: "Left text" }).fill("same\nold\n");
  await page.getByRole("textbox", { name: "Right text" }).fill("same\nnew\n");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("cell", { name: "replace", exact: true }).count(),
    1,
  );
  await page.getByRole("textbox", { name: "Right text" }).fill("same\nold\n");
  assert.equal(
    await page
      .getByRole("heading", { name: "1 changed regions", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await page.getByRole("textbox", { name: "Left text" }).fill("HELLO \n");
  await page.getByRole("textbox", { name: "Right text" }).fill("hello\n");
  await page
    .getByRole("checkbox", { name: "Ignore case", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Ignore whitespace", exact: true })
    .check();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Left text" })
    .fill("x".repeat(1024 * 1024 + 1));
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /at most 1 MiB/);
  const leftFile = join(fixtures, "left.txt");
  const rightFile = join(fixtures, "right.txt");
  await writeFile(leftFile, "original\r\n");
  await writeFile(rightFile, "updated\r\n");
  await page
    .getByRole("textbox", { name: "Left text" })
    .fill("First line\nOriginal text\n");
  await page
    .getByRole("textbox", { name: "Right text" })
    .fill("First line\nUpdated text\n");
  await page
    .getByRole("textbox", { name: "left path", exact: true })
    .fill(leftFile);
  await page.getByRole("button", { name: "Open left", exact: true }).click();
  await page
    .getByRole("textbox", { name: "right path", exact: true })
    .fill(rightFile);
  await page.getByRole("button", { name: "Open right", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Right text", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Refine selected region", exact: true })
    .click();
  await page.locator("mark").first().waitFor();
  await page
    .getByRole("button", { name: "Copy region to right", exact: true })
    .click();
  assert.equal(
    (
      await page
        .getByRole("textbox", { name: "Right text", exact: true })
        .locator(".cm-line")
        .allTextContents()
    ).join("\n"),
    "original\n",
  );
  await page.getByRole("button", { name: "Undo right", exact: true }).click();
  assert.equal(
    (
      await page
        .getByRole("textbox", { name: "Right text", exact: true })
        .locator(".cm-line")
        .allTextContents()
    ).join("\n"),
    "updated\n",
  );
  await page
    .getByRole("textbox", { name: "Left text", exact: true })
    .fill("keyboard saved\n");
  await page
    .getByRole("textbox", { name: "Left text", exact: true })
    .press("Control+s");
  await page.getByText("left saved.", { exact: true }).waitFor();
  assert.equal(await readFile(leftFile, "utf8"), "keyboard saved\r\n");
  await page
    .getByRole("textbox", { name: "Left text" })
    .fill("First line\nOriginal text\n");
  await page
    .getByRole("textbox", { name: "Right text" })
    .fill("First line\nUpdated text\n");
  // Open owned fixtures through native commands, avoiding a destructive discard prompt.
  const leftDocument = await call("open_document", {
    path: leftFile,
    encoding: null,
  });
  assert.deepEqual(Object.keys(leftDocument).sort(), [
    "bom",
    "encoding",
    "id",
    "path",
    "text",
  ]);
  assert.equal(typeof leftDocument.id, "string");
  assert.equal(typeof leftDocument.bom, "boolean");
  const saved = await call("save_document", {
    id: leftDocument.id,
    text: "edited\n",
    destination: null,
    convertUtf8: false,
  });
  assert.equal(await readFile(leftFile, "utf8"), "edited\r\n");
  await writeFile(leftFile, "external\r\n");
  await assert.rejects(
    call("save_document", {
      id: saved.id,
      text: "bad\n",
      destination: null,
      convertUtf8: false,
    }),
    /changed externally/,
  );
  assert.equal(await readFile(leftFile, "utf8"), "external\r\n");
  const utf16 = join(fixtures, "utf16.txt");
  await writeFile(
    utf16,
    Buffer.concat([Buffer.from([255, 254]), Buffer.from("one\r\n", "utf16le")]),
  );
  const utfDocument = await call("open_document", {
    path: utf16,
    encoding: null,
  });
  await call("save_document", {
    id: utfDocument.id,
    text: "two\n",
    destination: null,
    convertUtf8: false,
  });
  assert.deepEqual(
    await readFile(utf16),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from("two\r\n", "utf16le")]),
  );
  await call("close_document", { id: utfDocument.id });
  const leftFolder = join(fixtures, "left");
  const rightFolder = join(fixtures, "right");
  await mkdir(leftFolder);
  await mkdir(rightFolder);
  await mkdir(join(leftFolder, "empty"));
  await writeFile(join(leftFolder, "copy.txt"), "source");
  const options = { criterion: "content", exclude: [] };
  let rows = await call("scan_folders", {
    left: leftFolder,
    right: rightFolder,
    options,
    jobId: "scan-test",
  });
  assert.equal(rows[0].status, "leftOnly");
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "detail",
    "isDirectory",
    "leftSize",
    "relative",
    "rightSize",
    "status",
  ]);
  let plan = await call("preview_sync", {
    left: leftFolder,
    right: rightFolder,
    options,
    mode: "update",
  });
  await writeFile(join(leftFolder, "copy.txt"), "changed");
  await assert.rejects(
    call("execute_sync", { id: plan.id, jobId: "stale-test" }),
    /stale/,
  );
  plan = await call("preview_sync", {
    left: leftFolder,
    right: rightFolder,
    options,
    mode: "update",
  });
  assert.equal(plan.operations[0].action, "copy");
  const results = await call("execute_sync", {
    id: plan.id,
    jobId: "copy-test",
  });
  assert.ok(results.every((result) => result.error === null));
  await access(join(rightFolder, "empty"));
  assert.equal(
    await readFile(join(rightFolder, "copy.txt"), "utf8"),
    "changed",
  );
  rows = await call("scan_folders", {
    left: leftFolder,
    right: rightFolder,
    options,
    jobId: "equal-test",
  });
  assert.equal(rows[0].status, "same");
  assert.equal(rows[1].isDirectory, true);
  await writeFile(join(leftFolder, "move.txt"), "move safely");
  let filePlan = await call("preview_file_action", {
    left: leftFolder,
    right: rightFolder,
    options,
    relative: "move.txt",
    action: "move",
  });
  assert.equal(
    (await call("execute_sync", { id: filePlan.id, jobId: "move" }))[0].error,
    null,
  );
  assert.equal(
    await readFile(join(rightFolder, "move.txt"), "utf8"),
    "move safely",
  );
  await assert.rejects(access(join(leftFolder, "move.txt")));
  await writeFile(join(leftFolder, "delete.txt"), "recycle safely");
  filePlan = await call("preview_file_action", {
    left: leftFolder,
    right: rightFolder,
    options,
    relative: "delete.txt",
    action: "trashLeft",
  });
  assert.equal(
    (await call("execute_sync", { id: filePlan.id, jobId: "recycle" }))[0]
      .error,
    null,
  );
  await assert.rejects(access(join(leftFolder, "delete.txt")));
  await assert.rejects(
    call("execute_sync", { id: plan.id, jobId: "consumed-test" }),
    /missing or consumed/,
  );
  const mergeBlocks = await call("merge_text", {
    base: "a\nb\n",
    left: "A\nb\n",
    right: "a\nB\n",
  });
  assert.equal(mergeBlocks.map((block) => block.text).join(""), "A\nB\n");
  const conflicts = await call("merge_text", {
    base: "a\n",
    left: "L\n",
    right: "R\n",
  });
  assert.equal(conflicts[0].kind, "conflict");
  const settings = await call("read_settings");
  const baseFile = join(fixtures, "base.txt");
  await writeFile(baseFile, "base\n");
  assert.deepEqual(Object.keys(settings).sort(), [
    "formats",
    "ignoreCase",
    "ignoreLineEndings",
    "ignoreWhitespace",
    "recent",
    "sessions",
    "theme",
    "unimportantPatterns",
    "version",
  ]);
  await call("write_settings", {
    settings: {
      ...settings,
      theme: "dark",
      sessions: [
        { name: "fixture", left: leftFile, right: rightFile, mode: "text" },
        {
          name: "merge fixture",
          left: leftFile,
          right: rightFile,
          base: baseFile,
          mode: "merge",
        },
      ],
      formats: [
        {
          suffix: ".txt",
          ignoreCase: true,
          ignoreWhitespace: false,
          ignoreLineEndings: false,
          patterns: [],
        },
      ],
    },
  });
  const reloaded = await call("read_settings");
  assert.equal(reloaded.theme, "dark");
  assert.equal(reloaded.sessions[0].name, "fixture");
  const validSettings = await readFile(join(config, "settings.json"));
  await writeFile(join(config, "settings.json"), "{broken");
  await assert.rejects(call("read_settings"), /original retained/);
  assert.equal(
    await readFile(join(config, "settings.json"), "utf8"),
    "{broken",
  );
  await writeFile(join(config, "settings.json"), validSettings);
  await page.getByRole("button", { name: "folder", exact: true }).click();
  await page
    .getByRole("textbox", { name: "left path", exact: true })
    .fill(leftFolder);
  await page
    .getByRole("textbox", { name: "right path", exact: true })
    .fill(rightFolder);
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  await page
    .getByRole("region", { name: "Folder comparison entries" })
    .getByText("copy.txt", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  const directoryRow = page
    .locator(".folder-row")
    .filter({ hasText: "[dir] empty" });
  assert.equal(
    await directoryRow.getByRole("button", { name: "Open pair" }).isDisabled(),
    true,
  );
  await session.close();
  session = null;
  session = await launchNative(config);
  assert.equal((await session.call("read_settings")).formats[0].suffix, ".txt");
  await session.page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await session.page
    .getByText("Sessions and recent files", { exact: true })
    .click();
  await session.page
    .getByRole("button", { name: "merge fixture", exact: true })
    .click();
  await session.page
    .getByRole("textbox", { name: "Base text", exact: true })
    .waitFor();
  await session.page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  assert.ok(
    (
      await session.page
        .getByRole("textbox", { name: "base path", exact: true })
        .inputValue()
    ).endsWith("\\base.txt"),
  );
  assert.equal(
    (
      await session.page
        .getByRole("textbox", { name: "Base text", exact: true })
        .locator(".cm-line")
        .allTextContents()
    ).join("\n"),
    "base\n",
  );
  console.log(
    "PASS: native text/limits, CRLF and UTF-16 saves, stale-save rejection, folder scan/sync/stale/consumed previews, merge/conflicts, settings persistence/corruption, and folder UI.",
  );
} finally {
  if (session) await session.close();
  await rm(fixtures, { recursive: true });
}
