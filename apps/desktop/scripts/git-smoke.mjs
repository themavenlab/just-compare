import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchNative } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-git-"));
const config = join(root, "config");
await mkdir(config);
const base = join(root, "base.txt"),
  left = join(root, "left.txt"),
  right = join(root, "right.txt"),
  output = join(root, "output.txt");
await writeFile(base, "a\nb\n");
await writeFile(left, "A\nb\n");
await writeFile(right, "a\nB\n");
await writeFile(output, "a\nb\n");
let session;
const cli = fileURLToPath(
  new URL("../../../target/debug/compare.exe", import.meta.url),
);
try {
  session = await launchNative(
    config,
    ["git-merge", base, left, right, output],
    { launcher: cli },
  );
  await assert.rejects(
    session.call("finish_git_merge", { success: true }),
    /Save resolved output/,
  );
  await session.page
    .getByRole("textbox", { name: "Base text", exact: true })
    .waitFor();
  // Wait for startup documents; the IPC call also checks initialization error behavior.
  await session.page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  await session.page
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await session.page
    .getByRole("heading", { name: "0 unresolved conflicts", exact: true })
    .waitFor();
  await session.page
    .getByRole("button", { name: "Save merge output", exact: true })
    .click();
  assert.equal(await session.waitExit(), 0);
  assert.equal(await readFile(output, "utf8"), "A\nB\n");
  await session.close();
  session = null;
  session = await launchNative(
    config,
    ["git-merge", base, left, right, output],
    { launcher: cli },
  );
  await session.page
    .getByRole("textbox", { name: "Base text", exact: true })
    .waitFor();
  await session.destroy();
  assert.equal(await session.waitExit(), 1);
  await session.close();
  session = null;
  session = await launchNative(config, ["git-diff", left, right], {
    launcher: cli,
  });
  await session.page
    .getByRole("button", { name: "Compare", exact: true })
    .waitFor();
  await session.destroy();
  assert.equal(await session.waitExit(), 0);
  await session.close();
  session = null;
  const newOutput = join(root, "new-output.txt");
  session = await launchNative(
    config,
    ["git-merge", base, left, right, newOutput],
    { launcher: cli },
  );
  await session.page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  await session.page
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await session.page
    .getByRole("heading", { name: "0 unresolved conflicts", exact: true })
    .waitFor();
  await session.page
    .getByRole("button", { name: "Save merge output", exact: true })
    .click();
  assert.equal(await session.waitExit(), 0);
  assert.equal(await readFile(newOutput, "utf8"), "A\nB\n");
  await session.close();
  session = null;
  await writeFile(left, "L\n");
  await writeFile(right, "R\n");
  await writeFile(base, "a\n");
  session = await launchNative(
    config,
    ["git-merge", base, left, right, output],
    { launcher: cli },
  );
  await session.page
    .getByText("UTF-8 draft", { exact: false })
    .last()
    .waitFor({ state: "hidden" });
  await session.page
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await session.page
    .getByRole("heading", { name: "1 unresolved conflicts", exact: true })
    .waitFor();
  assert.equal(
    await session.page
      .getByRole("button", { name: "Save merge output", exact: true })
      .isDisabled(),
    true,
  );
  const outputDocument = await session.call("open_git_output");
  await assert.rejects(
    session.call("finish_git_merge", {
      success: true,
      outputId: outputDocument.id,
      resolutions: [null],
    }),
    /Resolve every conflict/,
  );
  await session.page
    .getByRole("button", { name: "Use left 1", exact: true })
    .click();
  await session.page
    .getByRole("heading", { name: "0 unresolved conflicts", exact: true })
    .waitFor();
  await session.page
    .getByRole("button", { name: "Save merge output", exact: true })
    .click();
  assert.equal(await session.waitExit(), 0);
  assert.equal(await readFile(output, "utf8"), "L\n");
  console.log(
    "PASS: Git merge waits, saves resolved output, exits 0; cancellation exits 1; Git diff closes with 0.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true });
}
