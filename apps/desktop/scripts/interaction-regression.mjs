import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-interactions-"));
const screenshots = resolve("..\\..\\artifacts\\compact-workbench");
let session;
try {
  const left = join(root, "left"),
    right = join(root, "right");
  const leftText = 'const name = "left";\nkeep();\n';
  const rightText = 'const name = "right";\nkeep();\n';
  for (const directory of [left, right]) {
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "same.txt"), "equal\n");
    await writeFile(join(directory, "nested", "same.txt"), "equal\n");
  }
  await writeFile(join(left, "different.js"), leftText);
  await writeFile(join(right, "different.js"), rightText);
  await writeFile(join(left, "left-only.txt"), "left only\n");
  await writeFile(join(right, "right-only.txt"), "right only\n");
  await writeFile(join(left, "nested", "different.txt"), "nested left\n");
  await writeFile(join(right, "nested", "different.txt"), "nested right\n");
  await mkdir(join(root, "config"));
  await mkdir(screenshots, { recursive: true });
  session = await launchNative(join(root, "config"));
  const { page, call } = session;
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const row = (name) =>
    workspace.locator(`.paired-folder-row[data-relative="${name}"]`);
  const text = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  const content = async (side) => {
    await text(side).locator(".cm-line").first().waitFor();
    return (await text(side).locator(".cm-line").allTextContents()).join("\n");
  };
  async function waitForContent(side, expected) {
    await page.waitForFunction(
      ({ side, expected }) => {
        const pane = document.querySelector(
          `.workspace-slot[aria-hidden="false"] [aria-label="${side} text"]`,
        );
        return (
          pane &&
          [...pane.querySelectorAll(".cm-line")]
            .map((line) => line.textContent)
            .join("\n") === expected
        );
      },
      { side, expected },
    );
  }
  const idle = () =>
    page.waitForFunction(
      () =>
        !document.querySelector(
          '.workspace-slot[aria-hidden="false"] .path-inputs button',
        )?.disabled &&
        !document.querySelector(".new-comparisons button")?.disabled,
    );
  // Only the OS chooser response is simulated; the real Browse handler and all
  // filesystem, comparison and rendering commands run in the native app.
  async function browse(side, path) {
    await page.evaluate((selection) => {
      const fetch = window.fetch;
      window.fetch = (input, options) => {
        if (decodeURIComponent(String(input)).includes("plugin:dialog|open")) {
          window.fetch = fetch;
          return Promise.resolve(
            new Response(JSON.stringify(selection), {
              headers: {
                "Content-Type": "application/json",
                "Tauri-Response": "ok",
              },
            }),
          );
        }
        return fetch(input, options);
      };
    }, path);
    await workspace
      .getByRole("button", { name: `Browse ${side}`, exact: true })
      .click();
  }
  async function filter(name) {
    await workspace.getByRole("button", { name: "Diffs", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  await selectWorkspace(page, "folder");
  await browse("left", left);
  await row("different.js").waitFor();
  await idle();
  assert.match(
    await workspace.locator(".status-bar").innerText(),
    /Choose the other folder/,
  );
  assert.equal(await row("nested").getAttribute("aria-expanded"), "false");
  assert.equal(await row("nested/different.txt").count(), 0);
  assert.equal(
    await row("nested")
      .locator(".folder-side")
      .last()
      .locator(".file-name")
      .innerText(),
    "",
  );
  await filter("Show Left Orphans");
  await browse("right", right);
  await row("left-only.txt").waitFor();
  await idle();
  assert.equal(await row("different.js").count(), 0);
  assert.equal(await row("same.txt").count(), 0);
  assert.equal(await row("right-only.txt").count(), 0);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await row("left-only.txt").waitFor();
  await idle();
  assert.equal(await row("different.js").count(), 0);
  await filter("Show Differences but No Orphans");
  await row("different.js").waitFor();
  assert.equal(await row("same.txt").count(), 0);
  assert.equal(await row("left-only.txt").count(), 0);
  assert.equal(await row("right-only.txt").count(), 0);
  assert.equal(await row("nested").getAttribute("aria-expanded"), "false");
  await row("nested")
    .getByRole("button", { name: "Expand nested left", exact: true })
    .click();
  await row("nested/different.txt").waitFor();
  assert.equal(await row("nested/same.txt").count(), 0);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  await row("nested/different.txt").waitFor();
  await idle();
  assert.equal(await row("nested/same.txt").count(), 0);
  assert.equal(
    await workspace.locator(".folder-browser input[type=checkbox]").count(),
    0,
  );
  assert.equal(
    await workspace.getByRole("tree").getAttribute("aria-multiselectable"),
    "true",
  );
  assert.equal(await row("nested").locator(".folder-icon").count(), 2);
  assert.equal(
    await row("nested/different.txt").locator(".file-icon").count(),
    2,
  );
  assert.equal(
    await row("nested/different.txt")
      .locator(".tree-elbow.last-sibling")
      .count(),
    2,
  );
  await row("different.js").locator(".folder-side").first().click();
  await row("nested/different.txt")
    .locator(".folder-side")
    .first()
    .click({ modifiers: ["Control"] });
  assert.equal(await row("different.js").getAttribute("aria-selected"), "true");
  assert.equal(
    await row("nested/different.txt").getAttribute("aria-selected"),
    "true",
  );
  await workspace.getByRole("tree").press(" ");
  assert.equal(
    await row("nested/different.txt").getAttribute("aria-selected"),
    "false",
  );
  await row("different.js").locator(".folder-side").first().click();
  await row("nested/different.txt")
    .locator(".folder-side")
    .first()
    .click({ modifiers: ["Shift"] });
  assert.equal(await row("nested").getAttribute("aria-selected"), "true");
  assert.equal(
    await row("nested/different.txt").getAttribute("aria-selected"),
    "true",
  );
  await page.screenshot({
    path: resolve(
      "..\\..\\artifacts\\compact-workbench\\folder-tree-light.png",
    ),
  });
  await row("different.js")
    .locator(".folder-side")
    .first()
    .locator(".file-name")
    .click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await readFile(join(right, "different.js"), "utf8"), rightText);
  await row("different.js")
    .locator(".folder-side")
    .first()
    .locator(".file-name")
    .dblclick();
  await workspace
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await idle();
  assert.equal(await content("Left"), leftText);
  assert.equal(await content("Right"), rightText);
  for (const side of ["Left", "Right"]) {
    assert.equal(
      await text(side).evaluate((node) => node.closest("label") !== null),
      false,
    );
    await text(side).locator(".cm-line").first().click();
    await text(side).locator(".cm-line").nth(1).click();
    assert.equal(await content("Left"), leftText);
    assert.equal(await content("Right"), rightText);
  }
  const folderTab = page.getByRole("tab").filter({ hasText: "left / right" });
  await folderTab.click();
  await filter("Show Right Orphans");
  await browse("left", left);
  await row("right-only.txt").waitFor();
  await idle();
  assert.equal(await row("different.js").count(), 0);
  assert.equal(await row("left-only.txt").count(), 0);
  await page
    .getByRole("tab")
    .filter({ hasText: "different.js / different.js" })
    .click();
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Toggle theme", exact: true })
    .click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  for (const side of ["Left", "Right"]) {
    const colors = await text(side)
      .locator(".cm-line")
      .first()
      .evaluate((node) => {
        const color = getComputedStyle(node.closest(".cm-content")).color;
        return {
          color,
          tokens: [...node.querySelectorAll("span")].map(
            (span) => getComputedStyle(span).color,
          ),
        };
      });
    assert.ok(
      colors.tokens.every((color) => color === colors.color),
      JSON.stringify(colors),
    );
  }
  await page.screenshot({ path: join(screenshots, "plain-text-dark.png") });
  await folderTab.click();
  await workspace.getByRole("button", { name: "All", exact: true }).click();
  // Browse reloads start collapsed under the recent-folder loading contract.
  await row("nested")
    .getByRole("button", { name: "Expand nested left", exact: true })
    .click();
  await row("nested/different.txt").waitFor();
  await page.screenshot({ path: join(screenshots, "folder-tree-dark.png") });
  await page
    .getByRole("tab")
    .filter({ hasText: "different.js / different.js" })
    .click();
  await workspace
    .getByRole("button", { name: "Copy difference 1 to right", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await idle();
  assert.equal(await content("Right"), leftText);
  assert.equal(await readFile(join(right, "different.js"), "utf8"), rightText);
  async function restoredDifference() {
    await workspace
      .getByRole("heading", { name: "1 changed regions", exact: true })
      .waitFor();
    await idle();
    assert.equal(await content("Left"), leftText);
    assert.equal(await content("Right"), rightText);
    assert.equal(
      await workspace
        .getByRole("button", {
          name: "Copy difference 1 to right",
          exact: true,
        })
        .count(),
      1,
    );
  }
  await workspace
    .getByRole("button", { name: "Undo right", exact: true })
    .click();
  await restoredDifference();
  await workspace
    .getByRole("button", { name: "Copy difference 1 to left", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await idle();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("menuitem", { name: "Undo left", exact: true }).click();
  await restoredDifference();
  await workspace
    .getByRole("button", { name: "Copy difference 1 to right", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();
  await idle();
  await text("Right").press("Control+z");
  await restoredDifference();
  await text("Right").press("Control+End");
  await text("Right").press("x");
  await text("Right").press("Control+z");
  await restoredDifference();
  assert.equal(
    await workspace
      .getByRole("button", { name: "Redo right", exact: true })
      .isEnabled(),
    true,
  );
  await text("Right").press("Control+y");
  await waitForContent("Right", `${rightText}x`);
  assert.equal(await content("Right"), `${rightText}x`);
  await workspace
    .getByRole("button", { name: "Undo right", exact: true })
    .click();
  await restoredDifference();
  await workspace
    .getByRole("button", { name: "Redo right", exact: true })
    .click();
  await waitForContent("Right", `${rightText}x`);
  assert.equal(await content("Right"), `${rightText}x`);
  await workspace
    .getByRole("button", { name: "Undo right", exact: true })
    .click();
  await restoredDifference();
  assert.equal(await readFile(join(left, "different.js"), "utf8"), leftText);
  assert.equal(await readFile(join(right, "different.js"), "utf8"), rightText);
  await workspace
    .getByRole("button", { name: "Copy difference 1 to right", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Save right", exact: true })
    .click();
  await folderTab.click();
  await idle();
  await workspace.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForFunction(() => {
    const row = document.querySelector(
      '.workspace-slot[aria-hidden="false"] .paired-folder-row[data-relative="different.js"]',
    );
    return row?.getAttribute("data-status") === "same";
  });
  assert.doesNotMatch(
    await workspace.locator(".status-bar").innerText(),
    /Results stale/,
  );
  assert.equal(await readFile(join(right, "different.js"), "utf8"), leftText);
  await page
    .getByRole("tab")
    .filter({ hasText: "different.js / different.js" })
    .click();
  const singleRight = await call("scan_folders", {
    left: "",
    right,
    rules: { content: "binary" },
    options: { criterion: "content", exclude: [] },
    jobId: "single-right",
  });
  assert.ok(
    singleRight.every(
      (entry) => entry.status === "rightOnly" && entry.importance === "unknown",
    ),
  );
  // Unequal source lengths need real alignment gaps, not just equal scroll offsets.
  const lines = Array.from({ length: 500 }, (_, index) => `line ${index}\n`);
  const longLeft = [
    ...lines.slice(0, 100),
    ...Array.from({ length: 20 }, (_, index) => `inserted ${index}\n`),
    ...lines.slice(100),
  ].join("");
  const longRight = lines.join("");
  const longLeftPath = join(root, "scroll-left.txt");
  const longRightPath = join(root, "scroll-right.txt");
  await writeFile(longLeftPath, longLeft);
  await writeFile(longRightPath, longRight);
  for (const [side, path] of [
    ["left", longLeftPath],
    ["right", longRightPath],
  ]) {
    await workspace
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(path);
    await workspace
      .getByRole("button", { name: `Open ${side}`, exact: true })
      .click();
    await idle();
  }
  await workspace
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await idle();
  const scroller = (side) => text(side).locator("..");
  async function scrollTo(side, top) {
    await scroller(side).evaluate((node, value) => {
      node.scrollTop = value;
    }, top);
    await page.waitForFunction((target) => {
      const nodes = [
        ...document.querySelectorAll(
          '.workspace-slot[aria-hidden="false"] .cm-scroller',
        ),
      ];
      return (
        nodes.length === 2 &&
        nodes.every((node) => Math.abs(node.scrollTop - target) <= 1)
      );
    }, top);
  }
  async function stableAligned(top) {
    const samples = await workspace.evaluate(async (node) => {
      const values = [];
      for (let frame = 0; frame < 36; frame++) {
        await new Promise(requestAnimationFrame);
        values.push(
          [...node.querySelectorAll(".cm-scroller")].map(
            (element) => element.scrollTop,
          ),
        );
      }
      return values;
    });
    assert.ok(
      samples.every((pair) =>
        pair.every((value) => Math.abs(value - top) <= 1),
      ),
      `Scrollbars must stay aligned without oscillation: ${JSON.stringify(samples)}`,
    );
    const positions = await Promise.all(
      ["Left", "Right"].map((side) =>
        text(side)
          .locator(".cm-line")
          .filter({ hasText: /^line 150$/ })
          .boundingBox(),
      ),
    );
    assert.ok(
      positions.every(Boolean),
      "Shared line must be visible in both panes",
    );
    assert.ok(
      Math.abs(positions[0].y - positions[1].y) <= 1,
      JSON.stringify(positions),
    );
  }
  await scrollTo("Left", 2800);
  const reloaded = longRight.replace("line 320\n", "reloaded 320\n");
  await writeFile(longRightPath, reloaded);
  for (let iteration = 0; iteration < 3; iteration++) {
    await workspace
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await workspace
      .getByRole("heading", { name: "2 changed regions", exact: true })
      .waitFor();
    await idle();
    await stableAligned(2800);
    await scrollTo("Right", 2700);
    await stableAligned(2700);
    await scrollTo("Left", 2800);
  }
  await text("Right").press("Control+Home");
  await text("Right").press("s");
  await scrollTo("Right", 2800);
  await workspace
    .getByRole("button", { name: "Save right", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "3 changed regions", exact: true })
    .waitFor();
  await idle();
  await stableAligned(2800);
  assert.equal(await readFile(longRightPath, "utf8"), `s${reloaded}`);
  assert.equal(await readFile(longLeftPath, "utf8"), longLeft);
  await scrollTo("Left", 2700);
  await stableAligned(2700);
  await workspace
    .getByRole("button", { name: "Copy region to right", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "2 changed regions", exact: true })
    .waitFor();
  await idle();
  await stableAligned(2700);
  await text("Right").press("Control+s");
  await idle();
  await workspace
    .locator(".metadata")
    .filter({ hasText: "/ unsaved" })
    .waitFor({ state: "hidden" });
  await stableAligned(2700);
  assert.equal(await readFile(longRightPath, "utf8"), reloaded);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Browse auto-lists/compares; Diffs persists; folders start collapsed with connected icon hierarchy and checkbox-free multi-selection; file pairs auto-compare; row clicks never copy; arrows copy drafts only; Undo restores drafts and diffs; dark text stays plain; Reload and Save preserve diffs, line alignment and stable two-way scrolling.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
