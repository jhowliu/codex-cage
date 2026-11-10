import { execa } from "execa";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { codexHomePath } from "./agent/codex.js";
import {
  agentFailureCode,
  agentProvidersInUse,
  agentRoles,
  agentShellCommand,
  defaultAgentModels,
  type AgentAssignment,
  type AgentProvider,
  type AgentRole,
} from "./agent/providers.js";
import { resolveExecutionMode, type CodexCageConfig } from "./config.js";
import { loadCodexCageConfigFile } from "./config-file.js";
import {
  credentialsForCommand,
  githubTokenFromEnv,
  globalCredentialNames,
  globalCredentialsPath,
  hasAgentCredentials,
  readCredentialEnv,
  type AgentProviderByRole,
  type CredentialEnv,
} from "./credentials.js";
import { dockerOneShotArgs } from "./docker.js";
import { requiredActionsSecretGroups } from "./github-actions.js";
import { createSecretRedactor } from "./guards.js";
import {
  ghAuthToken,
  githubAccountEnvName,
  githubAccountLogin,
  githubAccountSetting,
  type GhRunner,
} from "./github-auth.js";
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

export type DoctorCommandOptions = {
  /** Added to the process environment, e.g. credentials a probe forwards to Docker. */
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type DoctorCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  options?: DoctorCommandOptions,
) => Promise<DoctorCommandResult>;

export type DoctorOptions = {
  /** Make one minimal call per configured agent in the runtime image. */
  probe?: boolean;
};

export async function doctorProject(
  cwd: string,
  runCommand: DoctorCommandRunner = defaultCommandRunner,
  options: DoctorOptions = {},
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

  const agents: AgentProviderByRole = {
    implement: configState.config.agent.implement.provider,
    review: configState.config.agent.review.provider,
  };
  const globalPath = globalCredentialsPath();
  const credentialEnv = await readCredentialEnv(cwd, globalPath);
  const env = credentialEnv.env;
  checks.push(...(await globalCredentialsChecks(globalPath, credentialEnv)));
  const codexAuthFileAvailable = await readable(join(codexHomePath(), "auth.json"));
  for (const provider of agentProvidersInUse(agents)) {
    checks.push(
      agentAuthCheck(provider, {
        available: hasAgentCredentials(provider, { env, codexAuthFileAvailable }),
        globalPath,
      }),
    );
  }
  checks.push(await githubAuthCheck(env, (args) => runCommand("gh", args, cwd)));

  if (options.probe === true) {
    checks.push(
      ...(await agentProbeChecks({
        cwd,
        config: configState.config,
        env,
        agents,
        codexAuthFilePath: codexAuthFileAvailable
          ? join(codexHomePath(), "auth.json")
          : undefined,
        dockerAvailable: docker.exitCode === 0,
        globalPath,
        runCommand,
      })),
    );
  }

  if (configState.config.actions.enabled) {
    await checkActions(cwd, configState.config.actions, agents, checks, runCommand);
  } else {
    checks.push(pass("github-actions", "GitHub Actions automation is disabled."));
  }

  return result(checks);
}

const probeOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const satisfies Record<string, unknown>;

const probeTimeoutMs = 3 * 60 * 1000;

/**
 * Runs each distinct agent assignment once, the way a run invokes it: in the
 * runtime image, with only that provider's credentials, read-only, with a
 * structured-output schema. Catches rejected credentials, unavailable models,
 * and agent CLIs too old for the configured model before a run does.
 */
async function agentProbeChecks(input: {
  cwd: string;
  config: CodexCageConfig;
  env: Record<string, string>;
  agents: AgentProviderByRole;
  codexAuthFilePath: string | undefined;
  dockerAvailable: boolean;
  globalPath: string;
  runCommand: DoctorCommandRunner;
}): Promise<DoctorCheck[]> {
  if (resolveExecutionMode({ env: process.env, config: input.config }) === "direct") {
    return [
      warning(
        "agent-probe",
        "Skipped: direct mode runs agents on the CI runner, not in a local container.",
      ),
    ];
  }
  if (!input.dockerAvailable) {
    return [warning("agent-probe", "Skipped: Docker is unavailable.")];
  }

  const image = input.config.runtime.image;
  const redact = createSecretRedactor(input.env);
  const checks: DoctorCheck[] = [];

  for (const { agent, roles } of distinctAssignments(input.config.agent)) {
    const credentials = credentialsForCommand(roles[0], {
      env: input.env,
      agents: input.agents,
      codexAuthFilePath: input.codexAuthFilePath,
    });
    const command = `cd "$(mktemp -d)" && git init -q && ${agentShellCommand(agent, {
      access: "read-only",
      prompt: "Set ok to true.",
      executionMode: "docker",
      outputSchema: probeOutputSchema,
    })}`;
    const result = await input.runCommand(
      "docker",
      dockerOneShotArgs({
        image,
        env: credentials.env,
        codexAuthFilePath: credentials.codexAuthFilePath,
        command,
      }),
      input.cwd,
      { env: credentials.env, timeoutMs: probeTimeoutMs },
    );
    const name = `agent-probe:${roles.join("+")}`;
    const label = `${agent.provider} ${agent.model}`;
    checks.push(
      result.exitCode === 0
        ? pass(name, `${label} answered in ${image}.`)
        : fail(
            name,
            redact(
              probeFailureMessage({
                agent,
                label,
                image,
                result,
                globalPath: input.globalPath,
              }),
            ),
          ),
    );
  }

  return checks;
}

