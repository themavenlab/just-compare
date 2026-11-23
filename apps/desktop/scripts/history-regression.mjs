import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-history-"));
const config = join(root, "config");
let session;
try {
  const left = join(root, "left"),
    right = join(root, "right");
  for (const path of [config, left, right]) await mkdir(path);
  for (const path of [left, right]) {
    await mkdir(join(path, "nested"));
    await writeFile(
      join(path, "nested", "file.txt"),
      path === left ? "left\n" : "right\n",
    );
  }
  session = await launchNative(config);
  let page = session.page;
  const workspace = () => page.locator('.workspace-slot[aria-hidden="false"]');
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-tab-button")?.disabled,
    );
  await selectWorkspace(page, "folder");
  await workspace()
    .getByRole("button", { name: "Recent left folders", exact: true })
    .click();
  await workspace().getByText("No recent folders.", { exact: true }).waitFor();
  const input = (side) =>
    workspace().getByRole("combobox", { name: `${side} path`, exact: true });
  await input("left").press("Escape");
  assert.equal(await workspace().locator(".path-history").count(), 0);
  await input("left").fill(left);
  assert.equal(await workspace().locator(".folder-row").count(), 0);
  await input("left").press("Enter");
  await workspace().locator('.folder-row[data-relative="nested"]').waitFor();
  await idle();
  assert.equal((await session.call("read_settings")).recentFolders.length, 1);
  await input("right").fill(right);
  await input("right").press("Enter");
  await idle();
  let stored = await session.call("read_settings");
  assert.equal(stored.recentFolders.length, 2);
  assert.equal(stored.recentComparisons.length, 1);
  assert.equal(stored.recentComparisons[0].mode, "folder");
  assert.equal(
    await workspace()
      .locator('.folder-row[data-relative="nested/file.txt"]')
      .count(),
    0,
  );
  await input("left").fill(join(root, "missing"));
  await input("left").press("Enter");
  await workspace().getByRole("alert").waitFor();
  assert.ok(
    await workspace().locator('.folder-row[data-relative="nested"]').count(),
  );
  await idle();
  await workspace()
    .getByRole("button", { name: "Recent left folders", exact: true })
    .click();
  // The popup escapes the compact pane: every option must be hit-testable and
  // laid out below the full-width field, not squeezed into the path row.
  const geometry = await workspace().evaluate((ws) => {
    const field = ws
      .querySelector('[aria-label="left path"]')
      .closest(".path-input-field")
      .getBoundingClientRect();
    const options = [
      ...document.querySelectorAll(".path-history [role=option]"),
    ];
    return {
      field: [field.left, field.bottom, field.width],
      input: (() => {
        const box = ws
          .querySelector('[aria-label="left path"]')
          .getBoundingClientRect();
        return [box.left, box.right, box.top, box.bottom];
      })(),
      toggle: (() => {
        const button = ws.querySelector(".path-input-toggle");
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          position: style.position,
          borderWidth: style.borderTopWidth,
        };
      })(),
      options: options.map((option) => {
        const box = option.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + 4,
          box.top + box.height / 2,
        );
        return {
          top: box.top,
          height: box.height,
          hit: hit === option || option.contains(hit),
          align: getComputedStyle(option).textAlign,
        };
      }),
    };
  });
  assert.equal(geometry.options.length, 2);
  assert.equal(geometry.toggle.position, "absolute");
  assert.equal(geometry.toggle.borderWidth, "0px");
  assert.ok(geometry.toggle.left > geometry.input[0]);
  assert.ok(geometry.toggle.right < geometry.input[1]);
  assert.ok(
    geometry.toggle.top >= geometry.input[2] &&
      geometry.toggle.bottom <= geometry.input[3],
    JSON.stringify(geometry),
  );
  for (const option of geometry.options) {
    assert.ok(
      option.hit,
      `Recent folder option is clipped: ${JSON.stringify(geometry)}`,
    );
    assert.ok(option.top >= geometry.field[1], JSON.stringify(geometry));
    assert.ok(option.height < 40, JSON.stringify(geometry));
    assert.ok(["left", "start"].includes(option.align));
  }
  await input("left").fill("left");
  assert.equal(await workspace().getByRole("option").count(), 1);
  await input("left").press("ArrowDown");
  await input("left").press("Enter");
  await idle();
  assert.ok((await input("left").inputValue()).endsWith("\\left"));
  stored = await session.call("read_settings");
  assert.equal(stored.recentFolders.length, 2);
  assert.equal(stored.recentComparisons.length, 1);
  // A failed history write retains published history and reports the failure.
  await rename(join(config, "settings.json"), join(config, "backup"));
  await mkdir(join(config, "settings.json"));
  await workspace()
    .getByRole("button", { name: "Recent right folders", exact: true })
    .click();
  await workspace()
    .getByRole("button", { name: "Clear folder history", exact: true })
    .click();
  await workspace().getByRole("alert").waitFor();
  await idle();
  await workspace()
    .getByRole("button", { name: "Recent right folders", exact: true })
    .click();
  assert.equal(await workspace().getByRole("option").count(), 2);
  await rm(join(config, "settings.json"), { recursive: true });
  await rename(join(config, "backup"), join(config, "settings.json"));
  await session.close();
  session = await launchNative(config);
  page = session.page;
  await page.getByRole("button", { name: /^folder: left \/ right$/ }).click();
  await workspace().locator('.folder-row[data-relative="nested"]').waitFor();
  await idle();
  assert.ok((await input("right").inputValue()).endsWith("\\right"));
  assert.equal(
    (await session.call("read_settings")).recentComparisons.length,
    1,
  );
  const persisted = await session.call("read_settings");
  await session.call("write_settings", {
    settings: { ...persisted, theme: "dark" },
  });
  await session.call("remember_history", { folders: [left], comparison: null });
  await session.call("write_history", {
    recentFolders: [],
    recentComparisons: null,
  });
  await session.call("write_line_detail", {
    lineDetail: { height: 220, collapsed: true },
  });
  assert.equal(
    (await session.call("read_settings")).theme,
    "dark",
    "Automatic history/layout writes must preserve other persisted preferences",
  );
  // File paths use the same dropdown of recently opened files, not a datalist.
  const fileA = join(root, "a.txt"),
    fileB = join(root, "b.txt");
  await writeFile(fileA, "alpha\n");
  await writeFile(fileB, "bravo\n");
  await selectWorkspace(page, "text");
  assert.equal(await page.locator("datalist").count(), 0);
  for (const file of [fileA, fileB]) {
    await input("left").fill(file);
    await input("left").press("Enter");
    await idle();
  }
  await workspace()
    .getByRole("textbox", { name: "Left text", exact: true })
    .getByText("bravo")
    .waitFor();
  await workspace()
    .getByRole("button", { name: "Recent left files", exact: true })
    .click();
  const fileOptions = workspace()
    .getByRole("listbox", { name: "Recent left files", exact: true })
    .getByRole("option");
  const recentFiles = (await fileOptions.allTextContents()).slice(0, 2);
  assert.ok(
    recentFiles[0].endsWith("\\b.txt") && recentFiles[1].endsWith("\\a.txt"),
    JSON.stringify(recentFiles),
  );
  assert.equal(
    await workspace()
      .getByRole("button", { name: /^Remove recent file/ })
      .count(),
    0,
  );
  await fileOptions.filter({ hasText: "a.txt" }).click();
  await idle();
  await workspace()
    .getByRole("textbox", { name: "Left text", exact: true })
    .getByText("alpha")
    .waitFor();
  assert.equal(await input("left").inputValue(), recentFiles[1]);

  await session.call("write_history", {
    recentFolders: null,
    recentComparisons: Array.from({ length: 20 }, (_, index) => ({
      mode: "text",
      left: `left-${index}.txt`,
      right: `right-${index}.txt`,
      base: "",
    })),
  });
  await page.reload();
  const recentHeading = page.getByRole("heading", {
    name: "Recent comparisons",
    exact: true,
  });
  await recentHeading.waitFor();
  const scrollState = await page.evaluate(() => {
    const list = document.querySelector(".home-comparison-list");
    const main = document.querySelector(".home-main");
    const heroHeading = document.querySelector(".home-hero h2");
    const recentHeading = document.querySelector("#recent-heading");
    if (
      !(list instanceof HTMLElement) ||
      !(main instanceof HTMLElement) ||
      !(heroHeading instanceof HTMLElement) ||
      !(recentHeading instanceof HTMLElement)
    )
      throw new Error("The home history layout is missing required elements.");
    const before = {
      heroTop: heroHeading.getBoundingClientRect().top,
      recentTop: recentHeading.getBoundingClientRect().top,
    };
    list.scrollTop = list.scrollHeight;
    return {
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      mainScrollTop: main.scrollTop,
      heroTop: heroHeading.getBoundingClientRect().top,
      recentTop: recentHeading.getBoundingClientRect().top,
      before,
    };
  });
  assert.ok(
    scrollState.scrollHeight > scrollState.clientHeight,
    "Recent comparisons should scroll internally when history exceeds the visible list.",
  );
  assert.equal(scrollState.mainScrollTop, 0);
  assert.equal(scrollState.heroTop, scrollState.before.heroTop);
  assert.equal(scrollState.recentTop, scrollState.before.recentTop);
  console.log(
    "Native history regression passed: submission, one/two roots, keyboard picker, unclipped popup, recent-file dropdown, retained stale results, bounded persisted tuples, restart and failed persistence, and contained home-history scrolling.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
