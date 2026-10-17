export type DiffLine = {
  kind: "added" | "removed" | "context" | "hunk" | "metadata";
  text: string;
};

export type DiffFile = {
  path: string;
  previousPath: string | null;
  kind: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  lines: DiffLine[];
};

export type ChangeDiff = {
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
};

const maxFiles = 100;
const maxLines = 2_000;

/** A bounded, read-only presentation of Git's unified diff. Original patches stay downloadable. */
export function parseChangeDiff(patch: string): ChangeDiff {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;
  let lineCount = 0;
  let truncated = false;
  for (const text of patch.split(/\r?\n/)) {
    if (text.startsWith("diff --git ")) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const header = text.match(
        /^diff --git (?:a\/(.*?) b\/(.*)|"a\/(.*?)" "b\/(.*?)")$/,
      );
      const previous = header?.[1] ?? header?.[3] ?? null;
      current = {
        path: header?.[2] ?? header?.[4] ?? "Changed file",
        previousPath: previous,
        kind: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        lines: [],
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (current === null) continue;
    if (text.startsWith("@@")) inHunk = true;
    if (!inHunk) {
      if (text.startsWith("new file mode")) current.kind = "added";
      if (text.startsWith("deleted file mode")) current.kind = "deleted";
      if (text.startsWith("rename from ")) {
        current.kind = "renamed";
        current.previousPath = text.slice("rename from ".length);
      }
      if (text.startsWith("rename to ")) current.path = text.slice("rename to ".length);
      if (text.startsWith("+++ ") && text !== "+++ /dev/null") {
        current.path = diffPath(text.slice(4), "b/");
      }
      if (text.startsWith("--- ") && text !== "--- /dev/null") {
        current.previousPath = diffPath(text.slice(4), "a/");
      }
      if (text === "GIT binary patch" || text.startsWith("Binary files ")) {
        current.binary = true;
      }
      // Binary patch payloads and file headers are not useful as source changes.
      continue;
    }
    if (text === "") continue;
    if (lineCount >= maxLines) {
      truncated = true;
      break;
    }
    const kind = text.startsWith("@@")
      ? "hunk"
      : text.startsWith("+")
        ? "added"
        : text.startsWith("-")
          ? "removed"
          : text.startsWith(" ")
            ? "context"
            : "metadata";
    if (kind === "added") current.additions += 1;
    if (kind === "removed") current.deletions += 1;
    current.lines.push({ kind, text });
    lineCount += 1;
  }
  if (patch.trim() !== "" && files.length === 0) {
    throw new Error("Expected a Git unified diff.");
  }
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated,
  };
}

function diffPath(value: string, prefix: string): string {
  const path = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  // Keep Git's quoted escapes intact instead of guessing at an unknown path encoding.
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