function distinctAssignments(
  assignments: Record<AgentRole, AgentAssignment>,
): { agent: AgentAssignment; roles: [AgentRole, ...AgentRole[]] }[] {
  const groups: { agent: AgentAssignment; roles: [AgentRole, ...AgentRole[]] }[] = [];
  for (const role of agentRoles) {
    const agent = assignments[role];
    const group = groups.find(
      (candidate) =>
        candidate.agent.provider === agent.provider &&
        candidate.agent.model === agent.model,
    );
    if (group === undefined) groups.push({ agent, roles: [role] });
    else group.roles.push(role);
  }
  return groups;
}

function probeFailureMessage(input: {
  agent: AgentAssignment;
  label: string;
  image: string;
  result: DoctorCommandResult;
  globalPath: string;
}): string {
  const code = agentFailureCode(input.agent.provider, input.result);
  switch (code) {
    case "agent_auth_failed":
      return input.agent.provider === "claude"
        ? `Claude Code rejected its credentials. Run \`claude setup-token\` and update CLAUDE_CODE_OAUTH_TOKEN in ${input.globalPath}.`
        : `Codex rejected its credentials. Check OPENAI_API_KEY in ${input.globalPath}, or run \`codex login\`.`;
    case "agent_model_unavailable":
      return [
        `${input.label} is not available to this account, or the CLI in ${input.image} is too old for it.`,
        input.agent.provider === "codex" && input.agent.model === defaultAgentModels.codex
          ? `A ChatGPT-account Codex login cannot use ${defaultAgentModels.codex}; set OPENAI_API_KEY or pick a model your account offers.`
          : "",
        "Change the model in .codex-cage.yml or update the image.",
      ]
        .filter((part) => part !== "")
        .join(" ");
    case null: {
      const output = `${input.result.stderr}\n${input.result.stdout}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      const detail = output.at(-1)?.slice(0, 300) ?? "no output";
      return `${input.label} failed in ${input.image} (exit ${input.result.exitCode}): ${detail}`;
    }
    default: {
      const exhaustiveCode: never = code;
      return exhaustiveCode;
    }
  }
}

async function githubAuthCheck(
  env: Record<string, string>,
  gh: GhRunner,
): Promise<DoctorCheck> {
  const setting = githubAccountSetting(env);
  if (setting.status === "invalid") {
    return warning(
      "github-auth",
      `${githubAccountEnvName} in .codex-cage.env must be a GitHub login, got "${setting.value}".`,
    );
  }
  if (githubTokenFromEnv(env) !== undefined) {
    return pass("github-auth", "GITHUB_TOKEN is set in .codex-cage.env.");
  }
  const login = githubAccountLogin(setting);
  if ((await ghAuthToken(login, gh)) !== null) {
    return login === null
      ? pass(
          "github-auth",
          "Local runs use the active gh account; run `codex-cage setup` to pin one for this repo.",
        )
      : pass("github-auth", `Local runs use gh account ${login}.`);
  }
  return login === null
    ? warning(
        "github-auth",
        "Set GITHUB_TOKEN in .codex-cage.env or run `gh auth login`.",
      )
    : warning(
        "github-auth",
        `gh is not signed in as ${login} (${githubAccountEnvName}); run \`gh auth login\` or rerun \`codex-cage setup\`.`,
      );
}

function agentAuthCheck(
  provider: AgentProvider,
  input: { available: boolean; globalPath: string },
): DoctorCheck {
  switch (provider) {
    case "codex":
      return input.available
        ? pass("codex-auth", "Codex authentication is available locally.")
        : warning(
            "codex-auth",
            `Set OPENAI_API_KEY in ${input.globalPath} or sign in with Codex CLI.`,
          );
    case "claude":
      return input.available
        ? pass("claude-auth", "Claude Code authentication is available locally.")
        : warning(
            "claude-auth",
            `Run \`claude setup-token\` and set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in ${input.globalPath}.`,
          );
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

async function globalCredentialsChecks(
  path: string,
  credentialEnv: CredentialEnv,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const mode = await fileMode(path);

  if (mode !== null && (mode & 0o077) !== 0) {
    checks.push(
      warning(
        "global-credentials",
        `${path} is readable by other users; run \`chmod 600 ${path}\`.`,
      ),
    );
  }

  if (credentialEnv.ignoredGlobalNames.length > 0) {
    checks.push(
      warning(
        "global-credentials",
        `${path} only supplies ${globalCredentialNames.join(", ")}; ignored ${credentialEnv.ignoredGlobalNames.join(", ")}. Keep GitHub credentials in each repo's .codex-cage.env.`,
      ),
    );
  }

  return checks;
}

async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function checkActions(
  cwd: string,
  actions: CodexCageConfig["actions"],
  agents: AgentProviderByRole,
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
    for (const group of requiredActionsSecretGroups(agents)) {
      const label = group.join(" or ");
      const configured = group.find((name) => names.has(name));
      checks.push(
        configured !== undefined
          ? pass(`secret:${group[0]}`, `${configured} is configured.`)
          : fail(`secret:${group[0]}`, `${label} is missing from Actions secrets.`),
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
  options: DoctorCommandOptions = {},
): Promise<DoctorCommandResult> {
  try {
    const commandResult = await execa(command, args, {
      cwd,
      reject: false,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    return {
      // No exit code means the command never started or was killed.
      exitCode: commandResult.exitCode ?? 1,
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
