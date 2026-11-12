import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  databaseFileName,
  isProcessAlive,
  isRunInterrupted,
  openRunStore,
  openRunStoreReadOnly,
  runsDirectoryName,
  stateDirectoryName,
  type CreateRunInput,
  type RunRecord,
} from "../src/state.js";

// Above the largest pid Linux or macOS assigns, so no process has it.
const deadPid = 2 ** 22 + 12_345;

async function tempStateDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-cage-state-"));
}

function runInput(id: string): CreateRunInput {
  return {
    id,
    issueUrl: "https://github.com/jhowliu/agent-cage/issues/4",
    issueKey: "GH-4",
    repo: "jhowliu/agent-cage",
    baseBranch: "main",
    branch: `agent-cage/gh-4-${id}`,
    startedAt: new Date("2026-04-25T00:00:00.000Z"),
  };
}

test("run store persists runs, phases, review cycles, and artifacts", async () => {
  const cwd = await tempStateDirectory();

  try {
    const store = await openRunStore(cwd);
    const startedAt = new Date("2026-04-25T00:00:00.000Z");

    const run = await store.createRun({
      id: "run-1",
      issueUrl: "https://github.com/jhowliu/agent-cage/issues/4",
      issueKey: "GH-4",
      repo: "jhowliu/agent-cage",
      baseBranch: "main",
      branch: "agent-cage/gh-4-run-1",
      startedAt,
    });

    assert.equal(run.status, "queued");
    assert.ok(
      existsSync(join(cwd, stateDirectoryName, databaseFileName)),
      "expected SQLite database file",
    );
    assert.ok(
      existsSync(join(cwd, stateDirectoryName, runsDirectoryName, "run-1")),
      "expected run artifact directory",
    );

    const setupPhase = await store.startPhase({
      runId: "run-1",
      name: "setup",
      startedAt,
      logPath: ".agent-cage/runs/run-1/setup.log",
    });
    await store.finishPhase({
      phaseId: setupPhase.id,
      status: "passed",
      finishedAt: new Date("2026-04-25T00:01:00.000Z"),
    });
    await store.addReviewCycle({
      runId: "run-1",
      cycle: 1,
      decision: "pass",
      reportPath: ".agent-cage/runs/run-1/review-cycle-1.json",
    });
    const summaryPath = await store.writeArtifact("run-1", "summary.md", "# Summary\n");
    await store.updateRunStatus("run-1", {
      status: "succeeded",
      prUrl: "https://github.com/jhowliu/agent-cage/pull/15",
      finishedAt: new Date("2026-04-25T00:02:00.000Z"),
    });

    assert.equal(await readFile(summaryPath, "utf8"), "# Summary\n");
    store.close();

    const reopenedStore = await openRunStore(cwd);
    const runs = reopenedStore.listRuns();
    const details = reopenedStore.getRunDetails("run-1");

    assert.equal(runs.length, 1);
    assert.equal(details.run.status, "succeeded");
    assert.equal(details.run.prUrl, "https://github.com/jhowliu/agent-cage/pull/15");
    assert.equal(details.phases.length, 1);
    assert.equal(details.phases[0]?.status, "passed");
    assert.equal(details.reviewCycles.length, 1);
    assert.equal(details.reviewCycles[0]?.decision, "pass");
    assert.match(details.artifacts["summary"] ?? "", /summary\.md$/);

    reopenedStore.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run store fails clearly for unknown runs", async () => {
  const cwd = await tempStateDirectory();

  try {
    const store = await openRunStore(cwd);

    assert.throws(() => store.getRun("missing"), /Run missing does not exist/);

    store.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run stores opened by parallel runs keep each other's writes", async () => {
  const cwd = await tempStateDirectory();

  try {
    // Two runs in the same repository hold their own connections, like two
    // concurrent `agent-cage run` processes.
    const first = await openRunStore(cwd);
    const second = await openRunStore(cwd);

    await first.createRun(runInput("run-a"));
    await second.createRun(runInput("run-b"));
    const phase = await first.startPhase({ runId: "run-a", name: "implement" });
    await second.updateRunStatus("run-b", {
      status: "failed",
      failureCode: "verify_failed",
    });
    await first.finishPhase({ phaseId: phase.id, status: "passed" });
    first.close();
    second.close();

    const reader = await openRunStoreReadOnly(cwd);
    const runIds = reader
      .listRuns()
      .map((run) => run.id)
      .sort();

    assert.deepEqual(runIds, ["run-a", "run-b"]);
    assert.equal(reader.getRun("run-b").failureCode, "verify_failed");
    assert.equal(reader.getRunDetails("run-a").phases[0]?.status, "passed");
    reader.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read-only run store sees in-progress writes and rejects its own writes", async () => {
  const cwd = await tempStateDirectory();

  try {
    const writer = await openRunStore(cwd);
    await writer.createRun(runInput("run-live"));

    const reader = await openRunStoreReadOnly(cwd);
    assert.equal(reader.getRun("run-live").status, "queued");

    await writer.updateRunStatus("run-live", { status: "implementing" });
    assert.equal(reader.getRun("run-live").status, "implementing");
    await assert.rejects(reader.createRun(runInput("run-other")), /readonly/i);

    reader.close();
    writer.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read-only run store treats a repository without a database as having no runs", async () => {
  const cwd = await tempStateDirectory();

  try {
    const reader = await openRunStoreReadOnly(cwd);

    assert.deepEqual(reader.listRuns(), []);
    assert.throws(() => reader.getRun("missing"), /Run missing does not exist/);
    reader.close();
    assert.equal(existsSync(join(cwd, stateDirectoryName)), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run store records the process that runs each run", async () => {
  const cwd = await tempStateDirectory();

  try {
    const store = await openRunStore(cwd);

    assert.equal((await store.createRun(runInput("run-own"))).pid, process.pid);
    assert.equal(
      (await store.createRun({ ...runInput("run-other"), pid: 4242 })).pid,
      4242,
    );
    store.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a run is interrupted only when it never finished and its process is gone", () => {
  const run = (overrides: Partial<RunRecord>): RunRecord => ({
    id: "run-1",
    issueUrl: "https://github.com/jhowliu/agent-cage/issues/4",
    issueKey: "GH-4",
    repo: "jhowliu/agent-cage",
    baseBranch: "main",
    branch: "agent-cage/gh-4-run-1",
    status: "implementing",
    failureCode: null,
    prUrl: null,
    startedAt: "2026-04-25T00:00:00.000Z",
    finishedAt: null,
    pid: deadPid,
    ...overrides,
  });

  assert.equal(isRunInterrupted(run({})), true);
  assert.equal(isRunInterrupted(run({ pid: process.pid })), false, "still running");
  assert.equal(
    isRunInterrupted(run({ status: "failed", finishedAt: "2026-04-25T00:02:00.000Z" })),
    false,
    "finished",
  );
  assert.equal(isRunInterrupted(run({ pid: null })), false, "recorded without a pid");
});

test("a process owned by another user counts as alive", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(deadPid), false);
  assert.equal(
    isProcessAlive(1),
    true,
    "pid 1 exists, and kill(1, 0) fails with EPERM unless root",
  );
});

test("a database from an earlier version gains a pid column and keeps its runs", async () => {
  const cwd = await tempStateDirectory();

  try {
    await mkdir(join(cwd, stateDirectoryName), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(join(cwd, stateDirectoryName, databaseFileName));
    old.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, issue_url TEXT NOT NULL, issue_key TEXT NOT NULL,
        repo TEXT NOT NULL, base_branch TEXT NOT NULL, branch TEXT NOT NULL,
        status TEXT NOT NULL, failure_code TEXT, pr_url TEXT,
        started_at TEXT NOT NULL, finished_at TEXT
      );
      INSERT INTO schema_migrations VALUES (1, '1970-01-01T00:00:00.000Z');
      INSERT INTO runs (id, issue_url, issue_key, repo, base_branch, branch, status, started_at)
      VALUES ('run-old', 'https://github.com/jhowliu/agent-cage/issues/4', 'GH-4',
              'jhowliu/agent-cage', 'main', 'agent-cage/gh-4-run-old', 'implementing',
              '2026-04-25T00:00:00.000Z');
    `);
    old.close();

    const reader = await openRunStoreReadOnly(cwd);
    assert.equal(
      reader.getRun("run-old").pid,
      null,
      "a read-only store reads it unmigrated",
    );
    reader.close();

    const store = await openRunStore(cwd);
    await store.createRun(runInput("run-new"));
    assert.equal(store.getRun("run-old").pid, null);
    assert.equal(store.getRun("run-new").pid, process.pid);
    store.close();

    const reopened = await openRunStore(cwd);
    assert.deepEqual(
      reopened.listRuns().map((run) => run.id),
      ["run-old", "run-new"],
      "migrating an up-to-date database changes nothing",
    );
    reopened.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
