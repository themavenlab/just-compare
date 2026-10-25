import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchNative,
  previewUpdate,
  selectWorkspace,
} from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-workflows-"));
let session;
try {
  const left = join(root, "left");
  const right = join(root, "right");
  for (const directory of [left, right]) {
    await mkdir(join(directory, "nested"), { recursive: true });
  }
  for (const [name, a, b] of [
    ["first.txt", "first left\n", "first right\n"],
    ["nested\\second.txt", "second left\n", "second right\n"],
  ]) {
    await writeFile(join(left, name), a);
    await writeFile(join(right, name), b);
  }
  await mkdir(join(root, "config"));
  session = await launchNative(join(root, "config"));
  const { page } = session;
  const failures = [];
  const text = (side) =>
    page.getByRole("textbox", { name: `${side} text`, exact: true });
  const content = async (side) =>
    (await text(side).locator(".cm-line").allTextContents()).join("\n");
  const compare = async () => {
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.getByRole("heading", { name: /changed regions/ }).waitFor();
  };
  await selectWorkspace(page, "folder");
  const leftRoot = `\\\\?\\${left}`;
  const rightRoot = `\\\\?\\${right}`;
  await page
    .getByRole("combobox", { name: "left path", exact: true })
    .fill(leftRoot);
  await page
    .getByRole("combobox", { name: "right path", exact: true })
    .fill(rightRoot);
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  const folderList = page.getByRole("region", {
    name: "Folder comparison entries",
  });
  const row = (name) =>
    folderList.locator(`.folder-row[data-relative="${name}"]`);
  await row("first.txt").locator(".folder-side").first().click();
  const openPair = (name) =>
    row(name).locator(".folder-side").first().dblclick();
  try {
    await openPair("first.txt");
    await text("Left").waitFor({ timeout: 5000 });
    await selectWorkspace(page, "folder");
    assert.equal(
      await page
        .getByRole("combobox", { name: "left path", exact: true })
        .inputValue(),
      leftRoot,
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "right path", exact: true })
        .inputValue(),
      rightRoot,
    );
    assert.equal(await row("first.txt").getAttribute("aria-selected"), "true");
    await folderList
      .getByRole("button", { name: "Expand nested left", exact: true })
      .click();
    await openPair("nested/second.txt");
    await text("Left").waitFor();
    assert.equal(await content("Left"), "second left\n");
    assert.equal(await content("Right"), "second right\n");
    assert.equal(await page.getByRole("alert").count(), 0);
    await selectWorkspace(page, "folder");
    await page
      .getByRole("button", { name: "Scan folders", exact: true })
      .click();
    await row("first.txt").waitFor();
    await previewUpdate(page);
    await page
      .getByRole("heading", { name: "Sync preview: 2 operations", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.getByRole("button", { name: "Dismiss preview" }).click();
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    assert.equal(
      await page
        .getByRole("combobox", { name: "left path", exact: true })
        .inputValue(),
      rightRoot,
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "right path", exact: true })
        .inputValue(),
      leftRoot,
    );
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    await selectWorkspace(page, "text");
  } catch (error) {
    failures.push(`Folder round-trip: ${error.message}`);
    await selectWorkspace(page, "text");
  }

  const shared = Array.from(
    { length: 200 },
    (_, index) => `shared ${index} ${"x".repeat(180)}`,
  );
  const a = [...shared],
    b = [...shared];
  a[70] = "left first";
  b[70] = "right first";
  a[90] = "left second";
  b[90] = "right second";
  await text("Left").fill(a.join("\n") + "\n");
  await text("Right").fill(b.join("\n") + "\n");
  await compare();
  await page
    .getByRole("button", { name: "Go to difference 1", exact: true })
    .click();
  const scrolls = () =>
    page.evaluate(() => ({
      page: window.scrollY,
      editors: [
        ...document.querySelectorAll(
          '.workspace-slot[aria-hidden="false"] .cm-scroller',
        ),
      ].map((node) => ({
        top: node.scrollTop,
        left: node.scrollLeft,
      })),
    }));
  const arrow = page.getByRole("button", {
    name: "Copy difference 1 to right",
    exact: true,
  });
  await arrow.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    for (const scroller of document.querySelectorAll(
      '.workspace-slot[aria-hidden="false"] .cm-scroller',
    ))
      scroller.scrollLeft = 120;
  });
  const before = await scrolls();
  await arrow.click();
  try {
    await page
      .getByRole("heading", { name: "1 changed regions", exact: true })
      .waitFor({ timeout: 5000 });
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".copy-arrow:not(:disabled)")
      .first()
      .waitFor();
    const after = await scrolls();
    assert.ok(
      Math.abs(after.page - before.page) <= 2,
      `Page moved ${after.page - before.page}px`,
    );
    after.editors.forEach((position, index) => {
      assert.ok(
        Math.abs(position.top - before.editors[index].top) <= 2,
        `Editor ${index} moved ${position.top - before.editors[index].top}px`,
      );
      assert.ok(
        Math.abs(position.left - before.editors[index].left) <= 2,
        `Editor ${index} moved horizontally ${position.left - before.editors[index].left}px`,
      );
    });
    assert.equal(
      await page
        .locator('.workspace-slot[aria-hidden="false"]')
        .locator(".diff-replace")
        .count(),
      2,
    );
    await page
      .getByRole("button", { name: "Next difference", exact: true })
      .click();
    await page.waitForFunction(() => {
      const node = document.querySelector(
        '.workspace-slot[aria-hidden="false"] .diff-selected',
      );
      const viewport = node?.closest(".cm-scroller");
      if (!node || !viewport) return false;
      const line = node.getBoundingClientRect(),
        box = viewport.getBoundingClientRect();
      return line.top >= box.top && line.bottom <= box.bottom;
    });
    await page
      .getByRole("button", { name: "Copy region to left", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "0 changed regions", exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('.workspace-slot[aria-hidden="false"]')
        .locator(".copy-arrow")
        .count(),
      0,
    );
    assert.equal(
      await readFile(join(right, "first.txt"), "utf8"),
      "first right\n",
    );
  } catch (error) {
    failures.push(`Continuous copy: ${error.message}`);
  }
  for (const [source, target, direction] of [
    [[...shared.slice(0, 70), "extra", ...shared.slice(70)], shared, "right"],
    [shared, [...shared.slice(0, 70), "extra", ...shared.slice(70)], "right"],
    [shared, [...shared.slice(0, 70), "extra", ...shared.slice(70)], "left"],
  ]) {
    await text("Left").fill(source.join("\n") + "\n");
    await text("Right").fill(target.join("\n") + "\n");
    await compare();
    await page
      .getByRole("button", { name: "Go to difference 1", exact: true })
      .click();
    const copy = page.getByRole("button", {
      name: `Copy difference 1 to ${direction}`,
      exact: true,
    });
    await page.waitForFunction((label) => {
      const workspace = document.querySelector(
        '.workspace-slot[aria-hidden="false"]',
      );
      const arrow = [...workspace.querySelectorAll(".copy-arrow")].find(
        (node) => node.getAttribute("aria-label") === label,
      );
      if (!arrow) return false;
      const viewport = arrow.closest(".cm-scroller");
      if (!viewport) return false;
      const box = arrow.getBoundingClientRect(),
        bounds = viewport.getBoundingClientRect();
      return box.top >= bounds.top && box.bottom <= bounds.bottom;
    }, `Copy difference 1 to ${direction}`);
    await page.waitForFunction(() => {
      const panes = [
        ...document.querySelectorAll(
          '.workspace-slot[aria-hidden="false"] .cm-scroller',
        ),
      ];
      return (
        panes.length === 2 &&
        Math.abs(panes[0].scrollTop - panes[1].scrollTop) <= 1
      );
    });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const initial = await scrolls();
    await copy.click();
    await page
      .getByRole("heading", { name: "0 changed regions", exact: true })
      .waitFor();
    const final = await scrolls();
    final.editors.forEach((position, index) => {
      assert.ok(
        Math.abs(position.top - initial.editors[index].top) <= 2,
        `Gap-copy editor ${index} moved ${position.top - initial.editors[index].top}px`,
      );
    });
    assert.ok(
      Math.abs(final.page - initial.page) <= 2,
      `Gap copy must not move the page: ${initial.page} -> ${final.page}.`,
    );
  }

  const boundedLines = Array.from(
    { length: 19999 },
    (_, index) => `bounded ${index}`,
  );
  await text("Left").fill("second left\n");
  await text("Right").fill("second right\n");
  const boundedLeft = join(root, "bounded-left.txt");
  const boundedRight = join(root, "bounded-right.txt");
  await writeFile(boundedLeft, ["inserted", ...boundedLines].join("\n") + "\n");
  await writeFile(boundedRight, [...boundedLines, "tail"].join("\n") + "\n");
  await page
    .getByRole("combobox", { name: "left path", exact: true })
    .fill(boundedLeft);
  await page.getByRole("button", { name: "Open left", exact: true }).click();
  await page
    .getByRole("combobox", { name: "right path", exact: true })
    .fill(boundedRight);
  await page.getByRole("button", { name: "Open right", exact: true }).click();
  await compare();
  await page
    .getByRole("button", { name: "Copy difference 1 to right", exact: true })
    .click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /20,000|20000/);
  assert.equal(
    await text("Right").locator(".cm-line").first().innerText(),
    "inserted",
    "Refresh failure must retain the copied draft.",
  );
  assert.equal(
    await page
      .locator('.workspace-slot[aria-hidden="false"]')
      .locator(".copy-arrow")
      .count(),
    0,
    "Failed refresh must not leave stale actionable ranges.",
  );
  await page.getByRole("button", { name: "Undo right", exact: true }).click();
  await compare();
  await page
    .getByRole("heading", { name: "2 changed regions", exact: true })
    .waitFor();
  assert.deepEqual(failures, []);
  console.log(
    "PASS: extended Windows folder roots survive pair round-trips; repeated copies auto-refresh without editor/page jumps or implicit saves.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true });
}
