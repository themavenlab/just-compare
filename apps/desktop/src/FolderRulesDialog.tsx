import { useState } from "react";
import { native, type FolderRules } from "./api";
import { errorMessage } from "./comparison";
import { WorkspaceDialog } from "./WorkspaceDialog";

export function FolderRulesDialog({
  rules,
  exclusions,
  excludedFiles,
  excludedDirectories,
  onApply,
  onClose,
}: {
  rules: FolderRules;
  exclusions: string;
  excludedFiles: string[];
  excludedDirectories: string[];
  onApply: (
    rules: FolderRules,
    exclusions: string,
    excludedFiles: string[],
    excludedDirectories: string[],
    defaults: boolean,
  ) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<FolderRules>(structuredClone(rules));
  const [exclude, setExclude] = useState(exclusions);
  const [files, setFiles] = useState(excludedFiles.join("\n"));
  const [directories, setDirectories] = useState(
    excludedDirectories.join("\n"),
  );
  const [scope, setScope] = useState("view");
  const [help, setHelp] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  async function apply() {
    setApplying(true);
    setError("");
    try {
      await native("validate_folder_rules", {
        rules: draft,
        options: {
          criterion: "content",
          exclude: exclude.split("\n").filter(Boolean),
          excludeFiles: files.split("\n").filter(Boolean),
          excludeDirectories: directories.split("\n").filter(Boolean),
        },
      });
      onApply(
        draft,
        exclude,
        files.split("\n").filter(Boolean),
        directories.split("\n").filter(Boolean),
        scope === "defaults",
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setApplying(false);
    }
  }
  const set = <K extends keyof FolderRules>(key: K, value: FolderRules[K]) =>
    setDraft((prior) => ({ ...prior, [key]: value }));
  function check(
    key:
      | "compareSize"
      | "compareModified"
      | "ignoreDst"
      | "compareFilenameCase"
      | "alignCase"
      | "alignExtensions"
      | "compareReadonly"
      | "compareArchive"
      | "compareSystem"
      | "compareHidden"
      | "executableVersion",
    label: string,
  ) {
    return (
      <label>
        <input
          type="checkbox"
          checked={draft[key]}
          onChange={(event) => {
            const checked = event.target.checked;
            setDraft((prior) => {
              const next = { ...prior, [key]: checked };
              if (key === "compareSize" || key === "compareModified")
                next.quickTest = "none";
              if (
                next.quickTest === "none" &&
                !next.compareSize &&
                !next.compareModified &&
                next.quickTestPolicy === "skip"
              )
                next.quickTestPolicy = "requireAll";
              return next;
            });
          }}
        />
        {label}
      </label>
    );
  }
  return (
    <WorkspaceDialog
      title="Session Settings - Folder Compare"
      onClose={() => {
        if (!applying) onClose();
      }}
    >
      <form
        className="folder-rules-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!applying) void apply();
        }}
      >
        <div className="rules-columns">
          <fieldset>
            <legend>Quick tests</legend>
            {check("compareSize", "Compare file size")}
            {check("compareModified", "Compare timestamps")}
            <label>
              <input
                aria-label="Timestamp tolerance in seconds"
                type="number"
                min={0}
                max={86400}
                step={0.001}
                value={draft.timestampToleranceMs / 1000}
                disabled={!draft.compareModified}
                onChange={(event) =>
                  set("timestampToleranceMs", event.target.valueAsNumber * 1000)
                }
              />
              second tolerance
            </label>
            {check("ignoreDst", "Ignore daylight-saving difference (1 hour)")}
            <label title="Enable an explicit right-side offset; timestamps cannot identify their original timezone.">
              <input
                type="checkbox"
                checked={draft.timezoneOffsetMinutes !== 0}
                onChange={(event) =>
                  set("timezoneOffsetMinutes", event.target.checked ? 60 : 0)
                }
              />
              Ignore timezone difference using an explicit adjustment
            </label>
            <label>
              Right-side timestamp adjustment (minutes)
              <input
                aria-label="Right timezone offset in minutes"
                type="number"
                min={-1440}
                max={1440}
                step={1}
                disabled={draft.timezoneOffsetMinutes === 0}
                value={draft.timezoneOffsetMinutes}
                onChange={(event) =>
                  set("timezoneOffsetMinutes", event.target.valueAsNumber)
                }
              />
            </label>
            <p className="metadata">
              Explicit offset added to the right timestamp. A file timestamp
              does not identify its originating timezone.
            </p>
            {check("compareFilenameCase", "Compare filename case")}
            {check("alignCase", "Align uniquely matching ASCII-case names")}
            {check(
              "alignExtensions",
              "Align filenames with different extensions",
            )}
            <label title="Pair unique filenames after canonical NFC normalization within the same exact parent directory. This never renames files or performs Unicode case folding.">
              <input
                type="checkbox"
                checked={draft.textRules.unicodeNormalization}
                onChange={(event) =>
                  set("textRules", {
                    ...draft.textRules,
                    unicodeNormalization: event.target.checked,
                  })
                }
              />
              Align filenames with different Unicode normalization forms
            </label>
          </fieldset>
          <fieldset>
            <legend>Compare file attributes</legend>
            {check("compareArchive", "Archive (Windows)")}
            {check("compareSystem", "System (Windows)")}
            {check("compareHidden", "Hidden (Windows)")}
            {check("compareReadonly", "Read-only")}
          </fieldset>
        </div>
        <fieldset>
          <legend>Requires opening files</legend>
          <label>
            <input
              type="checkbox"
              checked={draft.content !== "none"}
              onChange={(event) => {
                set("content", event.target.checked ? "binary" : "none");
                if (!event.target.checked) set("quickTestPolicy", "requireAll");
              }}
            />
            Compare contents
          </label>
          {(["crc", "binary", "rules"] as const).map((method) => (
            <label
              key={method}
              title={
                method === "crc"
                  ? "Compare sizes and IEEE CRC-32 checksums. Collisions are possible; write-safety snapshots always use independent BLAKE3 hashes."
                  : undefined
              }
            >
              <input
                type="radio"
                name="content-method"
                value={method}
                checked={draft.content === method}
                disabled={draft.content === "none"}
                onChange={() => set("content", method)}
              />
              {method === "crc"
                ? "CRC comparison"
                : method === "binary"
                  ? "Binary comparison"
                  : "Rules-based comparison"}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={draft.quickTestPolicy === "skip"}
              disabled={
                (draft.quickTest === "none" &&
                  !draft.compareSize &&
                  !draft.compareModified) ||
                draft.content === "none" ||
                draft.quickTestPolicy === "override"
              }
              onChange={(event) =>
                set(
                  "quickTestPolicy",
                  event.target.checked ? "skip" : "requireAll",
                )
              }
            />
            Skip if quick tests indicate files are the same
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.quickTestPolicy === "override"}
              disabled={
                draft.content === "none" || draft.quickTestPolicy === "skip"
              }
              onChange={(event) =>
                set(
                  "quickTestPolicy",
                  event.target.checked ? "override" : "requireAll",
                )
              }
            />
            Content comparison overrides quick-test results
          </label>
          {check("executableVersion", "Compare executable versions (Windows)")}
          {draft.content === "rules" && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={draft.textRules.ignoreCase}
                  onChange={(event) =>
                    set("textRules", {
                      ...draft.textRules,
                      ignoreCase: event.target.checked,
                    })
                  }
                />
                Ignore text case
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.textRules.ignoreWhitespace}
                  onChange={(event) =>
                    set("textRules", {
                      ...draft.textRules,
                      ignoreWhitespace: event.target.checked,
                    })
                  }
                />
                Ignore whitespace
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.textRules.ignoreLineEndings}
                  onChange={(event) =>
                    set("textRules", {
                      ...draft.textRules,
                      ignoreLineEndings: event.target.checked,
                    })
                  }
                />
                Ignore EOL style
              </label>
              <label>
                Unimportant patterns
                <textarea
                  value={draft.textRules.unimportant.join("\n")}
                  onChange={(event) =>
                    set("textRules", {
                      ...draft.textRules,
                      unimportant: event.target.value
                        .split("\n")
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </>
          )}
        </fieldset>
        <fieldset>
          <legend>Name filters</legend>
          <label>
            Scan exclusions (one glob per line)
            <textarea
              aria-label="Exclusions (glob per line)"
              value={exclude}
              onChange={(event) => setExclude(event.target.value)}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Excluded exact paths</legend>
          <label>
            Files (one relative path per line)
            <textarea
              aria-label="Excluded file paths"
              value={files}
              onChange={(event) => setFiles(event.target.value)}
            />
          </label>
          <label>
            Folders and their contents (one relative path per line)
            <textarea
              aria-label="Excluded folder paths"
              value={directories}
              onChange={(event) => setDirectories(event.target.value)}
            />
          </label>
          <p className="metadata">
            Exact path exclusions are kind-specific, so excluding a folder does
            not hide a file with the same relative name.
          </p>
        </fieldset>
        {help && (
          <p className="metadata">
            Quick tests do not prove byte equality. Skip marks content
            unchecked. Override uses content equality instead of size/time
            equality. Matching rules never rename files; ambiguous names stay
            unpaired. Scan exclusions prevent file-content reads, while toolbar
            filters only hide already-scanned results. Unsupported capabilities
            report errors. Executable versions compare the four-part fixed file
            and product versions of EXE, DLL, OCX, SYS, SCR and CPL files on
            Windows; missing or invalid version resources are errors. Other
            files use the remaining tests. Saving preferences persists defaults.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <select
            aria-label="Apply folder rules scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="view">Use for this view only</option>
            <option value="defaults">
              Also use as defaults for new folder comparisons
            </option>
          </select>
          <button type="button" onClick={() => setHelp(!help)}>
            Help
          </button>
          <button type="button" disabled={applying} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={applying} className="primary">
            {applying ? "Validating..." : "OK"}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
