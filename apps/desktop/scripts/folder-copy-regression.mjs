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
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const fixture = await mkdtemp(join(tmpdir(), "folder-copy-regression-"));
const config = join(fixture, "config");
const left = join(fixture, "left");
const right = join(fixture, "right");
const tracker = join(right, "support", "github-tracker");
await Promise.all([
  mkdir(config),
  mkdir(left),
  mkdir(join(tracker, "sub"), { recursive: true }),
]);
await Promise.all([
  writeFile(join(tracker, "a.txt"), "alpha\n"),
  writeFile(join(tracker, "sub", "b.txt"), "beta\n"),
  writeFile(join(left, "paired.txt"), "paired\n"),
  writeFile(join(right, "paired.txt"), "paired\n"),
  writeFile(join(left, "doomed.txt"), "left-only\n"),
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
  await list
    .locator('.folder-row[data-relative="support"]')
    .getByRole("button", { name: "Expand support right", exact: true })
    .click();
  const trackerRow = list.locator(
    '.folder-row[data-relative="support/github-tracker"]',
  );
  await trackerRow.waitFor();
  await trackerRow.locator(".folder-side").nth(1).click();
  await trackerRow.locator(".folder-side").nth(1).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy to Side...", exact: true })
    .click();

  const actionDialog = page.getByRole("dialog", {
    name: "copySide - right side",
    exact: true,
  });
  await actionDialog.waitFor();
  await actionDialog
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await actionDialog.waitFor({ state: "detached" });
  await workspace
    .locator(".status-bar")
    .getByText("Completed 1 of 1 local actions.", { exact: false })
    .waitFor();

  assert.equal(
    await readFile(join(left, "support", "github-tracker", "a.txt"), "utf8"),
    "alpha\n",
  );
  assert.equal(
    await readFile(
      join(left, "support", "github-tracker", "sub", "b.txt"),
      "utf8",
    ),
    "beta\n",
  );

  // Copy to Left updates the affected rows without a manual rescan, and keeps
  // the selection made before the copy.
  await page.waitForFunction(
    () =>
      ["support", "support/github-tracker"].every(
        (relative) =>
          document
            .querySelector(
              `.workspace-slot[aria-hidden="false"] .folder-row[data-relative="${relative}"]`,
            )
            ?.getAttribute("data-status") === "same",
      ),
    undefined,
    { timeout: 10000 },
  );
  assert.match(
    (await trackerRow.getAttribute("class")) ?? "",
    /selected-folder-row/,
  );
  assert.equal(await page.getByText(/rescan/i).count(), 0);

  await list
    .locator('.folder-row[data-relative="paired.txt"]')
    .locator(".folder-side")
    .first()
    .dblclick();
  await page.getByRole("textbox", { name: "Left text", exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await selectWorkspace(page, "folder");

  await list
    .locator('.folder-row[data-relative="support"]')
    .locator(".folder-side")
    .nth(1)
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy Filename", exact: true })
    .click();
  const copyNameDialog = page.getByRole("dialog", {
    name: "copyFilename - right side",
    exact: true,
  });
  await copyNameDialog.waitFor();
  await copyNameDialog
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  await workspace
    .getByText("Copied 1 paths to the clipboard.", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);

  // Recycling a left-only file removes its row without a manual rescan.
  const doomedRow = list.locator('.folder-row[data-relative="doomed.txt"]');
  await doomedRow.waitFor();
  await doomedRow.locator(".folder-side").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete...", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: /^recycle - / });
  await deleteDialog.waitFor();
  await deleteDialog
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await deleteDialog.waitFor({ state: "detached" });
  await doomedRow.waitFor({ state: "detached", timeout: 10000 });
  await assert.rejects(access(join(left, "doomed.txt")), /ENOENT/);
  assert.equal(await page.getByText(/rescan/i).count(), 0);
  assert.equal(await page.getByRole("alert").count(), 0);

  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '.workspace-slot[aria-hidden="false"] .folder-row[data-relative="support"]',
        )
        ?.getAttribute("data-status") === "same",
  );
  assert.equal(
    await list
      .locator('.folder-row[data-relative="support"]')
      .getAttribute("data-status"),
    "same",
  );
  await list
    .locator('.folder-row[data-relative="support/github-tracker"]')
    .getByRole("button", { name: /Expand .*github-tracker/ })
    .first()
    .click();
  await list
    .locator('.folder-row[data-relative="support/github-tracker/sub"]')
    .getByRole("button", { name: /Expand .*sub/ })
    .first()
    .click();
  assert.equal(
    await list
      .locator('.folder-row[data-relative="support/github-tracker/a.txt"]')
      .getAttribute("data-status"),
    "same",
  );
  assert.equal(
    await list
      .locator('.folder-row[data-relative="support/github-tracker/sub/b.txt"]')
      .getAttribute("data-status"),
    "same",
  );
} finally {
  if (session) await session.close();
  await rm(fixture, { recursive: true, force: true });
}

console.log("Native missing-parent folder copy regression passed.");
