import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultSandboxImage,
  type DockerSandbox,
  type DockerSandboxOptions,
} from "../src/docker.js";
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
    codexAuthFilePath: null,
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
  await writeFile(join(cwd, "AGENTS.md"), "Always write focused tests.\n", "utf8");
  const events: string[] = [];
  const sandboxOptions: DockerSandboxOptions[] = [];
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
  let reviewIssueContext = "";

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        generateRunId: () => "run-test-123",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value", OPENAI_API_KEY: "" }),
        findCodexAuthFile: async () => "/host/.codex/auth.json",
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl:
            "https://x-access-token:token-value@github.com/jhowliu/codex-cage.git",
          redactedCloneUrl:
            "https://x-access-token:[REDACTED]@github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: (options: DockerSandboxOptions) => {
          sandboxOptions.push(options);
          return fakeSandbox(events);
        },
        createShellRunner: () => shell,
        runIndependentReview: async (input) => {
          reviewIssueContext = input.issueContext;
          return passingReview();
        },
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
    assert.equal(sandboxOptions[0]?.image, defaultSandboxImage);
    assert.deepEqual(sandboxOptions[0]?.env, {
      GH_TOKEN: "token-value",
      GITHUB_TOKEN: "token-value",
    });
    assert.equal(sandboxOptions[0]?.codexAuthFilePath, "/host/.codex/auth.json");
    assert.equal(published.length, 1);
    assert.equal(published[0]?.metadata.verification[0], "`npm test` passed");

    const store = await openRunStore(cwd);
    const details = store.getRunDetails("run-test-123");
    store.close();
    const runDirectory = join(cwd, ".codex-cage", "runs", "run-test-123");
    const implementationPrompt = await readFile(
      join(runDirectory, "implementation-prompt-1.md"),
      "utf8",
    );
    const reviewPrompt = await readFile(join(runDirectory, "review-prompt-0.md"), "utf8");
    const promptContext = await readFile(
      join(runDirectory, "prompt-context.json"),
      "utf8",
    );
    const instructions = await readFile(join(runDirectory, "instructions.md"), "utf8");

    assert.equal(details.run.status, "succeeded");
    assert.equal(details.run.prUrl, "https://github.com/jhowliu/codex-cage/pull/26");
    assert.match(implementationPrompt, /Repository instructions:/);
    assert.match(implementationPrompt, /Always write focused tests/);
    assert.match(reviewIssueContext, /Repository instructions:/);
    assert.match(reviewPrompt, /Verification summary:/);
    assert.match(
      shell.commands.find((command) => command.includes("codex exec")) ?? "",
      /--sandbox 'workspace-write'/,
    );
    assert.match(promptContext, /AGENTS\.md/);
    assert.match(instructions, /Always write focused tests/);
    assert.deepEqual(
      details.phases.map((phase) => phase.name),
      ["preflight", "cloning", "implement", "verify", "review", "pr"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage builds configured runtime Dockerfiles before cloning", async () => {
  const cwd = await createProject(`
verify:
  - npm test
runtime:
  image: registry.example.com/base:custom
  dockerfile: .codex-cage/Dockerfile
`);
  const events: string[] = [];
  const sandboxOptions: DockerSandboxOptions[] = [];
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

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        generateRunId: () => "run-image-123",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl:
            "https://x-access-token:token-value@github.com/jhowliu/codex-cage.git",
          redactedCloneUrl:
            "https://x-access-token:[REDACTED]@github.com/jhowliu/codex-cage.git",
        }),
        buildRuntimeImage: async (options) => {
          events.push(`build:${options.dockerfilePath}:${options.contextPath}`);
          return {
            image: "codex-cage/runtime-run-image-123:latest",
            dockerfilePath: options.dockerfilePath,
            contextPath: options.contextPath,
          };
        },
        createDockerSandbox: (options) => {
          sandboxOptions.push(options);
          return fakeSandbox(events);
        },
        createShellRunner: () => shell,
        runIndependentReview: async () => passingReview(),
        publishSuccessfulRun: async (input) => ({
          branchName: input.branchName ?? "codex-cage/gh-26-run-test",
          commitMessage: "#26 Wire run command",
          prTitle: "#26 Wire run command",
          prBody: "body",
          prUrl: "https://github.com/jhowliu/codex-cage/pull/26",
        }),
      },
    );

    assert.equal(result.status, "succeeded");
    assert.match(events[0] ?? "", /build:/);
    assert.deepEqual(events.slice(1), [
      "sandbox:create",
      "sandbox:clone",
      "sandbox:cleanup",
    ]);
    assert.equal(sandboxOptions[0]?.image, "codex-cage/runtime-run-image-123:latest");

    const store = await openRunStore(cwd);
    const details = store.getRunDetails("run-image-123");
    const runtimeImage = await readFile(
      join(cwd, ".codex-cage", "runs", "run-image-123", "runtime-image.json"),
      "utf8",
    );
    store.close();

    assert.deepEqual(
      details.phases.map((phase) => phase.name),
      ["preflight", "runtime_image", "cloning", "implement", "verify", "review", "pr"],
    );
    assert.match(runtimeImage, /codex-cage\/runtime-run-image-123:latest/);
    assert.match(runtimeImage, /"source": "built"/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage records runtime image build failures", async () => {
  const cwd = await createProject(`
verify:
  - npm test
runtime:
  dockerfile: .codex-cage/Dockerfile
`);
  const events: string[] = [];

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        generateRunId: () => "run-image-failed",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl:
            "https://x-access-token:token-value@github.com/jhowliu/codex-cage.git",
          redactedCloneUrl:
            "https://x-access-token:[REDACTED]@github.com/jhowliu/codex-cage.git",
        }),
        buildRuntimeImage: async () => {
          events.push("build");
          throw new Error("docker build failed");
        },
        createDockerSandbox: () => {
          throw new Error("sandbox should not be created after image build failure");
        },
      },
    );

    assert.deepEqual(result, {
      runId: "run-image-failed",
      status: "failed",
      failureCode: "runtime_image_failed",
      prUrl: null,
    });
    assert.deepEqual(events, ["build"]);

    const store = await openRunStore(cwd);
    const details = store.getRunDetails("run-image-failed");
    store.close();

    assert.equal(details.run.failureCode, "runtime_image_failed");
    assert.equal(details.phases.at(-1)?.name, "runtime_image");
    assert.equal(details.phases.at(-1)?.status, "failed");
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
        findCodexAuthFile: async () => null,
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
