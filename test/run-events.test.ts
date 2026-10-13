import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseRunEvent,
  parseRunEventLine,
  phaseToCanonicalStage,
  replayRunEvents,
  RunEventJournal,
  runEventProtocolVersion,
  type RunEvent,
  type RunEventDetails,
} from "../src/run/events.js";

function runStartedDetails(
  issueTitle = "Persist Runner events",
): Extract<RunEventDetails, { type: "run.started" }> {
  return {
    type: "run.started",
    payload: {
      issueKey: "#105",
      issueTitle,
      repository: "jhowliu/codex-cage",
      baseBranch: "main",
      branch: "codex-cage/gh-105-run-events",
      artifactDirectory: "/tmp/run-events",
      executionMode: "direct",
    },
  };
}

test("RunEvent schema is versioned, strict, and validates canonical activity context", () => {
  const valid: unknown = {
    protocolVersion: runEventProtocolVersion,
    eventId: "run-1:1",
    runId: "run-1",
    sequence: 1,
    occurredAt: "2026-10-11T00:00:00.000Z",
    ...runStartedDetails(),
  };

  assert.equal(parseRunEvent(valid).type, "run.started");
  assert.throws(
    () => parseRunEvent({ ...parseRunEvent(valid), protocolVersion: 2 }),
    /Invalid literal value|Invalid input/,
  );
  assert.throws(
    () => parseRunEvent({ ...parseRunEvent(valid), unexpected: true }),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      parseRunEvent({
        protocolVersion: runEventProtocolVersion,
        eventId: "run-1:2",
        runId: "run-1",
        sequence: 2,
        occurredAt: "2026-10-11T00:00:01.000Z",
        type: "activity.started",
        stage: "implement",
        stageAttempt: 1,
        payload: { activity: "cloning", logRef: "/tmp/cloning.log" },
      }),
    /activity does not belong/,
  );
  assert.throws(
    () =>
      parseRunEvent({
        protocolVersion: runEventProtocolVersion,
        eventId: "run-1:3",
        runId: "run-1",
        sequence: 3,
        occurredAt: "2026-10-11T00:00:02.000Z",
        type: "command.finished",
        stage: "verify",
        stageAttempt: 1,
        payload: {
          startedEventId: "run-1:2",
          command: "npm test",
          outcome: "succeeded",
          exitCode: 1,
          logRef: "/tmp/verify.log",
        },
      }),
    /Invalid literal value|Invalid input/,
  );
});

