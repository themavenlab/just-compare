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
      () => !document.querySelector(".new-comparisons button")?.disabled,
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
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await regions(0);
  await idle();
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
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await idle();
  await regions(1);
  assert.equal(await editor("Right").locator(".diff-line").count(), 1);

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
  await workspace.getByRole("button", { name: "Compare", exact: true }).click();
  await idle();
  await regions(1);

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
    "Native editing regression passed: live typing, localized CRLF differences, manual recompare, superseded responses, insertion alignment, Undo, explicit errors, original EOL significance and read-only sources.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
