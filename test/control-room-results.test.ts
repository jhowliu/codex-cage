import assert from "node:assert/strict";
import test from "node:test";
import type { ControlRunRecord } from "../src/control-room.js";
import { parseChangeDiff } from "../src/control-room-diff.js";
import { buildStageResult } from "../src/control-room-results.js";
import {
  runEventSchema,
  type CanonicalStage,
  type RunEvent,
  type RunEventDetails,
} from "../src/run/events.js";

const timestamp = "2026-10-15T10:00:00.000Z";

function event(details: RunEventDetails, sequence: number): RunEvent {
  return runEventSchema.parse({
    protocolVersion: 1,
    eventId: `event-${sequence}`,
    runId: "run-results",
    sequence,
    occurredAt: new Date(Date.parse(timestamp) + sequence * 1_000).toISOString(),
    ...details,
  });
}

function run(
  stage: CanonicalStage,
  events: RunEvent[],
  overrides: Partial<ControlRunRecord> = {},
): ControlRunRecord {
  return {
    id: "run-results",
    repositoryId: "repository",
    issueUrl: "https://github.com/example/repo/issues/1",
    status: "running",
    observationMode: "live",
    events,
    stages: [
      {
        stage,
        attempt: 1,
        status: "running",
        startedAt: timestamp,
        finishedAt: null,
        failureCode: null,
      },
    ],
    currentStage: stage,
    lastSequence: events.length,
    failureCode: null,
    prUrl: null,
    startedAt: timestamp,
    finishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    canCancel: true,
    artifacts: [],
    ...overrides,
  };
}

const noRead = async (): Promise<string> => {
  throw new Error("No artifact should be read.");
};

test("diff preview preserves file operations and literal content without counting headers as changes", () => {
  const result = parseChangeDiff(`diff --git a/src/hello world.ts b/src/hello world.ts
--- a/src/hello world.ts
+++ b/src/hello world.ts
@@ -1 +1,2 @@
-old
+<script>alert('literal')</script>
+new
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/logo.png b/logo.png
new file mode 100644
GIT binary patch
literal 10
secret-binary-payload
diff --git a/removed.ts b/removed.ts
deleted file mode 100644
--- a/removed.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
`);
  assert.equal(result.files[0]?.path, "src/hello world.ts");
  assert.equal(result.files[0]?.lines[2]?.text, "+<script>alert('literal')</script>");
  assert.equal(result.files[1]?.kind, "renamed");
  assert.equal(result.files[1]?.previousPath, "old.ts");
  assert.equal(result.files[2]?.binary, true);
  assert.deepEqual(result.files[2]?.lines, []);
  assert.equal(result.files[3]?.kind, "deleted");
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 2);
});

test("diff preview bounds large patches and reports that its counts are partial", () => {
  const result = parseChangeDiff(
    `diff --git a/large.ts b/large.ts\n@@ -0,0 +1,2050 @@\n${"+line\n".repeat(2_050)}`,
  );
  assert.equal(result.truncated, true);
  assert.equal(result.files[0]?.lines.length, 2_000);
  assert.equal(parseChangeDiff("").files.length, 0);
  assert.throws(() => parseChangeDiff("not a patch"), /Git unified diff/);
});

test("Prepare exposes target and activity results without private artifact directories", async () => {
  const events = [
    event(
      {
        type: "run.started",
        payload: {
          issueKey: "#1",
          issueTitle: "Fix login",
          repository: "example/repo",
          baseBranch: "main",
          branch: "cage/fix",
          artifactDirectory: "/private/credential-source",
          executionMode: "docker",
        },
      },
      1,
    ),
    event(
      {
        type: "activity.finished",
        stage: "prepare",
        stageAttempt: 1,
        payload: { activity: "cloning", logRef: "/private/run/cloning.log" },
      },
      2,
    ),
  ];
  const result = await buildStageResult(run("prepare", events), "prepare", noRead);
  assert.equal(result.stage, "prepare");
  if (result.stage !== "prepare") return;
  assert.equal(result.target?.baseBranch, "main");
  assert.equal(result.activities[0]?.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(result), /\/private/);
});

test("Verify joins command completions only for the latest attempt and excludes orchestration commands", async () => {
  const events = [
    event(
      {
        type: "command.started",
        stage: "verify",
        stageAttempt: 1,
        payload: { command: "old check", logRef: "/run/verify.log" },
      },
      1,
    ),
    event(
      {
        type: "command.started",
        stage: "verify",
        stageAttempt: 2,
        payload: { command: "npm test", logRef: "/run/verify.log" },
      },
      2,
    ),
    event(
      {
        type: "command.finished",
        stage: "verify",
        stageAttempt: 2,
        payload: {
          startedEventId: "event-2",
          command: "npm test",
          logRef: "/run/verify.log",
          outcome: "failed",
          exitCode: 2,
        },
      },
      3,
    ),
    event(
      {
        type: "command.started",
        stage: "verify",
        stageAttempt: 2,
        payload: { command: "git diff", logRef: null },
      },
      4,
    ),
    event(
      {
        type: "verification.updated",
        stage: "verify",
        stageAttempt: 2,
        payload: {
          kind: "commands",
          status: "failed",
          commandCount: 2,
          passedCount: 0,
          logRef: "/run/verify.log",
        },
      },
      5,
    ),
  ];
  const result = await buildStageResult(
    run("verify", events, {
      stages: [
        {
          stage: "verify",
          attempt: 2,
          status: "failed",
          startedAt: timestamp,
          finishedAt: timestamp,
          failureCode: "verify_failed",
        },
      ],
    }),
    "verify",
    noRead,
  );
  assert.equal(result.stage, "verify");
  if (result.stage !== "verify") return;
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]?.command, "npm test");
  assert.equal(result.commands[0]?.exitCode, 2);
  assert.equal(result.verification?.commandCount, 2);
  assert.equal(result.secretGuard, null);
});

