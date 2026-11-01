import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export async function selectWorkspace(page, mode) {
  const kind = { text: "Text", folder: "Folder", merge: "Merge" }[mode];
  if (!kind) throw new Error(`Unsupported test workspace: ${mode}`);
  const tabs = page.locator(".tab").filter({
    has: page.locator(".tab-kind", { hasText: new RegExp(`^${kind}$`) }),
  });
  if (await tabs.count()) await tabs.last().getByRole("tab").click();
  else
    await page
      .locator(".new-comparisons")
      .getByRole("button", {
        name: {
          text: "Text Compare",
          folder: "Folder Compare",
          merge: "3-Way Merge",
        }[mode],
        exact: true,
      })
      .click();
}

export async function togglePanel(page, panel) {
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  if (panel === "sessions") {
    const dialog = page.getByRole("dialog", {
      name: "Saved Sessions",
      exact: true,
    });
    if (await dialog.count())
      await dialog
        .getByRole("button", { name: "Close Saved Sessions", exact: true })
        .click();
    else {
      await page.getByRole("button", { name: "Session", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Saved Sessions...", exact: true })
        .click();
    }
    return;
  }
  if (
    panel === "rules" &&
    (await workspace.locator(".folder-workspace").count())
  ) {
    const dialog = page.getByRole("dialog", {
      name: "Session Settings - Folder Compare",
      exact: true,
    });
    if (await dialog.count()) {
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    } else
      await workspace
        .getByRole("button", { name: "Rules", exact: true })
        .click();
    return;
  }
  const element = workspace.locator(`[data-panel="${panel}"]`);
  if ((await element.getAttribute("open")) !== null) {
    await element.locator(":scope > summary").click();
    return;
  }

  const menu = "View";
  const command = {
    preferences: "Preferences",
    details: "Aligned view and range details",
    rules: "Comparison rules",
  }[panel];
  if (!command) throw new Error(`Unsupported test panel: ${panel}`);
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: command, exact: true }).click();
}

export async function previewUpdate(page) {
  const workspace = page.locator('.workspace-slot[aria-hidden="false"]');
  await workspace
    .getByRole("button", { name: "Copy options", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Preview update left to right",
      exact: true,
    })
    .click();
}

export async function launchNative(config, args = [], options = {}) {
  if (process.platform !== "win32")
    throw new Error("Native harness requires Windows WebView2.");
  const executable =
    options.desktop ??
    process.env.COMPARE_TEST_DESKTOP ??
    fileURLToPath(
      new URL("../src-tauri/target/debug/compare-desktop.exe", import.meta.url),
    );
  await access(executable);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to allocate debug port.");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const app = spawn(options.launcher ?? executable, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      COMPARE_TEST_CONFIG: config,
      COMPARE_DESKTOP: executable,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupError;
  let stderr = "";
  app.on("error", (error) => {
    startupError = error;
  });
  app.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const exited = once(app, "exit");
  let browser;
  const close = async () => {
    if (browser) await browser.close();
    if (app.exitCode === null && app.pid) {
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `
        $processes = Get-CimInstance Win32_Process;
        function Stop-OwnedTree([int] $owner) {
          foreach ($child in $processes | Where-Object { $_.ParentProcessId -eq $owner }) { Stop-OwnedTree $child.ProcessId }
          try { Stop-Process -Id $owner -ErrorAction Stop }
          catch { if (Get-CimInstance Win32_Process -Filter "ProcessId = $owner") { throw } }
        }
        Stop-OwnedTree ${app.pid}
      `,
      ]);
      await Promise.race([exited, delay(5000)]);
    }
  };
  try {
    let ready = false;
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startupError) throw startupError;
      if (app.exitCode !== null)
        throw new Error(`App exited ${app.exitCode}: ${stderr}`);
      try {
        const response = await fetch(`${endpoint}/json/version`, {
          signal: AbortSignal.timeout(500),
        });
        if (!response.ok) throw new Error(`CDP returned ${response.status}`);
        ready = true;
        break;
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    if (!ready)
      throw new Error(`Native WebView did not become ready: ${stderr}`, {
        cause: lastError,
      });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Native browser context missing.");
    const page =
      context.pages()[0] ??
      (await context.waitForEvent("page", { timeout: 15000 }));
    page.on("pageerror", (error) =>
      console.error("Native renderer error:", error.message),
    );
    await page
      .getByRole("heading", { name: "Just Compare", exact: true })
      .waitFor({ state: "attached" });
    const call = (command, args = {}) =>
      page.evaluate(
        ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
        { command, args },
      );
    return {
      page,
      call,
      pid: app.pid,
      close,
      waitExit: async () => {
        const timeout = delay(15000, undefined, { ref: false }).then(() => {
          throw new Error("Native process did not exit.");
        });
        const [code] = await Promise.race([exited, timeout]);
        return code;
      },
      destroy: async () => {
        try {
          await call("plugin:window|destroy", { label: "main" });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes(
              "Target page, context or browser has been closed",
            )
          )
            throw error;
        }
      },
      respondToDialog: async (buttonName) => {
        if (!["Confirm", "Cancel"].includes(buttonName))
          throw new Error("Unsupported workbench dialog response.");
        const dialog = page.getByRole("dialog", {
          name: "Confirm action",
          exact: true,
        });
        await dialog.waitFor();
        const message = await dialog.innerText();
        await dialog
          .getByRole("button", { name: buttonName, exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
        return message;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
