# Windows Microsoft Store release guide

This is a reusable release process, not permission to upload or publish.
Record candidate-specific progress and evidence in the release issue/PR or
current task conversation. Follow the [approval gates](agent-workflow.md#approval-gates).

## Release contract

| Item | Initial target |
| --- | --- |
| Product / publisher | Just Compare / The Maven Lab |
| Channel / pricing | Microsoft Store / free |
| OS / architecture | Windows 10 build 19041+ and Windows 11, x64 |
| Language | English (en-US) |
| Source availability | Private for now; MIT OR Apache-2.0 retained |
| Product website | `https://just-compare.themavenlab.org` |
| Store ID | `9MXXWGZP2CR5` |
| Package Name | `TheMavenLab.JustCompare` |
| Publisher | `CN=A266218B-395C-4CD1-A1EF-AE4605D7113C` |
| Publisher display name | `The Maven Lab` |
| Package family | `TheMavenLab.JustCompare_4fgrdp6hcpqfj` |

These are targets, not compatibility evidence. macOS/Linux, ARM64/x86, direct
public downloads and feature expansion are outside this release.
The Tauri identifier is an internal application identifier, not the Store Name.
Neither the Package SID nor credentials are needed in public marketing copy.

## Ownership

The application repository owns code, packaging, usage, architecture, safety
contracts and release-validation procedure. The sibling `just-compare-branding`
repository owns original brand sources, the static Astro/React/Tailwind website
and en-US Store copy/screenshots/logos. Keep application policy claims consistent
with the website; do not duplicate private implementation details into public assets.

## Candidate preparation

1. Select the release version and source revision. Preserve unrelated edits.
2. Run [validation](validation.md); record actual toolchain, checks and omissions.
3. Build frontend and native binaries with locked dependencies and embedded
   assets. Never package an arbitrary existing executable as a fresh candidate.
4. Use the existing MSIX path, preserving supplied identity and validating
   Windows four-part version ranges, Store revision rules and upgrade ordering.
   The current `0.1.0` application version is not a valid Store package version:
   MSIX requires a nonzero major and the Store reserves the fourth component.
   The owner must select the first release version; do not silently promote it.
5. Inspect package contents: desktop executable, CLI if advertised, necessary
   runtime files, manifest assets, project licenses, third-party attributions and
   applicable covered source. Review the [dependency obligations](dependencies.md).
6. Record package SHA-256, source revision, version, architecture and build inputs.
   Keep large artifacts and machine-specific reports out of tracked source.

`npm run test:packaging --workspace apps\desktop` exercises strict version
validation, manifest identity/resources and runtime-payload failure behavior.
`package:msix` always builds fresh locked frontend/core/embedded desktop outputs,
requires x64 MSVC, uses the same notice/runtime collection as the ZIP packager,
and writes an unsigned local package plus JSON provenance. Staging paths and
output names are unique; existing staging or packages are not overwritten.
Its manifest intentionally retains the existing full-trust behavior; it does
not register unapproved execution aliases or solve installed Explorer cleanup.

For draft marketing captures after an embedded-assets debug build:

```powershell
node apps\desktop\scripts\capture-marketing.mjs C:\parag_data\GitHub\just-compare-branding\website\public\screenshots C:\parag_data\GitHub\just-compare-branding\website\evidence\screenshots.json
```

The script owns disposable synthetic fixtures under Public Documents and records development-preview provenance outside published assets in `website/evidence/screenshots.json`. Keep that directory private; only PNGs belong in `website/public/screenshots`. These are genuine app captures, but must be refreshed after a release candidate passes installed-app validation.

Microsoft re-signs accepted Store MSIX packages; a purchased CA certificate is
not an assumed submission prerequisite. Local install tests can need trusted
test signing or a Store test channel. Obtain approval before installing a
certificate, enabling developer settings or installing/registering packages.
Never store certificate private keys or account secrets in either repository.

## Candidate acceptance

Record an explicit result for each Windows target, using clean environments:

- Install and offline launch, with documented WebView2/runtime prerequisites.
- Text/folder/merge workflows, safe save, stale-input protection, cancellation
  and errors with synthetic fixtures, including Unicode/spaced paths.
- Settings, history and opt-in recovery; verify installed data locations.
- CLI and Git use from installed paths, not developer-tree examples.
- Opt-in Explorer enable/use/remove, package upgrades and uninstall cleanup.
  Portable HKCU registration does not prove Store-safe integration.
- Upgrade preservation of user settings and explicit uninstall data-retention
  behavior. No silent source-file changes or orphaned integration promises.
- Keyboard/focus, dialogs, light/dark themes, scaling, common display sizes
  and screen-reader checks. Record limitations.
- Windows App Certification Kit checks and justification of required capabilities.
  A WACK pass does not guarantee Store certification.

Native debug regression suites and actual installed release testing are separate
evidence. Missing environments or approvals block the relevant claim. Reduce
support/features only with owner approval; do not relabel a failure as success.

## Store listing and policy review

Use the branding repository's field inventory and current Partner Center form.
Prepare description/features/search terms/release notes, accurate requirements,
real screenshots/captions, requested Store logos, category, markets, free pricing,
ratings/declarations, privacy/support/website URLs, applicable terms and tester
notes. The owner must confirm account declarations and contact details.

Use only original assets and synthetic data. Never use reference/mock screenshots,
private paths, unimplemented-feature claims or inaccessible private source links.
Keep requested 300x300, 150x150 and 71x71 exports distinct from manifest resource
requirements and the live form's required versus optional upload slots.

Privacy must reflect installed behavior. Separate local app processing from
Cloudflare hosting logs and Microsoft Store delivery/diagnostics. Do not promise
that uninstall removes integrations or all local data without verification.

## Launch sequence and rollback

1. Resolve candidate failures, notice/source obligations and support contact.
2. Separately approve publication of the coming-soon website with public HTTPS
   support and privacy pages. Add the Pages domain before its DNS CNAME.
3. Separately approve Store upload/submission. Confirm controlled publication
   settings rather than unintentionally enabling automatic public availability.
4. Address certification feedback and verify a Store-delivered install.
5. Owner approves availability. Confirm the public listing/acquisition link in
   intended markets before switching the website CTA to live.
6. Retain package hashes and the prior site deployment. Website rollback is
   separate from Store availability controls; package updates need increasing
   versions rather than downgrades. Record support triage without soliciting
   private comparison contents or enabling telemetry.

Git integration can deploy automatically on push. Connecting Cloudflare, pushing,
changing DNS, uploading packages and publishing each require explicit approval.

## Inputs that cannot be inferred

The owner supplied `compare@themavenlab.org` for public support, feature requests and private security reports. The website and app route feedback there; mailbox delivery is owner-confirmed, not verified by an automated email. A source-free GitHub tracker kit is prepared locally in the branding repository's `support/github-tracker`; creating it and enabling public links require separate approval. Keep the application and branding repositories private.

Release version, markets, rating answers, optional additional terms, brand asset rights, test environments, installed-app results, Store certification and publication approval must be supplied/verified. No public release readiness is asserted while these remain unresolved.

## References

- [MSIX package requirements and signing](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Store screenshots and images](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)
- [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)
