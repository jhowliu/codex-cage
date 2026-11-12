import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexExecCommand } from "../src/agent/codex.js";
import { createDockerSandbox, execaDockerRunner } from "../src/docker.js";
import type { CommandResult } from "../src/publish.js";
import { RunFailureError } from "../src/run/errors.js";
import {
  agentCommandFailure,
  createDockerShellRunner,
  createHostShellRunner,
  createHostWorkspace,
  createLineStreamSink,
  hostCommandWithCodexAuth,
} from "../src/sandbox-execution.js";

async function withWorkspace(
  fn: (workspacePath: string) => Promise<void>,
): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agent-cage-host-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withProcessEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(overrides);
  try {
    await fn();
  } finally {
    apply(previous);
  }
}

function testSandbox() {
  return createDockerSandbox(
    { runId: "run-test", cloneUrl: "https://github.com/acme/app.git", image: "img" },
    { run: async () => {} },
  );
}

test("docker shell runner finds the docker CLI and daemon from the host environment", async () => {
  await withWorkspace(async (binDir) => {
    // A fake docker CLI that reports what the real one would need to reach the daemon.
    await writeFile(
      join(binDir, "docker"),
      '#!/bin/sh\nprintf "%s|%s|%s" "${HOME:-unset}" "${DOCKER_HOST:-unset}" "${GITHUB_TOKEN:-unset}"\n',
    );
    await chmod(join(binDir, "docker"), 0o755);

    await withProcessEnv(
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: "/home/tester",
        DOCKER_HOST: "unix:///tmp/docker.sock",
        GITHUB_TOKEN: "ambient-secret",
      },
      async () => {
        const runner = createDockerShellRunner(testSandbox(), {});

        const result = await runner.run("true", { env: { GITHUB_TOKEN: "run-token" } });

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "/home/tester|unix:///tmp/docker.sock|run-token");
      },
    );
  });
});

async function fakeDocker(dir: string, script: string): Promise<void> {
  await writeFile(join(dir, "docker"), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, "docker"), 0o755);
}

async function rejectsWithFailureCode(
  promise: Promise<unknown>,
  failureCode: string,
  message: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RunFailureError);
    assert.equal(error.failureCode, failureCode);
    assert.match(error.message, message);
    return true;
  });
}

test("docker shell runner reports a missing docker CLI as docker_unavailable", async () => {
  await withWorkspace(async (emptyDir) => {
    await withProcessEnv({ PATH: emptyDir }, async () => {
      const runner = createDockerShellRunner(testSandbox(), {});

      await rejectsWithFailureCode(runner.run("true"), "docker_unavailable", /ENOENT/);
    });
  });
});

test("docker shell runner reports an unreachable daemon as docker_unavailable", async () => {
  await withWorkspace(async (binDir) => {
    await fakeDocker(
      binDir,
      'echo "docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2; exit 125',
    );
    await withProcessEnv({ PATH: `${binDir}:/usr/bin:/bin` }, async () => {
      const runner = createDockerShellRunner(testSandbox(), {});

      await rejectsWithFailureCode(
        runner.run("true"),
        "docker_unavailable",
        /Cannot connect to the Docker daemon/,
      );
    });
  });
});

test("docker shell runner returns failures of the sandbox command itself", async () => {
  await withWorkspace(async (binDir) => {
    await fakeDocker(binDir, 'echo "npm: not found" >&2; exit 127');
    await withProcessEnv({ PATH: `${binDir}:/usr/bin:/bin` }, async () => {
      const runner = createDockerShellRunner(testSandbox(), {});

      const result = await runner.run("npm ci");

      assert.equal(result.exitCode, 127);
      assert.match(result.stderr, /npm: not found/);
    });
  });
});

