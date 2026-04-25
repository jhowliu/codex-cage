import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DockerSandbox, DockerSandboxOptions } from "../src/docker.js";
import type { IssueContext } from "../src/issue.js";
import type { CommandResult, PublishSuccessfulRunInput } from "../src/publish.js";
import type { GithubRepo, RepoResolution } from "../src/repo.js";
import type { ReviewReport, RunIndependentReviewResult } from "../src/review.js";
import { runCodexCage, type ShellRunner } from "../src/run.js";
import { openRunStore } from "../src/state.js";

const repo: GithubRepo = {
  owner: "jhowliu",
  name: "codex-cage",
  fullName: "jhowliu/codex-cage",
};

const repoResolution: RepoResolution = {
  repo,
  source: "issue",
};

const issue: IssueContext = {
  source: "github",
  url: "https://github.com/jhowliu/codex-cage/issues/26",
  identifier: "#26",
  title: "Wire run command",
  body: "Connect the run command to the orchestrator.",
  comments: [],
  inferredRepo: repo.fullName,
};

function commandResult(stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

async function createProject(config: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-run-"));
  await writeFile(join(cwd, ".codex-cage.yml"), config, "utf8");
  return cwd;
}

function fakeSandbox(events: string[]): DockerSandbox {
  return {
    runId: "run-test-123",
    image: "fake-image",
    volumeName: "fake-volume",
    networkName: "fake-network",
    ownedNetworkName: "fake-network",
    workspacePath: "/workspace",
    async create(): Promise<void> {
      events.push("sandbox:create");
    },
    async cloneRepository(): Promise<void> {
      events.push("sandbox:clone");
    },
    async runCommand(): Promise<void> {
      throw new Error("runCommand should not be used by the orchestrator.");
    },
    async cleanup(): Promise<void> {
      events.push("sandbox:cleanup");
    },
  };
}

function shellRunner(results: Map<string, CommandResult>): ShellRunner & {
  commands: string[];
} {
  const commands: string[] = [];

  return {
    commands,
    async run(command): Promise<CommandResult> {
      commands.push(command);

      for (const [pattern, result] of results) {
        if (command.includes(pattern)) {
          return result;
        }
      }

      throw new Error(`Unexpected shell command: ${command}`);
    },
  };
}

function passingReview(): RunIndependentReviewResult {
  const report: ReviewReport = {
    decision: "pass",
    summary: "No blocking issues.",
    findings: [],
  };

  return {
    report,
    nextAction: { action: "continue" },
  };
}

test("runCodexCage executes the happy path and records a successful run", async () => {
  const cwd = await createProject(`
verify:
  - npm test
`);
  const events: string[] = [];
  const shell = shellRunner(
    new Map([
      ["git fetch origin", commandResult()],
      ["codex exec", commandResult("implemented")],
      ["npm test", commandResult("tests passed")],
      [
        "git add --intent-to-add",
        commandResult(`diff --git a/src/app.ts b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const changed = true;
`),
      ],
    ]),
  );
  const published: PublishSuccessfulRunInput[] = [];

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        generateRunId: () => "run-test-123",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl:
            "https://x-access-token:token-value@github.com/jhowliu/codex-cage.git",
          redactedCloneUrl:
            "https://x-access-token:[REDACTED]@github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: (_options: DockerSandboxOptions) => fakeSandbox(events),
        createShellRunner: () => shell,
        runIndependentReview: async () => passingReview(),
        publishSuccessfulRun: async (input) => {
          published.push(input);
          return {
            branchName: input.branchName ?? "codex-cage/gh-26-run-test",
            commitMessage: "#26 Wire run command",
            prTitle: "#26 Wire run command",
            prBody: "body",
            prUrl: "https://github.com/jhowliu/codex-cage/pull/26",
          };
        },
      },
    );

    assert.deepEqual(result, {
      runId: "run-test-123",
      status: "succeeded",
      failureCode: null,
      prUrl: "https://github.com/jhowliu/codex-cage/pull/26",
    });
    assert.deepEqual(events, ["sandbox:create", "sandbox:clone", "sandbox:cleanup"]);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.metadata.verification[0], "`npm test` passed");

    const store = await openRunStore(cwd);
    const details = store.getRunDetails("run-test-123");
    store.close();

    assert.equal(details.run.status, "succeeded");
    assert.equal(details.run.prUrl, "https://github.com/jhowliu/codex-cage/pull/26");
    assert.deepEqual(
      details.phases.map((phase) => phase.name),
      ["preflight", "cloning", "implement", "verify", "review", "pr"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage records verify failure after max iterations", async () => {
  const cwd = await createProject(`
verify:
  - npm test
agent:
  max_iterations: 1
`);
  const events: string[] = [];
  const shell = shellRunner(
    new Map([
      ["git fetch origin", commandResult()],
      ["codex exec", commandResult("implemented")],
      ["npm test", commandResult("", 1, "tests failed")],
    ]),
  );

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        generateRunId: () => "run-test-failed",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl:
            "https://x-access-token:token-value@github.com/jhowliu/codex-cage.git",
          redactedCloneUrl:
            "https://x-access-token:[REDACTED]@github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: () => fakeSandbox(events),
        createShellRunner: () => shell,
      },
    );

    assert.deepEqual(result, {
      runId: "run-test-failed",
      status: "failed",
      failureCode: "verify_failed",
      prUrl: null,
    });

    const store = await openRunStore(cwd);
    const details = store.getRunDetails("run-test-failed");
    store.close();

    assert.equal(details.run.status, "failed");
    assert.equal(details.run.failureCode, "verify_failed");
    assert.equal(details.phases.at(-1)?.name, "verify");
    assert.equal(details.phases.at(-1)?.status, "failed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
