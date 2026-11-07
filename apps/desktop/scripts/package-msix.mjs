import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  executableName,
  productName,
  productSlug,
  tauriConfig,
} from "./app-config.mjs";

if (process.platform !== "win32") {
  throw new Error("MSIX packaging requires Windows.");
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const desktopRoot = join(root, "apps", "desktop");
// Read and normalize version for Windows MSIX (must be 4-part: major.minor.build.revision)
const rawVersion = tauriConfig.version ?? "0.1.0";
const versionParts = rawVersion.split(".");
while (versionParts.length < 4) versionParts.push("0");
const packageVersion = versionParts.slice(0, 4).join(".");

// Identity details from Microsoft Partner Center
const PACKAGE_NAME = "TheMavenLab.JustCompare";
const PUBLISHER_ID = "CN=A266218B-395C-4CD1-A1EF-AE4605D7113C";
const PUBLISHER_DISPLAY_NAME = "The Maven Lab";
const DISPLAY_NAME = productName;
const EXECUTABLE_NAME = executableName;

console.log(`Packaging ${DISPLAY_NAME} v${packageVersion} (MSIX)...`);

// Locate makeappx.exe
function findMakeAppx() {
  const candidateDirs = [
    "C:\\Program Files (x86)\\Windows Kits\\10\\bin",
    "C:\\Program Files (x86)\\Windows Kits\\10\\App Certification Kit",
  ];
  for (const base of candidateDirs) {
    try {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-ChildItem -Path '${base}' -Recurse -Filter 'makeappx.exe' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like '*x64*' } | Select-Object -First 1 -ExpandProperty FullName`,
        ],
        { encoding: "utf8" },
      ).trim();
      if (output) return output;
    } catch {}
  }
  // Fallback to checking PATH
  try {
    return execFileSync("where.exe", ["makeappx.exe"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    throw new Error(
      "makeappx.exe not found. Install the Windows SDK or Desktop C++ tools.",
    );
  }
}

const makeappx = findMakeAppx();
console.log(`Found makeappx: ${makeappx}`);

// Ensure build output is ready
const releaseDesktop = join(
  desktopRoot,
  "src-tauri",
  "target",
  "release",
  "just-compare.exe",
);
try {
  await access(releaseDesktop);
} catch {
  console.log("Release binary not found. Compiling release build...");
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--manifest-path",
      join(desktopRoot, "src-tauri", "Cargo.toml"),
    ],
    { stdio: "inherit", cwd: root },
  );
}

// Prepare staging layout
const stagingDir = join(root, "artifacts", "msix-staging");
await rm(stagingDir, { recursive: true, force: true });
await mkdir(join(stagingDir, "Assets"), { recursive: true });

// Copy App Icons
const iconsDir = join(desktopRoot, "src-tauri", "icons");
const requiredAssets = [
  "StoreLogo.png",
  "Square44x44Logo.png",
  "Square150x150Logo.png",
];

for (const asset of requiredAssets) {
  const src = join(iconsDir, asset);
  const dest = join(stagingDir, "Assets", asset);
  await cp(src, dest);
}

// Generate AppxManifest.xml
const appxManifest = `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">

  <Identity
    Name="${PACKAGE_NAME}"
    Publisher="${PUBLISHER_ID}"
    Version="${packageVersion}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${DISPLAY_NAME}</DisplayName>
    <PublisherDisplayName>${PUBLISHER_DISPLAY_NAME}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>Fast, dependable local file and folder compare, 3-way merge, and diff utility.</Description>
  </Properties>

  <Resources>
    <Resource Language="en-us" />
  </Resources>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>

  <Applications>
    <Application Id="App"
      Executable="${EXECUTABLE_NAME}"
      uap10:RuntimeBehavior="packagedClassicApp"
      uap10:TrustLevel="mediumIL">
      <uap:VisualElements
        DisplayName="${DISPLAY_NAME}"
        Description="Fast, dependable local file and folder compare, 3-way merge, and diff utility."
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;

await writeFile(join(stagingDir, "AppxManifest.xml"), appxManifest, "utf8");

// Copy Executable and loader
await cp(releaseDesktop, join(stagingDir, EXECUTABLE_NAME));
const loader = join(dirname(releaseDesktop), "WebView2Loader.dll");
try {
  await access(loader);
  await cp(loader, join(stagingDir, "WebView2Loader.dll"));
} catch {}

// Output package file
const artifactsDir = join(root, "artifacts");
await mkdir(artifactsDir, { recursive: true });
const outputMsix = join(
  artifactsDir,
  `${productSlug}-${packageVersion}-windows-x64.msix`,
);

console.log(`Running makeappx pack -> ${outputMsix}`);
execFileSync(
  makeappx,
  ["pack", "/o", "/v", "/d", stagingDir, "/p", outputMsix],
  { stdio: "inherit" },
);

// Calculate SHA256 checksum
const hash = createHash("sha256")
  .update(await readFile(outputMsix))
  .digest("hex");

console.log("\n===========================================");
console.log(`SUCCESS: Package created at:`);
console.log(`  ${outputMsix}`);
console.log(`Package Version: ${packageVersion}`);
console.log(`SHA-256: ${hash}`);
console.log("===========================================\n");
