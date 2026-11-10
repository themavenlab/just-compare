import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchNative,
  openWorkspace,
  selectWorkspace,
} from "./native-harness.mjs";

const fixture = await mkdtemp(join(tmpdir(), "preview-map-regression-"));
const config = join(fixture, "config");
const leftA = join(fixture, "left-a");
const rightA = join(fixture, "right-a");
const leftB = join(fixture, "left-b");
const rightB = join(fixture, "right-b");
await Promise.all([
  mkdir(config),
  mkdir(leftA),
  mkdir(rightA),
  mkdir(leftB),
  mkdir(rightB),
]);

let session;
try {
  session = await launchNative(config);
  const { page, call } = session;
  await selectWorkspace(page, "folder");
  const scanCurrentWorkspace = async (left, right) => {
    const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
    await workspace
      .getByRole("combobox", { name: "left path", exact: true })
      .fill(left);
    await workspace
      .getByRole("combobox", { name: "right path", exact: true })
      .fill(right);
    await workspace
      .getByRole("button", { name: "Scan folders", exact: true })
      .click();
    await workspace
      .locator(".status-bar")
      .getByText("Scan complete:", { exact: false })
      .waitFor();
  };
  await scanCurrentWorkspace(leftA, rightA);
  const tabA = await page
    .getByRole("tab", { selected: true })
    .getAttribute("id");
  const previewA = await call("preview_local_action", {
    request: { kind: "createDirectory", parent: leftA, name: "created-a" },
    jobId: "preview-tab-a",
  });

  await openWorkspace(page, "folder");
  await scanCurrentWorkspace(leftB, rightB);
  const previewB = await call("preview_local_action", {
    request: { kind: "createDirectory", parent: leftB, name: "created-b" },
    jobId: "preview-tab-b",
  });

  await page.locator(`#${tabA}`).click();
  const outcomesA = await call("execute_local_action", {
    id: previewA.id,
    jobId: "execute-tab-a",
  });
  assert.equal(outcomesA[0].result.status, "completed");
  await access(join(leftA, "created-a"));

  const outcomesB = await call("execute_local_action", {
    id: previewB.id,
    jobId: "execute-tab-b",
  });
  assert.equal(outcomesB[0].result.status, "completed");
  await access(join(leftB, "created-b"));
} finally {
  if (session) await session.close();
  await rm(fixture, { recursive: true, force: true });
}

console.log("Per-tab native preview map regression passed.");
