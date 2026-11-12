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
import {
  agentFailureCode,
  agentShellCommand,
  extractAgentResult,
  type AgentAssignment,
  type AgentProvider,
  type AgentRole,
} from "./agent/providers.js";
import type { ExecutionMode } from "./config.js";
import type { FailureCode } from "./state.js";
import { shellQuote } from "./shell.js";
import { RunFailureError } from "./run/errors.js";

export type ShellRunner = {
  run(command: string, options?: DockerCommandOptions): Promise<CommandResult>;
};

export type ShellTimeouts = {
  commandMs: number;
  idleMs: number;
  deadlineAt: number;
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
  const workspacePath = await mkdtemp(join(tmpdir(), `agent-cage-${runId}-`));

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
  timeouts?: ShellTimeouts,
): ShellRunner {
  return {
    async run(
      command: string,
      options: DockerCommandOptions = {},
    ): Promise<CommandResult> {
      const commandEnv = options.env ?? {};
      const { started, ...result } = await runProcess(
        "docker",
        dockerRunArgs({
          image: sandbox.image,
          networkName: sandbox.networkName,
          volumeName: sandbox.volumeName,
          workspacePath: sandbox.workspacePath,
          labels: { "agent-cage.run_id": sandbox.runId },
          env: commandEnv,
          codexAuthFilePath: options.codexAuthFilePath,
          command,
        }),
        {
          // The docker CLI needs PATH, HOME (for its context), and DOCKER_* to
          // reach the daemon. The container still gets only the command env,
          // which dockerRunArgs forwards by name.
          env: { ...pickProcessEnv(dockerClientEnvNames), ...commandEnv },
          onData: options.onData ?? sink?.onData,
          sink,
          ...resolveTimeouts(options, timeouts),
        },
      );
      if (!started || dockerDaemonUnreachable(result)) {
        throw new RunFailureError(
          "docker_unavailable",
          `Docker could not run the sandbox command: ${result.stderr.trim()}`,
        );
      }
      return result;
    },
  };
}

// `docker run` exits 125 for its own errors, including an unreachable daemon.
function dockerDaemonUnreachable(result: CommandResult): boolean {
  return (
    result.exitCode === 125 &&
    /Cannot connect to the Docker daemon|error during connect/.test(result.stderr)
  );
}

export function createHostShellRunner(
  workspacePath: string,
  env: Record<string, string> = {},
  sink?: StreamSink,
  timeouts?: ShellTimeouts,
): ShellRunner {
  return {
    async run(
      command: string,
      options: DockerCommandOptions = {},
    ): Promise<CommandResult> {
      const commandEnv = { ...safeHostEnvironment(), ...env, ...(options.env ?? {}) };
      const { started: _started, ...result } = await runProcess(
        commandWithGitHubAuth(
          hostCommandWithCodexAuth(command, options.codexAuthFilePath, commandEnv),
          commandEnv,
        ),
        [],
        {
          shell: true,
          cwd: workspacePath,
          env: commandEnv,
          onData: options.onData ?? sink?.onData,
          sink,
          ...resolveTimeouts(options, timeouts),
        },
      );
      return result;
    },
  };
}

type ProcessOptions = {
  cwd?: string;
  env: Record<string, string>;
  shell?: boolean;
  onData: ((chunk: string) => void) | undefined;
  sink: StreamSink | undefined;
  timeoutMs: number | undefined;
  idleTimeoutMs: number | undefined;
};

/** `started` is false when the executable could not be spawned (e.g. ENOENT). */
type ProcessResult = CommandResult & { started: boolean };

