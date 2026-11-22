import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

// Rename, New Folder, Attributes and Touch each run from one folder-dialog
// Start click, with no second confirmation, and the listing refreshes on its
// own. Fixtures live in a temp directory owned by this test.
const fixture = await mkdtemp(join(tmpdir(), "one-step-actions-"));
const config = join(fixture, "config");
const left = join(fixture, "left");
const right = join(fixture, "right");
const renameFrom = join(left, "rename-me.txt");
const attributeTarget = join(left, "attribute-me.txt");
const touchTarget = join(left, "touch-me.txt");
const touchedAt = new Date(2020, 0, 2, 3, 4);

await Promise.all([mkdir(config), mkdir(left), mkdir(right)]);
await mkdir(join(left, "group"));
await Promise.all([
  writeFile(join(left, "keep.txt"), "same\n"),
  writeFile(join(right, "keep.txt"), "same\n"),
  writeFile(renameFrom, "rename\n"),
  writeFile(attributeTarget, "attribute\n"),
  writeFile(touchTarget, "touch\n"),
]);

let session;
try {
  session = await launchNative(config);
  const { page } = session;
  await selectWorkspace(page, "folder");
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  await workspace
    .getByRole("combobox", { name: "left path", exact: true })
    .fill(left);
  await workspace
    .getByRole("combobox", { name: "right path", exact: true })
    .fill(right);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await workspace
    .locator(".status-bar")
    .getByText("Scan complete:", { exact: false })
    .waitFor();

  const list = workspace.getByRole("region", {
    name: "Folder comparison entries",
  });
  const rowFor = (relative) =>
    list.locator(`.folder-row[data-relative="${relative}"]`);

  await rowFor("keep.txt").locator(".folder-side").first().click();
  await page.keyboard.press("Control+a");
  const visibleRows = list.locator('.folder-row:not([data-status="error"])');
  assert.equal(
    await visibleRows.evaluateAll(
      (rows) =>
        rows.filter((row) => row.classList.contains("selected-folder-row"))
          .length,
    ),
    await visibleRows.count(),
    "Ctrl+A selects every visible file and folder",
  );
  assert.equal(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
    "",
    "Ctrl+A does not select unrelated interface text",
  );
  await workspace.getByRole("button", { name: "Select", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "None visible", exact: true })
    .click();

  // Runs a menu action on a left-side row, then the folder dialog's single
  // Start click, and asserts that no second dialog appears.
  async function runOneStep({ relative, menuItem, dialogPrefix, fill }) {
    await rowFor(relative).waitFor();
    await rowFor(relative).locator(".folder-side").first().click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: menuItem, exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: `${dialogPrefix} - left side`,
    });
    await dialog.waitFor();
    await fill(dialog);
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("dialog").count(), 0);
  }

  // Rename: the old row disappears and the new name appears without a rescan.
  await runOneStep({
    relative: "rename-me.txt",
    menuItem: "Rename...",
    dialogPrefix: "rename",
    fill: async (dialog) => {
      const input = dialog.getByLabel("Action value", { exact: true });
      assert.equal(await input.inputValue(), "rename-me.txt");
      await input.fill("renamed.txt");
    },
  });
  await rowFor("rename-me.txt").waitFor({ state: "detached", timeout: 10000 });
  await rowFor("renamed.txt").waitFor({ timeout: 10000 });
  await assert.rejects(access(renameFrom), /ENOENT/);
  await access(join(left, "renamed.txt"));

  // New Folder: created under the left root and listed without a rescan.
  await runOneStep({
    relative: "keep.txt",
    menuItem: "New Folder...",
    dialogPrefix: "mkdir",
    fill: (dialog) =>
      dialog.getByLabel("Action value", { exact: true }).fill("created-dir"),
  });
  await rowFor("created-dir").waitFor({ timeout: 10000 });
  assert.ok((await stat(join(left, "created-dir"))).isDirectory());

  // Attributes: the read-only flag is applied by the single Start click.
  await runOneStep({
    relative: "attribute-me.txt",
    menuItem: "Attributes...",
    dialogPrefix: "attributes",
    fill: (dialog) => dialog.locator("select").selectOption("readonly"),
  });
  await assert.rejects(access(attributeTarget, constants.W_OK), /EPERM|EACCES/);

  // Touch: the modification time is applied by the single Start click.
  await runOneStep({
    relative: "touch-me.txt",
    menuItem: "Touch...",
    dialogPrefix: "touch",
    fill: (dialog) =>
      dialog
        .getByLabel("Action value", { exact: true })
        .fill("2020-01-02T03:04"),
  });
  const touched = await stat(touchTarget);
  assert.ok(
    Math.abs(touched.mtimeMs - touchedAt.getTime()) < 2000,
    `Expected mtime near ${touchedAt.toISOString()}, got ${touched.mtime.toISOString()}`,
  );
} finally {
  if (session) await session.close();
  await chmod(attributeTarget, 0o666).catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}

console.log("Native one-step actions regression passed.");
