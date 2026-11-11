import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  databaseFileName,
  openRunStore,
  openRunStoreReadOnly,
  runsDirectoryName,
  stateDirectoryName,
  type CreateRunInput,
} from "../src/state.js";

async function tempStateDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codex-cage-state-"));
}

function runInput(id: string): CreateRunInput {
  return {
    id,
    issueUrl: "https://github.com/jhowliu/codex-cage/issues/4",
    issueKey: "GH-4",
    repo: "jhowliu/codex-cage",
    baseBranch: "main",
    branch: `codex-cage/gh-4-${id}`,
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
      issueUrl: "https://github.com/jhowliu/codex-cage/issues/4",
      issueKey: "GH-4",
      repo: "jhowliu/codex-cage",
      baseBranch: "main",
      branch: "codex-cage/gh-4-run-1",
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
      logPath: ".codex-cage/runs/run-1/setup.log",
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
      reportPath: ".codex-cage/runs/run-1/review-cycle-1.json",
    });
    const summaryPath = await store.writeArtifact("run-1", "summary.md", "# Summary\n");
    await store.updateRunStatus("run-1", {
      status: "succeeded",
      prUrl: "https://github.com/jhowliu/codex-cage/pull/15",
      finishedAt: new Date("2026-04-25T00:02:00.000Z"),
    });

    assert.equal(await readFile(summaryPath, "utf8"), "# Summary\n");
    store.close();

    const reopenedStore = await openRunStore(cwd);
    const runs = reopenedStore.listRuns();
    const details = reopenedStore.getRunDetails("run-1");

    assert.equal(runs.length, 1);
    assert.equal(details.run.status, "succeeded");
    assert.equal(details.run.prUrl, "https://github.com/jhowliu/codex-cage/pull/15");
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
    // concurrent `codex-cage run` processes.
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