async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (options.idleTimeoutMs !== undefined) {
      idleTimer = setTimeout(() => controller.abort(), options.idleTimeoutMs);
    }
  };
  const onData = (chunk: string): void => {
    resetIdleTimer();
    options.onData?.(chunk);
  };
  resetIdleTimer();

  try {
    const processResult = await execa(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      env: options.env,
      extendEnv: false,
      stdin: "ignore",
      reject: false,
      cancelSignal: controller.signal,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...outputTeeOptions(onData),
    });
    const stopped = processResult.timedOut || processResult.isCanceled;
    // A process that never started (ENOENT) or was killed by a signal has no
    // exit code and usually no output; keep execa's reason for the log.
    const failureReason =
      processResult.exitCode === undefined &&
      !stopped &&
      typeof processResult.shortMessage === "string"
        ? processResult.shortMessage
        : "";
    return {
      started: !(
        processResult.exitCode === undefined &&
        processResult.signal === undefined &&
        !stopped
      ),
      exitCode: processResult.exitCode ?? (stopped ? 124 : 1),
      stdout: processResult.stdout,
      stderr: [processResult.stderr, failureReason]
        .filter((part) => part !== "")
        .join("\n"),
    };
  } catch (error) {
    return { started: true, ...processErrorResult(error) };
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.sink?.flush();
  }
}

function resolveTimeouts(
  options: DockerCommandOptions,
  defaults: ShellTimeouts | undefined,
): { timeoutMs: number | undefined; idleTimeoutMs: number | undefined } {
  const remaining = defaults === undefined ? undefined : defaults.deadlineAt - Date.now();
  const commandTimeout = options.timeoutMs ?? defaults?.commandMs;
  const timeoutMs =
    remaining === undefined
      ? commandTimeout
      : Math.max(1, Math.min(commandTimeout ?? remaining, remaining));
  return {
    timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs ?? defaults?.idleMs,
  };
}

function processErrorResult(error: unknown): CommandResult {
  if (error !== null && typeof error === "object") {
    const stdout =
      "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr =
      "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const timedOut =
      ("timedOut" in error && error.timedOut === true) ||
      ("isCanceled" in error && error.isCanceled === true);
    return { exitCode: timedOut ? 124 : 1, stdout, stderr };
  }
  return { exitCode: 1, stdout: "", stderr: String(error) };
}

const safeHostEnvNames = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CI",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "SYSTEMROOT",
  "WINDIR",
] as const;

const dockerClientEnvNames = [
  ...safeHostEnvNames,
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

function safeHostEnvironment(): Record<string, string> {
  return pickProcessEnv(safeHostEnvNames);
}

function pickProcessEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
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
    if (result.exitCode === 124) throw new RunFailureError("timeout", log);
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
  options: DockerCommandOptions | undefined,
  executionMode: ExecutionMode,
): ReviewAgentRunner {
  return {
    async run(input): Promise<string> {
      const command = agentShellCommand(input.agent, {
        access: "read-only",
        prompt: input.prompt,
        executionMode,
        outputSchema: input.outputSchema,
      });
      const result = await shell.run(command, options);

      if (result.exitCode !== 0) {
        throw agentCommandFailure(
          "review",
          input.agent.provider,
          formatCommandLog(command, result),
          result,
        );
      }

      try {
        return extractAgentResult(input.agent.provider, result.stdout);
      } catch (error) {
        throw new RunFailureError(
          agentFailureCode(input.agent.provider, result) ?? "review_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

const roleFailureCodes = {
  implement: "implement_failed",
  review: "review_failed",
} as const satisfies Record<AgentRole, FailureCode>;

/**
 * Maps a failed agent command to a failure code: timeouts, then credential
 * and model errors the provider reported, then a generic role failure.
 */
export function agentCommandFailure(
  role: AgentRole,
  provider: AgentProvider,
  log: string,
  result: CommandResult,
): RunFailureError {
  if (result.exitCode === 124) return new RunFailureError("timeout", log);
  return new RunFailureError(
    agentFailureCode(provider, result) ?? roleFailureCodes[role],
    log,
  );
}

/** Like requiredShell, for agent commands: failures carry an agent failure code. */
export async function requiredAgentShell(
  shell: ShellRunner,
  input: { role: AgentRole; agent: AgentAssignment; command: string },
  redactor: (input: string) => string,
  options?: DockerCommandOptions,
): Promise<string> {
  const result = await shell.run(input.command, options);
  const log = redactor(formatCommandLog(input.command, result));

  if (result.exitCode !== 0) {
    throw agentCommandFailure(input.role, input.agent.provider, log, result);
  }

  return log;
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
