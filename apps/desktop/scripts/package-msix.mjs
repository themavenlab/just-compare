import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

export const storeIdentity = Object.freeze({
  name: "TheMavenLab.JustCompare",
  publisher: "CN=A266218B-395C-4CD1-A1EF-AE4605D7113C",
  publisherDisplayName: "The Maven Lab",
  storeId: "9MXXWGZP2CR5",
});

export function msixVersion(version) {
  if (
    typeof version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.0)?$/.test(version)
  )
    throw new Error(
      "Store version must be major.minor.build, optionally followed by .0; prereleases and nonzero revisions are not supported.",
    );
  const parts = version.split(".").map(Number);
  if (parts.some((part) => part > 65535) || parts[0] === 0)
    throw new Error(
      "MSIX version components must fit 0..65535 and major must be greater than zero.",
    );
  return [...parts.slice(0, 3), 0].join(".");
}

const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");

export function msixManifest(version) {
  const checkedVersion = msixVersion(version);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="${storeIdentity.name}" Publisher="${storeIdentity.publisher}" Version="${checkedVersion}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${xml(productName)}</DisplayName>
    <PublisherDisplayName>${xml(storeIdentity.publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>Local text and folder comparison and three-way merge.</Description>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
  <Applications>
    <Application Id="App" Executable="${xml(executableName)}" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${xml(productName)}" Description="Local compare and merge."
        BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
</Package>
`;
}

async function findMakeAppx() {
  const sdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = (await readdir(sdkRoot, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = join(sdkRoot, version, "x64", "makeappx.exe");
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "makeappx.exe not found in the Windows SDK. Install the Windows SDK packaging tools.",
  );
}

export async function packageMsix() {
  if (process.platform !== "win32")
    throw new Error("MSIX packaging requires Windows.");
  const version = msixVersion(tauriConfig.version);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const host = /^host: (.+)$/m.exec(
    execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
  )?.[1];
  if (host !== "x86_64-pc-windows-msvc")
    throw new Error(
      "Store candidate packaging requires the reviewed x64 Windows MSVC toolchain.",
    );
  const makeappx = await findMakeAppx();
  execFileSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", "npm run build"],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync("cargo", ["build", "--workspace", "--release", "--locked"], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      join("apps", "desktop", "src-tauri", "Cargo.toml"),
      "--release",
      "--locked",
      "--features",
      "tauri/custom-protocol",
    ],
    { cwd: root, stdio: "inherit" },
  );
  const artifacts = join(root, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const staging = await mkdtemp(join(artifacts, "msix-staging-"));
  const loaderAvailable = await copyWindowsRuntime({
    root,
    destination: staging,
    host,
    executableName,
    desktop: join(
      root,
      "apps",
      "desktop",
      "src-tauri",
      "target",
      "release",
      "just-compare.exe",
    ),
    cli: join(root, "target", "release", "compare.exe"),
  });
  const notices = await collectWindowsNotices(root, staging, host);
  await mkdir(join(staging, "Assets"));
  for (const asset of [
    "StoreLogo.png",
    "Square44x44Logo.png",
    "Square150x150Logo.png",
  ])
    await cp(
      join(root, "apps", "desktop", "src-tauri", "icons", asset),
      join(staging, "Assets", asset),
    );
  await writeFile(join(staging, "AppxManifest.xml"), msixManifest(version));
  await writeFile(
    join(staging, "CLI-README.txt"),
    [
      "CLI/Git installation integration is not yet release-validated.",
      `compare.exe requires COMPARE_DESKTOP set to the absolute installed ${executableName} path.`,
      "Do not use package-version-specific installation paths as a permanent Git configuration.",
      "Microsoft WebView2 Evergreen Runtime is required.",
      "THIRD-PARTY.json over-includes build dependencies; distribution review is still required.",
    ].join("\r\n"),
  );
  const output = join(
    artifacts,
    `${productSlug}-${version}-windows-x64-${Date.now()}.msix`,
  );
  execFileSync(makeappx, ["pack", "/v", "/d", staging, "/p", output], {
    stdio: "inherit",
  });
  const sha256 = createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  const evidence = {
    output,
    staging,
    version,
    sha256,
    revision,
    dirty,
    host,
    loaderAvailable,
    thirdPartyPackages: notices.length,
    verification:
      "Package creation only; installation, certification and Store delivery remain unverified.",
  };
  await writeFile(`${output}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await packageMsix();
