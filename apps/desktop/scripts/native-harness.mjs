import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export async function launchNative(config, args = [], options = {}) {
  if (process.platform !== "win32")
    throw new Error("Native harness requires Windows WebView2.");
  const executable =
    options.desktop ??
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
    await page
      .getByRole("heading", { name: "Just Compare", exact: true })
      .waitFor();
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
    };
  } catch (error) {
    await close();
    throw error;
  }
}
