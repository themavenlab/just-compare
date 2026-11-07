import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchNative, selectWorkspace } from "./native-harness.mjs";

const root = await mkdtemp(join(tmpdir(), "compare-explorer-"));
const config = join(root, "config");
const originalExecutable =
  process.env.COMPARE_TEST_DESKTOP ??
  fileURLToPath(
    new URL("../src-tauri/target/debug/just-compare.exe", import.meta.url),
  );
const executable = join(root, "program files café", "just-compare.exe");
let registeredExecutable = executable;
let session;
const launch = async (args, raw = false) => {
  const child = spawn(
    raw ? "powershell.exe" : executable,
    raw
      ? [
          "-NoProfile",
          "-Command",
          '$ErrorActionPreference = "Stop"; $child = Start-Process -FilePath $env:COMPARE_TEST_LAUNCH -ArgumentList $env:COMPARE_TEST_ARGUMENTS -PassThru -Wait; exit $child.ExitCode',
        ]
      : args,
    {
      env: {
        ...process.env,
        COMPARE_TEST_CONFIG: config,
        COMPARE_TEST_LAUNCH: registeredExecutable,
        COMPARE_TEST_ARGUMENTS: args[0] ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code] = await once(child, "exit");
    if (code !== 0) console.error("LAUNCH STDERR:", stderr);
    assert.equal(code, 0, "Secondary shell launch must deliver and exit");
  } finally {
    clearTimeout(timer);
  }
};
try {
  await mkdir(join(root, "program files café"));
  await copyFile(originalExecutable, executable);
  const left = join(root, "left & café %.txt"),
    right = join(root, "right & 日本語.txt");
  const leftFolder = join(root, "left folder"),
    rightFolder = join(root, "right folder");
  for (const directory of [config, leftFolder, rightFolder])
    await mkdir(directory);
  await writeFile(left, "left\tcafé\n");
  await writeFile(right, "right\t日本語\n");
  for (const directory of [leftFolder, rightFolder])
    await writeFile(join(directory, "file.txt"), directory);
  session = await launchNative(config, [], { desktop: executable });
  let page = session.page;
  const workspace = () => page.locator('.workspace-slot[aria-hidden="false"]');
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector(".new-tab-button")?.disabled,
    );
  const menu = async (name) => {
    await page
      .getByRole("button", { name: "Integration", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  assert.equal(
    await session.call("explorer_integration", { enabled: null }),
    false,
  );
  await menu("Enable Explorer commands...");
  await page
    .getByRole("dialog", { name: "Confirm action" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await idle();
  assert.equal(
    await session.call("explorer_integration", { enabled: null }),
    false,
  );
  await menu("Enable Explorer commands...");
  await page
    .getByRole("dialog", { name: "Confirm action" })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await idle();
  assert.equal(
    await session.call("explorer_integration", { enabled: null }),
    true,
  );
  const regQuery = (args) =>
    execFileSync(
      "cmd.exe",
      ["/d", "/s", "/c", `chcp 65001 >nul && reg.exe ${args.join(" ")}`],
      { encoding: "utf8" },
    );
  const registered = regQuery([
    "query",
    "HKCU\\Software\\JustCompare\\Tests",
    "/s",
    "/f",
    "shell-select",
    "/d",
  ]);
  const command = registered
    .split(/\r?\n/)
    .find(
      (line) => line.includes('shell-select "%1"') && line.includes("REG_SZ"),
    );
  assert.ok(
    command,
    "The isolated registry must contain the real quoted launch command",
  );
  const registeredCommand = command.match(/"([^"]+)" (shell-select "%1")/);
  assert.ok(registeredCommand);
  registeredExecutable = registeredCommand[1];
  const rawArguments = registeredCommand[2].replace("%1", left);
  assert.ok(
    !command.includes("\\\\?\\"),
    "Shell activation must not use a device path",
  );
  const readMenus = () => {
    const registry = regQuery([
      "query",
      "HKCU\\Software\\JustCompare\\Tests",
      "/s",
    ]);
    const blocks = registry.split(/\r?\n(?=HKEY_)/);
    return ["*", "Directory", "Directory\\Background"].map((type) => {
      const block = blocks.find((value) =>
        value
          .split(/\r?\n/)[0]
          .endsWith(`\\${type}\\shell\\JustCompare.compare`),
      );
      assert.ok(block);
      return { hidden: block.includes("LegacyDisable"), text: block };
    });
  };
  assert.deepEqual(
    readMenus().map((menu) => menu.hidden),
    [true, true, true],
  );
  await selectWorkspace(page, "text");
  const draft = workspace().getByRole("textbox", {
    name: "Left text",
    exact: true,
  });
  await draft.locator(".cm-line").first().waitFor();
  await draft.fill("unsaved original draft");
  await launch([rawArguments], true);
  assert.deepEqual(
    readMenus().map((menu) => menu.hidden),
    [false, true, true],
  );
  assert.equal(await page.getByRole("tab").count(), 1);
  assert.equal(await page.getByText(/Selected for Compare:/).count(), 0);
  assert.ok(readMenus()[0].text.includes("Compare to left && café %.txt"));
  await launch(["shell-compare", right]);
  await workspace()
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await idle();
  assert.equal(await page.getByRole("tab").count(), 2);
  assert.ok(
    (
      await workspace()
        .getByRole("combobox", { name: "left path", exact: true })
        .inputValue()
    ).endsWith("left & café %.txt"),
  );
  await page.getByRole("tab").first().click();
  assert.match(await draft.innerText(), /unsaved original draft/);
  await launch(["shell-compare", leftFolder]);
  await page
    .getByRole("alert")
    .filter({ hasText: "two files or two folders" })
    .waitFor();
  await launch(["shell-open", join(root, "missing")]);
  await page
    .getByRole("alert")
    .filter({ hasText: /cannot find|not find/i })
    .waitFor();
  await launch(["shell-select", leftFolder]);
  assert.deepEqual(
    readMenus().map((menu) => menu.hidden),
    [true, false, false],
  );
  assert.ok(readMenus()[1].text.includes("Compare to left folder"));
  // Empty folder space passes the open folder through %V.
  assert.ok(readMenus()[2].text.includes("Compare to left folder"));
  // Explorer omits background verbs that declare MultiSelectModel.
  assert.ok(!readMenus()[2].text.includes("MultiSelectModel"));
  assert.match(
    regQuery([
      "query",
      "HKCU\\Software\\JustCompare\\Tests",
      "/s",
      "/f",
      "%V",
      "/d",
    ]),
    /shell-compare "%V"/,
  );
  await launch(["shell-compare", rightFolder]);
  await workspace().locator('.folder-row[data-relative="file.txt"]').waitFor();
  await idle();
  assert.equal(await page.getByRole("tab").count(), 3);
  await launch(["shell-open", left]);
  await workspace()
    .getByRole("textbox", { name: "Left text", exact: true })
    .locator(".cm-line")
    .first()
    .waitFor();
  await idle();
  assert.equal(await page.getByRole("tab").count(), 4);
  await Promise.all(
    Array.from({ length: 3 }, () => launch(["shell-open", left])),
  );
  await page.waitForFunction(() => {
    const slots = [...document.querySelectorAll(".workspace-slot")];
    return (
      slots.length === 7 &&
      slots
        .slice(-3)
        .every((slot) =>
          slot
            .querySelector('.cm-content[aria-label="Left text"]')
            ?.textContent?.includes("left\tcafé"),
        )
    );
  });
  await idle();
  await session.call("clear_shell_selection");
  assert.deepEqual(
    readMenus().map((menu) => menu.hidden),
    [true, true, true],
  );
  await session.close();
  // Selection with no running app must exit without starting a window.
  await launch(["shell-select", left]);
  assert.match(
    await readFile(join(config, "shell-selection.json"), "utf8"),
    /left & café %\.txt/,
  );
  // Cold startup revalidates the persisted selection and automatically compares.
  session = await launchNative(config, ["shell-compare", right], {
    desktop: executable,
  });
  page = session.page;
  await workspace()
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await idle();
  // A Git/CLI waiting window receives later shell launches when it is the only window.
  await session.close();
  session = await launchNative(config, ["git-diff", left, right], {
    desktop: executable,
  });
  page = session.page;
  await workspace()
    .getByRole("heading", { name: "1 changed regions", exact: true })
    .waitFor();
  await idle();
  await launch(["shell-open", right]);
  await page.waitForFunction(
    () => document.querySelectorAll('[role="tab"]').length === 2,
  );
  await idle();
  // Waiting launches never forward their own arguments: Git must keep its process.
  const waitingGit = spawn(executable, ["git-diff", left, right], {
    env: {
      ...process.env,
      COMPARE_TEST_CONFIG: config,
      // The CDP-enabled primary's WebView2 profile cannot be shared with other options.
      WEBVIEW2_USER_DATA_FOLDER: join(root, "independent-webview"),
    },
    stdio: "ignore",
  });
  try {
    const exitedEarly = await Promise.race([
      once(waitingGit, "exit").then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.equal(exitedEarly, false, "Git launches must remain independent");
    assert.equal(await page.getByRole("tab").count(), 2);
  } finally {
    if (waitingGit.exitCode === null) waitingGit.kill();
  }
  await menu("Remove Explorer commands...");
  await page
    .getByRole("dialog", { name: "Confirm action" })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await idle();
  assert.equal(
    await session.call("explorer_integration", { enabled: null }),
    false,
  );
  await assert.rejects(
    session.call("shell_action", { args: ["shell-compare", right] }),
    /No selected path/,
  );
  assert.equal(await readFile(left, "utf8"), "left\tcafé\n");
  assert.equal(await readFile(right, "utf8"), "right\t日本語\n");
  console.log(
    "Native Explorer regression passed: opt-in/removal, isolated registry, real secondary-process handoff, Unicode/metacharacters, files/folders, dirty tabs, invalid inputs, cold restart and selection cleanup.",
  );
} finally {
  if (session) {
    try {
      await session.call("explorer_integration", { enabled: false });
    } finally {
      await session.close();
    }
  }
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
