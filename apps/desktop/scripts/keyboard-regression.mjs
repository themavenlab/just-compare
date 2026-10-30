import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-keyboard-"));
let session;
try {
  const config = join(root, "config");
  await mkdir(config);
  session = await launchNative(config);
  const { page } = session;
  page.setDefaultTimeout(12000);
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
      .getByRole("button", { name: "Compare", exact: true })
      .click();
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
  await page.keyboard.press("Control+r");
  await waitForContent(
    "Right",
    "same\nleft first\nleft continuation\nmiddle\nright second\n",
  );
  await workspace.getByText(/Copied to right draft/).waitFor();
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
  assert.match(
    await page.locator(".shell-message[role='status']").innerText(),
    /F3 \/ Shift\+F3.*Ctrl\+N \/ Ctrl\+P.*Ctrl\+T.*F6/,
  );
  assert.equal(await page.locator(".shell-message[role='alert']").count(), 0);
  console.log(
    "PASS: new-tab chooser, difference navigation, whole-side and line copy, F3 search navigation, F5 compare, F6 pane focus and shortcut help.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
