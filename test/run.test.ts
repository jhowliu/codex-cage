import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type DockerCommandOptions,
  defaultSandboxImage,
  type DockerSandbox,
  type DockerSandboxOptions,
} from "../src/docker.js";
import type { IssueContext } from "../src/issue.js";
import {
  NoDiffError,
  type CommandResult,
  type PublishSuccessfulRunInput,
} from "../src/publish.js";
import type { GithubRepo, RepoResolution } from "../src/repo.js";
import type { ReviewReport, RunIndependentReviewResult } from "../src/review.js";
import {
  runCodexCage,
  type RunCodexCageDependencies,
  type RunProgressEvent,
  type ShellRunner,
} from "../src/run.js";
import {
  parseRunEventLine,
  replayRunEventJournal,
  type CanonicalStage,
  type RunEvent,
} from "../src/run/events.js";
import { openRunStore, type FailureCode } from "../src/state.js";

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

async function readRunEvents(cwd: string, runId: string): Promise<RunEvent[]> {
  const content = await readFile(
    join(cwd, ".codex-cage", "runs", runId, "events.ndjson"),
    "utf8",
  );
  return content
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map(parseRunEventLine);
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
  commandOptions: DockerCommandOptions[];
} {
  const commands: string[] = [];
  const commandOptions: DockerCommandOptions[] = [];

  return {
    commands,
    commandOptions,
    async run(command, options = {}): Promise<CommandResult> {
      commands.push(command);
      commandOptions.push(options);

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

// Shell that satisfies the happy path in both execution modes. Docker mode
// clones via the fake sandbox, direct mode clones via the shell, so this
// includes both `git clone` and `git fetch`.
function happyPathShell(): ReturnType<typeof shellRunner> {
  return shellRunner(
    new Map([
      ["git clone", commandResult()],
      ["git fetch origin", commandResult()],
      ["npm install", commandResult("setup passed")],
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
}

// Mode-specific provisioning fakes. Direct mode must never touch Docker; Docker
// mode must never touch the host workspace.
function modeDeps(
  mode: "docker" | "direct",
  shell: ShellRunner,
  events: string[],
): RunCodexCageDependencies {
  if (mode === "direct") {
    return {
      executionMode: "direct",
      createDockerSandbox: () => {
        throw new Error("Docker sandbox must not be created in direct mode.");
      },
      createHostWorkspace: async () => ({
        workspacePath: "/tmp/codex-cage-happy",
        cleanup: async () => undefined,
      }),
      createHostShellRunner: () => shell,
    };
  }

  return {
    executionMode: "docker",
    createHostWorkspace: () => {
      throw new Error("Host workspace must not be created in docker mode.");
    },
    createDockerSandbox: () => fakeSandbox(events),
    createShellRunner: () => shell,
  };
}

for (const mode of ["docker", "direct"] as const) {
  test(`runCodexCage reaches every gate and opens a PR in ${mode} mode`, async () => {
    const cwd = await createProject(`
setup:
  - npm install
verify:
  - npm test
`);
    const events: string[] = [];
    const runnerEvents: RunEvent[] = [];
    const progressEvents: RunProgressEvent[] = [];
    const shell = happyPathShell();

    try {
      const result = await runCodexCage(
        { cwd, issueUrl: issue.url },
        {
          generateRunId: () => `run-happy-${mode}`,
          readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
          findCodexAuthFile: async () => null,
          fetchIssueContext: async () => issue,
          resolveTargetRepo: async () => repoResolution,
          createAuthenticatedRepo: () => ({
            repo,
            cloneUrl: "https://github.com/jhowliu/codex-cage.git",
            redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
          }),
          runIndependentReview: async () => passingReview(),
          publishSuccessfulRun: async (input) => ({
            branchName: input.branchName ?? `codex-cage/gh-26-${mode}`,
            commitMessage: "#26 Wire run command",
            prTitle: "#26 Wire run command",
            prBody: "body",
            prUrl: "https://github.com/jhowliu/codex-cage/pull/26",
          }),
          onEvent: (event) => {
            runnerEvents.push(event);
          },
          onProgress: (event) => {
            progressEvents.push(event);
          },
          ...modeDeps(mode, shell, events),
        },
      );

      // Engine outcome is mode-agnostic: same status, PR, and phase sequence.
      assert.equal(result.status, "succeeded");
      assert.equal(result.prUrl, "https://github.com/jhowliu/codex-cage/pull/26");

      const store = await openRunStore(cwd);
      const details = store.getRunDetails(`run-happy-${mode}`);
      store.close();
      assert.deepEqual(
        details.phases.map((phase) => phase.name),
        ["preflight", "cloning", "setup", "implement", "verify", "review", "pr"],
      );

      const persistedEvents = await readRunEvents(cwd, `run-happy-${mode}`);
      const replay = await replayRunEventJournal(
        join(cwd, ".codex-cage", "runs", `run-happy-${mode}`, "events.ndjson"),
      );
      assert.deepEqual(runnerEvents, persistedEvents);
      assert.doesNotMatch(JSON.stringify(persistedEvents), /tests passed|implemented/);
      assert.deepEqual(
        persistedEvents.map((event) => event.sequence),
        persistedEvents.map((_, index) => index + 1),
      );
      assert.equal(replay.status, "succeeded");
      assert.deepEqual(
        replay.stages.map((stage) => [stage.stage, stage.attempt, stage.status]),
        [
          ["prepare", 1, "succeeded"],
          ["implement", 1, "succeeded"],
          ["verify", 1, "succeeded"],
          ["review", 1, "succeeded"],
          ["publish", 1, "succeeded"],
        ],
      );
      assert.deepEqual(
        persistedEvents
          .filter((event) => event.type === "activity.started")
          .map((event) => [event.stage, event.payload.activity]),
        [
          ["prepare", "preflight"],
          ["prepare", "cloning"],
          ["prepare", "setup"],
          ["implement", "implement"],
          ["verify", "verify"],
          ["review", "review"],
          ["publish", "pr"],
        ],
      );
      for (const eventType of [
        "command.finished",
        "verification.updated",
        "review.finished",
        "artifact.created",
        "change.created",
      ] as const) {
        assert.ok(
          persistedEvents.some((event) => event.type === eventType),
          `expected ${eventType}`,
        );
      }
      assert.equal(progressEvents[0]?.type, "run_started");
      assert.equal(progressEvents.at(-1)?.type, "run_finished");

      // Direct mode bypasses Codex's sandbox (the runner is already isolated);
      // Docker mode keeps it.
      const implementCommand =
        shell.commands.find((command) => command.includes("codex exec")) ?? "";
      if (mode === "direct") {
        assert.match(implementCommand, /--dangerously-bypass-approvals-and-sandbox/);
      } else {
        assert.match(implementCommand, /--sandbox 'workspace-write'/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("runCodexCage parses review agent stdout without command log noise", async () => {
  const cwd = await createProject(`
verify:
  - npm test
`);
  const events: string[] = [];
  const reviewJson = JSON.stringify({
    decision: "pass",
    summary: "No blocking issues.",
    findings: [],
  });
  const diff = `diff --git a/src/app.ts b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const changed = true;
`;
  const shell = shellRunner(
    new Map([
      ["git fetch origin", commandResult()],
      ["--sandbox 'workspace-write'", commandResult("implemented")],
      ["--sandbox 'read-only'", commandResult(reviewJson)],
      ["npm test", commandResult("tests passed")],
      ["git add --intent-to-add", commandResult(diff)],
    ]),
  );

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        executionMode: "docker",
        generateRunId: () => "run-review-stdout",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: () => fakeSandbox(events),
        createShellRunner: () => shell,
        publishSuccessfulRun: async (input) => ({
          branchName: input.branchName ?? "codex-cage/gh-26-run-test",
          commitMessage: "#26 Wire run command",
          prTitle: "#26 Wire run command",
          prBody: "body",
          prUrl: "https://github.com/jhowliu/codex-cage/pull/26",
        }),
      },
    );

    const reviewLog = await readFile(
      join(cwd, ".codex-cage", "runs", "run-review-stdout", "review.log"),
      "utf8",
    );
    const reviewPrompt = await readFile(
      join(cwd, ".codex-cage", "runs", "run-review-stdout", "review-prompt-0.md"),
      "utf8",
    );

    assert.equal(result.status, "succeeded");
    assert.doesNotMatch(reviewLog, /^\$ printf/);
    assert.match(
      reviewPrompt,
      /Target review policy: missing\. Proceed with built-in review rules\./,
    );
    assert.deepEqual(JSON.parse(reviewLog), {
      decision: "pass",
      summary: "No blocking issues.",
      findings: [],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage executes the happy path and records a successful run", async () => {
  const cwd = await createProject(`
setup:
  - npm install
verify:
  - npm test
`);
  await mkdir(join(cwd, ".codex-cage"), { recursive: true });
  await mkdir(join(cwd, ".github"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "Do not prompt-inject AGENTS.\n", "utf8");
  await writeFile(
    join(cwd, ".codex-cage", "instructions.md"),
    "Do not prompt-inject cage instructions.\n",
    "utf8",
  );
  await writeFile(
    join(cwd, ".codex-cage", "review-policy.md"),
    "Do not prompt-inject review policy contents.\n",
    "utf8",
  );
  await writeFile(
    join(cwd, ".github", "copilot-instructions.md"),
    "Do not prompt-inject Copilot.\n",
    "utf8",
  );
  await writeFile(join(cwd, "CLAUDE.md"), "Do not prompt-inject Claude.\n", "utf8");
  const events: string[] = [];
  const sandboxOptions: DockerSandboxOptions[] = [];
  const shell = shellRunner(
    new Map([
      ["git fetch origin", commandResult()],
      ["npm install", commandResult("setup passed")],
      ["--sandbox 'read-only'", commandResult("review passed")],
      ["codex exec", commandResult("implemented")],
      ["npm test", commandResult("tests passed")],
      ["'git' 'status'", commandResult("clean")],
      ["'gh' 'pr' 'view'", commandResult("pr")],
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
  let reviewPolicyStatus = "";
  let reviewEnv: Record<string, string> | undefined;

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        executionMode: "docker",
        generateRunId: () => "run-test-123",
        readEnv: async () => ({
          GITHUB_TOKEN: "token-value",
          OPENAI_API_KEY: "",
          LINEAR_API_KEY: "linear-value",
          APP_ENV: "test",
        }),
        findCodexAuthFile: async () => "/host/.codex/auth.json",
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: (options: DockerSandboxOptions) => {
          sandboxOptions.push(options);
          return fakeSandbox(events);
        },
        createShellRunner: () => shell,
        runIndependentReview: async (input) => {
          reviewIssueContext = input.issueContext;
          reviewPolicyStatus = input.reviewPolicyStatus ?? "";
          reviewEnv = input.env;
          await input.runner?.run({
            cwd: input.cwd,
            model: input.model,
            prompt: "review",
            outputSchema: { type: "object" },
          });
          return passingReview();
        },
        publishSuccessfulRun: async (input) => {
          published.push(input);
          await input.git?.run(["status"]);
          await input.gh?.run(["pr", "view"]);
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
    assert.equal(published.length, 1);
    assert.equal(published[0]?.metadata.verification[0], "`npm test` passed");
    assert.deepEqual(published[0]?.env, {
      GH_TOKEN: "token-value",
      GITHUB_TOKEN: "token-value",
    });
    assert.deepEqual(reviewEnv, {});

    const setupIndex = shell.commands.findIndex((command) => command === "npm install");
    const checkoutIndex = shell.commands.findIndex((command) =>
      command.includes("git fetch origin"),
    );
    const verifyIndex = shell.commands.findIndex((command) => command === "npm test");
    const implementIndex = shell.commands.findIndex(
      (command) =>
        command.includes("codex exec") && command.includes("--sandbox 'workspace-write'"),
    );
    const reviewIndex = shell.commands.findIndex(
      (command) =>
        command.includes("codex exec") && command.includes("--sandbox 'read-only'"),
    );
    const publishGitIndex = shell.commands.findIndex(
      (command) => command === "'git' 'status'",
    );
    const publishGhIndex = shell.commands.findIndex(
      (command) => command === "'gh' 'pr' 'view'",
    );

    assert.deepEqual(shell.commandOptions[checkoutIndex]?.env, {
      GH_TOKEN: "token-value",
      GITHUB_TOKEN: "token-value",
    });
    assert.deepEqual(shell.commandOptions[setupIndex]?.env, { APP_ENV: "test" });
    assert.equal(shell.commandOptions[setupIndex]?.codexAuthFilePath, undefined);
    assert.deepEqual(shell.commandOptions[verifyIndex]?.env, { APP_ENV: "test" });
    assert.equal(shell.commandOptions[verifyIndex]?.codexAuthFilePath, undefined);
    assert.deepEqual(shell.commandOptions[implementIndex]?.env, {});
    assert.equal(
      shell.commandOptions[implementIndex]?.codexAuthFilePath,
      "/host/.codex/auth.json",
    );
    assert.deepEqual(shell.commandOptions[reviewIndex]?.env, {});
    assert.equal(
      shell.commandOptions[reviewIndex]?.codexAuthFilePath,
      "/host/.codex/auth.json",
    );
    assert.deepEqual(shell.commandOptions[publishGitIndex]?.env, {
      GH_TOKEN: "token-value",
      GITHUB_TOKEN: "token-value",
    });
    assert.deepEqual(shell.commandOptions[publishGhIndex]?.env, {
      GH_TOKEN: "token-value",
      GITHUB_TOKEN: "token-value",
    });

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

    assert.equal(details.run.status, "succeeded");
    assert.equal(details.run.prUrl, "https://github.com/jhowliu/codex-cage/pull/26");
    assert.match(implementationPrompt, /native Codex AGENTS\.md/);
    assert.doesNotMatch(implementationPrompt, /Do not prompt-inject/);
    assert.doesNotMatch(reviewIssueContext, /Do not prompt-inject/);
    assert.match(reviewPrompt, /Verification summary:/);
    assert.match(
      reviewPrompt,
      /Target review policy: present at \.codex-cage\/review-policy\.md/,
    );
    assert.doesNotMatch(reviewPrompt, /Do not prompt-inject/);
    assert.match(reviewPolicyStatus, /Target review policy: present/);
    assert.match(
      shell.commands.find((command) => command.includes("codex exec")) ?? "",
      /--sandbox 'workspace-write'/,
    );
    assert.match(promptContext, /"status": "present"/);
    assert.doesNotMatch(promptContext, /Do not prompt-inject/);
    await assert.rejects(() => readFile(join(runDirectory, "instructions.md"), "utf8"), {
      code: "ENOENT",
    });
    assert.deepEqual(
      details.phases.map((phase) => phase.name),
      ["preflight", "cloning", "setup", "implement", "verify", "review", "pr"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage runs direct mode on the host without Docker resources", async () => {
  const cwd = await createProject(`
setup:
  - npm install
verify:
  - npm test
services:
  compose: .codex-cage/docker-compose.yml
  ready:
    - pg_isready
`);
  const shell = shellRunner(
    new Map([
      ["git clone", commandResult()],
      ["git fetch origin", commandResult()],
      ["npm install", commandResult("setup passed")],
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

  let workspaceRunId = "";
  let hostShellWorkspacePath = "";
  let cleanupCalls = 0;

  try {
    const result = await runCodexCage(
      {
        cwd,
        issueUrl: issue.url,
      },
      {
        executionMode: "direct",
        generateRunId: () => "run-direct-1",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: () => {
          throw new Error("Docker sandbox must not be created in direct mode.");
        },
        createComposeProject: () => {
          throw new Error("Compose must not be started in direct mode.");
        },
        createHostWorkspace: async (runId: string) => {
          workspaceRunId = runId;
          return {
            workspacePath: "/tmp/codex-cage-direct",
            cleanup: async () => {
              cleanupCalls += 1;
            },
          };
        },
        createHostShellRunner: (workspacePath: string) => {
          hostShellWorkspacePath = workspacePath;
          return shell;
        },
        runIndependentReview: async () => passingReview(),
        publishSuccessfulRun: async (input) => ({
          branchName: input.branchName ?? "codex-cage/gh-26-run-direct",
          commitMessage: "#26 Wire run command",
          prTitle: "#26 Wire run command",
          prBody: "body",
          prUrl: "https://github.com/jhowliu/codex-cage/pull/99",
        }),
      },
    );

    assert.deepEqual(result, {
      runId: "run-direct-1",
      status: "succeeded",
      failureCode: null,
      prUrl: "https://github.com/jhowliu/codex-cage/pull/99",
    });
    assert.equal(workspaceRunId, "run-direct-1");
    assert.equal(hostShellWorkspacePath, "/tmp/codex-cage-direct");
    assert.equal(cleanupCalls, 1);
    assert.ok(
      shell.commands.some(
        (command) =>
          command.includes("git clone") &&
          command.includes("https://github.com/jhowliu/codex-cage.git"),
      ),
      "direct mode should clone via the host shell",
    );

    const store = await openRunStore(cwd);
    const details = store.getRunDetails("run-direct-1");
    store.close();

    assert.equal(details.run.status, "succeeded");
    assert.deepEqual(
      details.phases.map((phase) => phase.name),
      ["preflight", "cloning", "setup", "implement", "verify", "review", "pr"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage redacts credential-bearing publish failures in artifacts", async () => {
  const cwd = await createProject(`
verify:
  - npm test
  `);
  const events: string[] = [];
  const deliveredEvents: RunEvent[] = [];
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
        executionMode: "docker",
        generateRunId: () => "run-publish-redact",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: () => fakeSandbox(events),
        createShellRunner: () => shell,
        runIndependentReview: async () => passingReview(),
        publishSuccessfulRun: async () => {
          throw new Error(
            "push failed: https://x-access-token:token-value@github.com/jhowliu/codex-cage.git",
          );
        },
        onEvent: (event) => {
          deliveredEvents.push(event);
        },
      },
    );

    const runDirectory = join(cwd, ".codex-cage", "runs", "run-publish-redact");
    const prLog = await readFile(join(runDirectory, "pr.log"), "utf8");
    const summary = await readFile(join(runDirectory, "summary.md"), "utf8");
    const eventJournal = await readFile(join(runDirectory, "events.ndjson"), "utf8");
    const replay = await replayRunEventJournal(join(runDirectory, "events.ndjson"));

    assert.deepEqual(result, {
      runId: "run-publish-redact",
      status: "failed",
      failureCode: "pr_failed",
      prUrl: null,
    });
    assert.doesNotMatch(prLog, /token-value/);
    assert.doesNotMatch(summary, /token-value/);
    assert.doesNotMatch(eventJournal, /token-value/);
    assert.doesNotMatch(JSON.stringify(deliveredEvents), /token-value/);
    assert.match(prLog, /x-access-token:\[REDACTED\]@github\.com/);
    assert.equal(replay.status, "failed");
    assert.equal(replay.failureCode, "pr_failed");
    assert.deepEqual(replay.stages.at(-1), {
      stage: "publish",
      attempt: 1,
      status: "failed",
      startedAt: replay.stages.at(-1)?.startedAt,
      finishedAt: replay.stages.at(-1)?.finishedAt,
      failureCode: "pr_failed",
    });
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
        executionMode: "docker",
        generateRunId: () => "run-image-123",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
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

    const runnerEvents = await readRunEvents(cwd, "run-image-123");
    const runtimeImageActivity = runnerEvents.find(
      (event) =>
        event.type === "activity.started" && event.payload.activity === "runtime_image",
    );
    assert.equal(runtimeImageActivity?.type, "activity.started");
    if (runtimeImageActivity?.type === "activity.started") {
      assert.equal(runtimeImageActivity.stage, "prepare");
      assert.equal(runtimeImageActivity.stageAttempt, 1);
    }
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
        executionMode: "docker",
        generateRunId: () => "run-image-failed",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
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

    const replay = await replayRunEventJournal(
      join(cwd, ".codex-cage", "runs", "run-image-failed", "events.ndjson"),
    );
    assert.equal(replay.status, "failed");
    assert.deepEqual(
      replay.stages.map((stage) => [stage.stage, stage.status, stage.failureCode]),
      [["prepare", "failed", "runtime_image_failed"]],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage preserves accepted changes before the publisher commits the workspace", async () => {
  const cwd = await createProject("verify:\n  - npm test\nagent:\n  max_iterations: 1\n");
  const backing = happyPathShell();
  let committed = false;
  const shell: ShellRunner = {
    async run(command, options) {
      if (committed && command.includes("git add --intent-to-add"))
        return commandResult();
      return await backing.run(command, options);
    },
  };
  try {
    const result = await runCodexCage(
      { cwd, issueUrl: issue.url },
      {
        executionMode: "docker",
        generateRunId: () => "run-preserve-patch",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: () => fakeSandbox([]),
        createShellRunner: () => shell,
        runIndependentReview: async () => passingReview(),
        publishSuccessfulRun: async () => {
          committed = true;
          return {
            branchName: "cage/fix",
            commitMessage: "Fix",
            prTitle: "Fix",
            prBody: "body",
            prUrl: "https://github.com/jhowliu/codex-cage/pull/1",
          };
        },
      },
    );
    assert.equal(result.status, "succeeded");
    const directory = join(cwd, ".codex-cage", "runs", "run-preserve-patch");
    const finalPatch = await readFile(join(directory, "final.patch"), "utf8");
    assert.match(finalPatch, /\+export const changed = true/);
    assert.equal(await readFile(join(directory, "changes-1.patch"), "utf8"), finalPatch);
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
        executionMode: "docker",
        generateRunId: () => "run-test-failed",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
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

    const replay = await replayRunEventJournal(
      join(cwd, ".codex-cage", "runs", "run-test-failed", "events.ndjson"),
    );
    assert.equal(replay.status, "failed");
    assert.equal(replay.failureCode, "verify_failed");
    assert.deepEqual(
      replay.stages.map((stage) => [stage.stage, stage.attempt, stage.status]),
      [
        ["prepare", 1, "succeeded"],
        ["implement", 1, "succeeded"],
        ["verify", 1, "failed"],
      ],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodexCage records retries as distinct canonical Stage Attempts", async () => {
  const cwd = await createProject(`
verify:
  - npm test
agent:
  max_iterations: 2
`);
  const sandboxEvents: string[] = [];
  let verificationCalls = 0;
  const diff = `diff --git a/src/app.ts b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const changed = true;
`;
  const shell: ShellRunner = {
    async run(command): Promise<CommandResult> {
      if (command.includes("git fetch origin")) return commandResult();
      if (command.includes("codex exec")) return commandResult("implemented");
      if (command === "npm test") {
        verificationCalls += 1;
        return verificationCalls === 1
          ? commandResult("", 1, "tests failed")
          : commandResult("tests passed");
      }
      if (command.includes("git add --intent-to-add")) return commandResult(diff);
      throw new Error(`Unexpected shell command: ${command}`);
    },
  };

  try {
    const result = await runCodexCage(
      { cwd, issueUrl: issue.url },
      {
        executionMode: "docker",
        generateRunId: () => "run-retry-events",
        readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
        findCodexAuthFile: async () => null,
        fetchIssueContext: async () => issue,
        resolveTargetRepo: async () => repoResolution,
        createAuthenticatedRepo: () => ({
          repo,
          cloneUrl: "https://github.com/jhowliu/codex-cage.git",
          redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
        }),
        createDockerSandbox: () => fakeSandbox(sandboxEvents),
        createShellRunner: () => shell,
        runIndependentReview: async () => passingReview(),
        publishSuccessfulRun: async (input) => ({
          branchName: input.branchName ?? "codex-cage/retry",
          commitMessage: "retry succeeded",
          prTitle: "retry succeeded",
          prBody: "body",
          prUrl: "https://github.com/jhowliu/codex-cage/pull/105",
        }),
      },
    );

    assert.equal(result.status, "succeeded");
    const replay = await replayRunEventJournal(
      join(cwd, ".codex-cage", "runs", "run-retry-events", "events.ndjson"),
    );
    const events = await readRunEvents(cwd, "run-retry-events");

    assert.deepEqual(
      replay.stages.map((stage) => [stage.stage, stage.attempt, stage.status]),
      [
        ["prepare", 1, "succeeded"],
        ["implement", 1, "succeeded"],
        ["verify", 1, "failed"],
        ["implement", 2, "succeeded"],
        ["verify", 2, "succeeded"],
        ["review", 1, "succeeded"],
        ["publish", 1, "succeeded"],
      ],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "implementation.iteration_started")
        .map((event) => [event.stageAttempt, event.payload.iteration]),
      [
        [1, 1],
        [2, 2],
      ],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

type ReplayableFailureScenario = {
  name: string;
  runId: string;
  config: string;
  failureCode: FailureCode;
  failedStage: CanonicalStage;
  shell: () => ReturnType<typeof shellRunner>;
  review?: NonNullable<RunCodexCageDependencies["runIndependentReview"]>;
  publish?: NonNullable<RunCodexCageDependencies["publishSuccessfulRun"]>;
};

const replayableFailureScenarios: readonly ReplayableFailureScenario[] = [
  {
    name: "review blocking",
    runId: "run-review-blocking-events",
    config: `
verify:
  - npm test
agent:
  max_iterations: 1
  max_review_cycles: 0
`,
    failureCode: "review_blocking",
    failedStage: "review",
    shell: () =>
      shellRunner(
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
      ),
    review: async () => ({
      report: {
        decision: "blocking",
        summary: "Required behavior is missing.",
        findings: [
          {
            severity: "blocking",
            message: "Add the missing behavior.",
            path: "src/app.ts",
            line: 2,
          },
        ],
      },
      nextAction: {
        action: "fail",
        failureCode: "review_blocking",
        feedback: "Add the missing behavior.",
      },
    }),
  },
  {
    name: "secret guard exhaustion",
    runId: "run-secret-guard-events",
    config: `
verify:
  - npm test
agent:
  max_iterations: 1
guards:
  max_secret_fix_attempts: 0
`,
    failureCode: "secret_guard_failed",
    failedStage: "verify",
    shell: () =>
      shellRunner(
        new Map([
          ["git fetch origin", commandResult()],
          ["codex exec", commandResult("implemented")],
          ["npm test", commandResult("tests passed")],
          [
            "git add --intent-to-add",
            commandResult(`diff --git a/src/app.ts b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const token = "token-value";
`),
          ],
        ]),
      ),
  },
  {
    name: "verification timeout",
    runId: "run-timeout-events",
    config: `
verify:
  - npm test
agent:
  max_iterations: 1
`,
    failureCode: "timeout",
    failedStage: "verify",
    shell: () =>
      shellRunner(
        new Map([
          ["git fetch origin", commandResult()],
          ["codex exec", commandResult("implemented")],
          ["npm test", commandResult("", 124, "command timed out")],
        ]),
      ),
  },
  {
    name: "no diff publish",
    runId: "run-no-diff-events",
    config: `
verify:
  - npm test
agent:
  max_iterations: 1
`,
    failureCode: "no_diff",
    failedStage: "publish",
    shell: () =>
      shellRunner(
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
      ),
    publish: async () => {
      throw new NoDiffError();
    },
  },
];

for (const scenario of replayableFailureScenarios) {
  test(`runCodexCage writes a replayable terminal history for ${scenario.name}`, async () => {
    const cwd = await createProject(scenario.config);
    const sandboxEvents: string[] = [];
    const shell = scenario.shell();

    try {
      const result = await runCodexCage(
        { cwd, issueUrl: issue.url },
        {
          executionMode: "docker",
          generateRunId: () => scenario.runId,
          readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
          findCodexAuthFile: async () => null,
          fetchIssueContext: async () => issue,
          resolveTargetRepo: async () => repoResolution,
          createAuthenticatedRepo: () => ({
            repo,
            cloneUrl: "https://github.com/jhowliu/codex-cage.git",
            redactedCloneUrl: "https://github.com/jhowliu/codex-cage.git",
          }),
          createDockerSandbox: () => fakeSandbox(sandboxEvents),
          createShellRunner: () => shell,
          runIndependentReview: scenario.review ?? (async () => passingReview()),
          publishSuccessfulRun:
            scenario.publish ??
            (async (input) => ({
              branchName: input.branchName ?? "codex-cage/unused",
              commitMessage: "unused",
              prTitle: "unused",
              prBody: "unused",
              prUrl: "https://github.com/jhowliu/codex-cage/pull/unused",
            })),
        },
      );

      assert.equal(result.status, "failed");
      assert.equal(result.failureCode, scenario.failureCode);

      const eventPath = join(cwd, ".codex-cage", "runs", scenario.runId, "events.ndjson");
      const eventText = await readFile(eventPath, "utf8");
      const events = await readRunEvents(cwd, scenario.runId);
      const replay = await replayRunEventJournal(eventPath);
      const failedStage = replay.stages.at(-1);

      assert.equal(replay.status, "failed");
      assert.equal(replay.failureCode, scenario.failureCode);
      assert.equal(failedStage?.stage, scenario.failedStage);
      assert.equal(failedStage?.status, "failed");
      assert.equal(failedStage?.failureCode, scenario.failureCode);
      assert.ok(replay.stages.every((stage) => stage.status !== "running"));
      assert.doesNotMatch(eventText, /token-value/);

      if (scenario.failureCode === "review_blocking") {
        assert.ok(
          events.some(
            (event) =>
              event.type === "review.finished" && event.payload.decision === "blocking",
          ),
        );
      }

      if (scenario.failureCode === "secret_guard_failed") {
        assert.ok(
          events.some(
            (event) =>
              event.type === "verification.updated" &&
              event.payload.kind === "secret_guard" &&
              event.payload.status === "failed" &&
              !event.payload.retryable,
          ),
        );
      }

      if (scenario.failureCode === "timeout") {
        assert.ok(
          events.some(
            (event) =>
              event.type === "command.finished" && event.payload.outcome === "timed_out",
          ),
        );
      }

      if (scenario.failureCode === "no_diff") {
        assert.ok(!events.some((event) => event.type === "change.created"));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
