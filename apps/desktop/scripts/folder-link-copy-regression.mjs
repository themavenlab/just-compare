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
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const fixture = await mkdtemp(join(tmpdir(), "folder-link-copy-regression-"));
const config = join(fixture, "config");
const left = join(fixture, "left");
const right = join(fixture, "right");
const linkTarget = join(fixture, "link-target");
await Promise.all([
  mkdir(config),
  mkdir(left),
  mkdir(right),
  mkdir(linkTarget),
]);
await Promise.all([
  writeFile(join(left, "file.txt"), "file\n"),
  writeFile(join(linkTarget, "inside.txt"), "inside\n"),
]);
// A junction needs no elevation on Windows, unlike a file symlink.
await symlink(linkTarget, join(left, "linked-entry"), "junction");

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
  const fileRow = list.locator('.folder-row[data-relative="file.txt"]');
  const linkRow = list.locator('.folder-row[data-relative="linked-entry"]');
  await fileRow.waitFor();
  await linkRow.waitFor();

  await fileRow.locator(".folder-side").first().click();
  await linkRow
    .locator(".folder-side")
    .first()
    .click({ modifiers: ["Control"] });
  await fileRow.locator(".folder-side").first().click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy to Side...", exact: true })
    .click();

  const actionDialog = page.getByRole("dialog", {
    name: "copySide - left side",
    exact: true,
  });
  await actionDialog.waitFor();
  await actionDialog
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await actionDialog.waitFor({ state: "detached" });

  const status = workspace.locator(".status-bar");
  await status
    .getByText("Completed 1 of 1 local actions.", { exact: false })
    .waitFor();
  await status
    .getByText("Links are not copied; 1 skipped.", { exact: false })
    .waitFor();

  assert.equal(await readFile(join(right, "file.txt"), "utf8"), "file\n");
  await assert.rejects(access(join(right, "linked-entry")));
} finally {
  if (session) await session.close();
  await rm(fixture, { recursive: true, force: true });
}
