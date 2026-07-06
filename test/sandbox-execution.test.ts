import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codexExecCommand,
  createHostShellRunner,
  createHostWorkspace,
  createLineStreamSink,
  hostCommandWithCodexAuth,
} from "../src/sandbox-execution.js";

async function withWorkspace(
  fn: (workspacePath: string) => Promise<void>,
): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codex-cage-host-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
