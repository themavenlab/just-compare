import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchNative } from "./native-harness.mjs";

if (process.platform !== "win32")
  throw new Error("This portable packaging target requires Windows.");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const label = `just-compare-0.1.0-windows-x64-${Date.now()}`;
const destination = join(root, "artifacts", label);
const host = /^host: (.+)$/m.exec(
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
)?.[1];
if (!host?.startsWith("x86_64-pc-windows-"))
  throw new Error("Packaging requires a Windows x64 Rust host.");
const metadata = (manifest) =>
  JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        host,
        "--manifest-path",
        manifest,
      ],
      { cwd: root, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
    ),
  );
const packages = new Map();
for (const manifest of [
  "Cargo.toml",
  join("apps", "desktop", "src-tauri", "Cargo.toml"),
])
  for (const pkg of metadata(manifest).packages)
    if (pkg.source) packages.set(`${pkg.name}-${pkg.version}`, pkg);
const desktop = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "compare-desktop.exe",
);
const cli = join(root, "target", "release", "compare.exe");
await access(desktop);
await access(cli);
await mkdir(destination, { recursive: true });
await cp(desktop, join(destination, "compare-desktop.exe"));
await cp(cli, join(destination, "compare.exe"));
const loader = join(dirname(desktop), "WebView2Loader.dll");
let loaderAvailable = true;
try {
  await access(loader);
} catch (error) {
  if (error.code !== "ENOENT" || host.endsWith("-gnu")) throw error;
  loaderAvailable = false;
}
if (loaderAvailable) {
  await cp(loader, join(destination, "WebView2Loader.dll"));
  const version = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath '${loader.replaceAll("'", "''")}').VersionInfo.FileVersion`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (version !== "1.0.3800.47")
    throw new Error(
      `Review the WebView2 loader license for changed version ${version}.`,
    );
  await cp(
    join(root, "docs", "engineering", "licenses", "webview2-loader.txt"),
    join(destination, "WebView2Loader-LICENSE.txt"),
  );
}
for (const filename of [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "Cargo.lock",
  "package-lock.json",
])
  await cp(join(root, filename), join(destination, filename));
await cp(
  join(root, "apps", "desktop", "src-tauri", "Cargo.lock"),
  join(destination, "desktop-Cargo.lock"),
);
const notices = [];
for (const [name, pkg] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  if (!pkg.license) throw new Error(`Missing Rust license: ${name}`);
  const source = dirname(pkg.manifest_path);
  const folder = join(destination, "third-party", "rust", name);
  await mkdir(folder, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^(license|copying|notice|copyright|readme)/i.test(entry.name)
    )
      await cp(join(source, entry.name), join(folder, entry.name));
    if (entry.isDirectory() && /^licen[sc]es?$/i.test(entry.name))
      await cp(join(source, entry.name), join(folder, entry.name), {
        recursive: true,
      });
  }
  if (pkg.license.includes("MPL-2.0"))
    await cp(source, join(destination, "third-party", "mpl-source", name), {
      recursive: true,
    });
  notices.push({
    ecosystem: "rust",
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
  });
}
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules") || pkg.link) continue;
  const source = resolve(root, path);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || !pkg.optional || !pkg.license) throw error;
    notices.push({
      ecosystem: "npm",
      name: path,
      version: pkg.version,
      license: pkg.license,
      notInstalled: true,
    });
    continue;
  }
  if (!manifest.license) throw new Error(`Missing npm license: ${path}`);
  const folder = join(
    destination,
    "third-party",
    "npm",
    path.replaceAll("/", "_"),
  );
  await mkdir(folder, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^(license|copying|notice|copyright|readme)/i.test(entry.name)
    )
      await cp(join(source, entry.name), join(folder, entry.name));
  }
  if (manifest.license.includes("MPL-2.0"))
    await cp(
      source,
      join(destination, "third-party", "mpl-source", path.replaceAll("/", "_")),
      { recursive: true },
    );
  notices.push({
    ecosystem: "npm",
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    repository: manifest.repository,
  });
}
await writeFile(
  join(destination, "THIRD-PARTY.json"),
  JSON.stringify(notices, null, 2),
);
await writeFile(
  join(destination, "README.txt"),
  [
    "Just Compare 0.1.0 - local unsigned Windows x64 preview.",
    "Run compare-desktop.exe. Requires the installed Microsoft WebView2 Evergreen Runtime.",
    "This is not a signed installer, or a public release.",
    "Text: 1 MiB / 20,000 lines per input. Folder: 10,000 entries per side, 100 MiB per file.",
    "Set COMPARE_DESKTOP to the absolute compare-desktop.exe path when using compare.exe.",
    "Settings use the OS application-config directory, not this portable folder.",
    "Third-party license/attribution files and MPL package source are included.",
    "THIRD-PARTY.json includes the full resolved build graph, not only linked runtime dependencies.",
    "Do not publish without the separate platform, signing and distribution-license review.",
  ].join("\r\n"),
);
const hashes = {};
for (const name of [
  "compare.exe",
  "compare-desktop.exe",
  ...(loaderAvailable ? ["WebView2Loader.dll"] : []),
])
  hashes[name] = createHash("sha256")
    .update(await readFile(join(destination, name)))
    .digest("hex");
await writeFile(
  join(destination, "SHA256.json"),
  JSON.stringify(hashes, null, 2),
);
const quote = (path) => `'${path.replaceAll("'", "''")}'`;
const archive = destination + ".zip";
async function normalizeArchiveTimes(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await normalizeArchiveTimes(path);
    await utimes(
      path,
      new Date("2000-01-01T00:00:00Z"),
      new Date("2000-01-01T00:00:00Z"),
    );
  }
}
await normalizeArchiveTimes(destination);
execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${quote(destination)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal`,
  ],
  { stdio: "inherit" },
);
const unpacked = destination + "-launch-check";
execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(unpacked)}`,
  ],
  { stdio: "inherit" },
);
const extracted = join(unpacked, label);
const session = await launchNative(extracted, [], {
  desktop: join(extracted, "compare-desktop.exe"),
});
try {
  const spans = await session.call("compare_text", {
    left: "a\n",
    right: "b\n",
    jobId: "portable",
    options: {
      ignoreCase: false,
      ignoreWhitespace: false,
      ignoreLineEndings: false,
      patterns: [],
    },
  });
  assert.equal(spans[0].kind, "replace");
  await session.destroy();
  assert.equal(await session.waitExit(), 0);
} finally {
  await session.close();
}
console.log(
  JSON.stringify(
    {
      archive,
      extracted,
      hashes,
      thirdPartyPackages: notices.length,
      verified:
        "Extracted release executable launched and compared through Rust IPC",
    },
    null,
    2,
  ),
);
