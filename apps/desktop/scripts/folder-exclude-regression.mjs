import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const fixture = await mkdtemp(join(tmpdir(), "folder-exclude-regression-"));
const config = join(fixture, "config");
const left = join(fixture, "left");
const right = join(fixture, "right");
await Promise.all([mkdir(config), mkdir(left), mkdir(right)]);
await writeFile(join(left, "hello"), "file");
await mkdir(join(right, "hello"));
await writeFile(join(right, "hello", "child.txt"), "child");
await writeFile(join(left, "rule-file.txt"), "same");
await writeFile(join(right, "rule-file.txt"), "same");
await mkdir(join(left, "rule-folder"));
await mkdir(join(right, "rule-folder"));
await writeFile(join(left, "rule-folder", "nested.txt"), "same");
await writeFile(join(right, "rule-folder", "nested.txt"), "same");
await mkdir(join(left, "node_modules", "package"), { recursive: true });
await mkdir(join(right, "node_modules", "package"), { recursive: true });
await writeFile(join(left, "node_modules", "package", "index.js"), "left");
await writeFile(join(right, "node_modules", "package", "index.js"), "right");
await mkdir(join(left, "paired"));
await mkdir(join(right, "paired"));
await writeFile(join(left, "paired", "nested.txt"), "same");
await writeFile(join(right, "paired", "nested.txt"), "same");

let session;
try {
  session = await launchNative(config);
  const { page } = session;
  await selectWorkspace(page, "folder");
  await page
    .getByRole("combobox", { name: "left path", exact: true })
    .fill(left);
  await page
    .getByRole("combobox", { name: "right path", exact: true })
    .fill(right);

  const list = page.getByRole("region", {
    name: "Folder comparison entries",
  });
  const statusBar = page.locator(".status-bar");
  const initialStatus = await statusBar.textContent();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Excluded file paths" })
    .fill("rule-file.txt");
  await page
    .getByRole("textbox", { name: "Excluded folder paths" })
    .fill("rule-folder");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForFunction((previousStatus) => {
    const status = document.querySelector(".status-bar")?.textContent ?? "";
    return status.includes("Scan complete:") && status !== previousStatus;
  }, initialStatus);
  assert.equal(
    await list.locator('.folder-row[data-relative="rule-file.txt"]').count(),
    0,
  );
  assert.equal(
    await list.locator('.folder-row[data-relative="rule-folder"]').count(),
    0,
  );
  assert.equal(
    await list
      .locator('.folder-row[data-relative="rule-folder/nested.txt"]')
      .count(),
    0,
  );

  const nodeModules = list.locator('.folder-row[data-relative="node_modules"]');
  await nodeModules.waitFor();
  const exactExclusionStatus = await statusBar.textContent();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Exclusions (glob per line)" })
    .fill("**/node_modules/**");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForFunction((previousStatus) => {
    const status = document.querySelector(".status-bar")?.textContent ?? "";
    return status.includes("Scan complete:") && status !== previousStatus;
  }, exactExclusionStatus);
  assert.equal(await nodeModules.count(), 0);
  assert.equal(
    await list
      .locator('.folder-row[data-relative="node_modules/package"]')
      .count(),
    0,
  );

  const helloRows = list.locator('.folder-row[data-relative="hello"]');
  await helloRows.first().waitFor();
  assert.equal(await helloRows.count(), 2);
  const helloFile = list.locator('.folder-row[data-row-key="f:hello"]');
  const helloFolder = list.locator('.folder-row[data-row-key="d:hello"]');
  assert.equal(await helloFile.getAttribute("data-status"), "leftOnly");
  assert.equal(await helloFolder.getAttribute("data-status"), "rightOnly");

  await helloFolder.locator(".folder-side").nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Exclude", exact: true }).click();
  await helloFolder.waitFor({ state: "detached" });
  assert.equal(await helloRows.count(), 1);
  await page.waitForFunction(() =>
    document
      .querySelector(".status-bar")
      ?.textContent?.includes("Scan complete:"),
  );
  assert.equal(await helloRows.count(), 1);
  assert.equal(await helloRows.getAttribute("data-status"), "leftOnly");
  assert.match(
    await helloRows
      .locator(".folder-side")
      .first()
      .locator(".entry-icon")
      .getAttribute("class"),
    /file-icon/,
  );
  assert.equal(
    await list.locator('.folder-row[data-relative="hello/child.txt"]').count(),
    0,
  );

  const pairedFolder = list.locator('.folder-row[data-relative="paired"]');
  await pairedFolder
    .locator(".folder-side")
    .nth(1)
    .locator(".tree-toggle")
    .click();
  await list
    .locator('.folder-row[data-relative="paired/nested.txt"]')
    .waitFor();
  await pairedFolder.locator(".folder-side").nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Exclude", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".status-bar")
      ?.textContent?.includes("Scan complete:"),
  );
  assert.equal(await pairedFolder.count(), 0);
  assert.equal(
    await list
      .locator('.folder-row[data-relative="paired/nested.txt"]')
      .count(),
    0,
  );
  assert.equal(await helloRows.count(), 1);
} finally {
  if (session) await session.close();
  await rm(fixture, { recursive: true, force: true });
}

console.log("Native folder exclusion regression passed.");
