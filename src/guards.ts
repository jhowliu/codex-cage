import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type GuardViolation =
  | {
      code: "sensitive_file";
      path: string;
      message: string;
    }
  | {
      code: "injected_secret";
      path: string;
      line: number;
      secretName: string;
      message: string;
    }
  | {
      code: "token_pattern";
      path: string;
      line: number;
      pattern: string;
      message: string;
    }
  | {
      code: "private_key";
      path: string;
      line: number;
      message: string;
    };

export type DiffGuardOptions = {
  injectedSecrets?: Record<string, string>;
};

export type GuardAttemptDecision =
  | { action: "retry"; nextAttempt: number }
  | { action: "fail"; attempts: number };

export class GuardViolationError extends Error {
  readonly violations: GuardViolation[];

  constructor(violations: GuardViolation[]) {
    super(formatGuardViolations(violations));
    this.name = "GuardViolationError";
    this.violations = violations;
  }
}

const envAssignmentPattern = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const minSecretLength = 4;
const envFilePath = ".codex-cage.env";

const tokenPatterns = [
  {
    name: "github_token",
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/,
  },
  {
    name: "openai_api_key",
    pattern: /sk-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: "aws_access_key_id",
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: "slack_token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/,
  },
] as const;

export async function readCodexCageEnv(
  cwd: string,
  relativePath = envFilePath,
): Promise<Record<string, string>> {
  const path = join(cwd, relativePath);

  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const trimmedLine = rawLine.trim();

    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue;
    }

    const match = trimmedLine.match(envAssignmentPattern);

    if (match === null) {
      throw new Error(`Invalid env assignment on line ${index + 1}.`);
    }

    const name = match[1];
    const rawValue = match[2];

    if (name === undefined || rawValue === undefined) {
      throw new Error(`Invalid env assignment on line ${index + 1}.`);
    }

    env[name] = unquoteEnvValue(rawValue.trim());
  }

  return env;
}

export function createSecretRedactor(
  secrets: Record<string, string>,
): (input: string) => string {
  const secretEntries = Object.entries(secrets).filter(([, value]) =>
    isScannableSecret(value),
  );

  return (input: string): string => {
    let redacted = input;

    for (const [name, value] of secretEntries) {
      redacted = redacted.replaceAll(value, `[REDACTED:${name}]`);
      redacted = redacted.replaceAll(encodeURIComponent(value), `[REDACTED:${name}]`);
    }

    return redacted.replace(
      /https:\/\/x-access-token:[^@\s]+@github\.com/g,
      "https://x-access-token:[REDACTED]@github.com",
    );
  };
}

export function scanDiffForGuardViolations(
  diff: string,
  options: DiffGuardOptions = {},
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const injectedSecrets = Object.entries(options.injectedSecrets ?? {}).filter(
    ([, value]) => isScannableSecret(value),
  );
  let currentPath: string | null = null;
  let newLineNumber = 0;
  const reportedSensitivePaths = new Set<string>();

  for (const line of diff.split(/\r?\n/)) {
    const diffPath = parseDiffPath(line);

    if (diffPath !== null) {
      currentPath = diffPath;
      newLineNumber = 0;

      if (isSensitiveFilePath(currentPath) && !reportedSensitivePaths.has(currentPath)) {
        reportedSensitivePaths.add(currentPath);
        violations.push({
          code: "sensitive_file",
          path: currentPath,
          message: `Sensitive file "${currentPath}" cannot be changed.`,
        });
      }

      continue;
    }

    const hunkStart = parseHunkNewStart(line);

    if (hunkStart !== null) {
      newLineNumber = hunkStart;
      continue;
    }

    if (currentPath === null || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }

    if (line.startsWith("+")) {
      const addedContent = line.slice(1);
      violations.push(
        ...scanAddedLine({
          path: currentPath,
          line: newLineNumber,
          content: addedContent,
          injectedSecrets,
        }),
      );
      newLineNumber += 1;
      continue;
    }

    if (!line.startsWith("-")) {
      newLineNumber += 1;
    }
  }

  return violations;
}

export function assertNoGuardViolations(violations: GuardViolation[]): void {
  if (violations.length > 0) {
    throw new GuardViolationError(violations);
  }
}

export function formatGuardViolations(violations: GuardViolation[]): string {
  if (violations.length === 0) {
    return "No guard violations.";
  }

  return violations
    .map((violation) => {
      const location =
        "line" in violation ? `${violation.path}:${violation.line}` : violation.path;

      return `${location} [${violation.code}] ${violation.message}`;
    })
    .join("\n");
}

export function isSensitiveFilePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;

  if (isSampleEnvFilePath(normalized)) {
    return false;
  }

  return (
    basename === ".env" ||
    basename === ".codex-cage.env" ||
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename === ".netrc" ||
    basename === "credentials" ||
    normalized.includes("/.ssh/") ||
    normalized.startsWith(".ssh/") ||
    normalized.includes("/.config/gh/") ||
    normalized.startsWith(".config/gh/") ||
    normalized.includes("/.aws/") ||
    normalized.startsWith(".aws/")
  );
}

export function guardAttemptDecision(input: {
  attempt: number;
  maxAttempts: number;
}): GuardAttemptDecision {
  const attempts = input.attempt + 1;

  if (attempts > input.maxAttempts) {
    return { action: "fail", attempts };
  }

  return { action: "retry", nextAttempt: attempts };
}

function scanAddedLine(input: {
  path: string;
  line: number;
  content: string;
  injectedSecrets: Array<[string, string]>;
}): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const [secretName, value] of input.injectedSecrets) {
    if (input.content.includes(value)) {
      violations.push({
        code: "injected_secret",
        path: input.path,
        line: input.line,
        secretName,
        message: `Injected secret "${secretName}" appears in the diff.`,
      });
    }
  }

  for (const tokenPattern of tokenPatterns) {
    if (tokenPattern.pattern.test(input.content)) {
      violations.push({
        code: "token_pattern",
        path: input.path,
        line: input.line,
        pattern: tokenPattern.name,
        message: `High-confidence ${tokenPattern.name} token appears in the diff.`,
      });
    }
  }

  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(input.content)) {
    violations.push({
      code: "private_key",
      path: input.path,
      line: input.line,
      message: "Private key material appears in the diff.",
    });
  }

  return violations;
}

function parseDiffPath(line: string): string | null {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);

  if (match === null) {
    return null;
  }

  return match[2] ?? null;
}

function parseHunkNewStart(line: string): number | null {
  const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

  if (match === null) {
    return null;
  }

  const newStart = match[1];

  if (newStart === undefined) {
    return null;
  }

  return Number.parseInt(newStart, 10);
}

function isSampleEnvFilePath(path: string): boolean {
  return (
    path.endsWith(".env.example") ||
    path.endsWith(".env.sample") ||
    path.endsWith(".env.template") ||
    path.endsWith(".codex-cage.env.example")
  );
}

function isScannableSecret(value: string): boolean {
  return value.length >= minSecretLength;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
