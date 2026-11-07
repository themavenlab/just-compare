import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productName } from "./app-config.mjs";
import { launchNative } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-keyboard-"));
let session;
try {
  const config = join(root, "config");
  await mkdir(config);
  session = await launchNative(config);
  const { page } = session;
  page.setDefaultTimeout(12000);
  await page.waitForFunction(() => {
    const button = document.querySelector(
      'button[aria-label="New comparison"]',
    );
    return button && !button.disabled;
  });
  await page.keyboard.press("Control+t");
  const chooser = page.getByRole("dialog", { name: "New comparison" });
  await chooser.waitFor();
  await chooser.getByRole("button", { name: "New Text Compare" }).click();

  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const editor = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  async function waitForContent(side, expected) {
    try {
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
    } catch (failure) {
      const actual = await editor(side)
        .locator(".cm-line")
        .allTextContents()
        .catch(() => []);
      const notice = await page
        .locator('[role="status"]')
        .allTextContents()
        .catch(() => []);
      throw new Error(
        `Expected ${side} content ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; status: ${JSON.stringify(notice)}`,
        { cause: failure },
      );
    }
  }
  async function compare() {
    await workspace
      .getByRole("heading", { name: "2 changed regions" })
      .waitFor();
  }
  const left = "same\nleft first\nleft continuation\nmiddle\nleft second\n";
  const right = "same\nxxxx first\nxxxx continuation\nmiddle\nright second\n";
  await editor("Left").fill(left);
  await editor("Right").fill(right);
  await compare();

  await editor("Left").click();
  await page.keyboard.press("Control+n");
  await workspace.getByText("2 / 2 differences", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const line = window
      .getSelection()
      ?.anchorNode?.parentElement?.closest(".cm-line");
    return (
      document.activeElement?.getAttribute("aria-label") === "Left text" &&
      line?.textContent === "left second"
    );
  });
  await page.keyboard.press("Control+p");
  await workspace.getByText("1 / 2 differences", { exact: true }).waitFor();
  await page.keyboard.press("Control+n");
  await workspace.getByText("2 / 2 differences", { exact: true }).waitFor();
  await page.keyboard.press("Control+r");
  await waitForContent(
    "Right",
    "same\nxxxx first\nxxxx continuation\nmiddle\nleft second\n",
  );
  await workspace.getByText(/Copied to right draft/).waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Left text",
  );
  assert.equal(
    await workspace.locator(".diff-selected").count(),
    0,
    "copy should not select a different region",
  );
  await page.waitForFunction(() => {
    const line = window
      .getSelection()
      ?.anchorNode?.parentElement?.closest(".cm-line");
    return line?.textContent === "left second";
  });
  await page.keyboard.press("Control+n");
  await workspace.getByText("1 / 1 differences", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const line = window
      .getSelection()
      ?.anchorNode?.parentElement?.closest(".cm-line");
    return line?.textContent === "left first";
  });
  await page.keyboard.press("Control+l");
  await waitForContent(
    "Left",
    "same\nxxxx first\nxxxx continuation\nmiddle\nleft second\n",
  );
  await workspace.getByText(/Copied to left draft/).waitFor();

  await editor("Left").fill(left);
  await editor("Right").fill(right);
  await compare();
  await editor("Left").click();
  await page.keyboard.press("Control+r");
  await waitForContent(
    "Right",
    "same\nleft first\nleft continuation\nmiddle\nright second\n",
  );
  await workspace.getByText(/Copied to right draft/).waitFor();

  await editor("Left").fill(left);
  await editor("Right").fill(right);
  await compare();
  await workspace
    .getByRole("button", { name: "Copy detail line to right", exact: true })
    .waitFor();
  await workspace
    .getByRole("button", { name: "Copy detail line to right", exact: true })
    .click();
  await waitForContent(
    "Right",
    "same\nleft first\nxxxx continuation\nmiddle\nright second\n",
  );
  await workspace.getByText(/Copied to right draft/).waitFor();

  await editor("Left").fill(left);
  await editor("Right").fill(right);
  await compare();
  await workspace
    .locator(
      '.editor:has([aria-label="Left text"]) .cm-lineNumbers .cm-gutterElement',
    )
    .nth(2)
    .click();
  await workspace.locator(".copy-arrow.single-line-copy").waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Left text",
  );
  await page.keyboard.press("Control+r");
  await waitForContent(
    "Right",
    "same\nleft first\nxxxx continuation\nmiddle\nright second\n",
  );
  await workspace.getByText(/Copied to right draft/).waitFor();
  await editor("Left").locator(".cm-line").nth(2).click();
  await workspace.locator(".copy-arrow.single-line-copy").waitFor({
    state: "hidden",
  });
  await page.keyboard.press("Control+n");
  await workspace.getByText("1 / 2 differences", { exact: true }).waitFor();
  await page.keyboard.press("Control+r");
  await waitForContent(
    "Right",
    "same\nleft first\nleft continuation\nmiddle\nright second\n",
  );
  await workspace.getByText(/Copied to right draft/).waitFor();
  await page.keyboard.press("Control+n");
  await workspace.getByText("1 / 1 differences", { exact: true }).waitFor();
  await page.keyboard.press("Control+r");
  await waitForContent(
    "Right",
    "same\nleft first\nleft continuation\nmiddle\nleft second\n",
  );
  await workspace.getByText(/Copied to right draft/).waitFor();

  await editor("Left").click();
  await page.keyboard.press("F6");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Right text",
  );
  await page.keyboard.press("Control+f");
  const find = workspace.getByRole("textbox", {
    name: "Find text",
    exact: true,
  });
  await find.fill("same");
  await page.keyboard.press("F3");
  await workspace.getByText(/Match 1 of 2/).waitFor();
  await page.keyboard.press("F3");
  await workspace.getByText(/Match 2 of 2/).waitFor();
  await page.keyboard.press("Shift+F3");
  await workspace.getByText(/Match 1 of 2/).waitFor();

  await workspace
    .getByRole("button", { name: "Close Find and Replace", exact: true })
    .click();
  await editor("Left").click();
  await page.keyboard.press("F5");
  await workspace.getByText("No differences", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })
    .click();
  const help = page.getByRole("dialog", { name: "Help & About" });
  await help.waitFor();
  await help
    .getByRole("heading", { name: "Keyboard shortcuts", exact: true })
    .waitFor();
  const dialogHeight = await help.evaluate(
    (dialog) => dialog.getBoundingClientRect().height,
  );
  assert.match(await help.innerText(), /F3 \/ Shift\+F3/);
  assert.match(await help.innerText(), /Ctrl\+N \/ Ctrl\+P/);
  assert.equal(
    await page.locator(".shell-message[role='status']").count(),
    0,
    "help content should not use the top status banner",
  );
  await help
    .getByRole("button", { name: "Getting Started", exact: true })
    .click();
  await help
    .getByRole("heading", { name: "Getting Started", exact: true })
    .waitFor();
  assert.equal(
    await help.evaluate((dialog) => dialog.getBoundingClientRect().height),
    dialogHeight,
    "Help dialog height should not change between sections",
  );
  assert.match(await help.innerText(), /Text Compare/);
  assert.match(await help.innerText(), /Folder Compare/);
  assert.match(await help.innerText(), /3-Way Merge/);
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Getting Started", exact: true })
    .click();
  const gettingStarted = page.getByRole("dialog", { name: "Help & About" });
  await gettingStarted
    .getByRole("heading", { name: "Getting Started", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page
    .getByRole("menuitem", { name: `About ${productName}`, exact: true })
    .click();
  const about = page.getByRole("dialog", { name: "Help & About" });
  await about
    .getByRole("heading", { name: `About ${productName}`, exact: true })
    .waitFor();
  assert.match(await about.innerText(), /does not upload your files/);
  assert.match(await about.innerText(), /workbench from The Maven Lab/);
  await page.keyboard.press("Escape");
  for (const [label, expected] of [
    ["Report a bug", "Steps to reproduce with a synthetic example:"],
    ["Request a feature", "Current workaround:"],
  ]) {
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    const feedback = page.getByRole("dialog", { name: "Help & About" });
    await feedback.getByRole("heading", { name: label, exact: true }).waitFor();
    assert.match(await feedback.innerText(), /compare@themavenlab\.org/);
    assert.match(await feedback.innerText(), /Nothing is sent automatically/);
    assert.match(
      await feedback.innerText(),
      /Send security concerns privately/,
    );
    assert.ok((await feedback.locator("pre").innerText()).includes(expected));
    await feedback.getByRole("button", { name: "Copy email address" }).click();
    await feedback
      .getByRole("status")
      .filter({
        hasText: "Email address copied. Nothing was sent.",
      })
      .waitFor();
    async function verifyClipboard(expected) {
      await feedback.evaluate((dialog) => {
        const target = document.createElement("textarea");
        target.setAttribute("aria-label", "Synthetic clipboard verification");
        dialog.append(target);
        target.focus();
      });
      try {
        await page.keyboard.press("Control+v");
        await page.waitForFunction(
          (value) =>
            document.querySelector(
              '[aria-label="Synthetic clipboard verification"]',
            )?.value === value,
          expected,
        );
      } finally {
        await feedback
          .getByRole("textbox", { name: "Synthetic clipboard verification" })
          .evaluate((target) => target.remove());
      }
    }
    await verifyClipboard("compare@themavenlab.org");
    await feedback
      .getByRole("button", { name: "Copy report template" })
      .click();
    await feedback
      .getByRole("status")
      .filter({
        hasText: "Report template copied. Nothing was sent.",
      })
      .waitFor();
    await verifyClipboard(await feedback.locator("pre").innerText());
    await page.evaluate(() => {
      window.__originalClipboardWrite = navigator.clipboard.writeText;
      navigator.clipboard.writeText = () =>
        Promise.reject(new Error("Synthetic clipboard denial"));
    });
    try {
      for (const name of ["Copy email address", "Copy report template"]) {
        await feedback.getByRole("button", { name }).click();
        await feedback
          .getByRole("alert")
          .filter({ hasText: "Synthetic clipboard denial" })
          .waitFor();
        assert.equal(await feedback.getByRole("status").count(), 0);
        assert.match(await feedback.getByRole("alert").innerText(), /manually/);
      }
    } finally {
      await page.evaluate(() => {
        navigator.clipboard.writeText = window.__originalClipboardWrite;
        delete window.__originalClipboardWrite;
      });
    }
    if (label === "Report a bug") await page.keyboard.press("Escape");
    else
      await feedback
        .getByRole("button", { name: "Close Help & About" })
        .click();
    await feedback.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "Help", exact: true })
        .evaluate((button) => button === document.activeElement),
      true,
    );
  }
  assert.equal(await page.locator(".shell-message[role='alert']").count(), 0);
  console.log(
    "PASS: new-tab chooser, difference navigation, whole-side and line copy, F3 search navigation, F5 compare, F6 pane focus, Help sections and feedback copy success/failure.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
