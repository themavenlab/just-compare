import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-inspector-"));
const config = join(root, "config");
let session;
try {
  await mkdir(config);
  session = await launchNative(config);
  let page = session.page;
  const workspace = () => page.locator('.workspace-slot[aria-hidden="false"]');
  const inspector = () =>
    workspace().getByRole("region", {
      name: "Line-by-line detail",
      exact: true,
    });
  const editor = (side) =>
    workspace().getByRole("textbox", { name: `${side} text`, exact: true });
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-comparisons button")?.disabled,
    );
  await selectWorkspace(page, "text");
  await editor("Left").locator(".cm-line").first().waitFor();
  const left =
    "equal\nalpha café\t x\nbeta " + "a".repeat(800) + "\nremoved\nend\n";
  const right = "equal\nALPHA cafe\t y\nBETA " + "b".repeat(800) + "\nend\n";
  await editor("Left").fill(left);
  await editor("Right").fill(right);
  await inspector().locator("mark").first().waitFor();
  await idle();
  const originalLeft = await editor("Left").innerText();
  const originalRight = await editor("Right").innerText();
  assert.match(await inspector().textContent(), /Left 2/);
  async function assertAlignedStarts() {
    const starts = await inspector()
      .locator("pre")
      .evaluateAll((lines) =>
        lines.map((line) => {
          const range = document.createRange();
          range.selectNodeContents(line);
          return range.getBoundingClientRect().x;
        }),
      );
    assert.equal(starts.length, 2);
    assert.ok(
      Math.abs(starts[0] - starts[1]) <= 1,
      `Source text must start at the same column: ${starts}`,
    );
    assert.equal(await inspector().locator(".inspector-source").count(), 2);
    assert.equal(await inspector().locator(".line-coordinates").count(), 0);
  }
  await assertAlignedStarts();
  await inspector()
    .getByRole("button", { name: "Next detail line", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".line-inspector pre")
      ?.textContent?.includes("beta "),
  );
  assert.ok(await inspector().locator("mark").count());
  assert.ok(
    await inspector()
      .locator(".line-inspector-content")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  );
  await inspector()
    .getByRole("button", { name: "Next detail line", exact: true })
    .click();
  await inspector()
    .getByText("Right (missing line)", { exact: true })
    .waitFor();
  const boxes = await inspector()
    .locator("pre")
    .evaluateAll((lines) =>
      lines.map((line) => line.getBoundingClientRect().x),
    );
  assert.ok(
    Math.abs(boxes[0] - boxes[1]) <= 1,
    "Missing-line labels must not shift the source column",
  );
  assert.equal(await editor("Left").innerText(), originalLeft);
  assert.equal(await editor("Right").innerText(), originalRight);
  // Caret selection updates detail without taking focus from the editor.
  await editor("Left").locator(".cm-line").first().click();
  await page.waitForFunction(
    () =>
      document.querySelector(".line-inspector .inspector-source")
        ?.textContent === "Left 1",
  );
  await inspector()
    .locator("pre")
    .first()
    .filter({ hasText: "equal" })
    .waitFor();
  await assertAlignedStarts();
  assert.equal(
    await editor("Left").evaluate(
      (element) => element === document.activeElement,
    ),
    true,
  );
  await inspector()
    .getByLabel("Detail height", { exact: true })
    .selectOption("220");
  await idle();
  assert.equal((await session.call("read_settings")).lineDetail.height, 220);
  await inspector()
    .getByRole("button", { name: "Collapse line detail", exact: true })
    .click();
  await idle();
  assert.equal(await inspector().locator("pre").count(), 0);
  await inspector()
    .getByRole("button", { name: "Expand line detail", exact: true })
    .click();
  await idle();
  await editor("Left").fill("edited\n");
  await workspace()
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  assert.equal(await inspector().locator("pre").count(), 2);
  await workspace()
    .getByRole("button", { name: "Undo left", exact: true })
    .click();
  await idle();
  await inspector().locator("pre").first().waitFor();
  await workspace()
    .getByRole("button", { name: "Copy region to right", exact: true })
    .click();
  await idle();
  await inspector().locator("pre").first().waitFor();
  await inspector()
    .getByRole("button", { name: "Collapse line detail", exact: true })
    .click();
  await idle();
  await session.close();
  session = await launchNative(config);
  page = session.page;
  await selectWorkspace(page, "text");
  await inspector()
    .getByRole("button", { name: "Expand line detail", exact: true })
    .waitFor();
  const settings = await session.call("read_settings");
  assert.deepEqual(settings.lineDetail, { collapsed: true, height: 220 });
  assert.ok(!JSON.stringify(settings).includes("café"));
  console.log(
    "Native inspector regression passed: multiline, missing lines, Unicode/tabs/long lines, caret/focus, read-only detail, invalidation, Undo/copy refresh and persisted layout.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
