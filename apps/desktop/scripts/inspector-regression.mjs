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
      () => !document.querySelector(".new-tab-button")?.disabled,
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
  // Only the stacked line pair, copy and collapse controls remain.
  for (const name of ["Next detail line", "Previous detail line"])
    assert.equal(await inspector().getByRole("button", { name }).count(), 0);
  assert.equal(await inspector().getByLabel("Detail height").count(), 0);
  await editor("Left")
    .locator(".cm-line")
    .nth(2)
    .click({ position: { x: 5, y: 5 } });
  await page.waitForFunction(() =>
    document
      .querySelector(".line-inspector pre")
      ?.textContent?.includes("beta "),
  );
  assert.ok(await inspector().locator("mark").count());
  const content = await inspector()
    .locator(".line-inspector-content")
    .evaluate((element) => {
      const lines = [...element.querySelectorAll("pre")].map(
        (line) => line.getBoundingClientRect().height,
      );
      return {
        height: element.getBoundingClientRect().height,
        lines,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      };
    });
  assert.ok(content.scrollWidth > content.clientWidth, JSON.stringify(content));
  assert.ok(
    content.height <= content.lines[0] + content.lines[1] + 40,
    `Line detail must fit its two lines: ${JSON.stringify(content)}`,
  );
  assert.ok(
    content.scrollHeight <= content.clientHeight + 1,
    JSON.stringify(content),
  );
  assert.equal(content.overflowY, "hidden");
  await editor("Left")
    .locator(".cm-line")
    .nth(3)
    .click({ position: { x: 5, y: 5 } });
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
    .getByRole("button", { name: "Collapse line detail", exact: true })
    .click();
  await idle();
  assert.equal(await inspector().locator("pre").count(), 0);
  assert.deepEqual((await session.call("read_settings")).lineDetail, {
    collapsed: true,
    height: 140,
  });
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
  // A clicked tool keeps focus, but its tooltip must follow hover only.
  const allButton = workspace().getByRole("button", {
    name: "All",
    exact: true,
  });
  const tooltipVisibility = () =>
    allButton.evaluate((button) => {
      const tip = button.parentElement.querySelector(".tool-tooltip");
      return [
        document.activeElement === button,
        getComputedStyle(tip).visibility,
      ];
    });
  await allButton.click();
  await page.waitForTimeout(600);
  assert.deepEqual(await tooltipVisibility(), [true, "visible"]);
  const away = await editor("Right").boundingBox();
  await page.mouse.move(away.x + away.width / 2, away.y + away.height / 2);
  await page.waitForTimeout(200);
  assert.deepEqual(await tooltipVisibility(), [true, "hidden"]);
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
  assert.deepEqual(settings.lineDetail, { collapsed: true, height: 140 });
  assert.ok(!JSON.stringify(settings).includes("café"));
  console.log(
    "Native inspector regression passed: multiline, missing lines, Unicode/tabs/long lines, caret/focus, read-only detail, invalidation, Undo/copy refresh, two-line compact panel, hover-only tooltips and persisted layout.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