test("docker runner reports a missing CLI or daemon as docker_unavailable", async () => {
  await withWorkspace(async (dir) => {
    await withProcessEnv({ PATH: dir }, async () => {
      await rejectsWithFailureCode(
        execaDockerRunner.run(["volume", "create", "x"]),
        "docker_unavailable",
        /not found on PATH/,
      );
    });

    await fakeDocker(dir, 'echo "Cannot connect to the Docker daemon" >&2; exit 1');
    await withProcessEnv({ PATH: `${dir}:/usr/bin:/bin` }, async () => {
      await rejectsWithFailureCode(
        execaDockerRunner.run(["volume", "create", "x"]),
        "docker_unavailable",
        /Cannot connect to the Docker daemon/,
      );
    });
  });
});

test("docker runner keeps the command's own error when Docker is available", async () => {
  await withWorkspace(async (binDir) => {
    await fakeDocker(
      binDir,
      'if [ "$1" = version ]; then echo 27.0.0; exit 0; fi; exit 3',
    );
    await withProcessEnv({ PATH: `${binDir}:/usr/bin:/bin` }, async () => {
      await assert.rejects(execaDockerRunner.run(["volume", "create", "x"]), (error) => {
        assert.ok(!(error instanceof RunFailureError));
        return true;
      });
    });
  });
});

test("agentCommandFailure maps timeouts, provider errors, and other failures", () => {
  const failure = (provider: "claude" | "codex", result: CommandResult) =>
    agentCommandFailure("implement", provider, "log", result).failureCode;

  assert.equal(failure("codex", { exitCode: 124, stdout: "", stderr: "" }), "timeout");
  assert.equal(
    failure("claude", {
      exitCode: 1,
      stdout: '{"type":"result","is_error":true,"api_error_status":401}',
      stderr: "",
    }),
    "agent_auth_failed",
  );
  assert.equal(
    failure("codex", { exitCode: 1, stdout: "", stderr: "ERROR: boom" }),
    "implement_failed",
  );
  assert.equal(
    agentCommandFailure("review", "codex", "log", { exitCode: 1, stdout: "", stderr: "" })
      .failureCode,
    "review_failed",
  );
});

test("host shell runner runs commands in the workspace directory", async () => {
  await withWorkspace(async (workspacePath) => {
    const runner = createHostShellRunner(workspacePath);

    const result = await runner.run("pwd");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), workspacePath);
  });
});

test("host shell runner surfaces non-zero exit codes without throwing", async () => {
  await withWorkspace(async (workspacePath) => {
    const runner = createHostShellRunner(workspacePath);

    const result = await runner.run("exit 7");

    assert.equal(result.exitCode, 7);
  });
});

