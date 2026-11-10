# Validation and definition of done

## Current evidence

The local Windows MVP has recorded native MSVC and earlier GNU evidence.
Configured macOS/Linux CI does not establish executed or certified support.
No clean Windows 10/11 installation matrix or Store-delivered release is
established by that history. See [historical evidence](validation-history.md)
for exact checks, failures, hardware and omissions, and the
[release guide](release.md) for candidate-specific gates.

## Windows local development

Use the repository-pinned Node/npm and Rust versions, Visual Studio's
**Desktop development with C++** workload with MSVC and a Windows SDK, and
WebView2 Evergreen. Inspect `.node-version`, `package.json` and
`rust-toolchain.toml` rather than assume globally installed versions.

In a fresh PowerShell at the repository root, run sequentially:

```powershell
node --version
npm --version
rustup show active-toolchain
rustc -vV
cargo --version
npm ci
npm run desktop:dev
```

Use `npm ci` for a fresh checkout or missing dependencies, not before every
check. `rustc -vV` should report `x86_64-pc-windows-msvc` for standard Windows
development. The first native build can take several minutes. Wait for the
native Just Compare window; a browser Vite preview cannot verify Rust IPC.
Keep the owning terminal open and stop it before preparing standalone builds.

If tools installed recently are missing, restart VS Code/terminals. The current
terminal can use `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`.
Check installed Visual Studio C++/SDK components before declaring them absent.
Remove only overrides you deliberately set for a historical GNU fallback;
never mix GNU libraries with MSVC or change machine-wide environment variables.
Use the Visual Studio developer terminal if linker/SDK discovery fails.

Port 1420 is strict. Stop only an earlier process you own if it is occupied.
Development executables need the live Vite server; use embedded assets below
for standalone testing.

## Commands

Run the smallest checks covering the change; escalate for integrated releases:

```powershell
cargo test --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --manifest-path apps\desktop\src-tauri\Cargo.toml -- --check
cargo clippy --manifest-path apps\desktop\src-tauri\Cargo.toml --locked -- -D warnings
npm run check
npm run lint
npm run format:check
npm test
npm run build
```

### Automated checks versus manual launch

For native suites, build standalone debug executables first:

```powershell
npm run build
cargo build --workspace --locked
cargo build --manifest-path apps\desktop\src-tauri\Cargo.toml --locked --features tauri/custom-protocol
```

Run native scripts sequentially: they share a WebView2 profile and simultaneous
launches can attach to the wrong process. The maintained package scripts include
`test:native`, `test:git`, `test:acceptance`, `test:workflows`, `test:workbench`,
`test:compact`, `test:interactions`, `test:auto-compare`, `test:keyboard`,
`test:sessions`, `test:recovery`, `test:alignment-merge`, `test:folder-copy`, `test:preview-maps`, `test:folder-exclude` and `test:folder-save`:

```powershell
npm run test:native --workspace apps\desktop
node apps\desktop\scripts\editing-regression.mjs
node apps\desktop\scripts\history-regression.mjs
node apps\desktop\scripts\inspector-regression.mjs
node apps\desktop\scripts\explorer-regression.mjs
```

Select other suite names from `apps/desktop/package.json` as appropriate.
`npm run test:preview-maps --workspace apps\desktop` verifies that a later tab's preview does not evict an earlier tab's native plan.
`npm run test:folder-copy --workspace apps\desktop` exercises direct-target folder copy when the destination parent folders do not yet exist.
`npm run test:folder-exclude --workspace apps\desktop` runs the focused native folder exclusion regression independently of the broader native smoke flow.
`COMPARE_TEST_DESKTOP` permits an alternate embedded-assets test executable.
These are Windows native WebView2/CDP tests, not packaged-release or other-OS
evidence. Use owned temporary fixtures. Real native dialogs, Explorer menu
interaction, screen readers and display scaling still need manual checks.

### Optimized local package

```powershell
npm run build
cargo build --workspace --release --locked
cargo build --manifest-path apps\desktop\src-tauri\Cargo.toml --release --locked --features tauri/custom-protocol
npm run package:windows --workspace apps\desktop
```

The portable packager includes both executables, notices and applicable covered
source, handles the loader according to the toolchain, and verifies extracted
launch. It produces an unsigned local ZIP, not Store certification.
`npm run package:msix` is the separate Store path; follow the release guide.

## Verified evidence

Preserved detailed results live in [validation history](validation-history.md#verified-evidence).
Do not copy historical passes into a new release report without rerunning them.

## Measured scale

See [historical measurements](validation-history.md#measured-scale).
They are single-machine warm/debug observations, not performance guarantees.
Current enforced limits and filesystem behavior are documented in
[usage](../product/usage.md) and [data safety](data-safety.md).

## Definition of done

- Observable acceptance criteria and applicable failure paths are verified.
- All scoped surfaces preserve typed contracts and data-safety behavior.
- Relevant format/lint/type/build/regression checks pass.
- Docs and actual supported-platform evidence agree with implementation.
- Dependencies, destructive testing and publication have scoped approval.
- Actual results, known failures and omitted manual checks are stated.
- No unrelated edits, private data, secrets or unauthorized uploads/commits occur.

A local package, browser preview or configured CI is not a public release.
