import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchNative,
  openWorkspace,
  previewUpdate,
} from "./native-harness.mjs";

if (process.platform !== "win32" || !process.env.PUBLIC)
  throw new Error(
    "Marketing captures require Windows and a public, nonpersonal fixture path.",
  );
const output = process.argv[2];
if (!output || !resolve(output).endsWith(join("public", "screenshots")))
  throw new Error(
    "Supply the branding website public\\screenshots output directory.",
  );
const evidence = process.argv[3];
if (
  !evidence ||
  resolve(evidence) !==
    join(dirname(dirname(resolve(output))), "evidence", "screenshots.json")
)
  throw new Error(
    "Supply the separate website\\evidence\\screenshots.json provenance destination; evidence must not be public.",
  );
const root = await mkdtemp(
  join(process.env.PUBLIC, "Documents", "Just Compare demo-"),
);
let session;
try {
  const left = join(root, "current"),
    right = join(root, "proposed");
  for (const folder of [left, right]) await mkdir(folder);
  for (const [name, a, b] of [
    [
      "release-notes.txt",
      "# Release notes\n\nKeep comparisons local.\nReview every change.\n",
      "# Release notes\n\nKeep comparisons local.\nReview every change carefully.\nSave when ready.\n",
    ],
    [
      "settings.json",
      '{\n  "theme": "light",\n  "recovery": false\n}\n',
      '{\n  "theme": "dark",\n  "recovery": false\n}\n',
    ],
    ["README.md", "# Sample project\n", "# Sample project\n"],
    ["changelog.txt", "Initial draft\n", "Reviewed draft\n"],
  ]) {
    await writeFile(join(left, name), a);
    await writeFile(join(right, name), b);
  }
  await writeFile(join(left, "draft.txt"), "Synthetic draft only.\n");
  await writeFile(join(right, "ready.txt"), "Synthetic ready version.\n");
  const config = join(root, "configuration");
  await mkdir(config);
  await mkdir(output, { recursive: true });
  await mkdir(dirname(resolve(evidence)), { recursive: true });
  session = await launchNative(config);
  const { page } = session;
  await page.setViewportSize({ width: 1920, height: 1080 });
  const captures = [];
  const capture = async (file) => {
    assert.equal(await page.locator('[role="alert"]').count(), 0);
    await page.screenshot({ path: join(output, file), animations: "disabled" });
    captures.push({
      file,
      sha256: createHash("sha256")
        .update(await readFile(join(output, file)))
        .digest("hex"),
    });
  };
  await openWorkspace(page, "text");
  await page
    .getByRole("textbox", { name: "Left text", exact: true })
    .fill(
      "# Project settings\n\nname: Just Compare\nversion: preview\nprocessing: local\nrecovery: disabled\n\nReview changes before saving.\nKeep a backup of important files.\n",
    );
  await page
    .getByRole("textbox", { name: "Right text", exact: true })
    .fill(
      "# Project settings\n\nname: Just Compare\nversion: release candidate\nprocessing: local\nrecovery: opt-in\n\nReview changes carefully before saving.\nKeep a backup of important files.\nChoose what matters.\n",
    );
  await page.getByRole("heading", { name: /changed regions/ }).waitFor();
  await capture("01-text.png");
  await openWorkspace(page, "folder");
  await page
    .getByRole("combobox", { name: "left path", exact: true })
    .fill(left);
  await page
    .getByRole("combobox", { name: "right path", exact: true })
    .fill(right);
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  await page
    .locator('.folder-row[data-relative="release-notes.txt"]')
    .waitFor();
  await capture("02-folders.png");
  await previewUpdate(page);
  await page.getByRole("dialog").waitFor();
  await capture("03-preview.png");
  await page.keyboard.press("Escape");
  await openWorkspace(page, "merge");
  for (const [name, value] of [
    ["Base", "# Welcome\n\nRelease: preview\nFiles stay local.\n"],
    ["Left", "# Welcome\n\nRelease: ready for review\nFiles stay local.\n"],
    ["Right", "# Welcome\n\nRelease: final checks\nFiles stay local.\n"],
  ])
    await page
      .getByRole("textbox", { name: `${name} text`, exact: true })
      .fill(value);
  await page
    .getByRole("button", { name: "Merge three inputs", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "1 unresolved conflicts", exact: true })
    .waitFor();
  await capture("04-merge.png");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  await writeFile(
    evidence,
    JSON.stringify(
      {
        kind: "development-preview",
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repo,
          encoding: "utf8",
        }).trim(),
        sourceDirty:
          execFileSync("git", ["status", "--porcelain"], {
            cwd: repo,
            encoding: "utf8",
          }).trim().length > 0,
        platform:
          "Windows x64, embedded-assets debug build; not an installed Store candidate",
        fixtureProvenance:
          "Original synthetic inputs generated by capture-marketing.mjs; no reference assets or user documents.",
        dimensions: { width: 1920, height: 1080 },
        captures,
      },
      null,
      2,
    ),
  );
  console.log(
    `Captured ${captures.length} draft native screenshots in ${output}`,
  );
} finally {
  if (session) await session.close();
  await rm(root, { recursive: true });
}
