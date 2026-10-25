import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchNative } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-compact-"));
const screenshots = resolve(
  process.env.COMPARE_SCREENSHOT_DIR ?? "..\\..\\artifacts\\compact-workbench",
);
let session;
try {
  const config = join(root, "config");
  const left = join(root, "left");
  const right = join(root, "right");
  for (const directory of [config, left, right, screenshots])
    await mkdir(directory, { recursive: true });
  const original = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
  const changed = original.replace("line 40", "changed 40");
  for (let index = 0; index < 45; index++) {
    const name = `file${String(index).padStart(2, "0")}.txt`;
    await writeFile(join(left, name), original);
    await writeFile(join(right, name), index === 0 ? changed : original);
  }
  await writeFile(join(left, "left-only.txt"), "left only\n");
  await writeFile(join(right, "right-only.txt"), "right only\n");
  session = await launchNative(config);
  const { page, call } = session;
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.getByRole("region", { name: "Home", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab").count(), 0);
  assert.equal(await page.locator(".code-editor").count(), 0);
  assert.equal(
    await page.locator(".home-screen .workflow-launcher").count(),
    3,
  );
  await page.screenshot({ path: join(screenshots, "home-light.png") });
  await page
    .locator(".home-screen")
    .getByRole("button", { name: "Text Compare", exact: true })
    .click();
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const text = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  await text("Left").waitFor();
  assert.equal(await text("Left").textContent(), "");
  assert.equal(await text("Right").textContent(), "");
  await text("Left").fill(original);
  await text("Right").fill(changed);
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await workspace
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await workspace.getByRole("button", { name: "Context", exact: true }).click();
  await workspace.locator(".comparison-fold").first().waitFor();
  await workspace.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".comparison-fold"));
  assert.equal(
    (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
    original,
  );
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(size);
    const geometry = await workspace
      .locator(".code-editor")
      .evaluateAll((nodes) => ({
        height: nodes[0].querySelector(".cm-scroller").getBoundingClientRect()
          .height,
        alignment: Math.abs(
          nodes[0].getBoundingClientRect().top -
            nodes[1].getBoundingClientRect().top,
        ),
        overflow:
          document.documentElement.scrollHeight > innerHeight ||
          document.documentElement.scrollWidth > innerWidth,
      }));
    assert.ok(
      geometry.height >= (size.width === 1280 ? 520 : 480),
      JSON.stringify(geometry),
    );
    assert.ok(geometry.alignment <= 2, JSON.stringify(geometry));
    assert.equal(geometry.overflow, false);
    console.log("Text geometry:", size, geometry);
  }
  await page.setViewportSize({ width: 1420, height: 800 });
  await workspace.getByRole("button", { name: "Rules", exact: true }).click();
  await workspace
    .getByRole("checkbox", { name: "Ignore case", exact: true })
    .check();
  await workspace.locator(".text-rules > summary").click();
  await text("Left").fill("CASE\n");
  await text("Right").fill("case\n");
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await workspace
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await workspace.getByRole("button", { name: "Minor", exact: true }).click();
  await workspace
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  assert.equal(await workspace.locator(".diff-minor").count(), 2);
  for (const [a, b] of [
    ["a\nb\nc\nd\n", "a\nextra\nb\nc\nd\n"],
    ["a\nextra\nb\nc\nd\n", "a\nb\nc\nd\n"],
    ["a\none\nb\ntwo\nc\n", "a\nONE\nand more\nb\nTWO\nc\n"],
    ["a\nb\nc\n", "a\nb\nc\n"],
  ]) {
    await text("Left").fill(a);
    await text("Right").fill(b);
    await workspace
      .getByRole("button", { name: "Compare", exact: true })
      .click();
    await workspace.getByRole("heading", { name: /changed regions/ }).waitFor();
    for (const filter of ["Same", "Diffs", "Context", "All"]) {
      await workspace
        .getByRole("button", { name: filter, exact: true })
        .click();
      if (filter === "Same" && a.includes("extra")) {
        const alignment = await workspace
          .locator(".code-editor")
          .evaluateAll((nodes) =>
            nodes.map(
              (node) =>
                [...node.querySelectorAll(".cm-line")]
                  .find((line) => line.textContent === "b")
                  ?.getBoundingClientRect().top,
            ),
          );
        assert.ok(
          Math.abs(alignment[0] - alignment[1]) <= 2,
          JSON.stringify(alignment),
        );
      }
    }
    assert.equal(
      (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
      a,
    );
    assert.equal(
      (await text("Right").locator(".cm-line").allTextContents()).join("\n"),
      b,
    );
  }
  assert.deepEqual(rendererErrors, []);
  await text("Left").fill(original);
  await text("Right").fill(changed);
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await workspace
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await page.screenshot({ path: join(screenshots, "text-light.png") });

  await page
    .locator(".new-comparisons")
    .getByRole("button", { name: "Folder Compare", exact: true })
    .click();
  await workspace.getByLabel("left path", { exact: true }).fill(left);
  await workspace.getByLabel("right path", { exact: true }).fill(right);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await workspace
    .getByText("Scan complete:", { exact: false })
    .first()
    .waitFor();
  const listing = workspace.getByRole("tree", {
    name: "Paired folder hierarchy",
  });
  const folderGeometry = await listing.evaluate((node) => {
    const row = node.querySelector(".paired-folder-row");
    const sides = row.querySelectorAll(".folder-side");
    return {
      viewport: node.clientHeight,
      rowHeight: row.getBoundingClientRect().height,
      visibleRows: Math.floor(
        node.clientHeight / row.getBoundingClientRect().height,
      ),
      alignment: Math.abs(
        sides[0].getBoundingClientRect().top -
          sides[1].getBoundingClientRect().top,
      ),
      overflow:
        document.documentElement.scrollHeight > innerHeight ||
        document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(folderGeometry.rowHeight, 18);
  assert.ok(folderGeometry.visibleRows >= 28, JSON.stringify(folderGeometry));
  assert.ok(folderGeometry.alignment <= 2);
  assert.equal(folderGeometry.overflow, false);
  console.log("Folder geometry:", folderGeometry);
  await page.screenshot({ path: join(screenshots, "folder-light.png") });
  await workspace.getByRole("button", { name: "Diffs", exact: true }).click();
  assert.equal(
    await page
      .getByRole("menu", { name: "Diffs", exact: true })
      .getByRole("menuitem")
      .count(),
    10,
  );
  await page.screenshot({ path: join(screenshots, "diffs-light.png") });
  await page
    .getByRole("menuitem", { name: "Show Left Orphans", exact: true })
    .click();
  await workspace.locator('[data-relative="left-only.txt"]').waitFor();
  assert.equal(await workspace.locator(".paired-folder-row").count(), 1);
  await workspace.getByRole("button", { name: "All", exact: true }).click();
  await workspace.getByRole("button", { name: "Filters", exact: true }).click();
  const rulesDialog = page.getByRole("dialog", {
    name: "Session Settings - Folder Compare",
    exact: true,
  });
  await rulesDialog.waitFor();
  const rulesGeometry = await rulesDialog.evaluate((node) => ({
    viewport: node.clientHeight,
    content: node.scrollHeight,
  }));
  assert.equal(
    rulesGeometry.content,
    rulesGeometry.viewport,
    JSON.stringify(rulesGeometry),
  );
  await page.screenshot({ path: join(screenshots, "rules-light.png") });
  await rulesDialog
    .getByRole("checkbox", { name: "Compare timestamps", exact: true })
    .check();
  await rulesDialog.getByLabel("Timestamp tolerance in seconds").fill("3");
  await rulesDialog
    .getByRole("radio", { name: "CRC comparison", exact: true })
    .check();
  await rulesDialog
    .getByRole("checkbox", {
      name: "Align filenames with different Unicode normalization forms",
      exact: true,
    })
    .check();
  await rulesDialog
    .getByRole("checkbox", {
      name: "Compare executable versions (Windows)",
      exact: true,
    })
    .check();
  await rulesDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(await rulesDialog.count(), 0);

  const row = (name) =>
    workspace.locator(`.paired-folder-row[data-relative="${name}"]`);
  await row("file00.txt")
    .locator(".folder-side")
    .first()
    .click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for file00.txt",
    exact: true,
  });
  await menu.waitFor();
  const menuGeometry = await menu.evaluate((node) => ({
    height: node.clientHeight,
    contents: node.scrollHeight,
    top: node.getBoundingClientRect().top,
    bottom: node.getBoundingClientRect().bottom,
  }));
  assert.equal(
    menuGeometry.contents,
    menuGeometry.height,
    JSON.stringify(menuGeometry),
  );
  assert.ok(
    menuGeometry.top >= 0 && menuGeometry.bottom <= 800,
    JSON.stringify(menuGeometry),
  );
  await page.screenshot({ path: join(screenshots, "context-light.png") });
  for (const label of [
    "Open With",
    "Compare Contents...",
    "Copy to Side...",
    "Move to Side...",
    "Copy to Folder...",
    "Move to Folder...",
    "Delete...",
    "Rename...",
    "Attributes...",
    "Touch...",
    "Exclude",
    "New Folder...",
    "Copy Filename",
    "Ignored",
    "Refresh Selection",
    "Synchronize...",
    "Explorer",
  ])
    assert.equal(
      await menu.getByRole("menuitem", { name: label, exact: true }).count(),
      1,
    );
  await menu
    .getByRole("menuitem", { name: "Compare Contents...", exact: true })
    .click();
  const contents = page.getByRole("dialog", {
    name: "Compare Contents",
    exact: true,
  });
  await contents.waitFor();
  await contents
    .getByRole("radio", { name: "CRC comparison", exact: true })
    .check();
  await page.screenshot({ path: join(screenshots, "contents-light.png") });
  await contents.getByRole("button", { name: "Start", exact: true }).click();
  const results = page.getByRole("dialog", {
    name: "Content comparison results",
    exact: true,
  });
  await results.waitFor();
  assert.match(await results.innerText(), /file00\.txt.*different/);
  await results.getByRole("button", { name: "Close", exact: true }).click();
  await workspace.getByRole("button", { name: "Diffs", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Show Left Orphans", exact: true })
    .click();
  await row("left-only.txt")
    .locator(".folder-side")
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename...", exact: true }).click();
  const rename = page.getByRole("dialog", {
    name: "rename - left side",
    exact: true,
  });
  await rename.getByLabel("Action value").fill("renamed.txt");
  await rename.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.getByRole("dialog", {
    name: "Local action preview",
    exact: true,
  });
  await preview.waitFor();
  assert.match(await preview.innerText(), /renamed\.txt/);
  await preview
    .getByRole("button", { name: "Confirm and execute preview", exact: true })
    .click();
  await session.respondToDialog("Confirm");
  await page.waitForFunction(() =>
    document
      .querySelector('.workspace-slot[aria-hidden="false"] .status-bar')
      ?.textContent.includes("Completed 1 of 1 local actions"),
  );
  assert.equal(
    await readFile(join(left, "renamed.txt"), "utf8"),
    "left only\n",
  );
  await writeFile(join(left, "file01.txt"), "batch first\n");
  await writeFile(join(left, "file02.txt"), "batch second\n");
  await workspace.getByRole("button", { name: "All", exact: true }).click();
  const scanFolders = async () => {
    await workspace
      .getByRole("button", { name: "Scan folders", exact: true })
      .click();
    await workspace
      .locator(".status-bar")
      .getByText("Scan complete:", { exact: false })
      .waitFor();
  };
  await scanFolders();
  await row("file01.txt").locator(".folder-side").first().click();
  await row("file02.txt")
    .locator(".folder-side")
    .first()
    .click({ modifiers: ["Control"] });
  await row("file01.txt")
    .locator(".folder-side")
    .first()
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy to Side...", exact: true })
    .click();
  const sideCopy = page.getByRole("dialog", {
    name: "copySide - left side",
    exact: true,
  });
  await sideCopy.getByRole("checkbox", { name: /Allow replacement/ }).check();
  await sideCopy.getByRole("button", { name: "Preview", exact: true }).click();
  await preview.waitFor();
  assert.equal(await preview.locator(".local-preview-entries p").count(), 2);
  assert.match(await preview.innerText(), /replaces existing/);
  await preview
    .getByRole("button", { name: "Confirm and execute preview", exact: true })
    .click();
  await session.respondToDialog("Confirm");
  await workspace
    .locator(".status-bar")
    .getByText("Completed 2 of 2 local actions.", { exact: false })
    .waitFor();
  assert.equal(
    await readFile(join(right, "file01.txt"), "utf8"),
    "batch first\n",
  );
  assert.equal(
    await readFile(join(right, "file02.txt"), "utf8"),
    "batch second\n",
  );
  await scanFolders();
  await writeFile(join(right, "file00.txt"), original);
  await row("file00.txt")
    .locator(".folder-side")
    .first()
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Refresh Selection", exact: true })
    .click();
  await workspace
    .locator(".status-bar")
    .getByText("Refreshed 1 selected entries", { exact: false })
    .waitFor();
  assert.equal(await row("file00.txt").getAttribute("data-status"), "same");
  await workspace.getByRole("button", { name: "Rules", exact: true }).click();
  await rulesDialog
    .getByLabel("Exclusions (glob per line)", { exact: true })
    .fill("[");
  await rulesDialog.getByRole("button", { name: "OK", exact: true }).click();
  await rulesDialog.getByRole("alert").waitFor();
  assert.match(
    await rulesDialog.getByRole("alert").innerText(),
    /glob|pattern|unclosed/i,
  );
  await rulesDialog
    .getByLabel("Exclusions (glob per line)", { exact: true })
    .fill("");
  await rulesDialog
    .getByRole("radio", { name: "CRC comparison", exact: true })
    .check();
  await rulesDialog
    .getByRole("checkbox", {
      name: "Align filenames with different Unicode normalization forms",
      exact: true,
    })
    .check();
  await rulesDialog
    .getByRole("checkbox", {
      name: "Compare executable versions (Windows)",
      exact: true,
    })
    .check();
  await rulesDialog.getByRole("button", { name: "OK", exact: true }).click();
  await rulesDialog.waitFor({ state: "detached" });
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await workspace.locator(".folder-disk-space").waitFor();
  await row("file00.txt").waitFor();
  await workspace.getByRole("button", { name: "Rules", exact: true }).click();
  assert.equal(
    await rulesDialog
      .getByRole("radio", { name: "CRC comparison", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await rulesDialog
      .getByRole("checkbox", {
        name: "Align filenames with different Unicode normalization forms",
        exact: true,
      })
      .isChecked(),
    true,
  );
  assert.equal(
    await rulesDialog
      .getByRole("checkbox", {
        name: "Compare executable versions (Windows)",
        exact: true,
      })
      .isChecked(),
    true,
  );
  await page.screenshot({ path: join(screenshots, "rules-enabled-light.png") });
  await rulesDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  const options = { criterion: "content", exclude: [] };
  const nativeRows = await call("scan_folders", {
    left,
    right,
    options,
    rules: { content: "binary" },
    jobId: "compact-scan",
  });
  assert.ok(
    nativeRows.every(
      (entry) =>
        "leftModified" in entry && "rightRelative" in entry && "newer" in entry,
    ),
  );
  await writeFile(join(right, "file01.txt"), "CRC difference fixture\n");
  const crcRows = await call("scan_folders", {
    left,
    right,
    options,
    rules: { content: "crc" },
    jobId: "compact-crc",
  });
  assert.equal(
    crcRows.find((entry) => entry.relative === "file00.txt").status,
    "same",
  );
  assert.equal(
    crcRows.find((entry) => entry.relative === "file01.txt").status,
    "different",
  );
  const space = await call("disk_space", { path: left });
  assert.ok(BigInt(space.totalBytes) > 0n);
  assert.ok(BigInt(space.availableBytes) <= BigInt(space.totalBytes));
  await assert.rejects(
    call("disk_space", { path: join(left, "file00.txt") }),
    /directory/,
  );
  assert.match(
    await workspace.locator(".folder-disk-space").innerText(),
    /Free L:.*bytes free.*R:.*bytes free/,
  );
  await writeFile(join(left, "\u00e9.txt"), "unicode fixture");
  await writeFile(join(right, "e\u0301.txt"), "unicode fixture");
  const unicodeRows = await call("scan_folders", {
    left,
    right,
    options,
    rules: { content: "crc", textRules: { unicodeNormalization: true } },
    jobId: "compact-unicode",
  });
  const unicodeRow = unicodeRows.find(
    (entry) => entry.leftRelative === "\u00e9.txt",
  );
  assert.equal(unicodeRow.rightRelative, "e\u0301.txt");
  assert.equal(unicodeRow.status, "same");
  await writeFile(join(left, "invalid.exe"), "invalid version fixture");
  await writeFile(join(right, "invalid.exe"), "invalid version fixture");
  const versionRows = await call("scan_folders", {
    left,
    right,
    options,
    rules: { executableVersion: true },
    jobId: "compact-version",
  });
  assert.match(
    versionRows.find((entry) => entry.relative === "invalid.exe").error,
    /version/,
  );
  const plan = await call("preview_local_action", {
    request: { kind: "createDirectory", parent: left, name: "new-directory" },
    jobId: "compact-preview",
  });
  const normalizedRoots = await call("normalize_folder_roots", { left, right });
  assert.equal(
    plan.operations[0].entries[0].destination,
    join(normalizedRoots.left, "new-directory"),
  );
  const outcomes = await call("execute_local_action", {
    id: plan.id,
    jobId: "compact-execute",
  });
  assert.equal(outcomes[0].result.status, "completed");
  await assert.rejects(
    call("execute_local_action", { id: plan.id, jobId: "compact-replay" }),
    /consumed/,
  );
  const settings = await call("read_settings");
  settings.folderRules = {
    content: "crc",
    timestampToleranceMs: 2000,
    executableVersion: true,
    textRules: { unicodeNormalization: true },
  };
  settings.contentComparison = {
    method: "crc",
    showResults: true,
    prompt: false,
  };
  await call("write_settings", { settings });
  const restored = await call("read_settings");
  assert.equal(restored.folderRules.timestampToleranceMs, 2000);
  assert.equal(restored.contentComparison.prompt, false);
  assert.equal(restored.contentComparison.method, "crc");
  assert.equal(restored.folderRules.textRules.unicodeNormalization, true);
  assert.equal(restored.folderRules.executableVersion, true);
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Toggle theme", exact: true })
    .click();
  await page.screenshot({ path: join(screenshots, "folder-dark.png") });
  assert.deepEqual(rendererErrors, []);
  await session.close();
  session = await launchNative(config, [
    "git-diff",
    join(left, "file00.txt"),
    join(right, "file00.txt"),
  ]);
  await session.page
    .getByRole("textbox", { name: "Left text", exact: true })
    .waitFor();
  assert.equal(await session.page.getByRole("tab").count(), 1);
  assert.equal(await session.page.locator(".home-screen").count(), 0);
  const restartSettings = await session.call("read_settings");
  assert.equal(restartSettings.folderRules.timestampToleranceMs, 2000);
  assert.equal(restartSettings.contentComparison.prompt, false);
  assert.equal(restartSettings.contentComparison.method, "crc");
  assert.equal(
    restartSettings.folderRules.textRules.unicodeNormalization,
    true,
  );
  assert.equal(restartSettings.folderRules.executableVersion, true);
  console.log(
    "Compact native workbench: Home/blank drafts, comparison filters, geometry, all visible folder menu entries, Rules apply/cancel, selected CRC content, NFC alignment, executable-version errors, disk space, previewed rename, opaque-plan replay, settings restart and explicit Git startup passed.",
  );
  console.log("Screenshots:", screenshots);
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
