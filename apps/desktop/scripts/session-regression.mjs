import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-sessions-"));
const config = join(root, "config");
let session;
try {
  const left = join(root, "left"),
    right = join(root, "right"),
    leftUpdated = join(root, "left-updated"),
    rightUpdated = join(root, "right-updated");
  await mkdir(config);
  for (const directory of [left, right, leftUpdated, rightUpdated])
    await mkdir(directory);
  await writeFile(join(left, "file.txt"), "left\n");
  await writeFile(join(right, "file.txt"), "right\n");
  await writeFile(join(leftUpdated, "file.txt"), "updated left\n");
  await writeFile(join(rightUpdated, "file.txt"), "updated right\n");
  session = await launchNative(config);
  let page = session.page;
  const workspace = () => page.locator('.workspace-slot[aria-hidden="false"]');
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const topCommand = async (name) => {
    await page.getByRole("button", { name: "Session", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-tab-button")?.disabled,
    );
  let browserDialogs = 0;
  page.on("dialog", async (event) => {
    browserDialogs++;
    await event.dismiss();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectWorkspace(page, "folder");
  for (const [side, path] of [
    ["left", left],
    ["right", right],
  ])
    await workspace()
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(path);
  await workspace()
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await workspace().locator('.folder-row[data-relative="file.txt"]').waitFor();
  await idle();
  await workspace()
    .getByRole("button", { name: "Sessions", exact: true })
    .click();
  const menu = page.getByRole("menu", { name: "Sessions", exact: true });
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
    "New Text Compare",
    "New Folder Compare",
    "New 3-Way Merge",
  ]);
  assert.equal(await page.locator('[data-panel="sessions"]').count(), 0);
  await menu.press("Escape");
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 640, height: 480 });
  await topCommand("Save Session");
  const scaledDialog = await dialog("Save Session").boundingBox();
  assert.ok(
    scaledDialog &&
      scaledDialog.x >= 0 &&
      scaledDialog.y >= 0 &&
      scaledDialog.x + scaledDialog.width <= 640 &&
      scaledDialog.y + scaledDialog.height <= 480,
    "Dialogs remain within a narrow high-contrast viewport.",
  );
  await dialog("Save Session")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog("Save Session")
    .getByRole("alert")
    .filter({ hasText: "Enter a session name" })
    .waitFor();
  await dialog("Save Session")
    .getByLabel("Session name", { exact: true })
    .fill("Cancelled");
  await dialog("Save Session")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.emulateMedia({ forcedColors: "none" });
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal((await session.call("read_settings")).sessions.length, 0);
  await topCommand("Save Session");
  await dialog("Save Session")
    .getByLabel("Session name", { exact: true })
    .fill("  Folder fixture  ");
  const labelBox = await dialog("Save Session").locator("label").boundingBox();
  const inputBox = await dialog("Save Session")
    .getByLabel("Session name", { exact: true })
    .boundingBox();
  assert.ok(
    inputBox.width > 400 && inputBox.y >= labelBox.y + 12,
    "The session name must have a full-width field beneath its label",
  );
  const screenshots = resolve("..\\..\\artifacts\\compact-workbench");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "save-session.png") });
  await dialog("Save Session")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog("Save Session").waitFor({ state: "hidden" });
  await idle();
  const saved = (await session.call("read_settings")).sessions;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "Folder fixture");
  assert.ok(saved[0].left.endsWith("\\left"));
  assert.ok(saved[0].right.endsWith("\\right"));
  assert.equal(saved[0].folderRules.content, "binary");
  assert.equal(
    await page.getByRole("tab", { name: /Folder fixture/ }).count(),
    1,
    "Saving a session should identify its tab",
  );
  await topCommand("Save Session");
  const updateDialog = dialog("Save Session");
  assert.equal(
    await updateDialog.getByLabel("Session name", { exact: true }).inputValue(),
    "Folder fixture",
  );
  assert.equal(
    await updateDialog.getByLabel("Session name", { exact: true }).isEditable(),
    false,
    "Save should keep the current session name fixed",
  );
  await updateDialog
    .getByRole("button", { name: "Update", exact: true })
    .click();
  await updateDialog.waitFor({ state: "hidden" });
  for (const [side, path] of [
    ["left", leftUpdated],
    ["right", rightUpdated],
  ])
    await workspace()
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(path);
  await workspace()
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await workspace().locator('.folder-row[data-relative="file.txt"]').waitFor();
  await idle();
  await topCommand("Save Session");
  await dialog("Save Session")
    .getByRole("button", { name: "Update", exact: true })
    .click();
  await dialog("Save Session").waitFor({ state: "hidden" });
  const updated = (await session.call("read_settings")).sessions;
  assert.ok(updated[0].left.endsWith("\\left-updated"));
  assert.ok(updated[0].right.endsWith("\\right-updated"));
  await topCommand("Save Session As...");
  await dialog("Save Session As")
    .getByLabel("Session name", { exact: true })
    .fill("Copied fixture");
  await dialog("Save Session As")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog("Save Session As").waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("tab", { name: /Copied fixture/ }).count(),
    1,
    "Save As should give the tab the new saved-session identity",
  );
  await topCommand("Saved Sessions...");
  const sessionsDialog = dialog("Saved Sessions");
  await sessionsDialog
    .getByRole("button", {
      name: "Move session Copied fixture up",
      exact: true,
    })
    .click();
  await idle();
  assert.equal(
    (await session.call("read_settings")).sessions[0].name,
    "Copied fixture",
    "Session ordering should persist immediately",
  );
  await sessionsDialog
    .getByRole("button", {
      name: "Rename saved session Copied fixture",
      exact: true,
    })
    .click();
  await sessionsDialog
    .getByLabel("Rename session Copied fixture", { exact: true })
    .fill("Renamed fixture");
  await sessionsDialog
    .getByRole("button", { name: "Save name", exact: true })
    .click();
  await idle();
  assert.equal(
    (await session.call("read_settings")).sessions[0].name,
    "Renamed fixture",
  );
  assert.equal(
    await page.getByRole("tab", { name: /Renamed fixture/ }).count(),
    1,
    "Renaming a session should update open tab identity",
  );
  await sessionsDialog.press("Escape");
  await topCommand("Save Session As...");
  await dialog("Save Session As")
    .getByLabel("Session name", { exact: true })
    .fill("folder FIXTURE");
  await dialog("Save Session As")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  const overwriteDialog = page.getByRole("dialog", {
    name: "Confirm action",
    exact: true,
  });
  await overwriteDialog.waitFor();
  await overwriteDialog
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await dialog("Save Session As").waitFor({ state: "hidden" });
  const overwritten = (await session.call("read_settings")).sessions;
  assert.equal(overwritten.length, 2);
  assert.ok(overwritten.some((item) => item.name === "Folder fixture"));
  assert.ok(
    overwritten
      .find((item) => item.name === "Folder fixture")
      .left.endsWith("\\left-updated"),
  );
  await workspace()
    .getByRole("button", { name: "Sessions", exact: true })
    .click();
  await page.screenshot({ path: join(screenshots, "sessions-menu.png") });
  await menu.press("Escape");
  await topCommand("Save Session As...");
  await dialog("Save Session As")
    .getByLabel("Session name", { exact: true })
    .fill("folder FIXTURE");
  await dialog("Save Session As")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  const duplicateConfirm = page.getByRole("dialog", {
    name: "Confirm action",
    exact: true,
  });
  await duplicateConfirm.waitFor();
  await duplicateConfirm
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(
    await dialog("Save Session As")
      .getByLabel("Session name", { exact: true })
      .inputValue(),
    "folder FIXTURE",
    "Canceling duplicate replacement should retain the input",
  );
  await dialog("Save Session As").press("Escape");
  await topCommand("Save Session As...");
  await dialog("Save Session As")
    .getByLabel("Session name", { exact: true })
    .fill("Failure fixture");
  const settingsFile = join(config, "settings.json");
  const backup = join(config, "settings.backup");
  await rename(settingsFile, backup);
  await mkdir(settingsFile);
  try {
    await dialog("Save Session As")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await dialog("Save Session As").getByRole("alert").waitFor();
    await idle();
    assert.equal(
      await dialog("Save Session As")
        .getByLabel("Session name", { exact: true })
        .inputValue(),
      "Failure fixture",
    );
  } finally {
    await rm(settingsFile, { recursive: true });
    await rename(backup, settingsFile);
  }
  await dialog("Save Session As")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await workspace()
    .getByRole("button", { name: "Sessions", exact: true })
    .click();
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "Open Failure fixture", exact: true })
      .count(),
    0,
  );
  await menu
    .getByRole("menuitem", { name: "New Text Compare", exact: true })
    .click();
  const leftText = workspace().getByRole("textbox", {
    name: "Left text",
    exact: true,
  });
  await leftText.locator(".cm-line").first().waitFor();
  await leftText.fill("draft");
  await workspace()
    .getByRole("button", { name: "Sessions", exact: true })
    .click();
  await menu
    .getByRole("menuitem", { name: "Open Folder fixture", exact: true })
    .click();
  await workspace().locator('.folder-row[data-relative="file.txt"]').waitFor();
  await idle();
  // Returning through the tab strip must retain the unsaved draft.
  await page
    .locator(".tab")
    .filter({ has: page.locator(".tab-kind", { hasText: /^Text$/ }) })
    .last()
    .getByRole("tab")
    .click();
  assert.equal(
    await workspace()
      .getByRole("textbox", { name: "Left text", exact: true })
      .innerText(),
    "draft",
  );
  await workspace()
    .getByRole("button", { name: "Format", exact: true })
    .click();
  await dialog("File-format Profiles")
    .getByLabel("File suffix", { exact: true })
    .fill(".txt");
  await dialog("File-format Profiles")
    .getByRole("button", {
      name: "Save current rules as file-format profile",
      exact: true,
    })
    .click();
  await dialog("File-format Profiles")
    .getByRole("button", { name: "Remove profile .txt", exact: true })
    .waitFor();
  await dialog("File-format Profiles").press("Escape");
  assert.equal(browserDialogs, 0);
  assert.deepEqual(errors, []);
  await session.close();
  session = await launchNative(config);
  page = session.page;
  await selectWorkspace(page, "folder");
  await workspace()
    .getByRole("button", { name: "Sessions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Open Folder fixture", exact: true })
    .click();
  await workspace().locator('.folder-row[data-relative="file.txt"]').waitFor();
  await idle();
  await topCommand("Saved Sessions...");
  await dialog("Saved Sessions")
    .getByRole("button", { name: "Remove session Folder fixture", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Confirm action", exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await idle();
  assert.equal((await session.call("read_settings")).sessions.length, 1);
  assert.equal(
    await page.getByRole("tab", { name: /Folder fixture/ }).count(),
    0,
    "Removing a session should clear its open tab identity",
  );
  await dialog("Saved Sessions")
    .getByRole("button", {
      name: "Remove session Renamed fixture",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Confirm action", exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await idle();
  assert.equal((await session.call("read_settings")).sessions.length, 0);
  await dialog("Saved Sessions").press("Escape");
  await workspace().getByRole("button", { name: "Home", exact: true }).click();
  const home = page.getByRole("region", { name: "Home", exact: true });
  await home
    .getByRole("button", { name: "Add saved session", exact: true })
    .click();
  const form = home.locator(".session-create");
  await form.getByLabel("Name", { exact: true }).fill("Home fixture");
  await form.getByLabel("Left path", { exact: true }).fill(left);
  await form.getByLabel("Right path", { exact: true }).fill(right);
  await form.getByRole("button", { name: "Add session", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  assert.equal(
    (await session.call("read_settings")).sessions[0].name,
    "Home fixture",
  );
  await home
    .getByRole("button", {
      name: "Remove saved session Home fixture",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Confirm action", exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await idle();
  assert.equal((await session.call("read_settings")).sessions.length, 0);
  console.log(
    "PASS: named tab identity; Save and Save As; explicit duplicate overwrite/cancel; rename and ordering; persistence failure retains input; restart; draft-preserving switches; confirmed removal clears tab identity.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
