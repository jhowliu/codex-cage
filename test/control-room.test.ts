import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createControlRoomServer,
  type LocalRunnerLauncher,
  type LocalRunnerHandle,
} from "../src/control-room.js";
import { RunEventJournal } from "../src/run/events.js";

async function tempRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-cage-control-room-repo-"));
  await writeFile(
    join(path, ".codex-cage.yml"),
    "verify:\n  - npm test\n\nsetup: []\n",
    "utf8",
  );
  return path;
}

function fakeRunner(): LocalRunnerLauncher {
  return async ({ runId, repositoryPath }): Promise<LocalRunnerHandle> => {
    const directory = join(repositoryPath, ".codex-cage", "runs", runId);
    await mkdir(directory, { recursive: true });
    const eventPath = join(directory, "events.ndjson");
    const resultPath = join(directory, "result.json");
    const journal = new RunEventJournal({
      runId,
      path: eventPath,
      redact: (value) => value,
    });
    const exit = (async (): Promise<number> => {
      await journal.append({
        type: "run.started",
        payload: {
          issueKey: "#123",
          issueTitle: "Control Room smoke path",
          repository: "example/repository",
          baseBranch: "main",
          branch: `codex-cage/${runId}`,
          artifactDirectory: directory,
          executionMode: "docker",
        },
      });
      for (const stage of [
        "prepare",
        "implement",
        "verify",
        "review",
        "publish",
      ] as const) {
        await journal.append({
          type: "stage.started",
          stage,
          stageAttempt: 1,
          payload: {},
        });
        if (stage === "verify") {
          await journal.append({
            type: "verification.updated",
            stage,
            stageAttempt: 1,
            payload: {
              kind: "commands",
              status: "passed",
              commandCount: 1,
              passedCount: 1,
              logRef: join(directory, "verify.log"),
            },
          });
        }
        if (stage === "review") {
          await journal.append({
            type: "review.finished",
            stage,
            stageAttempt: 1,
            payload: {
              cycle: 0,
              decision: "pass",
              summary: "No blocking issues.",
              findingCount: 0,
              reportRef: join(directory, "review-0.json"),
            },
          });
        }
        if (stage === "publish") {
          await journal.append({
            type: "change.created",
            stage,
            stageAttempt: 1,
            payload: {
              branch: `codex-cage/${runId}`,
              commitMessage: "Control Room smoke path",
              title: "Control Room smoke path",
              url: "https://github.com/example/repository/pull/123",
              metadataRef: join(directory, "pr.json"),
            },
          });
        }
        await journal.append({
          type: "stage.finished",
          stage,
          stageAttempt: 1,
          payload: {},
        });
      }
      await journal.append({
        type: "run.finished",
        payload: {
          status: "succeeded",
          failureCode: null,
          prUrl: "https://github.com/example/repository/pull/123",
        },
      });
      await writeFile(
        resultPath,
        JSON.stringify({
          runId,
          status: "succeeded",
          failureCode: null,
          prUrl: "https://github.com/example/repository/pull/123",
        }),
        "utf8",
      );
      return 0;
    })();

    return { eventPath, resultPath, exit, cancel: () => undefined };
  };
}

function pendingRunner(state: { cancelled: boolean }): LocalRunnerLauncher {
  return async ({ runId, repositoryPath }): Promise<LocalRunnerHandle> => {
    const directory = join(repositoryPath, ".codex-cage", "runs", runId);
    await mkdir(directory, { recursive: true });
    const eventPath = join(directory, "events.ndjson");
    const resultPath = join(directory, "result.json");
    let resolveExit: ((code: number) => void) | undefined;
    const exit = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    return {
      eventPath,
      resultPath,
      exit,
      cancel: () => {
        state.cancelled = true;
        resolveExit?.(143);
      },
    };
  };
}

async function json<TValue>(url: string, options?: RequestInit): Promise<TValue> {
  const response = await fetch(url, options);
  const body: unknown = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body as TValue;
}

