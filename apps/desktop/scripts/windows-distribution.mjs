import { execFileSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function copyWindowsRuntime({
  root,
  desktop,
  cli,
  destination,
  host,
  executableName,
}) {
  if (!/^x86_64-pc-windows-(msvc|gnu)$/.test(host))
    throw new Error(`Unsupported Windows packaging host: ${host}`);
  await access(desktop);
  await access(cli);
  await mkdir(destination, { recursive: true });
  await cp(desktop, join(destination, executableName));
  await cp(cli, join(destination, "compare.exe"));
  const loader = join(dirname(desktop), "WebView2Loader.dll");
  try {
    await access(loader);
  } catch (error) {
    if (error.code !== "ENOENT" || host.endsWith("-gnu")) throw error;
    return false;
  }
  const version = execFileSync(
    "powershell.exe",
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
  await cp(loader, join(destination, "WebView2Loader.dll"));
  await cp(
    join(root, "docs", "engineering", "licenses", "webview2-loader.txt"),
    join(destination, "WebView2Loader-LICENSE.txt"),
  );
  return true;
}

export async function collectWindowsNotices(root, destination, host) {
  const packages = new Map();
  for (const manifest of [
    "Cargo.toml",
    join("apps", "desktop", "src-tauri", "Cargo.toml"),
  ]) {
    const metadata = JSON.parse(
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
    for (const pkg of metadata.packages)
      if (pkg.source) packages.set(`${pkg.name}-${pkg.version}`, pkg);
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
      manifest = JSON.parse(
        await readFile(join(source, "package.json"), "utf8"),
      );
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
        join(
          destination,
          "third-party",
          "mpl-source",
          path.replaceAll("/", "_"),
        ),
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
  return notices;
}
