# Dependency Review and Licensing

This document tracks approved direct dependencies, licensing terms, and transitive distribution obligations for Just Compare.

---

## Approved Direct Dependencies

| Dependency | Purpose | License |
| :--- | :--- | :--- |
| **React & React DOM** | User interface rendering | MIT |
| **Tauri (core, api, build, cli)** | Native desktop shell and window capabilities | MIT OR Apache-2.0 |
| **serde & serde_json** | Typed Rust serialization and settings persistence | MIT OR Apache-2.0 |
| **similar** | Histogram line comparison engine | Apache-2.0 |
| **encoding_rs** | Strict legacy text encoding and decoding | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| **regex** | Bounded unimportant-difference filtering rules | MIT OR Apache-2.0 |
| **TypeScript** | Strict frontend static typing | Apache-2.0 |
| **Vite & Vitest** | Frontend build tooling and unit tests | MIT |
| **ESLint & Prettier** | Code formatting and linting | MIT |
| **CodeMirror 6 (state, view, lang-js, lang-json)** | Virtualized code editor, alignment widgets, and syntax highlighting | MIT |
| **playwright-core** | Native WebView2 smoke and integration testing | Apache-2.0 |
| **tempfile** | Sibling temporary file writes and test fixtures | MIT OR Apache-2.0 |
| **globset** | Folder exclusion glob matching | MIT OR Unlicense |
| **blake3 (`pure`)** | Streaming content hashing without native C compiler requirements | CC0-1.0 OR Apache-2.0 |
| **trash** | Recoverable local file deletion | MIT |
| **tauri-plugin-dialog** | Native file picker and confirmation dialogs | MIT OR Apache-2.0 |
| **winreg (0.56.0, Windows only)** | Owned, opt-in per-user Windows Explorer context menu registration | MIT |
| **tauri-plugin-single-instance (2.5.4, Windows only)** | Queued normal-app shell launch handoff, excluding Git waiting launches | MIT OR Apache-2.0 |
| **WebView2Loader.dll (1.0.3800.47)** | GNU Windows desktop loader companion | Microsoft Redistributable License |

---

## Transitive Obligations

- **Mozilla Public License (MPL-2.0):** Certain transitive build dependencies (e.g. `lightningcss` in npm) and Rust crates (`cssparser`, `selectors`, `dtoa-short`, `option-ext`) are licensed under MPL-2.0. MPL obligations apply at the file level and do not relicense unrelated application code. When redistributing binaries, applicable source availability requirements are respected.
- **WebView2 Loader:** When distributing on Windows under the GNU toolchain, `WebView2Loader.dll` is bundled alongside its required [redistribution notice](licenses/webview2-loader.txt). The system-installed WebView2 Evergreen Runtime itself retains Microsoft's standard terms.
- **Lockfile Auditing:** Every dependency addition or version bump requires inspecting transitive licenses in `Cargo.lock` and `package-lock.json`.

---

## Packaging and Attribution

The packaging script (`npm run package:windows --workspace apps/desktop`) automatically:
1. Gathers license and attribution files from installed crate and npm registries into a structured `third-party/` directory.
2. Extracts and includes source code for any active MPL-2.0 dependencies.
3. Generates a comprehensive `THIRD-PARTY.json` manifest of all resolved packages.
4. Emits cryptographic SHA-256 hashes for all output executables.
