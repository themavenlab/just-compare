import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, openWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-auto-"));
let session;
try {
  const config = join(root, "config");
  await mkdir(config);
  const left = join(root, "left");
  const right = join(root, "right");
  await mkdir(left);
  await mkdir(right);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    await writeFile(join(left, name), `${name} left\n`);
    await writeFile(join(right, name), `${name} right\n`);
  }
  await writeFile(join(left, "file.txt"), "alpha beta gamma\n");
  await writeFile(join(right, "file.txt"), "alpha BETA gamma\n");

  session = await launchNative(config);
  const { page } = session;
  page.setDefaultTimeout(15000);
  await page.keyboard.press("Control+t");
  const chooser = page.getByRole("dialog", { name: "New comparison" });
  await chooser.waitFor();
  await chooser.getByRole("button", { name: "New Text Compare" }).click();
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const editor = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });

  assert.equal(
    await workspace
      .getByRole("button", { name: "Compare", exact: true })
      .count(),
    0,
    "There is no manual Compare button.",
  );

  // Typing into two empty panes compares without any explicit action.
  await editor("Left").fill("same\nalpha beta gamma\nend\n");
  await editor("Right").fill("same\nalpha BETA gamma\nend\n");
  await workspace
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();

  // Intraline differences are marked inside the editors and can be toggled.
  await workspace.locator(".cm-intraline-change").first().waitFor();
  const inline = workspace.getByRole("button", {
    name: "Inline changes",
    exact: true,
  });
  await inline.click();
  await workspace.locator(".cm-intraline-change").first().waitFor({
    state: "detached",
  });
  assert.equal(
    await workspace.getByText("Intraline changed byte ranges").count(),
    0,
    "The redundant intraline section is gone.",
  );
  await inline.click();
  await workspace.locator(".cm-intraline-change").first().waitFor();

  // Copy buttons and navigation work regardless of the caret and selection.
  await editor("Left").click();
  const copyRight = workspace.getByRole("button", {
    name: /Copy .* to right/,
  });
  assert.equal(await copyRight.first().isDisabled(), false);
  await copyRight.first().click();
  await workspace
    .getByRole("heading", { name: "0 changed regions", exact: true })
    .waitFor();

  // Rule changes recompare automatically.
  await editor("Right").fill("same\nalpha BETA gamma\nend\n");
  await workspace
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();

  // Folder arrow navigation follows Explorer, even after clicking a control.
  await openWorkspace(page, "folder");
  await workspace.getByLabel("left path", { exact: true }).fill(left);
  await workspace.getByLabel("right path", { exact: true }).fill(right);
  await workspace
    .getByRole("button", { name: "Scan folders", exact: true })
    .click();
  const list = workspace.getByRole("region", {
    name: "Folder comparison entries",
  });
  const row = (path) => list.locator(`.folder-row[data-relative="${path}"]`);
  await row("a.txt").waitFor();
  await row("a.txt").locator(".folder-side").first().click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await row("c.txt").getAttribute("aria-selected"), "true");
  assert.ok(
    (await row("c.txt").getAttribute("class")).includes("selected-folder-row"),
    "Arrow keys move the selection to the third row, which is an alternate row.",
  );
  assert.ok(
    !(await row("a.txt").getAttribute("class")).includes("selected-folder-row"),
    "Moving the selection clears the previous row.",
  );
  await page.keyboard.press("End");
  assert.ok(
    (await row("file.txt").getAttribute("class")).includes(
      "selected-folder-row",
    ),
  );

  // File paths never expose the Windows verbatim prefix.
  await row("file.txt").locator(".folder-side").first().dblclick();
  await page.waitForFunction(() => {
    const input = document.querySelector(
      '.workspace-slot[aria-hidden="false"] [aria-label="left path"]',
    );
    return input?.value.endsWith("file.txt");
  });
  const shown = await workspace
    .getByRole("combobox", { name: "left path", exact: true })
    .inputValue();
  assert.ok(!shown.startsWith("\\\\?\\"), `Unexpected prefix in ${shown}`);
  console.log(
    "Native auto-compare regression passed: no Compare button, automatic compare, inline toggle, folder arrows, clean paths.",
  );
} finally {
  await session?.destroy?.().catch(() => {});
  await session?.close?.().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
