export type DependencyChangeKind = "manifest" | "lockfile";

export type DependencyFileChange = {
  path: string;
  kind: DependencyChangeKind;
};

export type DependencyChangeSummary = {
  changed: boolean;
  files: DependencyFileChange[];
};

const dependencyFiles = new Map<string, DependencyChangeKind>([
  ["package.json", "manifest"],
  ["package-lock.json", "lockfile"],
  ["pnpm-lock.yaml", "lockfile"],
  ["yarn.lock", "lockfile"],
]);

export function classifyDependencyChanges(diff: string): DependencyChangeSummary {
  const files = new Map<string, DependencyFileChange>();

  for (const line of diff.split(/\r?\n/)) {
    const path = parseDiffPath(line);

    if (path === null) {
      continue;
    }

    const kind = dependencyFiles.get(basename(path));

    if (kind !== undefined) {
      files.set(path, { path, kind });
    }
  }

  const sortedFiles = [...files.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  return {
    changed: sortedFiles.length > 0,
    files: sortedFiles,
  };
}

export function formatDependencyChangesMarkdown(
  summary: DependencyChangeSummary,
): string {
  if (!summary.changed) {
    return "- None detected.";
  }

  return summary.files.map((file) => `- \`${file.path}\` (${file.kind})`).join("\n");
}

function parseDiffPath(line: string): string | null {
  if (!line.startsWith("diff --git ")) {
    return null;
  }

  const match = line.match(/^diff --git (?:"a\/((?:\\"|[^"])*)"|a\/(\S+)) /);
  const rawPath = match?.[1] ?? match?.[2];

  if (rawPath === undefined) {
    return null;
  }

  return unescapeGitPath(rawPath);
}

function unescapeGitPath(path: string): string {
  return path.replaceAll('\\"', '"');
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}
