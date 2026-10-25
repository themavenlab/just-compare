import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-interactions-"));
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
  const content = async (side) =>
    (await text(side).locator(".cm-line").allTextContents()).join("\n");
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
  const screenshots = resolve("..\\..\\artifacts\\compact-workbench");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "plain-text-dark.png") });
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
  assert.equal(await readFile(join(left, "different.js"), "utf8"), leftText);
  assert.equal(await readFile(join(right, "different.js"), "utf8"), rightText);
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
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Browse lists one side and auto-compares both; Diffs survives browse/refresh; folders start collapsed; file pairs auto-compare; row clicks never copy; arrow copies drafts only; toolbar/menu/keyboard Undo restores drafts and diffs after copies or edits; dark source text has no syntax colors.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
