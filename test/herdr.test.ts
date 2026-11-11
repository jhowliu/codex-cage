import assert from "node:assert/strict";
import test from "node:test";
import { createCli } from "../src/commands.js";
import { createHerdrRunEventSink, herdrPaneFromEnv } from "../src/herdr.js";
import type { RunCodexCageDependencies, RunCodexCageResult } from "../src/run.js";
import { parseRunEvent, type RunEvent, type RunEventDetails } from "../src/run/events.js";

let eventSequence = 0;

function event(details: RunEventDetails): RunEvent {
  eventSequence += 1;
  return parseRunEvent({
    ...details,
    protocolVersion: 1,
    eventId: `event-${eventSequence}`,
    runId: "run-1",
    sequence: eventSequence,
    occurredAt: "2026-11-11T00:00:00.000Z",
  });
}

const runStarted = event({
  type: "run.started",
  payload: {
    issueKey: "#1",
    issueTitle: "Add multiply()",
    repository: "jhowliu/codex-cage-sandbox",
    baseBranch: "main",
    branch: "codex-cage/1-add-multiply",
    artifactDirectory: ".codex-cage/runs/run-1",
    executionMode: "docker",
  },
});

function stageStarted(
  stage: "prepare" | "implement" | "verify",
  stageAttempt: number,
): RunEvent {
  return event({ type: "stage.started", stage, stageAttempt, payload: {} });
}

/** Records herdr commands, replacing each `--seq` value after checking it increases. */
function recorder() {
  const commands: string[][] = [];
  let lastSequence = 0n;

  return {
    commands,
    runCommand: async (args: readonly string[]): Promise<void> => {
      const recorded = [...args];
      const seqIndex = recorded.indexOf("--seq");

      if (seqIndex !== -1) {
        const sequence = BigInt(recorded[seqIndex + 1] ?? "0");
        assert.ok(sequence > lastSequence, "--seq must increase");
        lastSequence = sequence;
        recorded[seqIndex + 1] = "<seq>";
      }

      commands.push(recorded);
    },
  };
}

const reportAgent = ["pane", "report-agent", "wP:p3", "--source", "codex-cage"];

/** The expected `report-metadata` command for issue #1 in pane wP:p3. */
function metadata(displayAgent: string, ...stateLabels: string[]): string[] {
  return [
    "pane",
    "report-metadata",
    "wP:p3",
    "--source",
    "codex-cage",
    "--agent",
    "codex-cage",
    "--title",
    "#1 Add multiply()",
    "--display-agent",
    displayAgent,
    ...stateLabels.flatMap((label) => ["--state-label", label]),
    "--seq",
    "<seq>",
  ];
}

test("herdrPaneFromEnv finds the pane only inside herdr", () => {
  assert.deepEqual(herdrPaneFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "wP:p3" }), {
    paneId: "wP:p3",
  });
  assert.equal(herdrPaneFromEnv({ HERDR_PANE_ID: "wP:p3" }), null);
  assert.equal(herdrPaneFromEnv({ HERDR_ENV: "1" }), null);
  assert.equal(herdrPaneFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: " " }), null);
});