test("host shell runner merges base env with per-command env", async () => {
  await withWorkspace(async (workspacePath) => {
    const runner = createHostShellRunner(workspacePath, { BASE_VAR: "base" });

    const result = await runner.run('printf "%s-%s" "$BASE_VAR" "$CMD_VAR"', {
      env: { CMD_VAR: "cmd" },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "base-cmd");
  });
});

test("host shell runner does not inherit ambient credentials", async () => {
  await withWorkspace(async (workspacePath) => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ambient-secret";
    try {
      const runner = createHostShellRunner(workspacePath);
      const result = await runner.run('printf "%s" "${GITHUB_TOKEN:-unset}"');
      assert.equal(result.stdout, "unset");
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
});

test("host shell runner supports shell operators like the docker runner", async () => {
  await withWorkspace(async (workspacePath) => {
    const runner = createHostShellRunner(workspacePath);

    const result = await runner.run("true && printf ok");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok");
  });
});

test("host shell runner closes stdin so stdin-reading commands do not hang", async () => {
  await withWorkspace(async (workspacePath) => {
    const runner = createHostShellRunner(workspacePath);

    // `cat` with no file reads stdin until EOF. With stdin closed it returns
    // immediately; without the fix this would hang forever.
    const result = await runner.run("cat");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });
});

test("host shell runner enforces idle and total timeouts", async () => {
  await withWorkspace(async (workspacePath) => {
    const idleRunner = createHostShellRunner(workspacePath, {}, undefined, {
      commandMs: 5_000,
      idleMs: 20,
      deadlineAt: Date.now() + 5_000,
    });
    const idleResult = await idleRunner.run("sleep 1");
    assert.equal(idleResult.exitCode, 124);

    const expiredRunner = createHostShellRunner(workspacePath, {}, undefined, {
      commandMs: 5_000,
      idleMs: 5_000,
      deadlineAt: Date.now() - 1,
    });
    const expiredResult = await expiredRunner.run("sleep 1");
    assert.equal(expiredResult.exitCode, 124);
  });
});

test("host shell runner configures git askpass when a GitHub token is present", async () => {
  await withWorkspace(async (workspacePath) => {
    const runner = createHostShellRunner(workspacePath, {
      GITHUB_TOKEN: "secret-token",
    });

    const result = await runner.run('"$GIT_ASKPASS" Username; "$GIT_ASKPASS" Password');

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "x-access-token\nsecret-token");
  });
});

test("host shell runner leaves git askpass unset without a GitHub token", async () => {
  await withWorkspace(async (workspacePath) => {
    const runner = createHostShellRunner(workspacePath);

    const result = await runner.run('printf "%s" "${GIT_ASKPASS:-unset}"');

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "unset");
  });
});

test("codex auth logs in with the API key when one is present", () => {
  const wrapped = hostCommandWithCodexAuth("codex exec --model gpt", undefined, {
    OPENAI_API_KEY: "sk-test",
  });

  assert.match(wrapped, /codex login --with-api-key/);
  assert.match(wrapped, /CODEX_HOME="\$\(mktemp -d\)"/);
  assert.doesNotMatch(wrapped, /cp .*auth\.json/);
  assert.ok(wrapped.endsWith("codex exec --model gpt"));
});

test("codex auth copies the OAuth file when no API key is present", () => {
  const wrapped = hostCommandWithCodexAuth(
    "codex exec --model gpt",
    "/host/.codex/auth.json",
    {},
  );

  assert.match(wrapped, /cp '\/host\/\.codex\/auth\.json'/);
  assert.doesNotMatch(wrapped, /codex login/);
});

test("codex auth is a no-op for commands without credentials", () => {
  assert.equal(hostCommandWithCodexAuth("git status", undefined, {}), "git status");
});

test("codex exec uses the sandbox flag by default", () => {
  const command = codexExecCommand({
    model: "gpt",
    sandbox: "workspace-write",
    prompt: "do it",
  });

  assert.match(command, /--sandbox 'workspace-write'/);
  assert.doesNotMatch(command, /--dangerously-bypass-approvals-and-sandbox/);
});

test("codex exec bypasses the sandbox in direct mode", () => {
  const command = codexExecCommand({
    model: "gpt",
    sandbox: "workspace-write",
    prompt: "do it",
    bypassSandbox: true,
  });

  assert.match(command, /--dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(command, /--sandbox/);
});

test("line stream sink redacts complete lines and flushes the remainder", () => {
  const lines: string[] = [];
  const sink = createLineStreamSink(
    (line) => lines.push(line),
    (input) => input.replaceAll("hunter2", "[REDACTED]"),
  );

  sink.onData("token=");
  sink.onData("hunter2\npartial");
  assert.deepEqual(lines, ["token=[REDACTED]\n"]);

  sink.flush();
  assert.deepEqual(lines, ["token=[REDACTED]\n", "partial\n"]);
});

test("host shell runner streams live output while still buffering the result", async () => {
  await withWorkspace(async (workspacePath) => {
    const streamed: string[] = [];
    const sink = createLineStreamSink((line) => streamed.push(line));
    const runner = createHostShellRunner(workspacePath, {}, sink);

    const result = await runner.run("printf 'a\\nb\\n'");

    // Buffered result is still available (needed for diff/review parsing).
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "a\nb");
    // ...and the same output was streamed live, line-buffered.
    assert.equal(streamed.join(""), "a\nb\n");
  });
});

test("createHostWorkspace makes an empty directory and cleans it up", async () => {
  const workspace = await createHostWorkspace("run-host-workspace");

  const stats = await stat(workspace.workspacePath);
  assert.equal(stats.isDirectory(), true);
  assert.deepEqual(await readdir(workspace.workspacePath), []);

  await workspace.cleanup();
  await assert.rejects(() => stat(workspace.workspacePath), { code: "ENOENT" });
});
