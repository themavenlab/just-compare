import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-recovery-"));
const config = join(root, "config");
const recoveryFile = join(config, "draft-recovery.json");
const leftPath = join(root, "left.txt");
const rightPath = join(root, "right.txt");
const basePath = join(root, "base.txt");
const mergeLeftPath = join(root, "merge-left.txt");
const mergeRightPath = join(root, "merge-right.txt");
let session;

async function waitForRecords(expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const store = JSON.parse(await readFile(recoveryFile, "utf8"));
      assert.equal(store.version, 1);
      if (store.records.length === expected) return store.records;
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${expected} draft recovery records.`);
}

async function confirm(page) {
  const dialog = page.getByRole("dialog", {
    name: "Confirm action",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function expectNoRecoveryFile() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await readFile(recoveryFile);
    } catch (failure) {
      if (failure.code === "ENOENT") return;
      throw failure;
    }
    await delay(100);
  }
  assert.fail("Draft recovery storage was not removed.");
}

async function waitForRecoverySetting(session, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const enabled = (await session.call("read_settings")).recoverDrafts;
    if (enabled === expected) return;
    await delay(100);
  }
  assert.equal((await session.call("read_settings")).recoverDrafts, expected);
}

try {
  await mkdir(config);
  await writeFile(leftPath, "source left\n");
  await writeFile(rightPath, "source right\n");
  await writeFile(basePath, "same\nbase\nend\n");
  await writeFile(mergeLeftPath, "same\nleft\nend\n");
  await writeFile(mergeRightPath, "same\nright\nend\n");
  session = await launchNative(config);
  let page = session.page;
  const checkbox = () =>
    page.getByRole("checkbox", {
      name: "Keep unsaved drafts for up to 7 days",
      exact: true,
    });
  await checkbox().click();
  await confirm(page);
  await waitForRecoverySetting(session, true);

  await selectWorkspace(page, "text");
  let workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const editor = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-tab-button")?.disabled,
    );
  for (const [side, path] of [
    ["left", leftPath],
    ["right", rightPath],
  ]) {
    await workspace
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(path);
    await workspace
      .getByRole("button", { name: `Open ${side}`, exact: true })
      .click();
    await idle();
  }
  const draftLeft = "unsaved left draft\n";
  const draftRight = "unsaved right draft\n";
  await editor("Left").fill(draftLeft);
  await editor("Right").fill(draftRight);
  const [saved] = await waitForRecords(1);
  assert.ok(saved.leftPath.endsWith("\\left.txt"));
  assert.ok(saved.rightPath.endsWith("\\right.txt"));
  assert.equal(saved.leftText, draftLeft);
  assert.equal(saved.rightText, draftRight);

  await session.close();
  session = await launchNative(config);
  page = session.page;
  assert.equal(
    await page.locator('.workspace-slot[aria-hidden="false"]').count(),
    0,
    "Recovery data must not automatically reopen a private workspace.",
  );
  const recoveryRow = page.locator(".recovery-item").filter({
    hasText: "left.txt / right.txt",
  });
  await recoveryRow.getByRole("button", { name: "Restore draft" }).click();
  workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const restoredEditor = (side) =>
    workspace.getByRole("textbox", { name: `${side} text`, exact: true });
  await restoredEditor("Left").waitFor();
  assert.equal(
    (await restoredEditor("Left").innerText()).trimEnd(),
    draftLeft.trimEnd(),
  );
  assert.equal(
    (await restoredEditor("Right").innerText()).trimEnd(),
    draftRight.trimEnd(),
  );
  assert.equal(await readFile(leftPath, "utf8"), "source left\n");
  assert.equal(await readFile(rightPath, "utf8"), "source right\n");

  await page.getByRole("button", { name: /^Close / }).click();
  await confirm(page);
  await expectNoRecoveryFile();

  await selectWorkspace(page, "text");
  workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  await workspace
    .getByRole("textbox", { name: "Left text", exact: true })
    .fill("draft to discard\n");
  await waitForRecords(1);
  await session.close();
  session = await launchNative(config);
  page = session.page;
  const discardRow = page.locator(".recovery-item");
  await discardRow
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await confirm(page);
  await expectNoRecoveryFile();

  await selectWorkspace(page, "merge");
  workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  for (const [side, path] of [
    ["base", basePath],
    ["left", mergeLeftPath],
    ["right", mergeRightPath],
  ]) {
    await workspace
      .getByRole("combobox", { name: `${side} path`, exact: true })
      .fill(path);
    await workspace
      .getByRole("button", { name: `Open ${side}`, exact: true })
      .click();
    await idle();
  }
  await workspace
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "1 unresolved conflicts", exact: true })
    .waitFor();
  await workspace
    .getByRole("button", { name: "Use left 1", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "0 unresolved conflicts", exact: true })
    .waitFor();
  const mergeOutput = "manually edited recovered output\n";
  await workspace
    .getByRole("textbox", { name: "Merge output", exact: true })
    .fill(mergeOutput);
  const [mergeRecovery] = await waitForRecords(1);
  assert.equal(mergeRecovery.mode, "merge");
  assert.ok(Object.keys(mergeRecovery.choices).length > 0);
  assert.equal(mergeRecovery.output, mergeOutput);

  await session.close();
  session = await launchNative(config);
  page = session.page;
  const mergeRow = page.locator(".recovery-item").filter({
    hasText: "merge-left.txt / merge-right.txt",
  });
  await mergeRow.getByRole("button", { name: "Restore draft" }).click();
  workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  await workspace
    .getByRole("heading", { name: "0 unresolved conflicts", exact: true })
    .waitFor();
  assert.match(
    await workspace.locator(".conflict h3").innerText(),
    /Conflict 1 \(resolved\)/,
  );
  assert.equal(
    (
      await workspace
        .getByRole("textbox", { name: "Merge output", exact: true })
        .innerText()
    ).trimEnd(),
    mergeOutput.trimEnd(),
  );
  assert.equal(await readFile(basePath, "utf8"), "same\nbase\nend\n");
  assert.equal(await readFile(mergeLeftPath, "utf8"), "same\nleft\nend\n");
  assert.equal(await readFile(mergeRightPath, "utf8"), "same\nright\nend\n");
  await page.getByRole("button", { name: /^Close / }).click();
  await confirm(page);
  await expectNoRecoveryFile();

  await checkbox().click();
  await confirm(page);
  await waitForRecoverySetting(session, false);
  await assert.rejects(
    session.call("load_recoveries"),
    /Draft recovery is disabled/,
  );

  await checkbox().click();
  await confirm(page);
  await waitForRecoverySetting(session, true);
  await selectWorkspace(page, "text");
  workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  const closeDraft = "graceful close draft\n";
  await workspace
    .getByRole("textbox", { name: "Left text", exact: true })
    .fill(closeDraft);
  await session.call("plugin:window|close", { label: "main" });
  await page
    .getByRole("dialog", { name: "Confirm action", exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  assert.equal(await session.waitExit(), 0);
  await session.close();
  session = null;
  const [closedRecovery] = await waitForRecords(1);
  assert.equal(closedRecovery.leftText, closeDraft);

  session = await launchNative(config);
  page = session.page;
  assert.equal(await page.locator(".recovery-item").count(), 1);
  console.log(
    "Native draft recovery, restart, restore, discard, and close checks passed.",
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true, force: true });
}
