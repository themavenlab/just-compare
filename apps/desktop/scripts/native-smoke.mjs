import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchNative,
  selectWorkspace,
  togglePanel,
} from "./native-harness.mjs";

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
  assert.equal(await page.getByRole("tab").count(), 0);
  const fileMenu = page.getByRole("button", { name: "File", exact: true });
  await fileMenu.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "New Text Compare" }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const openLeft = page.getByRole("menuitem", {
    name: "Open left...",
    exact: true,
  });
  assert.equal(await openLeft.getAttribute("aria-disabled"), "true");
  const disabledDescription = await openLeft.getAttribute("aria-describedby");
  assert.ok(disabledDescription);
  assert.match(
    await page.locator(`[id="${disabledDescription}"]`).innerText(),
    /unavailable/,
  );
  await openLeft.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.getByRole("tab").count(), 0);
  await page.keyboard.press("Escape");
  assert.equal(
    await fileMenu.evaluate((element) => element === document.activeElement),
    true,
  );
  await fileMenu.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "New Text Compare" }).waitFor();
  await page.keyboard.press("Tab");
  await page.getByRole("menu", { name: "File", exact: true }).waitFor({
    state: "detached",
  });
  assert.equal(
    await page
      .getByRole("button", { name: "Edit", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
    "Tab exits a menu to the next application command.",
  );
  await selectWorkspace(page, "text");
  const textWorkflow = page.getByRole("tab").first();
  assert.equal(await textWorkflow.getAttribute("aria-selected"), "true");
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".session-panel")
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".preferences")
      .getAttribute("open"),
    null,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Open left", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("textbox", { name: "Left text" }).fill("same\nold\n");
  await page.getByRole("textbox", { name: "Right text" }).fill("same\nnew\n");
  await page
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await page
    .locator('.workspace-slot[aria-hidden="false"]')
    .locator(".cm-editor .diff-selected")
    .first()
    .waitFor();
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".cm-editor .diff-replace")
      .count(),
    2,
  );
  for (const width of [1100, 900]) {
    await page.setViewportSize({ width, height: 800 });
    const alignment = await page.evaluate(() => {
      const panes = [
        ...document.querySelectorAll(
          '.workspace-slot[aria-hidden="false"] .code-editor',
        ),
      ];
      return Math.abs(
        panes[0].getBoundingClientRect().top -
          panes[1].getBoundingClientRect().top,
      );
    });
    assert.ok(
      alignment <= 2,
      `Pane headers misalign by ${alignment}px at ${width}px`,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  await page.setViewportSize({ width: 640, height: 480 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "A narrow viewport remains horizontally usable at increased display scaling.",
  );
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"] .code-editor')
      .count(),
    2,
  );
  await page.setViewportSize({ width: 1100, height: 800 });
  await page
    .locator('.workspace-slot[aria-hidden="false"]')
    .locator(".file-options > summary")
    .first()
    .click();
  assert.equal(
    await page.evaluate(() => {
      const panes = [
        ...document.querySelectorAll(
          '.workspace-slot[aria-hidden="false"] .code-editor',
        ),
      ];
      return (
        Math.abs(
          panes[0].getBoundingClientRect().top -
            panes[1].getBoundingClientRect().top,
        ) <= 2
      );
    }),
    true,
    "Expanding file options must preserve pane alignment.",
  );
  await page
    .locator('.workspace-slot[aria-hidden="false"]')
    .locator(".file-options > summary")
    .first()
    .click();
  await textWorkflow.click();
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".cm-editor .diff-replace")
      .count(),
    2,
  );
  const comparePosition = await page
    .getByRole("button", { name: "Next difference", exact: true })
    .boundingBox();
  const editorPosition = await page
    .locator(".code-editor")
    .first()
    .boundingBox();
  assert.ok(
    comparePosition && editorPosition && comparePosition.y < editorPosition.y,
  );
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".comparison-details")
      .getAttribute("open"),
    null,
  );
  await togglePanel(page, "details");
  assert.equal(
    await page.getByRole("cell", { name: "replace", exact: true }).count(),
    1,
  );
  await page.getByRole("textbox", { name: "Right text" }).fill("same\nold\n");
  await page
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".cm-editor .diff-line")
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "1 changed regions", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await page.getByRole("textbox", { name: "Left text" }).fill("first\nlast\n");
  await page
    .getByRole("textbox", { name: "Right text" })
    .fill("first\nadded\nlast\n");
  await page
    .locator('.workspace-slot[aria-hidden="false"]')
    .locator(".cm-editor .diff-insert")
    .waitFor();
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".cm-editor .diff-delete")
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Swap sides", exact: true }).click();
  await page
    .locator('.workspace-slot[aria-hidden="false"]')
    .locator(".cm-editor .diff-delete")
    .waitFor();
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".cm-editor .diff-insert")
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Right text" })
      .locator(".diff-line")
      .count(),
    0,
    "Missing-side gaps must not be marked as real document lines.",
  );
  await page.getByRole("button", { name: "Swap sides", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Left text" })
    .fill("old-a\nsame\nold-b\n");
  await page
    .getByRole("textbox", { name: "Right text" })
    .fill("new-a\nsame\nnew-b\n");
  await page
    .getByRole("heading", { name: "2 changed regions", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Next difference", exact: true })
    .click();
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".difference-count")
      .innerText(),
    "2 / 2 differences",
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Right text" })
      .locator(".diff-selected")
      .innerText(),
    "new-b",
  );
  await page.keyboard.press("Alt+ArrowUp");
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".difference-count")
      .innerText(),
    "1 / 2 differences",
  );
  await page
    .getByRole("button", { name: "Copy difference 2 to right", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await page
    .locator('.workspace-slot[aria-hidden="false"]')
    .locator(".copy-arrow:not(:disabled)")
    .first()
    .waitFor();
  assert.equal(
    (
      await page
        .getByRole("textbox", { name: "Right text" })
        .locator(".cm-line")
        .allTextContents()
    ).join("\n"),
    "new-a\nsame\nold-b\n",
    "A nonselected region arrow must copy that region, not the selected region.",
  );
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".copy-arrow")
      .count(),
    2,
    "Remaining difference arrows refresh automatically.",
  );
  await page.getByRole("button", { name: "Undo right", exact: true }).click();
  assert.equal(
    (
      await page
        .getByRole("textbox", { name: "Right text" })
        .locator(".cm-line")
        .allTextContents()
    ).join("\n"),
    "new-a\nsame\nnew-b\n",
  );
  const arrowCases = [
    {
      left: "same\nold\n",
      right: "same\nnew\n",
      destination: "left",
      expected: "same\nnew\n",
    },
    { left: "a\n", right: "extra\na\n", destination: "right", expected: "a\n" },
    {
      left: "a\n",
      right: "a\nextra\n",
      destination: "left",
      expected: "a\nextra\n",
    },
    { left: "extra\na\n", right: "a\n", destination: "left", expected: "a\n" },
    {
      left: "a\nextra\n",
      right: "a\n",
      destination: "right",
      expected: "a\nextra\n",
    },
    { left: "", right: "added", destination: "left", expected: "added" },
    { left: "", right: "added", destination: "right", expected: "" },
    { left: "removed", right: "", destination: "right", expected: "removed" },
    { left: "removed", right: "", destination: "left", expected: "" },
  ];
  for (const [index, test] of arrowCases.entries()) {
    await page.getByRole("textbox", { name: "Left text" }).fill(test.left);
    await page.getByRole("textbox", { name: "Right text" }).fill(test.right);
    const arrow = page.getByRole("button", {
      name: `Copy difference 1 to ${test.destination}`,
      exact: true,
    });
    await arrow.waitFor();
    const source = test.destination === "left" ? "right" : "left";
    await arrow.focus();
    await arrow.press(index % 2 === 0 ? "Enter" : "Space");
    await page
      .getByRole("heading", { name: "0 changed regions", exact: true })
      .waitFor();
    const destinationEditor = page.getByRole("textbox", {
      name: test.destination === "left" ? "Left text" : "Right text",
      exact: true,
    });
    assert.equal(
      (await destinationEditor.locator(".cm-line").allTextContents()).join(
        "\n",
      ),
      test.expected,
      `Inline copy case ${index + 1}`,
    );
    assert.equal(
      await page
        .locator('.workspace-slot[aria-hidden="false"]')
        .locator(".copy-arrow")
        .count(),
      0,
      "The copied difference disappears after automatic comparison.",
    );
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      test.destination === "left" ? "Left text" : "Right text",
      "Copy restores keyboard focus to the destination draft.",
    );
    await page
      .getByRole("button", { name: `Undo ${test.destination}`, exact: true })
      .click();
    assert.equal(
      (await destinationEditor.locator(".cm-line").allTextContents()).join(
        "\n",
      ),
      test[test.destination],
      "Inline copy is undoable.",
    );
    assert.equal(
      (
        await page
          .getByRole("textbox", {
            name: source === "left" ? "Left text" : "Right text",
            exact: true,
          })
          .locator(".cm-line")
          .allTextContents()
      ).join("\n"),
      test[source],
      "Inline copy leaves its source unchanged.",
    );
  }
  await page.getByRole("textbox", { name: "Left text" }).fill("HELLO \n");
  await page.getByRole("textbox", { name: "Right text" }).fill("hello\n");
  await togglePanel(page, "rules");
  await page
    .getByRole("checkbox", { name: "Ignore case", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Ignore whitespace", exact: true })
    .check();
  await togglePanel(page, "rules");
  await page
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Left text" })
    .fill("x".repeat(1024 * 1024 + 1));
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /at most 1 MiB/);
  const leftFile = join(fixtures, "left.txt");
  const rightFile = join(fixtures, "right.txt");
  await writeFile(leftFile, "original\r\n");
  await writeFile(rightFile, "updated\r\n");
  await page.getByRole("textbox", { name: "Left text" }).fill("");
  await page.getByRole("textbox", { name: "Right text" }).fill("");
  await page
    .getByRole("combobox", { name: "left path", exact: true })
    .fill(leftFile);
  await page.getByRole("button", { name: "Open left", exact: true }).click();
  await page
    .getByRole("combobox", { name: "right path", exact: true })
    .fill(rightFile);
  await page.getByRole("button", { name: "Open right", exact: true }).click();
  await page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Refine selected region", exact: true })
    .click();
  await page
    .locator('.workspace-slot[aria-hidden="false"]')
    .locator("mark")
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Copy difference 1 to right", exact: true })
    .click();
  assert.equal(
    await readFile(rightFile, "utf8"),
    "updated\r\n",
    "Inline copying must not save the file.",
  );
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
  assert.equal(await call("document_changed", { id: saved.id }), false);
  await writeFile(leftFile, "external\r\n");
  assert.equal(await call("document_changed", { id: saved.id }), true);
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
  assert.equal(rows[0].leftKind, "file");
  assert.equal(rows[0].rightKind, null);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "detail",
    "error",
    "importance",
    "isDirectory",
    "leftKind",
    "leftModified",
    "leftRelative",
    "leftSize",
    "newer",
    "newerMixed",
    "relative",
    "rightKind",
    "rightModified",
    "rightRelative",
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
  let filePlan = await call("preview_local_action", {
    request: {
      kind: "move",
      sources: [join(leftFolder, "move.txt")],
      destination: rightFolder,
    },
    jobId: "move",
  });
  const moveResults = await call("execute_local_action", {
    id: filePlan.id,
    jobId: "move",
  });
  assert.equal(moveResults.length, 1);
  assert.equal(
    moveResults[0].result.status,
    "completed",
    moveResults[0].result.message,
  );
  assert.equal(
    await readFile(join(rightFolder, "move.txt"), "utf8"),
    "move safely",
  );
  await assert.rejects(access(join(leftFolder, "move.txt")));
  await writeFile(join(leftFolder, "delete.txt"), "recycle safely");
  filePlan = await call("preview_local_action", {
    request: { kind: "recycle", sources: [join(leftFolder, "delete.txt")] },
    jobId: "recycle",
  });
  const recycleResults = await call("execute_local_action", {
    id: filePlan.id,
    jobId: "recycle",
  });
  assert.equal(recycleResults.length, 1);
  assert.equal(
    recycleResults[0].result.status,
    "completed",
    recycleResults[0].result.message,
  );
  await assert.rejects(access(join(leftFolder, "delete.txt")));
  const mismatchLeft = join(fixtures, "mismatch-left");
  const mismatchRight = join(fixtures, "mismatch-right");
  await mkdir(mismatchLeft);
  await mkdir(mismatchRight);
  await mkdir(join(mismatchLeft, "folder-left"));
  await writeFile(join(mismatchRight, "folder-left"), "file");
  await writeFile(join(mismatchLeft, "folder-right"), "file");
  await mkdir(join(mismatchRight, "folder-right"));
  await writeFile(join(mismatchRight, "folder-right", "child.txt"), "child");
  const mismatchRows = await call("scan_folders", {
    left: mismatchLeft,
    right: mismatchRight,
    options,
    jobId: "type-mismatch-test",
  });
  const folderLeft = mismatchRows.find((row) => row.relative === "folder-left");
  assert.equal(folderLeft.status, "typeMismatch");
  assert.equal(folderLeft.leftKind, "directory");
  assert.equal(folderLeft.rightKind, "file");
  assert.equal(folderLeft.error, null);
  const folderRight = mismatchRows.find(
    (row) => row.relative === "folder-right",
  );
  assert.equal(folderRight.status, "typeMismatch");
  assert.equal(folderRight.leftKind, "file");
  assert.equal(folderRight.rightKind, "directory");
  assert.equal(folderRight.error, null);
  assert.equal(
    mismatchRows.find((row) => row.relative === "folder-right/child.txt")
      .status,
    "rightOnly",
  );
  await assert.rejects(
    call("preview_sync", {
      left: mismatchLeft,
      right: mismatchRight,
      options,
      mode: "update",
    }),
    /collision/,
    "A display mismatch must not make unsafe synchronization executable.",
  );
  await assert.rejects(
    call("execute_sync", { id: plan.id, jobId: "consumed-test" }),
    /missing or consumed/,
  );
  const mergeBlocks = await call("merge_text", {
    gitSession: false,
    base: "a\nb\n",
    left: "A\nb\n",
    right: "a\nB\n",
  });
  assert.equal(mergeBlocks.map((block) => block.text).join(""), "A\nB\n");
  const conflicts = await call("merge_text", {
    gitSession: false,
    base: "a\n",
    left: "L\n",
    right: "R\n",
  });
  assert.equal(conflicts[0].kind, "conflict");
  await assert.rejects(
    call("merge_text", {
      gitSession: true,
      base: "a\n",
      left: "L\n",
      right: "R\n",
    }),
    /not launched as a Git merge tool/,
  );
  const settings = await call("read_settings");
  const baseFile = join(fixtures, "base.txt");
  await writeFile(baseFile, "base\n");
  assert.deepEqual(Object.keys(settings).sort(), [
    "formats",
    "ignoreCase",
    "ignoreLineEndings",
    "ignoreWhitespace",
    "recent",
    "recentComparisons",
    "recentFolders",
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
  await writeFile(join(leftFolder, "different.txt"), "left version");
  await writeFile(join(rightFolder, "different.txt"), "right version");
  await writeFile(join(leftFolder, "left-only.txt"), "left only");
  await writeFile(join(rightFolder, "right-only.txt"), "right only");
  const linkedTarget = join(fixtures, "linked-target");
  await mkdir(linkedTarget);
  await symlink(linkedTarget, join(leftFolder, "linked-entry"), "junction");
  await selectWorkspace(page, "folder");
  await page
    .getByRole("combobox", { name: "left path", exact: true })
    .fill(leftFolder);
  await page
    .getByRole("combobox", { name: "right path", exact: true })
    .fill(rightFolder);
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  await page
    .getByRole("region", { name: "Folder comparison entries" })
    .getByText("copy.txt", { exact: true })
    .first()
    .waitFor();
  const folderList = page.getByRole("region", {
    name: "Folder comparison entries",
  });
  for (const [relative, status] of [
    ["copy.txt", "same"],
    ["different.txt", "different"],
    ["left-only.txt", "leftOnly"],
    ["right-only.txt", "rightOnly"],
    ["linked-entry", "error"],
  ]) {
    const row = folderList.locator(`.folder-row[data-relative="${relative}"]`);
    assert.equal(await row.getAttribute("data-status"), status);
    const left = row.locator(".folder-side").nth(0);
    const right = row.locator(".folder-side").nth(1);
    assert.equal(await left.getAttribute("aria-label"), `Left: ${relative}`);
    assert.equal(await right.getAttribute("aria-label"), `Right: ${relative}`);
    assert.equal(
      await left.locator(".file-name").innerText(),
      status === "rightOnly" ? "" : relative,
    );
    assert.equal(
      await right.locator(".file-name").innerText(),
      status === "leftOnly" ? "" : relative,
    );
    if (status === "error") {
      await left.locator(".file-name").click();
      assert.equal(await row.getAttribute("aria-selected"), "false");
    }
  }
  for (const theme of ["light", "dark"]) {
    await togglePanel(page, "preferences");
    if (
      (await page.evaluate(() => document.documentElement.dataset.theme)) !==
      theme
    )
      await page
        .getByRole("button", { name: "Toggle theme", exact: true })
        .click();
    await togglePanel(page, "preferences");
    const colors = await folderList
      .locator(".folder-side:not(.missing) .file-name")
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((node) => [
            node.closest(".folder-side").className,
            getComputedStyle(node).color,
          ]),
        ),
      );
    assert.equal(
      new Set(Object.values(colors)).size,
      5,
      `Each folder status has a distinct filename color in ${theme} theme.`,
    );
    const contrast = await folderList.evaluate((list) => {
      const luminance = (rgb) => {
        const values = rgb
          .match(/\d+/g)
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const s = value / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      const background = luminance(getComputedStyle(list).backgroundColor);
      return [...list.querySelectorAll(".file-name")].map((name) => {
        const foreground = luminance(getComputedStyle(name).color);
        return (
          (Math.max(background, foreground) + 0.05) /
          (Math.min(background, foreground) + 0.05)
        );
      });
    });
    assert.ok(
      contrast.every((value) => value >= 4.5),
      `Filename contrast must reach 4.5:1 in ${theme}: ${contrast}`,
    );
  }
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
    true,
  );
  const highContrastIndicators = await folderList.evaluate((list) =>
    Object.fromEntries(
      ["different", "leftOnly", "rightOnly", "error"].map((status) => {
        const name = list.querySelector(`.folder-side.${status} .file-name`);
        const style = name ? getComputedStyle(name) : null;
        return [
          status,
          style && {
            decoration: style.textDecorationLine,
            decorationStyle: style.textDecorationStyle,
            borderStart: style.borderInlineStartWidth,
            borderEnd: style.borderInlineEndWidth,
          },
        ];
      }),
    ),
  );
  assert.equal(
    highContrastIndicators.different.decoration,
    "underline",
    "Different files retain a non-color indicator in high contrast.",
  );
  assert.equal(
    highContrastIndicators.leftOnly.borderStart,
    "2px",
    "Left-only files retain a non-color indicator in high contrast.",
  );
  assert.equal(
    highContrastIndicators.rightOnly.borderEnd,
    "2px",
    "Right-only files retain a non-color indicator in high contrast.",
  );
  assert.equal(
    highContrastIndicators.error.decorationStyle,
    "wavy",
    "Folder errors retain a non-color indicator in high contrast.",
  );
  await page.emulateMedia({ forcedColors: "none" });
  await page.getByRole("button", { name: "Diffs", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Show Left Orphans", exact: true })
    .click();
  assert.equal(
    await folderList
      .locator(".folder-row:not([data-status='leftOnly'])")
      .count(),
    0,
  );
  await page.getByRole("button", { name: "All", exact: true }).click();
  await folderList
    .locator('.folder-row[data-relative="left-only.txt"] .folder-side')
    .first()
    .click();
  await togglePanel(page, "rules");
  await page
    .getByLabel("Exclusions (glob per line)", { exact: true })
    .fill("*.tmp");
  await togglePanel(page, "rules");
  assert.equal(
    await page.getByRole("button", { name: "Copy", exact: true }).isDisabled(),
    true,
    "Changed scan criteria clear stale selections.",
  );
  await togglePanel(page, "rules");
  await page.getByLabel("Exclusions (glob per line)", { exact: true }).fill("");
  await togglePanel(page, "rules");
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  await folderList.getByText("copy.txt", { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await writeFile(
    join(leftFolder, "external-recheck.txt"),
    "external folder update",
  );
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Recheck disk", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.querySelector(".new-tab-button")?.disabled,
  );
  assert.match(
    await page
      .locator('.workspace-slot[aria-hidden="false"] .result-summary')
      .last()
      .innerText(),
    /folder results may be stale/,
  );
  assert.equal(
    await folderList
      .locator('.folder-row[data-relative="external-recheck.txt"]')
      .count(),
    0,
    "Folder recheck must retain the old listing until a scan refreshes it.",
  );
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  await folderList
    .locator('.folder-row[data-relative="external-recheck.txt"]')
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".new-tab-button")?.disabled,
  );
  assert.doesNotMatch(
    await page
      .locator('.workspace-slot[aria-hidden="false"] .result-summary')
      .last()
      .innerText(),
    /stale/,
  );
  for (const width of [1100, 900, 640]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Folder entries should not overflow at ${width}px.`,
    );
  }
  const directoryRow = page.locator('.folder-row[data-relative="empty"]');
  const tabCount = await page.getByRole("tab").count();
  await directoryRow.locator(".folder-side").first().dblclick();
  assert.equal(
    await page.getByRole("tab").count(),
    tabCount,
    "Directories expand rather than open as text files.",
  );
  const errorsBeforeMismatchScan = await folderList
    .locator('.folder-row[data-status="error"]')
    .count();
  await mkdir(join(leftFolder, "type-mismatch-folder"));
  await writeFile(join(rightFolder, "type-mismatch-folder"), "file");
  await writeFile(join(leftFolder, "type-mismatch-file"), "file");
  await mkdir(join(rightFolder, "type-mismatch-file"));
  await writeFile(
    join(rightFolder, "type-mismatch-file", "child.txt"),
    "child",
  );
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  const folderMismatchRows = folderList.locator(
    '.folder-row[data-relative="type-mismatch-folder"]',
  );
  await folderMismatchRows.first().waitFor();
  assert.equal(
    await folderMismatchRows.count(),
    2,
    "A file/folder conflict is displayed as two side-only rows.",
  );
  const folderMismatchFolder = folderList.locator(
    '.folder-row[data-relative="type-mismatch-folder"][data-display-side="left"]',
  );
  const folderMismatchFile = folderList.locator(
    '.folder-row[data-relative="type-mismatch-folder"][data-display-side="right"]',
  );
  assert.equal(
    await folderMismatchFolder.getAttribute("data-status"),
    "leftOnly",
  );
  assert.equal(
    await folderMismatchFile.getAttribute("data-status"),
    "rightOnly",
  );
  assert.match(
    await folderMismatchFolder
      .locator(".folder-side")
      .nth(0)
      .locator(".entry-icon")
      .getAttribute("class"),
    /folder-icon/,
  );
  assert.match(
    await folderMismatchFile
      .locator(".folder-side")
      .nth(1)
      .locator(".entry-icon")
      .getAttribute("class"),
    /file-icon/,
  );
  assert.equal(
    await folderMismatchRows.locator(".type-mismatch-note").count(),
    0,
  );
  assert.equal(
    await folderMismatchRows
      .locator(".row-hover-actions button:not(:disabled)")
      .count(),
    0,
  );
  const reverseMismatchRows = folderList.locator(
    '.folder-row[data-relative="type-mismatch-file"]',
  );
  assert.equal(await reverseMismatchRows.count(), 2);
  const reverseMismatchFolder = reverseMismatchRows.locator(
    '[data-display-side="right"]',
  );
  await reverseMismatchFolder
    .locator(".folder-side")
    .nth(1)
    .locator(".tree-toggle")
    .click();
  assert.equal(
    await folderList
      .locator('.folder-row[data-relative="type-mismatch-file/child.txt"]')
      .getAttribute("data-status"),
    "rightOnly",
  );
  assert.equal(
    await folderList.locator('.folder-row[data-status="error"]').count(),
    errorsBeforeMismatchScan,
    "A readable type mismatch does not create a comparison error.",
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("menuitem", { name: "Files only", exact: true }).click();
  await folderMismatchFile.waitFor();
  assert.equal(
    await folderList.locator('.folder-row[data-relative="empty"]').count(),
    0,
    "Files-only filtering hides folder-only rows.",
  );
  assert.equal(
    await folderList
      .locator(
        '.folder-row[data-relative="type-mismatch-folder"][data-display-side="right"]',
      )
      .count(),
    1,
    "Files-only filtering retains mixed-kind rows with a file side.",
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Folders only", exact: true })
    .click();
  assert.equal(
    await folderList.locator('.folder-row[data-relative="copy.txt"]').count(),
    0,
    "Folders-only filtering hides file-only rows.",
  );
  assert.equal(
    await folderList
      .locator(
        '.folder-row[data-relative="type-mismatch-folder"][data-display-side="left"]',
      )
      .count(),
    1,
    "Folders-only filtering retains mixed-kind rows with a folder side.",
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Files and folders", exact: true })
    .click();
  const visibleOrder = await folderList
    .locator(".folder-row[data-relative]")
    .evaluateAll((elements) =>
      elements
        .map((element) => ({
          path: element.getAttribute("data-relative"),
          folder: !!element.querySelector(".entry-icon.folder-icon"),
        }))
        .filter((row) => row.path && !row.path.includes("/")),
    );
  const firstFileIndex = visibleOrder.findIndex((row) => !row.folder);
  assert.ok(firstFileIndex >= 0);
  assert.ok(
    visibleOrder.slice(0, firstFileIndex).every((row) => row.folder),
    "Folders remain grouped before files in the paired tree.",
  );
  await session.close();
  session = null;
  session = await launchNative(config);
  await selectWorkspace(session.page, "text");
  assert.equal((await session.call("read_settings")).formats[0].suffix, ".txt");
  await session.page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await togglePanel(session.page, "sessions");
  await session.page
    .getByRole("button", { name: "merge fixture", exact: true })
    .click();
  await session.page
    .getByRole("textbox", { name: "Base text", exact: true })
    .waitFor();
  assert.equal(
    await session.page
      .getByRole("region", { name: "Comparison options" })
      .count(),
    0,
  );
  for (const width of [1100, 900, 640]) {
    await session.page.setViewportSize({ width, height: 800 });
    assert.equal(
      await session.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Merge should not overflow at ${width}px.`,
    );
  }
  await session.page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  assert.ok(
    (
      await session.page
        .getByRole("combobox", { name: "base path", exact: true })
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
    "PASS: native text/limits, CRLF and UTF-16 saves, exact stale-save/recheck checks, folder recheck/scan/sync/stale/consumed previews, merge/conflicts, settings persistence/corruption, and folder UI.",
  );
} finally {
  if (session) await session.close();
  await rm(fixtures, { recursive: true });
}
