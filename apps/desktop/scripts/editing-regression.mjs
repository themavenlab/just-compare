import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-editing-"));
let session;
try {
  const config = join(root, "config");
  await mkdir(config);
  const left = join(root, "left.txt");
  const right = join(root, "right.txt");
  const original = "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n";
  await writeFile(left, original);
  await writeFile(right, original);
  session = await launchNative(config);
  const { page, call } = session;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const editor = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-tab-button")?.disabled,
    );
  const regions = (count) =>
    workspace
      .getByRole("heading", {
        name: `${count} changed regions`,
        exact: true,
      })
      .waitFor();
  await selectWorkspace(page, "text");
  for (const [side, path] of [
    ["left", left],
    ["right", right],
  ]) {
    await workspace
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(path);
    await workspace
      .getByRole("button", { name: `Open ${side}`, exact: true })
      .click();
    await idle();
  }
  await regions(0);
  await idle();
  await workspace
    .getByRole("button", { name: "Find / Replace", exact: true })
    .click();
  await workspace.getByRole("textbox", { name: "Find text" }).fill("three");
  await workspace
    .getByRole("button", { name: "Find Next", exact: true })
    .click();
  await workspace
    .getByRole("status")
    .filter({ hasText: "Match 1 of 2 in the left pane." })
    .waitFor();
  assert.equal(
    await editor("Left").evaluate(() => window.getSelection()?.toString()),
    "three",
  );
  await workspace
    .getByRole("button", { name: "Find Next", exact: true })
    .click();
  await workspace
    .getByRole("status")
    .filter({ hasText: "Match 2 of 2 in the right pane." })
    .waitFor();
  await workspace.getByRole("tab", { name: "Replace", exact: true }).click();
  await workspace.getByRole("textbox", { name: "Replace with" }).fill("THREE");
  await workspace
    .getByRole("button", { name: "Preview Replace All...", exact: true })
    .click();
  const replacementDialog = workspace.getByRole("dialog", {
    name: "Review Replace All",
  });
  await replacementDialog
    .getByText("Replace 2 matches across both panes.", { exact: false })
    .waitFor();
  assert.equal(await replacementDialog.locator("del").count(), 2);
  await replacementDialog
    .getByRole("button", { name: "Replace All", exact: true })
    .click();
  await idle();
  assert.match(await editor("Left").innerText(), /THREE/);
  assert.match(await editor("Right").innerText(), /THREE/);
  assert.equal(await readFile(left, "utf8"), original);
  assert.equal(await readFile(right, "utf8"), original);
  await workspace
    .getByRole("button", { name: "Undo left", exact: true })
    .click();
  await idle();
  await workspace
    .getByRole("button", { name: "Undo right", exact: true })
    .click();
  await idle();
  await regions(0);
  await workspace
    .getByRole("button", { name: "Redo left", exact: true })
    .click();
  await regions(1);
  await editor("Right").press("Control+y");
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Right text"]')
      ?.textContent?.includes("THREE"),
  );
  await regions(0);
  await editor("Left").press("Control+z");
  await regions(1);
  await editor("Right").press("Control+z");
  await regions(0);
  await workspace
    .getByRole("button", { name: "Close Find and Replace", exact: true })
    .click();
  await page.keyboard.press("Control+g");
  const lineInput = workspace.getByRole("spinbutton", {
    name: "Go to line number",
  });
  await lineInput.fill("99");
  await workspace.getByRole("button", { name: "Go", exact: true }).click();
  await workspace
    .getByRole("alert")
    .filter({ hasText: "Enter a line number from 1 to 6." })
    .waitFor();
  await lineInput.fill("3");
  await workspace.getByRole("button", { name: "Go", exact: true }).click();
  await workspace
    .getByRole("status")
    .filter({ hasText: "Moved to line 3 in the left pane." })
    .waitFor();
  assert.equal(
    await editor("Left").evaluate((node) => {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const element =
        anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
      return element?.closest(".cm-line")?.textContent ?? null;
    }),
    "three",
  );
  await workspace
    .getByRole("button", { name: "Close Find and Replace", exact: true })
    .click();
  await editor("Left").locator(".cm-line").nth(2).click();
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await regions(1);
  assert.equal(await editor("Left").locator(".diff-line").count(), 1);
  assert.equal(await editor("Right").locator(".diff-line").count(), 1);
  assert.equal(
    await editor("Left").locator(".diff-line").innerText(),
    "threeX",
  );
  assert.equal(
    await editor("Left").evaluate((node) => node === document.activeElement),
    true,
  );
  await idle();
  await regions(1);
  assert.equal(await editor("Right").locator(".diff-line").count(), 1);
  for (const [side, expectedIcon] of [
    ["Left", "copyRight"],
    ["Right", "copyLeft"],
  ]) {
    const gutter = await editor(side).evaluate((content) => {
      const cmEditor = content.closest(".cm-editor");
      const copyGutter = cmEditor?.querySelector(".cm-copy-gutter");
      const button = copyGutter?.querySelector(".copy-arrow");
      const icon = button?.querySelector(".copy-arrow-icon");
      const lineNumberGutter = cmEditor?.querySelector(".cm-lineNumbers");
      const editorContent = cmEditor?.querySelector(".cm-content");
      if (
        !cmEditor ||
        !copyGutter ||
        !button ||
        !icon ||
        !lineNumberGutter ||
        !editorContent
      )
        return null;
      const gutterBounds = copyGutter.getBoundingClientRect();
      const lineNumberBounds = lineNumberGutter.getBoundingClientRect();
      const contentBounds = editorContent.getBoundingClientRect();
      const buttonStyle = getComputedStyle(button);
      const iconBounds = icon.getBoundingClientRect();
      return {
        gutterLeft: gutterBounds.left,
        gutterRight: gutterBounds.right,
        lineNumberLeft: lineNumberBounds.left,
        lineNumberRight: lineNumberBounds.right,
        contentLeft: contentBounds.left,
        contentRight: contentBounds.right,
        name: icon.getAttribute("data-icon"),
        iconWidth: iconBounds.width,
        iconHeight: iconBounds.height,
        buttonMargin: buttonStyle.margin,
        buttonPadding: buttonStyle.padding,
        buttonBackground: buttonStyle.backgroundColor,
        iconFill: icon.getAttribute("fill"),
        iconPath: icon.querySelector("path")?.getAttribute("d"),
      };
    });
    assert.ok(gutter, `${side} editor should show a copy arrow`);
    assert.equal(gutter.name, expectedIcon);
    assert.ok(
      gutter.gutterRight <= gutter.lineNumberLeft + 1 &&
        gutter.lineNumberRight <= gutter.contentLeft + 1,
      `${side} editor gutters should be ordered arrow, line number, content: ${JSON.stringify(gutter)}`,
    );
    assert.equal(gutter.iconWidth, 15);
    assert.equal(gutter.iconHeight, 12);
    assert.equal(gutter.buttonMargin, "0px");
    assert.equal(gutter.buttonPadding, "0px");
    assert.equal(gutter.buttonBackground, "rgba(0, 0, 0, 0)");
    assert.equal(gutter.iconFill, "currentColor");
    assert.ok(gutter.iconPath, `${side} arrow should use a filled SVG icon`);
  }

  // Delay a real native response while a newer edit arrives.
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = async (input, options) => {
      if (decodeURIComponent(String(input)).includes("compare_text")) {
        window.fetch = fetch;
        document.documentElement.dataset.editRequest = "started";
        const response = await fetch(input, options);
        await new Promise((resolve) => setTimeout(resolve, 600));
        return response;
      }
      return fetch(input, options);
    };
  });
  await editor("Left").fill("obsolete\n");
  await page.waitForFunction(
    () => document.documentElement.dataset.editRequest === "started",
  );
  const latest = original.replace(/\r\n/g, "\n").replace("three", "threeY");
  await editor("Left").fill(latest);
  await regions(1);
  assert.equal(await editor("Left").locator(".diff-line").count(), 1);
  assert.equal(
    await editor("Left").locator(".diff-line").innerText(),
    "threeY",
  );
  await editor("Right").fill(
    original.replace(/\r\n/g, "\n").replace("three", "threeY"),
  );
  await regions(0);
  await editor("Left").fill(latest.replace("four\n", "inserted\nfour\n"));
  await regions(1);
  assert.ok(await workspace.locator(".alignment-gap").count());
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = async (input, options) => {
      if (decodeURIComponent(String(input)).includes("compare_text")) {
        window.fetch = fetch;
        document.documentElement.dataset.alignedEdit = "started";
        const response = await fetch(input, options);
        await new Promise((resolve) => setTimeout(resolve, 600));
        return response;
      }
      return fetch(input, options);
    };
  });
  await editor("Left").locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("Z");
  await page.waitForFunction(
    () => document.documentElement.dataset.alignedEdit === "started",
  );
  assert.ok(
    await workspace.locator(".alignment-gap").count(),
    "Typing must retain the prior alignment during refresh",
  );
  assert.equal(
    await workspace.locator(".copy-arrow").count(),
    0,
    "Stale ranges must not expose copy actions",
  );
  await regions(2);
  await workspace
    .getByRole("button", { name: "Undo left", exact: true })
    .click();
  await idle();
  await regions(1);
  await workspace
    .getByRole("button", { name: "Undo left", exact: true })
    .click();
  await idle();
  await regions(0);

  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) => {
      if (decodeURIComponent(String(input)).includes("compare_text")) {
        window.fetch = fetch;
        return Promise.resolve(
          new Response(JSON.stringify("Synthetic live compare failure"), {
            headers: {
              "Content-Type": "application/json",
              "Tauri-Response": "error",
            },
          }),
        );
      }
      return fetch(input, options);
    };
  });
  await editor("Left").fill("recoverable edit\n");
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic live compare failure" })
    .waitFor();
  assert.match(await editor("Left").innerText(), /recoverable edit/);
  assert.equal(await workspace.locator(".diff-line").count(), 0);
  await idle();
  await regions(1);

  await editor("Right").fill(original.replace(/\r\n/g, "\n"));
  await regions(1);
  await writeFile(left, "external\r\n");
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Recheck disk", exact: true })
    .click();
  const diskChanges = workspace.getByRole("dialog", {
    name: "Source files changed on disk",
    exact: true,
  });
  await diskChanges.waitFor();
  const stalePaneTops = await workspace
    .locator(".code-editor")
    .evaluateAll((editors) =>
      editors.map((editor) => editor.getBoundingClientRect().top),
    );
  assert.ok(
    Math.abs(stalePaneTops[0] - stalePaneTops[1]) <= 2,
    `Stale-file controls must not shift one editor pane: ${JSON.stringify(stalePaneTops)}`,
  );
  await diskChanges
    .getByRole("button", { name: "Compare left with Disk", exact: true })
    .click();
  await diskChanges.getByText("On disk", { exact: true }).waitFor();
  await diskChanges.getByText("external", { exact: true }).waitFor();
  await diskChanges
    .getByRole("button", { name: "Back to changed files", exact: true })
    .click();
  await diskChanges
    .getByRole("button", { name: "Keep left Draft", exact: true })
    .click();
  assert.match(await editor("Left").innerText(), /recoverable edit/);
  await workspace
    .getByRole("button", { name: "Save left", exact: true })
    .click();
  await workspace
    .getByRole("alert")
    .filter({ hasText: "File changed externally" })
    .waitFor();
  assert.equal(await readFile(left, "utf8"), "external\r\n");
  await workspace
    .getByRole("button", { name: "Review left disk change", exact: true })
    .click();
  await diskChanges
    .getByRole("button", { name: "Reload left from Disk", exact: true })
    .click();
  const discardDraft = page.getByRole("dialog", {
    name: "Confirm action",
    exact: true,
  });
  await discardDraft.waitFor();
  await discardDraft
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.match(await editor("Left").innerText(), /recoverable edit/);
  await diskChanges
    .getByRole("button", { name: "Reload left from Disk", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Confirm action", exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await idle();
  assert.match(await editor("Left").innerText(), /external/);
  await writeFile(left, original);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Recheck disk", exact: true })
    .click();
  await diskChanges.waitFor();
  await diskChanges
    .getByRole("button", { name: "Reload left from Disk", exact: true })
    .click();
  await idle();
  await regions(0);
  assert.match(await editor("Left").innerText(), /three/);

  const document = await call("open_document", { path: left, encoding: null });
  try {
    const restored = await call("compare_text", {
      left: original.replace(/\r\n/g, "\n").replace("three", "threeX"),
      right: original,
      documents: { left: document.id, right: null },
      jobId: crypto.randomUUID(),
      options: {
        ignoreCase: false,
        ignoreWhitespace: false,
        ignoreLineEndings: false,
        patterns: [],
      },
    });
    assert.deepEqual(
      restored
        .filter((span) => span.kind !== "equal")
        .map((span) => [span.leftStart, span.leftEnd]),
      [[2, 3]],
    );
    const actualEolDifference = await call("compare_text", {
      left: original,
      right: original.replace(/\r\n/g, "\n"),
      jobId: crypto.randomUUID(),
      options: {
        ignoreCase: false,
        ignoreWhitespace: false,
        ignoreLineEndings: false,
        patterns: [],
      },
    });
    assert.ok(
      actualEolDifference.some((span) => span.kind !== "equal"),
      "Real EOL differences must remain significant",
    );
    for (const [index, text] of [
      "one\rtwo\rthree\rfour\r",
      "one\r\ntwo\nthree\rfour\r\n",
    ].entries()) {
      const path = join(root, `endings-${index}.txt`);
      await writeFile(path, text);
      const mixed = await call("open_document", { path, encoding: null });
      try {
        const result = await call("compare_text", {
          left: text.replace(/\r\n|\r/g, "\n").replace("three", "threeX"),
          right: text,
          documents: { left: mixed.id, right: null },
          jobId: crypto.randomUUID(),
          options: {
            ignoreCase: false,
            ignoreWhitespace: false,
            ignoreLineEndings: false,
            patterns: [],
          },
        });
        assert.deepEqual(
          result
            .filter((span) => span.kind !== "equal")
            .map((span) => [span.leftStart, span.leftEnd]),
          [[2, 3]],
        );
        assert.equal(await readFile(path, "utf8"), text);
      } finally {
        await call("close_document", { id: mixed.id });
      }
    }
    await assert.rejects(
      call("compare_text", {
        left: "draft",
        right: "draft",
        documents: { left: "closed-document", right: null },
        jobId: crypto.randomUUID(),
        options: {
          ignoreCase: false,
          ignoreWhitespace: false,
          ignoreLineEndings: false,
          patterns: [],
        },
      }),
      /Document is closed/,
    );
  } finally {
    await call("close_document", { id: document.id });
  }
  assert.equal(await readFile(left, "utf8"), original);
  assert.equal(await readFile(right, "utf8"), original);
  assert.deepEqual(errors, []);
  console.log(
    "Native editing regression passed: search/replace/Undo/Redo, line navigation, live comparison, explicit disk recheck, Compare with Disk, Keep Draft, confirmed Reload, and unchanged source files.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