test("RunEventJournal sequences, redacts, bounds, and appends before delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cage-events-"));
  const path = join(directory, "events.ndjson");
  const delivered: RunEvent[] = [];
  let clockTick = 0;

  try {
    const journal = new RunEventJournal({
      runId: "run-ordering",
      path,
      redact: (value) => value.replaceAll("known-secret", "[REDACTED]"),
      now: () => new Date(Date.UTC(2026, 9, 11, 0, 0, clockTick++)),
      sink: async (event) => {
        const persisted = (await readFile(path, "utf8"))
          .trim()
          .split("\n")
          .map(parseRunEventLine);
        assert.equal(persisted.at(-1)?.eventId, event.eventId);
        delivered.push(event);
      },
    });

    await journal.append(runStartedDetails(`known-secret ${"x".repeat(3_000)}`));
    await journal.append({
      type: "stage.started",
      stage: "prepare",
      stageAttempt: 1,
      payload: {},
    });

    const persistedText = await readFile(path, "utf8");
    const persisted = persistedText.trim().split("\n").map(parseRunEventLine);

    assert.deepEqual(
      persisted.map((event) => event.sequence),
      [1, 2],
    );
    assert.equal(new Set(persisted.map((event) => event.eventId)).size, 2);
    assert.deepEqual(delivered, persisted);
    assert.doesNotMatch(persistedText, /known-secret/);

    const started = persisted[0];
    assert.equal(started?.type, "run.started");
    if (started?.type === "run.started") {
      assert.ok(started.payload.issueTitle.length <= 2_048);
      assert.match(started.payload.issueTitle, /\[REDACTED\]/);
      assert.match(started.payload.issueTitle, /\.\.\.\[truncated\]$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RunEventJournal keeps durable sequencing when observer delivery fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cage-events-failed-sink-"));
  const path = join(directory, "events.ndjson");
  const originalConsoleError = console.error;
  const deliveryErrors: string[] = [];
  console.error = (message?: unknown): void => {
    deliveryErrors.push(String(message));
  };

  try {
    const journal = new RunEventJournal({
      runId: "run-failed-sink",
      path,
      redact: (value) => value,
      sink: () => {
        throw new Error("observer unavailable");
      },
    });

    await journal.append(runStartedDetails());
    await journal.append({
      type: "stage.started",
      stage: "prepare",
      stageAttempt: 1,
      payload: {},
    });

    const persisted = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map(parseRunEventLine);
    assert.deepEqual(
      persisted.map((event) => event.sequence),
      [1, 2],
    );
    assert.equal(deliveryErrors.length, 2);
  } finally {
    console.error = originalConsoleError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay validates NDJSON, ignores exact duplicate delivery, and restores outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cage-replay-"));
  const path = join(directory, "events.ndjson");

  try {
    const journal = new RunEventJournal({
      runId: "run-replay",
      path,
      redact: (value) => value,
      now: () => new Date("2026-10-11T00:00:00.000Z"),
    });

    await journal.append(runStartedDetails());
    await journal.append({
      type: "stage.started",
      stage: "prepare",
      stageAttempt: 1,
      payload: {},
    });
    await journal.append({
      type: "stage.finished",
      stage: "prepare",
      stageAttempt: 1,
      payload: {},
    });
    await journal.append({
      type: "stage.started",
      stage: "implement",
      stageAttempt: 1,
      payload: {},
    });
    await journal.append({
      type: "stage.failed",
      stage: "implement",
      stageAttempt: 1,
      payload: { failureCode: "internal_error" },
    });
    await journal.append({
      type: "run.finished",
      payload: {
        status: "failed",
        failureCode: "internal_error",
        prUrl: null,
      },
    });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const duplicate = lines[1];
    assert.ok(duplicate !== undefined);
    const replay = replayRunEvents(
      [...lines.slice(0, 3), duplicate, ...lines.slice(3)].join("\n"),
    );

    assert.equal(replay.status, "failed");
    assert.equal(replay.failureCode, "internal_error");
    assert.equal(replay.lastSequence, 6);
    assert.deepEqual(
      replay.stages.map((stage) => ({
        stage: stage.stage,
        attempt: stage.attempt,
        status: stage.status,
        failureCode: stage.failureCode,
      })),
      [
        { stage: "prepare", attempt: 1, status: "succeeded", failureCode: null },
        {
          stage: "implement",
          attempt: 1,
          status: "failed",
          failureCode: "internal_error",
        },
      ],
    );

    const thirdLine = lines[2];
    assert.ok(thirdLine !== undefined);
    const thirdEvent = parseRunEventLine(thirdLine);
    assert.throws(
      () =>
        replayRunEvents(
          [
            lines[0],
            JSON.stringify({
              ...thirdEvent,
              eventId: "run-replay:gap",
              sequence: 3,
            }),
          ].join("\n"),
        ),
      /Expected run event sequence 2/,
    );
    assert.throws(() => replayRunEvents("not-json\n"), /Invalid run event on line 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy phases map deterministically to canonical Stages", () => {
  assert.deepEqual(
    (
      [
        "preflight",
        "runtime_image",
        "cloning",
        "setup",
        "implement",
        "verify",
        "review",
        "pr",
      ] as const
    ).map((phase) => phaseToCanonicalStage(phase)),
    [
      "prepare",
      "prepare",
      "prepare",
      "prepare",
      "implement",
      "verify",
      "review",
      "publish",
    ],
  );
});
