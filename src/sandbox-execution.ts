import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandWithGitHubAuth,
  dockerRunArgs,
  type DockerCommandOptions,
  type DockerSandbox,
} from "./docker.js";
import type { CommandResult, CommandRunOptions, CommandRunner } from "./publish.js";
import type { ReviewAgentRunner } from "./review.js";

export type ShellRunner = {
  run(command: string, options?: DockerCommandOptions): Promise<CommandResult>;
};

export type HostWorkspace = {
  workspacePath: string;
  cleanup: () => Promise<void>;
};

/**
 * Creates an empty host directory to clone the target repository into for
 * direct-mode runs, where the runner (not Docker) provides isolation.
 */
export async function createHostWorkspace(runId: string): Promise<HostWorkspace> {
  const workspacePath = await mkdtemp(join(tmpdir(), `codex-cage-${runId}-`));

  return {
    workspacePath,
    async cleanup(): Promise<void> {
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

export function createDockerShellRunner(
  sandbox: DockerSandbox,
  _env: Record<string, string>,
): ShellRunner {
  return {
    async run(
      command: string,
      options: DockerCommandOptions = {},
    ): Promise<CommandResult> {
      const commandEnv = options.env ?? {};
      const result = await execa(
        "docker",
        dockerRunArgs({
          image: sandbox.image,
          networkName: sandbox.networkName,
          volumeName: sandbox.volumeName,
          workspacePath: sandbox.workspacePath,
          labels: { "codex-cage.run_id": sandbox.runId },
          env: commandEnv,
          codexAuthFilePath: options.codexAuthFilePath,
          command,
        }),
        {
          env: commandEnv,
          reject: false,
        },
      );

      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

export function createHostShellRunner(
  workspacePath: string,
  env: Record<string, string> = {},
): ShellRunner {
  return {
    async run(
      command: string,
      options: DockerCommandOptions = {},
    ): Promise<CommandResult> {
      const commandEnv = { ...env, ...(options.env ?? {}) };
      const result = await execa(
        commandWithGitHubAuth(
          hostCommandWithCodexAuth(command, options.codexAuthFilePath),
          commandEnv,
        ),
        {
          shell: true,
          cwd: workspacePath,
          env: commandEnv,
          reject: false,
        },
      );

      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

export async function requiredShell(
  shell: ShellRunner,
  command: string,
  redactor: (input: string) => string = (input) => input,
  options?: DockerCommandOptions,
): Promise<string> {
  const result = await shell.run(command, options);
  const log = redactor(formatCommandLog(command, result));

  if (result.exitCode !== 0) {
    throw new Error(log);
  }

  return log;
}

export async function readCurrentDiff(shell: ShellRunner): Promise<string> {
  const result = await shell.run(
    "git add --intent-to-add -- . && git diff --binary HEAD",
  );

  if (result.exitCode !== 0) {
    throw new Error(formatCommandLog("git diff", result));
  }

  return result.stdout;
}

export function createGitCommandRunner(
  shell: ShellRunner,
  options?: DockerCommandOptions,
): CommandRunner {
  return createShellCommandRunner(shell, "git", options);
}

export function createGhCommandRunner(
  shell: ShellRunner,
  options?: DockerCommandOptions,
): CommandRunner {
  return createShellCommandRunner(shell, "gh", options);
}

export function createReviewAgentRunner(
  shell: ShellRunner,
  options?: DockerCommandOptions,
): ReviewAgentRunner {
  return {
    async run(input): Promise<string> {
      const outputSchemaPath = "/tmp/codex-cage-review-output-schema.json";
      const writeOutputSchemaCommand = `printf %s ${shellQuote(
        JSON.stringify(input.outputSchema),
      )} > ${shellQuote(outputSchemaPath)}`;

      const command = `${writeOutputSchemaCommand} && ${codexExecCommand({
        model: input.model,
        sandbox: "read-only",
        outputSchemaPath,
        prompt: input.prompt,
      })}`;
      const result = await shell.run(command, options);

      if (result.exitCode !== 0) {
        throw new Error(formatCommandLog(command, result));
      }

      return result.stdout;
    },
  };
}

export function codexExecCommand(input: {
  model: string;
  sandbox: "read-only" | "workspace-write";
  outputSchemaPath?: string | undefined;
  prompt: string;
}): string {
  const args = [
    "codex exec",
    "--model",
    shellQuote(input.model),
    "--sandbox",
    shellQuote(input.sandbox),
  ];

  if (input.outputSchemaPath !== undefined) {
    args.push("--output-schema", shellQuote(input.outputSchemaPath));
  }

  args.push(shellQuote(input.prompt));

  return args.join(" ");
}

export function formatCommandLog(command: string, result: CommandResult): string {
  return [
    `$ ${command}`,
    `exit code: ${result.exitCode}`,
    result.stdout.trim() === "" ? "" : `stdout:\n${result.stdout}`,
    result.stderr.trim() === "" ? "" : `stderr:\n${result.stderr}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hostCommandWithCodexAuth(
  command: string,
  codexAuthFilePath: string | undefined,
): string {
  if (codexAuthFilePath === undefined) {
    return command;
  }

  const quoted = shellQuote(codexAuthFilePath);
  return [
    `if [ -f ${quoted} ] && [ -z "\${OPENAI_API_KEY:-}" ]; then mkdir -p "\${CODEX_HOME:-$HOME/.codex}"`,
    `cp ${quoted} "\${CODEX_HOME:-$HOME/.codex}/auth.json"`,
    `chmod 600 "\${CODEX_HOME:-$HOME/.codex}/auth.json"`,
    "fi",
    command,
  ].join("; ");
}

function createShellCommandRunner(
  shell: ShellRunner,
  executable: string,
  options?: DockerCommandOptions,
): CommandRunner {
  return {
    async run(
      args: string[],
      runOptions: CommandRunOptions = {},
    ): Promise<CommandResult> {
      const env = {
        ...(options?.env ?? {}),
        ...(runOptions.env ?? {}),
      };
      const commandOptions: DockerCommandOptions = {
        ...options,
        ...(Object.keys(env).length === 0 ? {} : { env }),
      };

      return await shell.run(
        [executable, ...args].map(shellQuote).join(" "),
        commandOptions,
      );
    },
  };
}
