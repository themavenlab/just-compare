import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

// Delete runs from one folder-dialog Start click, with no second confirmation,
// and the listing refreshes without a manual rescan. Fixtures live in a temp
// directory owned by this test.
const fixture = await mkdtemp(join(tmpdir(), "delete-regression-"));
const config = join(fixture, "config");
const left = join(fixture, "left");
const right = join(fixture, "right");
const doomed = join(left, "doomed.txt");

await Promise.all([mkdir(config), mkdir(left), mkdir(right)]);
await Promise.all([
  writeFile(join(left, "keep.txt"), "same\n"),
  writeFile(join(right, "keep.txt"), "same\n"),
  writeFile(doomed, "left-only\n"),
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
  const row = list.locator('.folder-row[data-relative="doomed.txt"]');
  await row.waitFor();
  await row.locator(".folder-side").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete...", exact: true }).click();

  const deleteDialog = page.getByRole("dialog", { name: /^recycle - / });
  await deleteDialog.waitFor();
  await deleteDialog
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await deleteDialog.waitFor({ state: "detached" });

  // No second confirmation may appear after Start.
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole("dialog").count(), 0);

  // The listing refreshes on its own; no Scan click is made here.
  await row.waitFor({ state: "detached", timeout: 10000 });
  await assert.rejects(access(doomed), /ENOENT/);
  await list.locator('.folder-row[data-relative="keep.txt"]').waitFor();
} finally {
  if (session) await session.close();
  await rm(fixture, { recursive: true, force: true });
}

console.log("Native delete regression passed.");
