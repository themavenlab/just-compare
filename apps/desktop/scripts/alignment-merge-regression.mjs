import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-alignment-merge-"));
let session;
try {
  const config = join(root, "config");
  await mkdir(config);
  const textLeftPath = join(root, "text-left.txt");
  const textRightPath = join(root, "text-right.txt");
  const basePath = join(root, "base.txt");
  const leftPath = join(root, "left.txt");
  const rightPath = join(root, "right.txt");
  const base = "A\nbase\nC\nbase2\nE\n";
  const left = "A\nL\nL\nC\nLD\nE\n";
  const right = "A\nR\nR\nC\nRD\nE\n";
  await Promise.all([
    writeFile(textLeftPath, "café  \r\nsame\r\n"),
    writeFile(textRightPath, "café\t\r\nsame\r\n"),
    writeFile(basePath, base),
    writeFile(leftPath, left),
    writeFile(rightPath, right),
  ]);
  session = await launchNative(config);
  const { page } = session;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-comparisons button")?.disabled,
    );
  const editor = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  const regions = (count) =>
    workspace
      .getByRole("heading", {
        name: `${count} changed regions`,
        exact: true,
      })
      .waitFor();
  const openInput = async (side, path) => {
    await workspace
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(path);
    await workspace
      .getByRole("button", { name: `Open ${side}`, exact: true })
      .click();
    await idle();
  };

  await selectWorkspace(page, "text");
  await openInput("left", textLeftPath);
  await openInput("right", textRightPath);
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await regions(1);
  await workspace
    .getByRole("button", { name: "Next difference", exact: true })
    .click();
  await workspace
    .getByRole("button", {
      name: "Highlight intraline differences",
      exact: true,
    })
    .click();
  await workspace.locator(".cm-intraline-change").first().waitFor();
  await workspace
    .getByRole("button", { name: "Whitespace / EOL", exact: true })
    .click();
  await workspace.locator(".cm-visible-eol").first().waitFor();
  assert.ok(await workspace.locator(".cm-visible-space").count());
  assert.ok(await workspace.locator(".cm-visible-tab").count());
  assert.match(
    await workspace.locator(".cm-visible-eol").first().textContent(),
    /CRLF/,
  );

  await editor("Left").fill("top\nA\nB\nmiddle\nend\n");
  await editor("Right").fill("top\nmiddle\nend\nA\nB\n");
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await regions(2);
  await workspace.locator(".diff-move-marker").first().waitFor();

  const anchoredLeft = "head\nleft anchor\ntail\n";
  const anchoredRight = "head\nright anchor\ntail\n";
  await editor("Left").fill(anchoredLeft);
  await editor("Right").fill(anchoredRight);
  await regions(1);
  await editor("Left").locator(".cm-line").nth(1).click();
  await editor("Right").locator(".cm-line").nth(1).click();
  await workspace
    .getByRole("button", { name: "Anchor lines", exact: true })
    .click();
  const clearAnchors = workspace.getByRole("button", {
    name: "Clear anchors (1)",
    exact: true,
  });
  await clearAnchors.waitFor();
  await editor("Left").fill(`${anchoredLeft}extra\n`);
  await regions(2);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".tool-control button")].some(
      (button) =>
        button.textContent?.includes("Clear anchors") && button.disabled,
    ),
  );

  await selectWorkspace(page, "merge");
  await openInput("base", basePath);
  await openInput("left", leftPath);
  await openInput("right", rightPath);
  await workspace
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "2 unresolved conflicts" })
    .waitFor();
  await workspace
    .getByRole("button", {
      name: "Next unresolved conflict",
      exact: true,
    })
    .click();
  await workspace.locator(".conflict-active h3").waitFor();
  assert.match(
    (await workspace.locator(".conflict-active h3").textContent()) ?? "",
    /Conflict 1/,
  );
  await workspace
    .getByRole("button", {
      name: "Next unresolved conflict",
      exact: true,
    })
    .click();
  assert.match(
    (await workspace.locator(".conflict-active h3").textContent()) ?? "",
    /Conflict 2/,
  );
  await workspace
    .getByRole("button", {
      name: "Previous unresolved conflict",
      exact: true,
    })
    .click();
  assert.match(
    (await workspace.locator(".conflict-active h3").textContent()) ?? "",
    /Conflict 1/,
  );

  const output = workspace.getByRole("textbox", {
    name: "Merge output",
    exact: true,
  });
  await workspace
    .getByRole("button", { name: "Use both 1", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "1 unresolved conflicts" })
    .waitFor();
  assert.match(await output.innerText(), /L\nL\nR\nR/);
  await workspace
    .getByRole("button", {
      name: "Undo conflict resolution",
      exact: true,
    })
    .click();
  await workspace
    .getByRole("heading", { name: "2 unresolved conflicts" })
    .waitFor();
  assert.doesNotMatch(await output.innerText(), /L\nL\nR\nR/);
  await workspace
    .getByRole("button", {
      name: "Redo conflict resolution",
      exact: true,
    })
    .click();
  await workspace
    .getByRole("heading", { name: "1 unresolved conflicts" })
    .waitFor();
  assert.match(await output.innerText(), /L\nL\nR\nR/);
  await workspace
    .getByRole("button", { name: "Use left 2", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "0 unresolved conflicts" })
    .waitFor();
  assert.equal(
    await workspace
      .getByRole("button", { name: "Save merge output", exact: true })
      .isEnabled(),
    true,
  );

  assert.equal(await readFile(basePath, "utf8"), base);
  assert.equal(await readFile(leftPath, "utf8"), left);
  assert.equal(await readFile(rightPath, "utf8"), right);
  assert.deepEqual(errors, []);
  console.log(
    "Native alignment/merge regression passed: intraline and EOL marks, manual anchor lifecycle, moved-block markers, conflict navigation, left-then-right duplicate-preserving resolution, and resolution Undo/Redo.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
