import { execa } from "execa";
import {
  dockerRunArgs,
  type DockerCommandOptions,
  type DockerSandbox,
} from "./docker.js";
import type { CommandResult, CommandRunOptions, CommandRunner } from "./publish.js";
import type { ReviewAgentRunner } from "./review.js";

export type ShellRunner = {
  run(command: string, options?: DockerCommandOptions): Promise<CommandResult>;
};

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
