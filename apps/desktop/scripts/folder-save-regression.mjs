import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-folder-save-"));
let session;
try {
  const left = join(root, "left");
  const right = join(root, "right");
  const config = join(root, "config");
  await Promise.all([mkdir(left), mkdir(right), mkdir(config)]);
  await Promise.all([
    writeFile(join(left, "tracked.txt"), "same\n"),
    writeFile(join(right, "tracked.txt"), "same\n"),
    writeFile(join(root, "outside.txt"), "outside\n"),
  ]);
  await Promise.all(
    Array.from({ length: 1000 }, async (_, index) => {
      const name = `unrelated-${index}.txt`;
      await Promise.all([
        writeFile(join(left, name), `left ${index}\n`),
        writeFile(join(right, name), `left ${index}\n`),
      ]);
    }),
  );

  session = await launchNative(config);
  const { page, call } = session;
  await selectWorkspace(page, "folder");
  let workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.__folderRefreshCommands = [];
    window.__folderRefreshMetrics = {};
    window.fetch = async (input, init) => {
      const request = decodeURIComponent(String(input));
      const command = [
        "scan_folders",
        "compare_folder_selection",
        "refresh_folder_paths",
        "relative_folder_path",
      ].find((name) => request.includes(name));
      if (!command) return originalFetch(input, init);
      window.__folderRefreshCommands.push(command);
      const start = performance.now();
      try {
        return await originalFetch(input, init);
      } finally {
        const metric = window.__folderRefreshMetrics[command] ?? {
          count: 0,
          totalMs: 0,
        };
        const elapsed = performance.now() - start;
        window.__folderRefreshMetrics[command] = {
          count: metric.count + 1,
          totalMs: metric.totalMs + elapsed,
          lastMs: elapsed,
        };
      }
    };
  });
  await workspace.getByLabel("left path", { exact: true }).fill(left);
  await workspace.getByLabel("right path", { exact: true }).fill(right);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await workspace
    .getByText("Scan complete:", { exact: false })
    .first()
    .waitFor();
  const fullScan = await page.evaluate(
    () => window.__folderRefreshMetrics.scan_folders,
  );
  const folderTab = page.getByRole("tab", { selected: true });
  const folderTabId = await folderTab.getAttribute("id");
  await page.evaluate(() => {
    window.__folderRefreshCommands = [];
  });

  await selectWorkspace(page, "text");
  workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  for (const side of ["left", "right"]) {
    await workspace
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(join(side === "left" ? left : right, "tracked.txt"));
    await workspace
      .getByRole("button", { name: `Open ${side}`, exact: true })
      .click();
  }
  const editor = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  await editor("Left").fill("changed\n");
  await workspace
    .getByRole("button", { name: "Save left", exact: true })
    .click();
  await workspace.getByText("left saved.", { exact: true }).waitFor();

  await page.locator(`#${folderTabId}`).click();
  const folderWorkspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const tracked = folderWorkspace.locator(
    '.folder-row[data-relative="tracked.txt"]',
  );
  await page.waitForFunction(() => {
    const row = document.querySelector(
      '.workspace-slot[aria-hidden="false"] .folder-row[data-relative="tracked.txt"]',
    );
    return row?.getAttribute("data-status") === "different";
  });
  const refreshCommands = await page.evaluate(
    () => window.__folderRefreshCommands,
  );
  assert.equal(
    refreshCommands.filter((command) => command === "scan_folders").length,
    0,
    "Saving one file must not dispatch a full folder scan",
  );
  assert.equal(
    refreshCommands.filter((command) => command === "compare_folder_selection")
      .length,
    0,
    "Saving one file must not recompare the selection",
  );
  assert.equal(
    refreshCommands.filter((command) => command === "refresh_folder_paths")
      .length,
    1,
    "Saving one file should dispatch one path-scoped refresh",
  );
  assert.equal(await tracked.getAttribute("data-status"), "different");
  assert.equal(await tracked.getAttribute("aria-selected"), "false");
  assert.equal(await readFile(join(left, "tracked.txt"), "utf8"), "changed\n");
  const refreshMetrics = await page.evaluate(() => ({
    mapping: window.__folderRefreshMetrics.relative_folder_path,
    selection: window.__folderRefreshMetrics.refresh_folder_paths,
  }));

  assert.equal(
    await call("relative_folder_path", {
      left,
      right,
      path: join(root, "outside.txt"),
    }),
    null,
    "Paths outside the roots are not mapped",
  );
  console.log(
    `PASS: 1,001-row native comparison; full scan ${fullScan.lastMs.toFixed(1)} ms; save mapping ${refreshMetrics.mapping.lastMs.toFixed(1)} ms; selected refresh ${refreshMetrics.selection.lastMs.toFixed(1)} ms; no full rescan on save.`,
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
