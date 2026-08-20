import { execa } from "execa";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexCageConfig } from "./config.js";
import { loadCodexCageConfigFile } from "./config-file.js";
import { readCodexCageEnv } from "./guards.js";
import { GENERATED_WORKFLOW_MARKER } from "./setup.js";

export type DoctorCheck =
  | { status: "pass"; name: string; message: string }
  | { status: "warning"; name: string; message: string }
  | { status: "fail"; name: string; message: string };

export type DoctorResult = {
  healthy: boolean;
  checks: DoctorCheck[];
};

export type DoctorCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DoctorCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<DoctorCommandResult>;

export async function doctorProject(
  cwd: string,
  runCommand: DoctorCommandRunner = defaultCommandRunner,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const configState = await loadCodexCageConfigFile(cwd);
  if (configState.status === "missing") {
    checks.push(
      fail("configuration", ".codex-cage.yml was not found; run codex-cage setup."),
    );
    return result(checks);
  }
  if (configState.status === "invalid") {
    checks.push(
      fail("configuration", configState.errors.map((error) => error.message).join("; ")),
    );
    return result(checks);
  }

  checks.push(pass("configuration", ".codex-cage.yml is valid."));
  checks.push(
    configState.config.verify.length > 0
      ? pass("verification", `${configState.config.verify.length} command(s) configured.`)
      : fail("verification", "At least one verification command is required."),
  );

  const git = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  checks.push(
    git.exitCode === 0
      ? pass("git", "Git repository detected.")
      : fail("git", "Current directory is not a Git repository."),
  );

  const docker = await runCommand("docker", ["info"], cwd);
  checks.push(
    docker.exitCode === 0
      ? pass("docker", "Docker daemon is available for local runs.")
      : warning("docker", "Docker is unavailable; local runs will not work."),
  );

  const env = await readCodexCageEnv(cwd);
  const hasCodexAuth =
    env.OPENAI_API_KEY !== undefined ||
    (await readable(join(homedir(), ".codex", "auth.json")));
  checks.push(
    hasCodexAuth
      ? pass("codex-auth", "Codex authentication is available locally.")
      : warning(
          "codex-auth",
          "Set OPENAI_API_KEY in .codex-cage.env or sign in with Codex CLI.",
        ),
  );
  checks.push(
    env.GITHUB_TOKEN !== undefined || env.GH_TOKEN !== undefined
      ? pass("github-auth", "GitHub authentication is available locally.")
      : warning("github-auth", "Set GITHUB_TOKEN in .codex-cage.env for local runs."),
  );

  if (configState.config.actions.enabled) {
    await checkActions(cwd, configState.config.actions, checks, runCommand);
  } else {
    checks.push(pass("github-actions", "GitHub Actions automation is disabled."));
  }

  return result(checks);
}

async function checkActions(
  cwd: string,
  actions: CodexCageConfig["actions"],
  checks: DoctorCheck[],
  runCommand: DoctorCommandRunner,
): Promise<void> {
  const workflowPath = resolve(cwd, actions.workflow);
  const workflow = await readOptionalFile(workflowPath);
  checks.push(
    workflow?.startsWith(GENERATED_WORKFLOW_MARKER) === true
      ? pass("workflow", `${actions.workflow} is managed by Codex Cage.`)
      : fail("workflow", `${actions.workflow} is missing or not managed by Codex Cage.`),
  );

  const ghAuth = await runCommand("gh", ["auth", "status"], cwd);
  if (ghAuth.exitCode !== 0) {
    checks.push(
      warning("gh-auth", "GitHub CLI is not authenticated; remote checks skipped."),
    );
    return;
  }
  checks.push(pass("gh-auth", "GitHub CLI is authenticated."));

  const secrets = await runCommand("gh", ["secret", "list", "--json", "name"], cwd);
  if (secrets.exitCode === 0) {
    const names = parseNameList(secrets.stdout);
    for (const name of ["OPENAI_API_KEY", "CODEX_CAGE_GITHUB_TOKEN"]) {
      checks.push(
        names.has(name)
          ? pass(`secret:${name}`, `${name} is configured.`)
          : fail(`secret:${name}`, `${name} is missing from Actions secrets.`),
      );
    }
  } else {
    checks.push(warning("actions-secrets", "Could not inspect GitHub Actions secrets."));
  }

  const labels = await runCommand(
    "gh",
    ["label", "list", "--limit", "1000", "--json", "name"],
    cwd,
  );
  if (labels.exitCode === 0) {
    const names = parseNameList(labels.stdout);
    for (const name of Object.values(actions.labels)) {
      checks.push(
        names.has(name)
          ? pass(`label:${name}`, `${name} exists.`)
          : fail(`label:${name}`, `${name} is missing.`),
      );
    }
  } else {
    checks.push(warning("actions-labels", "Could not inspect GitHub labels."));
  }
}

function parseNameList(value: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.flatMap((item) => {
        if (item === null || typeof item !== "object" || !("name" in item)) return [];
        return typeof item.name === "string" ? [item.name] : [];
      }),
    );
  } catch {
    return new Set();
  }
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<DoctorCommandResult> {
  try {
    const commandResult = await execa(command, args, { cwd, reject: false });
    return {
      exitCode: commandResult.exitCode ?? 0,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function result(checks: DoctorCheck[]): DoctorResult {
  return { healthy: checks.every((check) => check.status !== "fail"), checks };
}

function pass(name: string, message: string): DoctorCheck {
  return { status: "pass", name, message };
}

function warning(name: string, message: string): DoctorCheck {
  return { status: "warning", name, message };
}

function fail(name: string, message: string): DoctorCheck {
  return { status: "fail", name, message };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
