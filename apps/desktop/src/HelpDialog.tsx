import { useState } from "react";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { APP_NAME } from "./appName";

export type HelpSection = "getting-started" | "shortcuts" | "about";

const sections: { id: HelpSection; label: string }[] = [
  { id: "getting-started", label: "Getting Started" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "about", label: `About ${APP_NAME}` },
];

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
  const heading = sections.find((item) => item.id === section)?.label;

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
              onClick={() => setSection(item.id)}
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
          {section === "about" && (
            <div className="help-about">
              <p>
                {APP_NAME} is an original, local-first compare and merge
                workbench. This Phase 1 MVP supports text comparison, folder
                comparison, and three-way merge workflows.
              </p>
              <p>
                Comparison contents stay on your device; the app does not upload
                your files. Folder actions are previewed before they change
                local files.
              </p>
              <p>
                The project is actively evolving and is not a claim of complete
                feature parity with other comparison tools. Platform support and
                validation are documented in the project README.
              </p>
            </div>
          )}
        </section>
      </div>
    </WorkspaceDialog>
  );
}