async function waitForRun(
  url: string,
  runId: string,
): Promise<{ status: string; prUrl: string | null; lastSequence: number }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const run = await json<{
      status: string;
      prUrl: string | null;
      lastSequence: number;
    }>(`${url}/api/runs/${runId}`);
    if (run.status === "succeeded" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

test("Control Room registers a ready repository, streams a local Run, and persists the projection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-control-room-"));
  const repositoryPath = await tempRepository();
  const first = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: fakeRunner(),
  });

  try {
    const repository = await json<{ id: string; status: string }>(
      `${first.url}/api/repositories`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repositoryPath }),
      },
    );
    assert.equal(repository.status, "ready");

    const run = await json<{ id: string }>(`${first.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        issueUrl: "https://github.com/example/repository/issues/123",
      }),
    });
    const completed = await waitForRun(first.url, run.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.prUrl, "https://github.com/example/repository/pull/123");
    assert.equal(completed.lastSequence > 0, true);

    const detail = await json<{
      currentStage: string | null;
      stages: Array<{ stage: string; status: string }>;
      events: unknown[];
    }>(`${first.url}/api/runs/${run.id}`);
    assert.equal(detail.currentStage, null);
    assert.deepEqual(
      detail.stages.map((stage) => [stage.stage, stage.status]),
      [
        ["prepare", "succeeded"],
        ["implement", "succeeded"],
        ["verify", "succeeded"],
        ["review", "succeeded"],
        ["publish", "succeeded"],
      ],
    );
    assert.equal(detail.events.length > 10, true);
  } finally {
    await first.close();
    await rm(repositoryPath, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Control Room keeps repository and Run projections after server restart and serves the React shell", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-control-room-reopen-"));
  const repositoryPath = await tempRepository();
  const first = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: fakeRunner(),
  });
  let runId = "";

  try {
    const repository = await json<{ id: string }>(`${first.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repositoryPath }),
    });
    const run = await json<{ id: string }>(`${first.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        issueUrl: "https://github.com/example/repository/issues/124",
      }),
    });
    runId = run.id;
    await waitForRun(first.url, run.id);
  } finally {
    await first.close();
  }

  const second = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: fakeRunner(),
  });
  try {
    const repositories = await json<Array<{ id: string }>>(
      `${second.url}/api/repositories`,
    );
    const run = await json<{ id: string; status: string }>(
      `${second.url}/api/runs/${runId}`,
    );
    const page = await fetch(`${second.url}/`);
    const html = await page.text();
    const scriptPath = html.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
    assert.ok(scriptPath);
    const script = await fetch(`${second.url}${scriptPath}`);
    assert.equal(repositories.length, 1);
    assert.equal(run.status, "succeeded");
    assert.match(html, /Codex Cage Control Room/);
    assert.equal(script.ok, true);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  } finally {
    await second.close();
    await rm(repositoryPath, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Control Room stops active local Runners during shutdown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-control-room-shutdown-"));
  const repositoryPath = await tempRepository();
  const state = { cancelled: false };
  const server = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: pendingRunner(state),
  });

  try {
    const repository = await json<{ id: string }>(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repositoryPath }),
    });
    await json(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        issueUrl: "https://github.com/example/repository/issues/125",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await server.close();
    await rm(repositoryPath, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }

  assert.equal(state.cancelled, true);
});

test("Control Room rejects invalid repository and unsupported Work Item requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-control-room-invalid-"));
  const server = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: fakeRunner(),
  });

  try {
    const invalidRepository = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(cwd, "missing") }),
    });
    assert.equal(invalidRepository.status, 400);

    const unsupported = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "missing",
        issueUrl: "https://linear.app/acme/issue/ENG-1/task",
      }),
    });
    assert.equal(unsupported.status, 404);
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Control Room reports GitHub auth status without exposing the configured token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-control-room-auth-"));
  await writeFile(
    join(cwd, ".codex-cage.env"),
    "GITHUB_TOKEN=test-token-value\n",
    "utf8",
  );
  const server = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: fakeRunner(),
    githubAuthFetch: async () =>
      new Response(null, { status: 401, statusText: "Unauthorized" }),
  });

  try {
    const response = await fetch(`${server.url}/api/auth/status`);
    const status = (await response.json()) as {
      provider: string;
      status: string;
      source: string;
      message: string;
      checkedAt: string;
    };
    assert.equal(response.status, 200);
    assert.deepEqual(
      {
        provider: status.provider,
        status: status.status,
        source: status.source,
        message: status.message,
      },
      {
        provider: "github",
        status: "invalid",
        source: "codex-cage-env",
        message:
          "GitHub rejected the configured token. Update .codex-cage.env, then recheck.",
      },
    );
    assert.match(status.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(JSON.stringify(status), /test-token-value/);
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Control Room reports missing GitHub auth without making a network request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-control-room-auth-missing-"));
  const server = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: fakeRunner(),
    githubAuthFetch: async () => {
      throw new Error("Auth check should not run without a token.");
    },
  });

  try {
    const response = await fetch(`${server.url}/api/auth/status`);
    const status = (await response.json()) as {
      status: string;
      source: string;
      message: string;
    };
    assert.equal(response.status, 200);
    assert.equal(status.status, "missing");
    assert.equal(status.source, "none");
    assert.equal(
      status.message,
      "Add GITHUB_TOKEN to .codex-cage.env, then recheck authentication.",
    );
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Control Room exposes a loopback SSE snapshot stream", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-control-room-sse-"));
  const server = await createControlRoomServer({
    cwd,
    port: 0,
    launchRunner: fakeRunner(),
  });
  const controller = new AbortController();

  try {
    const response = await fetch(`${server.url}/api/events`, {
      signal: controller.signal,
    });
    assert.equal(
      response.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    const firstChunk = await reader.read();
    assert.match(new TextDecoder().decode(firstChunk.value), /event: snapshot/);
    controller.abort();
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
