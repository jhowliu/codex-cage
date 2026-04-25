import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openRunStore } from "../src/state.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDir, "..", "src", "cli.js");

function runCli(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("root help lists MVP commands", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: codex-cage/);
  assert.match(result.stdout, /\binit\b/);
  assert.match(result.stdout, /\brun\b/);
  assert.match(result.stdout, /\bruns\b/);
  assert.match(result.stdout, /\bcleanup\b/);
});

test("command help is available for MVP commands", () => {
  const commands = [
    ["init", "--help"],
    ["run", "--help"],
    ["runs", "list", "--help"],
    ["runs", "show", "--help"],
    ["cleanup", "--help"],
  ];

  for (const command of commands) {
    const result = runCli(command);

    assert.equal(result.status, 0, command.join(" "));
    assert.match(result.stdout, /Usage:/);
  }
});

test("runs list and show read local run metadata", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-cli-runs-"));

  try {
    const store = await openRunStore(cwd);
    await store.createRun({
      id: "run-1",
      issueUrl: "https://github.com/jhowliu/codex-cage/issues/4",
      issueKey: "GH-4",
      repo: "jhowliu/codex-cage",
      baseBranch: "main",
      branch: "codex-cage/gh-4-run-1",
      startedAt: new Date("2026-04-25T00:00:00.000Z"),
    });
    await store.updateRunStatus("run-1", {
      status: "failed",
      failureCode: "verify_failed",
      finishedAt: new Date("2026-04-25T00:02:00.000Z"),
    });
    store.close();

    const listResult = runCli(["runs", "list"], cwd);
    assert.equal(listResult.status, 0);
    assert.match(listResult.stdout, /run-1\s+GH-4\s+failed\s+verify_failed/);

    const showResult = runCli(["runs", "show", "run-1"], cwd);
    assert.equal(showResult.status, 0);
    assert.match(showResult.stdout, /Run: run-1/);
    assert.match(showResult.stdout, /Failure: verify_failed/);
    assert.match(showResult.stdout, /Artifacts:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