test("Review retains blocking verdicts, validates findings, and handles missing or inconsistent reports", async () => {
  const review = event(
    {
      type: "review.finished",
      stage: "review",
      stageAttempt: 1,
      payload: {
        cycle: 0,
        decision: "blocking",
        summary: "Fix access control.",
        findingCount: 1,
        reportRef: "/run/review-0.json",
      },
    },
    1,
  );
  const record = run("review", [review], { artifacts: ["review-0.json"] });
  const report = {
    decision: "blocking",
    summary: "Fix access control.",
    findings: [
      {
        severity: "blocking",
        path: "src/auth.ts",
        line: 18,
        message: "Check ownership before returning a record.",
      },
    ],
  };
  const result = await buildStageResult(record, "review", async (name) => {
    assert.equal(name, "review-0.json");
    return JSON.stringify(report);
  });
  assert.equal(result.stage, "review");
  if (result.stage !== "review") return;
  assert.equal(result.verdict?.decision, "blocking");
  assert.equal(result.report.status, "available");
  if (result.report.status === "available")
    assert.equal(result.report.value.findings[0]?.line, 18);
  const missing = await buildStageResult(record, "review", noRead);
  assert.ok(missing.stage === "review" && missing.report.status === "unavailable");
  const inconsistent = await buildStageResult(record, "review", async () =>
    JSON.stringify({ decision: "pass", summary: "Pass", findings: [] }),
  );
  assert.ok(inconsistent.stage === "review" && inconsistent.report.status === "invalid");
  const malformed = await buildStageResult(record, "review", async () => "not JSON");
  assert.ok(malformed.stage === "review" && malformed.report.status === "invalid");
});

test("evidence reads require an announced artifact and never follow a report's original path", async () => {
  const review = event(
    {
      type: "review.finished",
      stage: "review",
      stageAttempt: 1,
      payload: {
        cycle: 0,
        decision: "pass",
        summary: "Pass",
        findingCount: 0,
        reportRef: "/etc/passwd",
      },
    },
    1,
  );
  let reads = 0;
  const result = await buildStageResult(run("review", [review]), "review", async () => {
    reads += 1;
    return "";
  });
  assert.ok(result.stage === "review" && result.report.status === "unavailable");
  assert.equal(reads, 0);
});

test("Implement uses its current change snapshot and does not borrow a previous iteration's patch", async () => {
  const iteration = event(
    {
      type: "implementation.iteration_started",
      stage: "implement",
      stageAttempt: 2,
      payload: { iteration: 2, maxIterations: 5 },
    },
    1,
  );
  const record = run("implement", [iteration], {
    stages: [
      {
        stage: "implement",
        attempt: 2,
        status: "running",
        startedAt: timestamp,
        finishedAt: null,
        failureCode: null,
      },
    ],
    artifacts: ["changes-1.patch", "changes-2.patch", "verify.log"],
  });
  const result = await buildStageResult(record, "implement", async (name) => {
    assert.equal(name, "changes-2.patch");
    return "diff --git a/app.ts b/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
  });
  assert.ok(result.stage === "implement" && result.changes.status === "available");
  assert.deepEqual(result.artifacts, ["changes-2.patch"]);
  const waiting = await buildStageResult(
    { ...record, artifacts: ["changes-1.patch"] },
    "implement",
    noRead,
  );
  assert.ok(waiting.stage === "implement" && waiting.changes.status === "unavailable");
});

test("pending, interrupted, and preflight-failed results do not invent successful work", async () => {
  const pending = await buildStageResult(
    run("prepare", [], { stages: [], status: "queued" }),
    "publish",
    noRead,
  );
  assert.equal(pending.status, "pending");
  const aborted = await buildStageResult(
    run("verify", [], { status: "aborted" }),
    "verify",
    noRead,
  );
  assert.equal(aborted.status, "aborted");
  const failed = await buildStageResult(
    run("prepare", [], { stages: [], status: "failed", failureCode: "internal_error" }),
    "prepare",
    noRead,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "internal_error");
});

test("Publish uses recorded metadata and only offers safe GitHub pull request links", async () => {
  for (const [url, expected] of [
    ["https://github.com/example/repo/pull/1", "https://github.com/example/repo/pull/1"],
    ["javascript:alert(1)", null],
    ["https://github.com:123/example/repo/pull/1", null],
  ] as const) {
    const change = event(
      {
        type: "change.created",
        stage: "publish",
        stageAttempt: 1,
        payload: {
          branch: "cage/fix",
          commitMessage: "Fix login",
          title: "#1 Fix login",
          url,
          metadataRef: "/run/pr.json",
        },
      },
      1,
    );
    const result = await buildStageResult(run("publish", [change]), "publish", noRead);
    assert.ok(result.stage === "publish" && result.change !== null);
    assert.equal(result.change.url, expected);
    assert.equal(result.change.commitMessage, "Fix login");
  }
});
