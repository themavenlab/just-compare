import { useState } from "react";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { APP_NAME } from "./appName";

export type HelpSection =
  "getting-started" | "shortcuts" | "bug-report" | "feature-request" | "about";

const sections: { id: HelpSection; label: string }[] = [
  { id: "getting-started", label: "Getting Started" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "bug-report", label: "Report a bug" },
  { id: "feature-request", label: "Request a feature" },
  { id: "about", label: `About ${APP_NAME}` },
];

const supportEmail = "compare@themavenlab.org";
const reportTemplates = {
  "bug-report": [
    `Subject: ${APP_NAME}: Bug report`,
    "",
    "App version: [fill in]",
    "Windows version: [fill in]",
    "Workflow: [text compare / folder compare / three-way merge]",
    "Steps to reproduce with a synthetic example:",
    "1. ",
    "Expected result:",
    "Actual result / error message (redacted):",
    "",
    "Do not include private files, paths, credentials or recovery drafts.",
  ].join("\n"),
  "feature-request": [
    `Subject: ${APP_NAME}: Feature request`,
    "",
    "Problem or use case:",
    "Current workaround:",
    "Suggested improvement:",
    "How it would help:",
    "",
    "Use synthetic examples. Do not include sensitive information.",
  ].join("\n"),
};

const shortcutGroups = [
  {
    title: "App and navigation",
    shortcuts: [
      ["Ctrl+T", "Start a new comparison."],
      ["Ctrl+Tab / Ctrl+Shift+Tab", "Move to the next or previous tab."],
      ["Ctrl+W", "Close the active comparison tab."],
      ["Ctrl+Enter / F5", "Run the active comparison or merge."],
      ["Ctrl+N / Ctrl+P", "Go to the next or previous difference."],
      ["F6", "Move focus between the text panes."],
    ],
  },
  {
    title: "Text compare and editing",
    shortcuts: [
      ["Ctrl+F / Ctrl+H / Ctrl+G", "Find, replace, or go to a source line."],
      ["F3 / Shift+F3", "Find the next or previous match."],
      ["Alt+Up / Alt+Down", "Go to the previous or next difference."],
      [
        "Ctrl+R / Ctrl+L",
        "Copy the selected difference left-to-right or right-to-left.",
      ],
      ["Ctrl+S", "Save the focused editor when saving is available."],
      ["Ctrl+Z / Ctrl+Y", "Undo or redo in the focused editor."],
    ],
  },
  {
    title: "Folder compare",
    shortcuts: [
      [
        "Arrow keys",
        "Navigate folder rows; Left/Right also collapse or expand folders or switch sides.",
      ],
      ["Enter", "Open the selected file pair or expand/collapse a folder."],
      ["Space", "Select or deselect the focused file."],
    ],
  },
] as const;

export function HelpDialog({
  initialSection,
  onClose,
}: {
  initialSection: HelpSection;
  onClose: () => void;
}) {
  const [section, setSection] = useState(initialSection);
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const heading = sections.find((item) => item.id === section)?.label;
  const reportTemplate =
    section === "bug-report" || section === "feature-request"
      ? reportTemplates[section]
      : null;
  async function copy(text: string, label: string) {
    setNotice("");
    setError("");
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label} copied. Nothing was sent.`);
    } catch (failure) {
      setError(
        `Could not copy ${label.toLowerCase()}: ${String(failure)}. Select and copy the displayed text manually.`,
      );
    } finally {
      setCopying(false);
    }
  }

  return (
    <WorkspaceDialog
      title="Help & About"
      onClose={onClose}
      className="help-dialog"
    >
      <div className="help-layout">
        <nav className="help-navigation" aria-label="Help topics">
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={section === item.id}
              disabled={copying}
              onClick={() => {
                setSection(item.id);
                setNotice("");
                setError("");
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <section
          className="help-content"
          aria-labelledby="help-section-heading"
        >
          <h3 id="help-section-heading">{heading}</h3>
          {section === "getting-started" && (
            <div className="help-workflows">
              <article>
                <h4>Text Compare</h4>
                <p>
                  Compare two files or text drafts, review aligned differences,
                  and copy selected changes between editable drafts. Saving is a
                  separate action.
                </p>
              </article>
              <article>
                <h4>Folder Compare</h4>
                <p>
                  Choose two folders to compare their contents. Filter and
                  select entries, then review the preview before applying file
                  actions.
                </p>
              </article>
              <article>
                <h4>3-Way Merge</h4>
                <p>
                  Compare a base with left and right versions, resolve conflicts
                  in the output, and save after all conflicts are resolved.
                </p>
              </article>
            </div>
          )}
          {section === "shortcuts" && (
            <>
              <p className="help-platform-note">
                On macOS, use ⌘ in place of Ctrl and Option in place of Alt.
              </p>
              <div className="help-shortcut-groups">
                {shortcutGroups.map((group) => (
                  <div className="help-shortcut-group" key={group.title}>
                    <h4>{group.title}</h4>
                    <dl>
                      {group.shortcuts.map(([keys, description]) => (
                        <div key={keys}>
                          <dt>
                            <kbd>{keys}</kbd>
                          </dt>
                          <dd>{description}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            </>
          )}
          {reportTemplate && (
            <div className="help-feedback">
              <p>
                Email The Maven Lab at <strong>{supportEmail}</strong>. Copy the
                address or template into your email service. Nothing is sent
                automatically and no file contents or diagnostics are collected.
              </p>
              <p className="help-support-address">
                Support: https://just-compare.themavenlab.org/support/
              </p>
              {section === "feature-request" && (
                <p>
                  Describe the problem and how the change would help. Requests
                  do not guarantee delivery.
                </p>
              )}
              <p>
                Use synthetic examples. Omit private paths, documents,
                credentials and recovery drafts; redact screenshots before
                sharing. Send security concerns privately to the email above,
                not to a public discussion.
              </p>
              <div className="help-feedback-actions">
                <button
                  type="button"
                  disabled={copying}
                  onClick={() => void copy(supportEmail, "Email address")}
                >
                  Copy email address
                </button>
                <button
                  type="button"
                  disabled={copying}
                  onClick={() => void copy(reportTemplate, "Report template")}
                >
                  Copy report template
                </button>
              </div>
              {notice && <p role="status">{notice}</p>}
              {error && <p role="alert">{error}</p>}
              <pre className="help-report-template" tabIndex={0}>
                {reportTemplate}
              </pre>
            </div>
          )}
          {section === "about" && (
            <div className="help-about">
              <p>
                {APP_NAME} is an original, local-first compare and merge
                workbench from The Maven Lab. It supports text comparison,
                folder comparison, and three-way merge workflows.
              </p>
              <p>
                Comparison contents stay on your device; the app does not upload
                your files. Folder actions are previewed before they change
                local files.
              </p>
              <p>
                For support, use Report a bug or Request a feature in this Help
                dialog. No account is required for comparison.
              </p>
            </div>
          )}
        </section>
      </div>
    </WorkspaceDialog>
  );
}
