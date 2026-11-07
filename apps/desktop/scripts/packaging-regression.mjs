import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { executableName } from "./app-config.mjs";
import { msixManifest, msixVersion, storeIdentity } from "./package-msix.mjs";
import { copyWindowsRuntime } from "./windows-distribution.mjs";

test("Store versions are strict, bounded and have a reserved zero revision", () => {
  assert.equal(msixVersion("1.2.3"), "1.2.3.0");
  assert.equal(msixVersion("65535.65535.65535.0"), "65535.65535.65535.0");
  for (const version of [
    undefined,
    "0.1.0",
    "1.2",
    "1.2.3.4",
    "1.2.3.0.0",
    "1.2.3-beta",
    "01.2.3",
    "65536.0.0",
    "-1.0.0",
    "1.2.3\n",
  ])
    assert.throws(() => msixVersion(version));
});

test("manifest preserves Store identity, architecture, language and executable resources", () => {
  const manifest = msixManifest("1.0.0");
  for (const value of [
    storeIdentity.name,
    storeIdentity.publisher,
    storeIdentity.publisherDisplayName,
    executableName,
    'Version="1.0.0.0"',
    'ProcessorArchitecture="x64"',
    'Language="en-us"',
    'MinVersion="10.0.19041.0"',
    "runFullTrust",
    "Assets\\Square44x44Logo.png",
    "Assets\\Square150x150Logo.png",
  ])
    assert.ok(manifest.includes(value), value);
  assert.throws(() => msixManifest("1.0.0.1"));
});

test("payload includes CLI, permits absent MSVC loader, and rejects missing inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "just-compare-package-test-"));
  try {
    const desktop = join(root, "app.exe");
    const cli = join(root, "cli.exe");
    await writeFile(desktop, "synthetic desktop");
    await writeFile(cli, "synthetic cli");
    const options = {
      root,
      desktop,
      cli,
      destination: join(root, "payload"),
      host: "x86_64-pc-windows-msvc",
      executableName,
    };
    assert.equal(await copyWindowsRuntime(options), false);
    assert.equal(
      await readFile(join(options.destination, "compare.exe"), "utf8"),
      "synthetic cli",
    );
    assert.equal(
      await readFile(join(options.destination, executableName), "utf8"),
      "synthetic desktop",
    );
    await assert.rejects(
      copyWindowsRuntime({ ...options, cli: join(root, "missing.exe") }),
      { code: "ENOENT" },
    );
    await assert.rejects(
      copyWindowsRuntime({ ...options, host: "x86_64-pc-windows-gnu" }),
      { code: "ENOENT" },
    );
    await assert.rejects(
      copyWindowsRuntime({ ...options, host: "aarch64-pc-windows-msvc" }),
      /Unsupported/,
    );
    await mkdir(join(root, "not-a-file"));
    await assert.rejects(
      copyWindowsRuntime({ ...options, cli: join(root, "not-a-file") }),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("marketing captures reject absent or public evidence destinations before launching", () => {
  const script = fileURLToPath(
    new URL("./capture-marketing.mjs", import.meta.url),
  );
  const output = join(
    tmpdir(),
    "compare-capture-guard",
    "website",
    "public",
    "screenshots",
  );
  for (const args of [[], [join(output, "manifest.json")]]) {
    const result = spawnSync(process.execPath, [script, output, ...args], {
      encoding: "utf8",
      env: { ...process.env, PUBLIC: process.env.PUBLIC ?? tmpdir() },
    });

    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      process.platform === "win32"
        ? /evidence must not be public/
        : /Marketing captures require Windows/,
    );
  }
});

test("authored app and portable copy contain no competitor references", async () => {
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const forbidden = new RegExp(
    [
      ["beyond", "compare"].join("[\\s_-]*"),
      ["scooter", "software"].join("[\\s_-]*"),
    ].join("|"),
    "i",
  );
  for (const entry of await readdir(source, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
    assert.doesNotMatch(
      await readFile(join(entry.parentPath, entry.name), "utf8"),
      forbidden,
      entry.name,
    );
  }
  assert.doesNotMatch(
    await readFile(new URL("./package-windows.mjs", import.meta.url), "utf8"),
    forbidden,
  );
});
