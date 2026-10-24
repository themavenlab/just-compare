import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-workbench-"));
let session;
try {
  const left = join(root, "left"),
    right = join(root, "right");
  for (const directory of [left, right])
    await mkdir(join(directory, "nested"), { recursive: true });
  await writeFile(join(left, "first.txt"), "left first\n");
  await writeFile(join(right, "first.txt"), "right first\n");
  await writeFile(join(left, "nested", "second.txt"), "left second\n");
  await writeFile(join(right, "nested", "second.txt"), "right second\n");
  await writeFile(
    join(right, "right-only.txt"),
    Buffer.from([0xef, 0xbb, 0xbf, 97, 13, 10]),
  );
  await mkdir(join(root, "config"));
  session = await launchNative(join(root, "config"));
  const { page } = session;
  const normalizedRoots = await session.call("normalize_folder_roots", {
    left,
    right,
  });
  assert.deepEqual(Object.keys(normalizedRoots).sort(), ["left", "right"]);
  await assert.rejects(
    session.call("normalize_folder_roots", { left: "", right }),
    /absolute path/,
  );
  await assert.rejects(
    session.call("normalize_folder_roots", {
      left: join(left, "first.txt"),
      right,
    }),
    /must be directories/,
  );
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const text = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  const compare = async () => {
    await workspace
      .getByRole("button", { name: "Compare", exact: true })
      .click();
    await workspace.getByRole("heading", { name: /changed regions/ }).waitFor();
  };
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-comparisons button")?.disabled,
    );
  await text("Left").waitFor();
  await text("Left").fill("Keep this unsaved draft\n");
  const originalTab = page.getByRole("tab", { selected: true });
  const originalId = await originalTab.getAttribute("id");
  await page.getByRole("button", { name: "Text Compare", exact: true }).click();
  await text("Left").fill("one\nleft\n");
  await text("Right").fill("one\nright\n");
  await compare();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })
    .click();
  assert.match(
    await page.locator(".shell-message[role='status']").innerText(),
    /Ctrl\+Tab/,
  );
  assert.equal(await page.locator(".shell-message[role='alert']").count(), 0);
  await page.getByRole("button", { name: "Dismiss help", exact: true }).click();
  const secondId = await page
    .getByRole("tab", { selected: true })
    .getAttribute("id");
  await workspace
    .getByRole("checkbox", { name: "Ignore case", exact: true })
    .check();
  await page.locator(`#${originalId}`).click();
  assert.equal(
    (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
    "Keep this unsaved draft\n",
  );
  assert.equal(
    await workspace
      .getByRole("checkbox", { name: "Ignore case", exact: true })
      .isChecked(),
    false,
  );
  await page
    .locator(".tab")
    .filter({ has: page.locator(`#${originalId}`) })
    .getByRole("button", { name: /^Close / })
    .click();
  const closeDialog = await session.respondToDialog("Cancel");
  assert.match(closeDialog, /Discard unsaved edits/);
  await page.waitForFunction(
    () => !document.querySelector(".new-comparisons button")?.disabled,
  );
  assert.equal(await page.locator(`#${originalId}`).count(), 1);
  assert.equal(
    (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
    "Keep this unsaved draft\n",
  );
  await page.locator(`#${secondId}`).click();
  assert.equal(
    await workspace
      .getByRole("checkbox", { name: "Ignore case", exact: true })
      .isChecked(),
    true,
  );
  await compare();
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
        pageOverflow:
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
        viewport: [innerWidth, innerHeight],
        alerts: [...document.querySelectorAll('[role="alert"]')].map(
          (node) => node.textContent,
        ),
        shellRows: [...document.querySelector(".workbench-shell").children].map(
          (node) => [node.className, node.getBoundingClientRect().height],
        ),
        rows: [...nodes[0].closest("main").children].map((node) => [
          node.className,
          node.getBoundingClientRect().height,
        ]),
      }));
    assert.ok(geometry.alignment <= 2, JSON.stringify(geometry));
    assert.equal(geometry.pageOverflow, false);
    if (size.width === 1280)
      assert.ok(geometry.height >= 480, JSON.stringify(geometry));
    console.log(
      `Workbench geometry ${size.width}x${size.height}: editor body ${geometry.height}px; alignment ${geometry.alignment}px; page overflow ${geometry.pageOverflow}`,
    );
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await workspace
    .getByRole("separator", { name: "Resize comparison panes" })
    .focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    await workspace.getByRole("separator").getAttribute("aria-valuenow"),
    "48",
  );
  const longLines = Array.from(
    { length: 220 },
    (_, index) => `shared ${index} ${"x".repeat(180)}`,
  );
  const longRight = [...longLines];
  longRight[70] = "right change";
  await text("Left").fill(longLines.join("\n") + "\n");
  await text("Right").fill(longRight.join("\n") + "\n");
  await compare();
  const scrollPositions = () =>
    workspace
      .locator(".cm-scroller")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ top: node.scrollTop, left: node.scrollLeft })),
      );
  await workspace.locator(".cm-scroller").evaluateAll((nodes) => {
    for (const node of nodes) {
      node.scrollTop = 500;
      node.scrollLeft = 90;
    }
  });
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll(
        '.workspace-slot[aria-hidden="false"] .cm-scroller',
      ),
    ].every((node) => node.scrollTop >= 498),
  );
  const scrollBefore = await scrollPositions();
  await page.locator(`#${originalId}`).click();
  await page.locator(`#${secondId}`).click();
  const scrollAfter = await scrollPositions();
  scrollAfter.forEach((value, index) => {
    assert.ok(Math.abs(value.top - scrollBefore[index].top) <= 2);
    assert.ok(Math.abs(value.left - scrollBefore[index].left) <= 2);
  });
  await text("Left").press("Control+z");
  assert.equal(
    (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
    "one\nleft\n",
  );
  await text("Right").fill("one\nright\n");
  await compare();
  await page
    .getByRole("button", { name: "Folder Compare", exact: true })
    .click();
  await workspace
    .getByRole("textbox", { name: "left path", exact: true })
    .fill(left);
  await workspace
    .getByRole("textbox", { name: "right path", exact: true })
    .fill(right);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  const folderTabId = await page
    .getByRole("tab", { selected: true })
    .getAttribute("id");
  const list = workspace.getByRole("region", {
    name: "Folder comparison entries",
  });
  const row = (path) => list.locator(`.folder-row[data-relative="${path}"]`);
  await row("nested/second.txt").waitFor();
  await workspace
    .getByRole("button", { name: "Collapse nested", exact: true })
    .click();
  assert.equal(await row("nested/second.txt").count(), 0);
  await workspace
    .getByRole("button", { name: "Expand nested", exact: true })
    .click();
  await row("nested/second.txt").getByRole("checkbox").check();
  await workspace
    .getByRole("button", { name: "Sort by name", exact: true })
    .click();
  assert.equal(
    await row("nested/second.txt").getByRole("checkbox").isChecked(),
    true,
  );
  await row("first.txt")
    .getByRole("button", { name: "Open pair", exact: true })
    .click();
  await text("Left").waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(
        '.workspace-slot[aria-hidden="false"] [aria-label="left path"]',
      )
      ?.value.endsWith("first.txt"),
  );
  const firstPairId = await page
    .getByRole("tab", { selected: true })
    .getAttribute("id");
  await page
    .getByRole("button", { name: "Return to folder comparison" })
    .click();
  assert.equal(
    await workspace
      .getByRole("textbox", { name: "left path", exact: true })
      .inputValue(),
    left,
  );
  await row("nested/second.txt").dblclick();
  await page.waitForFunction(() =>
    document
      .querySelector(
        '.workspace-slot[aria-hidden="false"] [aria-label="left path"]',
      )
      ?.value.endsWith("second.txt"),
  );
  await page.locator(`#${originalId}`).click();
  assert.equal(
    (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
    "Keep this unsaved draft\n",
  );
  await page.locator(`#${folderTabId}`).click();
  await row("right-only.txt")
    .getByRole("button", { name: "Copy right-only.txt to left", exact: true })
    .click();
  const preview = workspace.getByRole("region", {
    name: "Sync preview",
    exact: true,
  });
  await workspace
    .getByRole("heading", { name: "Sync preview: 1 operations" })
    .waitFor();
  assert.match(await preview.innerText(), /RIGHT to LEFT/);
  await assert.rejects(readFile(join(left, "right-only.txt")), /ENOENT/);
  await workspace
    .getByRole("button", { name: "Confirm and execute preview" })
    .click();
  const reverseDialog = await session.respondToDialog("Confirm");
  assert.match(reverseDialog, /RIGHT to LEFT/);
  await page.waitForFunction(
    () => !document.querySelector(".new-comparisons button")?.disabled,
  );
  await idle();
  assert.deepEqual(
    await readFile(join(left, "right-only.txt")),
    await readFile(join(right, "right-only.txt")),
  );
  await row("first.txt")
    .getByRole("button", { name: "Copy first.txt to right", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "Sync preview: 1 operations" })
    .waitFor();
  assert.equal(
    await readFile(join(right, "first.txt"), "utf8"),
    "right first\n",
  );
  await workspace
    .getByRole("button", { name: "Confirm and execute preview" })
    .click();
  const forwardDialog = await session.respondToDialog("Confirm");
  assert.match(forwardDialog, /LEFT to RIGHT/);
  await page.waitForFunction(
    () => !document.querySelector(".new-comparisons button")?.disabled,
  );
  await idle();
  assert.equal(
    await readFile(join(right, "first.txt"), "utf8"),
    "left first\n",
  );
  await page.locator(`#${firstPairId}`).click();
  assert.match(
    await workspace
      .locator(".metadata")
      .allTextContents()
      .then((values) => values.join(" ")),
    /disk changed; reopen to refresh/,
  );
  await compare();
  assert.match(
    await workspace
      .locator(".metadata")
      .allTextContents()
      .then((values) => values.join(" ")),
    /disk changed; reopen to refresh/,
  );
  await workspace
    .getByRole("button", { name: "Open right", exact: true })
    .click();
  await idle();
  assert.doesNotMatch(
    await workspace
      .locator(".editor")
      .filter({
        has: page.getByRole("textbox", { name: "Right text", exact: true }),
      })
      .locator(".metadata")
      .innerText(),
    /disk changed; reopen to refresh/,
  );
  assert.equal(
    (await text("Right").locator(".cm-line").allTextContents()).join("\n"),
    "left first\n",
  );
  await workspace
    .getByRole("button", { name: "Save right", exact: true })
    .click();
  await idle();
  await page.locator(`#${folderTabId}`).click();
  assert.match(
    await workspace.locator(".result-summary").innerText(),
    /folder results may be stale/,
  );
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await idle();
  assert.doesNotMatch(
    await workspace.locator(".result-summary").innerText(),
    /stale|Scan folders to list/,
  );
  await row("first.txt").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy to right", exact: true })
    .waitFor();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Recycle left",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  await row("nested/second.txt")
    .getByRole("button", {
      name: "Copy nested/second.txt to right",
      exact: true,
    })
    .click();
  await workspace
    .getByRole("heading", { name: "Sync preview: 1 operations" })
    .waitFor();
  await writeFile(join(left, "nested", "second.txt"), "externally changed\n");
  await workspace
    .getByRole("button", { name: "Confirm and execute preview" })
    .click();
  await session.respondToDialog("Confirm");
  await workspace.getByRole("alert").waitFor();
  assert.match(
    await workspace.getByRole("alert").innerText(),
    /changed|stale/i,
  );
  assert.equal(
    await readFile(join(right, "nested", "second.txt"), "utf8"),
    "right second\n",
  );
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await row("nested/second.txt").waitFor();
  await row("nested/second.txt")
    .getByRole("button", {
      name: "Copy nested/second.txt to right",
      exact: true,
    })
    .click();
  await workspace
    .getByRole("heading", { name: "Sync preview: 1 operations" })
    .waitFor();
  await page
    .getByRole("button", { name: "Folder Compare", exact: true })
    .click();
  const secondFolderId = await page
    .getByRole("tab", { selected: true })
    .getAttribute("id");
  await workspace
    .getByRole("textbox", { name: "left path", exact: true })
    .fill(left);
  await workspace
    .getByRole("textbox", { name: "right path", exact: true })
    .fill(right);
  await workspace
    .getByRole("button", { name: "Preview update left to right", exact: true })
    .click();
  assert.match(
    await session.respondToDialog("Cancel"),
    /Replace the pending sync preview/,
  );
  await idle();
  await page.locator(`#${folderTabId}`).click();
  assert.equal(await workspace.locator(".sync-preview").count(), 1);
  await page.locator(`#${secondFolderId}`).click();
  await workspace
    .getByRole("button", { name: "Preview update left to right", exact: true })
    .click();
  assert.match(
    await session.respondToDialog("Confirm"),
    /Replace the pending sync preview/,
  );
  await workspace
    .getByRole("heading", { name: "Sync preview: 1 operations" })
    .waitFor();
  await page.locator(`#${folderTabId}`).click();
  assert.equal(await workspace.locator(".sync-preview").count(), 0);
  await page.locator(`#${secondFolderId}`).click();
  await workspace.getByRole("button", { name: "Dismiss preview" }).click();
  await page.keyboard.press("Control+w");
  await idle();
  assert.equal(await page.locator(`#${secondFolderId}`).count(), 0);
  await page.locator(`#${secondId}`).click();
  await workspace
    .getByRole("button", { name: "Copy region to right", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Right text",
  );
  await workspace
    .getByRole("button", { name: "Undo right", exact: true })
    .click();
  assert.equal(
    (await text("Right").locator(".cm-line").allTextContents()).join("\n"),
    "one\nright\n",
  );
  const handles = [];
  for (let index = 0; index < 33; index++) {
    try {
      handles.push(
        (
          await session.call("open_document", {
            path: join(left, "first.txt"),
            encoding: null,
          })
        ).id,
      );
    } catch (error) {
      assert.match(error.message, /Too many open documents/);
      break;
    }
  }
  assert.equal(
    handles.length,
    28,
    "Four document handles belong to the two opened pairs; total capacity stays 32.",
  );
  await page.getByRole("button", { name: "Text Compare", exact: true }).click();
  await workspace
    .getByRole("textbox", { name: "left path", exact: true })
    .fill(join(left, "first.txt"));
  await workspace
    .getByRole("button", { name: "Open left", exact: true })
    .click();
  await workspace.getByRole("alert").waitFor();
  assert.match(
    await workspace.getByRole("alert").innerText(),
    /Too many open documents/,
  );
  await page.keyboard.press("Control+w");
  await idle();
  for (const id of handles) await session.call("close_document", { id });
  await page.locator(`#${originalId}`).click();
  assert.equal(
    (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
    "Keep this unsaved draft\n",
  );
  await page.locator(`#${secondId}`).click();
  const largeLeft = join(root, "large-left"),
    largeRight = join(root, "large-right");
  await mkdir(largeLeft);
  await mkdir(largeRight);
  for (let offset = 0; offset < 1000; offset += 50)
    await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const name = `file-${offset + index}.txt`;
        await writeFile(join(largeLeft, name), "x".repeat(4096));
        await writeFile(join(largeRight, name), "x".repeat(4096));
      }),
    );
  await page
    .getByRole("button", { name: "Folder Compare", exact: true })
    .click();
  const scanTabId = await page
    .getByRole("tab", { selected: true })
    .getAttribute("id");
  await workspace
    .getByRole("textbox", { name: "left path", exact: true })
    .fill(largeLeft);
  await workspace
    .getByRole("textbox", { name: "right path", exact: true })
    .fill(largeRight);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await page.locator(`#${originalId}`).click();
  await page.locator(".background-job").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Folder Compare", exact: true })
      .isDisabled(),
    true,
  );
  await idle();
  assert.equal(
    (await text("Left").locator(".cm-line").allTextContents()).join("\n"),
    "Keep this unsaved draft\n",
  );
  await page.locator(`#${scanTabId}`).click();
  assert.match(
    await workspace.locator(".folder-view-bar").innerText(),
    /1000 visible/,
  );
  assert.ok(
    (await workspace.locator(".folder-row[data-relative]").count()) < 70,
    "Folder DOM stays virtualized.",
  );
  await page.keyboard.press("Control+w");
  await idle();
  await page.getByRole("button", { name: "3-Way Merge", exact: true }).click();
  const mergeTabId = await page
    .getByRole("tab", { selected: true })
    .getAttribute("id");
  await text("Base").fill("a\n");
  await text("Left").fill("A\n");
  await text("Right").fill("a\n");
  await workspace
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  const mergeOutput = workspace.getByRole("textbox", {
    name: "Merge output",
    exact: true,
  });
  await mergeOutput.fill("manual output\n");
  await page.getByRole("button", { name: "3-Way Merge", exact: true }).click();
  await text("Base").fill("b\n");
  await text("Left").fill("b\n");
  await text("Right").fill("B\n");
  await workspace
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "0 unresolved conflicts", exact: true })
    .waitFor();
  await page.locator(`#${mergeTabId}`).click();
  assert.equal(
    (await mergeOutput.locator(".cm-line").allTextContents()).join("\n"),
    "manual output\n",
  );
  await page.locator(`#${secondId}`).click();
  await compare();
  const artifacts = process.env.COMPARE_TEST_ARTIFACTS;
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    for (const theme of ["light", "dark"]) {
      if (
        (await page.evaluate(() => document.documentElement.dataset.theme)) !==
        theme
      ) {
        await page.getByRole("button", { name: "View", exact: true }).click();
        await page
          .getByRole("menuitem", { name: "Toggle theme", exact: true })
          .click();
      }
      await page.screenshot({
        path: join(artifacts, `tabbed-workbench-${theme}.png`),
      });
      await page.locator(`#${folderTabId}`).click();
      await page.screenshot({
        path: join(artifacts, `folder-tree-${theme}.png`),
      });
      await page.locator(`#${secondId}`).click();
    }
  }
  console.log(
    "PASS: tab draft/rule/history/scroll isolation, compact pane geometry, tree/sort/context menus, new pair tabs, dirty-close cancellation, directional confirmed copies, stale previews, cross-tab preview replacement and visible 32-document capacity failures.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true });
}
