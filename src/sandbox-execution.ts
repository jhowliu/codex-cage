import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
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

// A line-buffered output sink. Chunks are accumulated and each complete line is
// passed through `redact` before `write`, so secrets are removed even when the
// output streams live. Callers flush after a command to emit a trailing
// partial line.
export type StreamSink = {
  onData: (chunk: string) => void;
  flush: () => void;
};

export function createLineStreamSink(
  write: (line: string) => void,
  redact: (input: string) => string = (input) => input,
): StreamSink {
  let buffer = "";
  const emit = (line: string): void => write(redact(line));

  return {
    onData(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        emit(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        emit(buffer.endsWith("\n") ? buffer : `${buffer}\n`);
        buffer = "";
      }
    },
  };
}

// Builds execa stdio options that both buffer output (for the returned result)
// and tee live chunks to `onData`. Without a sink, execa keeps its defaults.
function outputTeeOptions(
  onData: ((chunk: string) => void) | undefined,
): { stdout: ["pipe", Writable]; stderr: ["pipe", Writable] } | Record<string, never> {
  if (onData === undefined) {
    return {};
  }

  const sink = (): Writable =>
    new Writable({
      write(chunk, _encoding, callback): void {
        onData(chunk.toString());
        callback();
      },
    });

  return { stdout: ["pipe", sink()], stderr: ["pipe", sink()] };
}

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
  sink?: StreamSink,
): ShellRunner {
  return {
    async run(
      command: string,
      options: DockerCommandOptions = {},
    ): Promise<CommandResult> {
      const commandEnv = options.env ?? {};
      const onData = options.onData ?? sink?.onData;
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
          ...outputTeeOptions(onData),
        },
      );
      sink?.flush();

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
  sink?: StreamSink,
): ShellRunner {
  return {
    async run(
      command: string,
      options: DockerCommandOptions = {},
    ): Promise<CommandResult> {
      const commandEnv = { ...env, ...(options.env ?? {}) };
      const onData = options.onData ?? sink?.onData;
      const result = await execa(
        commandWithGitHubAuth(
          hostCommandWithCodexAuth(command, options.codexAuthFilePath, commandEnv),
          commandEnv,
        ),
        {
          shell: true,
          cwd: workspacePath,
          env: commandEnv,
          // Close stdin so host commands get EOF immediately. Codex CLI's
          // `exec` reads stdin and would otherwise hang waiting for input
          // that never arrives (the Docker runner is immune because the
          // container has no stdin attached).
          stdin: "ignore",
          reject: false,
          ...outputTeeOptions(onData),
        },
      );
      sink?.flush();

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

export function hostCommandWithCodexAuth(
  command: string,
  codexAuthFilePath: string | undefined,
  env: Record<string, string>,
): string {
  const hasApiKey = env.OPENAI_API_KEY !== undefined;

  if (!hasApiKey && codexAuthFilePath === undefined) {
    return command;
  }

  const lines: string[] = [];

  if (hasApiKey) {
    // Log Codex in with the API key into an isolated CODEX_HOME so it uses the
    // key instead of any ChatGPT/OAuth login, without touching the user's
    // ~/.codex (config and MCP servers are skipped too, keeping runs clean).
    lines.push(
      'CODEX_HOME="$(mktemp -d)"; export CODEX_HOME',
      'printf %s "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1 || true',
    );
  } else if (codexAuthFilePath !== undefined) {
    const quoted = shellQuote(codexAuthFilePath);
    lines.push(
      `if [ -f ${quoted} ]; then mkdir -p "\${CODEX_HOME:-$HOME/.codex}"`,
      `cp ${quoted} "\${CODEX_HOME:-$HOME/.codex}/auth.json"`,
      `chmod 600 "\${CODEX_HOME:-$HOME/.codex}/auth.json"`,
      "fi",
    );
  }

  lines.push(command);
  return lines.join("; ");
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
