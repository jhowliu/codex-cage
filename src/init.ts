import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export type InitOptions = {
  dockerfile?: boolean;
};

export type InitResult = {
  created: string[];
  updated: string[];
};

const configPath = ".codex-cage.yml";
const envExamplePath = ".codex-cage.env.example";
const gitignorePath = ".gitignore";
const dockerfilePath = ".codex-cage/Dockerfile";
const instructionsPath = ".codex-cage/instructions.md";

const defaultConfig = `# Codex Cage target repo configuration.
# Replace the verify command before running Codex Cage.
setup: []

verify:
  - echo "Replace this with your real test command" && exit 1

services:
  compose: null
  ready: []

runtime:
  image: ghcr.io/jhowliu/codex-cage/base:0.1.0
  dockerfile: null

agent:
  model: gpt-5.5
  max_iterations: 5
  max_review_cycles: 2

timeouts:
  total_minutes: 90
  command_minutes: 20
  idle_minutes: 10

pr:
  draft: false

git:
  base: main
  author_name: Codex Cage
  author_email: codex-cage@users.noreply.github.com

issue:
  comments: 10

guards:
  max_secret_fix_attempts: 2
`;

const envExample = `# Copy this file to .codex-cage.env and fill in local secrets.
OPENAI_API_KEY=
GITHUB_TOKEN=
# Required only for Linear issue URLs.
LINEAR_API_KEY=
`;

const dockerfile = `FROM ghcr.io/jhowliu/codex-cage/base:0.1.0

# Add target-repo system dependencies here.
`;

const instructions = `# Codex Cage Instructions

- Follow the repository's existing style and tests.
- Keep changes focused on the issue.
- Do not commit, push, create pull requests, or write secrets.
`;

const gitignoreEntries = [".codex-cage.env", ".codex-cage/runs/", ".codex-cage/*.sqlite"];

export async function initProject(
  cwd: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const configFilePath = join(cwd, configPath);
  const dockerfileFilePath = join(cwd, dockerfilePath);
  const instructionsFilePath = join(cwd, instructionsPath);

  await assertFileDoesNotExist(cwd, configFilePath);

  if (options.dockerfile) {
    await assertFileDoesNotExist(cwd, dockerfileFilePath);
  }

  await createFileOnce(cwd, configFilePath, defaultConfig, created);
  if (!(await fileExists(instructionsFilePath))) {
    await createFileOnce(cwd, instructionsFilePath, instructions, created);
  }
  await mergeEnvExample(cwd, join(cwd, envExamplePath), created, updated);
  await appendGitignoreEntries(cwd, join(cwd, gitignorePath), updated);

  if (options.dockerfile) {
    await createFileOnce(cwd, dockerfileFilePath, dockerfile, created);
  }

  return { created, updated };
}

async function createFileOnce(
  cwd: string,
  path: string,
  content: string,
  created: string[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  created.push(relativeDisplayPath(cwd, path));
}

async function assertFileDoesNotExist(cwd: string, path: string): Promise<void> {
  if (await fileExists(path)) {
    throw new Error(`${relativeDisplayPath(cwd, path)} already exists.`);
  }
}

async function mergeEnvExample(
  cwd: string,
  path: string,
  created: string[],
  updated: string[],
): Promise<void> {
  if (!(await fileExists(path))) {
    await writeFile(path, envExample, "utf8");
    created.push(relativeDisplayPath(cwd, path));
    return;
  }

  const current = await readFile(path, "utf8");
  const currentKeys = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((key): key is string => key !== undefined),
  );
  const missingLines = envExample
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
      return key === undefined || !currentKeys.has(key);
    })
    .filter((line) => !current.includes(line));

  if (missingLines.length === 0) {
    return;
  }

  const separator = current.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${current}${separator}${missingLines.join("\n")}\n`, "utf8");
  updated.push(relativeDisplayPath(cwd, path));
}

async function appendGitignoreEntries(
  cwd: string,
  path: string,
  updated: string[],
): Promise<void> {
  const current = (await readOptionalFile(path)) ?? "";
  const lines = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = gitignoreEntries.filter((entry) => !lines.has(entry));

  if (missing.length === 0) {
    return;
  }

  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${current}${separator}${missing.join("\n")}\n`, "utf8");
  updated.push(relativeDisplayPath(cwd, path));
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await readOptionalFile(path)) !== undefined;
}

function relativeDisplayPath(cwd: string, path: string): string {
  return relative(cwd, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