test("the herdr sink mirrors a successful run into its pane", async () => {
  const { commands, runCommand } = recorder();
  const sink = createHerdrRunEventSink({
    pane: { paneId: "wP:p3" },
    runCommand,
    now: () => 1_000,
  });

  for (const runEvent of [
    runStarted,
    stageStarted("prepare", 1),
    stageStarted("implement", 1),
    event({
      type: "implementation.iteration_started",
      stage: "implement",
      stageAttempt: 1,
      payload: { iteration: 2, maxIterations: 3 },
    }),
    event({
      type: "command.started",
      stage: "implement",
      stageAttempt: 1,
      payload: { command: "npm test", logRef: null },
    }),
    stageStarted("implement", 2),
    event({
      type: "run.finished",
      payload: {
        status: "succeeded",
        failureCode: null,
        prUrl: "https://github.com/jhowliu/codex-cage-sandbox/pull/7",
      },
    }),
  ]) {
    await sink(runEvent);
  }

  assert.deepEqual(commands, [
    [
      ...reportAgent,
      "--agent",
      "codex-cage",
      "--state",
      "working",
      "--message",
      "run run-1",
      "--seq",
      "<seq>",
    ],
    metadata("starting"),
    metadata("prepare", "working=prepare"),
    metadata("implement", "working=implement"),
    metadata("implement 2/3", "working=implement 2/3"),
    metadata("implement try 2", "working=implement try 2"),
    metadata("PR opened", "idle=PR opened", "done=PR opened"),
    [
      ...reportAgent,
      "--agent",
      "codex-cage",
      "--state",
      "idle",
      "--message",
      "PR opened. https://github.com/jhowliu/codex-cage-sandbox/pull/7",
      "--seq",
      "<seq>",
    ],
    [
      "notification",
      "show",
      "codex-cage #1: PR opened",
      "--body",
      "https://github.com/jhowliu/codex-cage-sandbox/pull/7",
      "--sound",
      "done",
    ],
  ]);
});

test("the herdr sink marks a failed run blocked and asks for attention", async () => {
  const { commands, runCommand } = recorder();
  const sink = createHerdrRunEventSink({ pane: { paneId: "wP:p3" }, runCommand });

  await sink(runStarted);
  commands.length = 0;
  await sink(
    event({
      type: "run.finished",
      payload: { status: "failed", failureCode: "verify_failed", prUrl: null },
    }),
  );

  assert.deepEqual(commands, [
    metadata("verify_failed", "blocked=failed: verify_failed"),
    [
      ...reportAgent,
      "--agent",
      "codex-cage",
      "--state",
      "blocked",
      "--message",
      "failed: verify_failed. Inspect it with: codex-cage runs show run-1",
      "--seq",
      "<seq>",
    ],
    [
      "notification",
      "show",
      "codex-cage #1: failed: verify_failed",
      "--body",
      "Inspect it with: codex-cage runs show run-1",
      "--sound",
      "request",
    ],
  ]);
});

test("the herdr sink warns once and stops after a herdr command fails", async () => {
  const warnings: string[] = [];
  let calls = 0;
  const sink = createHerdrRunEventSink({
    pane: { paneId: "wP:p3" },
    runCommand: async () => {
      calls += 1;
      throw new Error("spawn herdr ENOENT");
    },
    warn: (message) => warnings.push(message),
  });

  await sink(runStarted);
  await sink(stageStarted("prepare", 1));

  assert.equal(calls, 1);
  assert.deepEqual(warnings, [
    "herdr status updates are off for this run: spawn herdr ENOENT",
  ]);
});

test("codex-cage run reports to herdr only inside a herdr pane", async () => {
  const result: RunCodexCageResult = {
    runId: "run-1",
    status: "succeeded",
    failureCode: null,
    prUrl: "https://github.com/jhowliu/codex-cage-sandbox/pull/7",
  };
  const runWithEnv = async (env: Record<string, string | undefined>) => {
    let received: RunCodexCageDependencies | undefined;
    const program = createCli({
      runCodexCage: async (_input, dependencies): Promise<RunCodexCageResult> => {
        received = dependencies;
        return result;
      },
    });
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

    await withEnv(env, async () => {
      await withSilencedConsole(async () => {
        await program.parseAsync(["run", "https://github.com/o/r/issues/1"], {
          from: "user",
        });
      });
    });
    return received;
  };

  const inside = await runWithEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "wP:p3" });
  const outside = await runWithEnv({ HERDR_ENV: undefined, HERDR_PANE_ID: undefined });

  assert.equal(typeof inside?.onEvent, "function");
  assert.equal(outside?.onEvent, undefined);
});

async function withEnv(
  values: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  const assign = (entries: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  assign(values);
  try {
    await body();
  } finally {
    assign(previous);
  }
}

async function withSilencedConsole(body: () => Promise<void>): Promise<void> {
  const { log, error } = console;
  const exitCode = process.exitCode;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await body();
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
}
