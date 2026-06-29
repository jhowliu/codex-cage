import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostShellRunner } from "../src/sandbox-execution.js";

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
