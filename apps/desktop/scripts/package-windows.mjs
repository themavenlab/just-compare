import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executableName,
  productName,
  productSlug,
  tauriConfig,
} from "./app-config.mjs";
import {
  collectWindowsNotices,
  copyWindowsRuntime,
} from "./windows-distribution.mjs";

if (process.platform !== "win32")
  throw new Error("This portable packaging target requires Windows.");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const version = tauriConfig.version ?? "0.1.0";
const label = `${productSlug}-${version}-windows-x64-${Date.now()}`;
const destination = join(root, "artifacts", label);
const host = /^host: (.+)$/m.exec(
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
)?.[1];
if (!host?.startsWith("x86_64-pc-windows-"))
  throw new Error("Packaging requires a Windows x64 Rust host.");
const desktop = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "just-compare.exe",
);
const cli = join(root, "target", "release", "compare.exe");
await mkdir(destination, { recursive: true });
const loaderAvailable = await copyWindowsRuntime({
  root,
  desktop,
  cli,
  destination,
  host,
  executableName,
});
const notices = await collectWindowsNotices(root, destination, host);
await writeFile(
  join(destination, "README.txt"),
  [
    `${productName} ${version} - local unsigned Windows x64 preview.`,
    `Run ${executableName}. Requires the installed Microsoft WebView2 Evergreen Runtime.`,
    "This is not a signed installer, public release, or full Beyond Compare parity.",
    "Text: 1 MiB / 20,000 lines per input. Folder: 10,000 entries per side, 100 MiB per file.",
    `Set COMPARE_DESKTOP to the absolute ${executableName} path when using compare.exe.`,
    "Settings use the OS application-config directory, not this portable folder.",
    "Third-party license/attribution files and MPL package source are included.",
    "THIRD-PARTY.json includes the full resolved build graph, not only linked runtime dependencies.",
    "Do not publish without the separate platform, signing and distribution-license review.",
  ].join("\r\n"),
);
const hashes = {};
for (const name of [
  "compare.exe",
  executableName,
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
  desktop: join(extracted, executableName),
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
