import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCli } from "../src/commands.js";
import type { RunCommandOptions, RunCodexCageResult } from "../src/run.js";
import { openRunStore } from "../src/state.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDir, "..", "src", "cli.js");

function runCli(args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
  });
}

test("root help lists commands", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: codex-cage/);
  assert.match(result.stdout, /\binit\b/);
  assert.match(result.stdout, /\brun\b/);
  assert.match(result.stdout, /\bruns\b/);
  assert.match(result.stdout, /\bcleanup\b/);
});

test("command help is available for commands", () => {
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

test("run accepts a positional issue URL", async () => {
  const calls: RunCommandOptions[] = [];
  const originalConsoleLog = console.log;
  const program = createCli({
    runCodexCage: async (input): Promise<RunCodexCageResult> => {
      calls.push(input);
      return {
        runId: "run-cli-test",
        status: "failed",
        failureCode: null,
        prUrl: null,
      };
    },
  });

  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  console.log = () => undefined;

  try {
    await program.parseAsync(
      [
        "run",
        "https://github.com/jhowliu/codex-cage/issues/35",
        "--repo",
        "jhowliu/codex-cage",
      ],
      { from: "user" },
    );
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(calls, [
    {
      issueUrl: "https://github.com/jhowliu/codex-cage/issues/35",
      repo: "jhowliu/codex-cage",
    },
  ]);
});

test("run keeps the --issue option for compatibility", async () => {
  const calls: RunCommandOptions[] = [];
  const originalConsoleLog = console.log;
  const program = createCli({
    runCodexCage: async (input): Promise<RunCodexCageResult> => {
      calls.push(input);
      return {
        runId: "run-cli-test",
        status: "failed",
        failureCode: null,
        prUrl: null,
      };
    },
  });

  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  console.log = () => undefined;

  try {
    await program.parseAsync(
      ["run", "--issue", "https://github.com/jhowliu/codex-cage/issues/35"],
      { from: "user" },
    );
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(calls, [
    {
      issueUrl: "https://github.com/jhowliu/codex-cage/issues/35",
    },
  ]);
});

test("run accepts --no-publish", async () => {
  const calls: RunCommandOptions[] = [];
  const output: string[] = [];
  const originalConsoleLog = console.log;
  const program = createCli({
    runCodexCage: async (input): Promise<RunCodexCageResult> => {
      calls.push(input);
      return {
        runId: "run-cli-no-publish",
        status: "succeeded",
        failureCode: null,
        prUrl: null,
        noPublish: true,
      };
    },
  });

  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  console.log = (message?: unknown) => {
    output.push(String(message));
  };

  try {
    await program.parseAsync(
      ["run", "https://github.com/jhowliu/codex-cage/issues/35", "--no-publish"],
      { from: "user" },
    );
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(calls, [
    {
      issueUrl: "https://github.com/jhowliu/codex-cage/issues/35",
      noPublish: true,
    },
  ]);
  assert.match(output.join("\n"), /PR: no PR created \(no-publish mode\)/);
  assert.match(output.join("\n"), /\.codex-cage\/runs\/run-cli-no-publish\/final\.patch/);
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

test("runs show can emit color when forced", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-cli-color-"));

  try {
    const store = await openRunStore(cwd);
    await store.createRun({
      id: "run-color",
      issueUrl: "https://github.com/jhowliu/codex-cage/issues/4",
      issueKey: "GH-4",
      repo: "jhowliu/codex-cage",
      baseBranch: "main",
      branch: "codex-cage/gh-4-run-color",
      startedAt: new Date("2026-04-25T00:00:00.000Z"),
    });
    await store.updateRunStatus("run-color", {
      status: "succeeded",
      prUrl: "https://github.com/jhowliu/codex-cage/pull/4",
      finishedAt: new Date("2026-04-25T00:02:00.000Z"),
    });
    store.close();

    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
    delete env.NO_COLOR;

    const showResult = runCli(["runs", "show", "run-color"], cwd, env);
    assert.equal(showResult.status, 0);
    assert.match(showResult.stdout, /\u001B\[/);
    assert.match(showResult.stdout, /Status/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
