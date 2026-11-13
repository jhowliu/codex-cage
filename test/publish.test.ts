import assert from "node:assert/strict";
import test from "node:test";
import type { IssueContext } from "../src/issue.js";
import {
  BranchExistsError,
  NoDiffError,
  branchExists,
  formatIssueLinkage,
  formatPrBody,
  generateBranchName,
  hasPublishableChanges,
  publishRevision,
  publishSuccessfulRun,
  type CommandResult,
  type CommandRunner,
} from "../src/publish.js";
import { parseReviseMarker, type RevisionContext } from "../src/pull-request.js";
import type { GithubRepo } from "../src/repo.js";

type RecordedCall = {
  args: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
};

function result(stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

function recordingRunner(results: CommandResult[]): CommandRunner & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  return {
    calls,
    async run(args, options): Promise<CommandResult> {
      calls.push({ args, cwd: options?.cwd, env: options?.env });
      const next = results.shift();

      if (next === undefined) {
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      }

      return next;
    },
  };
}

const repo: GithubRepo = {
  owner: "jhowliu",
  name: "agent-cage",
  fullName: "jhowliu/agent-cage",
};

const githubIssue: IssueContext = {
  source: "github",
  url: "https://github.com/jhowliu/agent-cage/issues/11",
  identifier: "#11",
  title: "Publish successful runs",
  body: "Create PRs after checks pass.",
  comments: [],
  inferredRepo: "jhowliu/agent-cage",
};

const linearIssue: IssueContext = {
  source: "linear",
  url: "https://linear.app/acme/issue/ENG-123/publish",
  identifier: "ENG-123",
  title: "Publish successful runs",
  body: "Create PRs after checks pass.",
  comments: [],
  inferredRepo: null,
};

const metadata = {
  runId: "run-1234567890abcdef",
  description: "Adds the publish flow.\n\n## How to use\n\nRun `agent-cage run`." as
    | string
    | null,
  verification: ["npm test", "npm run format"],
  reviewStatus: "Independent review passed.",
  risks: ["GitHub API unavailable would fail publishing."],
};

test("generateBranchName creates run-specific branch names", () => {
  assert.equal(
    generateBranchName({ issue: githubIssue, runId: metadata.runId }),
    "agent-cage/gh-11-run-1234567890ab",
  );
  assert.equal(
    generateBranchName({ issue: linearIssue, runId: metadata.runId }),
    "agent-cage/linear-eng-123-run-1234567890ab",
  );
});

test("formatPrBody opens with the review's description, then verification, review, risks, run id, and GitHub closing keyword", () => {
  const body = formatPrBody({ issue: githubIssue, metadata });

  assert.ok(
    body.startsWith(
      "Adds the publish flow.\n\n## How to use\n\nRun `agent-cage run`.\n\n## Verification\n",
    ),
  );
  assert.match(body, /- npm test/);
  assert.match(body, /Independent review passed/);
  assert.match(body, /GitHub API unavailable/);
  assert.match(body, /Run ID: run-1234567890abcdef/);
  assert.match(body, /Closes #11/);
});

test("formatPrBody falls back to a one-line summary without a review description", () => {
  const body = formatPrBody({
    issue: githubIssue,
    metadata: { ...metadata, description: null },
  });

  assert.ok(
    body.startsWith(`Implemented #11: ${githubIssue.title}\n\n## Verification\n`),
  );
  assert.match(body, /Closes #11/);
});

test("formatIssueLinkage links Linear issues without closing or mutating them", () => {
  assert.equal(
    formatIssueLinkage(linearIssue),
    "- Linear: https://linear.app/acme/issue/ENG-123/publish",
  );
});

test("hasPublishableChanges rejects empty status and accepts changed status", async () => {
  assert.equal(
    await hasPublishableChanges({
      cwd: "/repo",
      git: recordingRunner([result("")]),
    }),
    false,
  );
  assert.equal(
    await hasPublishableChanges({
      cwd: "/repo",
      git: recordingRunner([result(" M src/app.ts\n?? src/new.ts\n")]),
    }),
    true,
  );
});

test("branchExists checks local and remote branches without creating or force pushing", async () => {
  const git = recordingRunner([result("", 1), result("", 0)]);

  assert.equal(
    await branchExists({
      cwd: "/repo",
      branchName: "agent-cage/gh-11-run-1",
      git,
    }),
    true,
  );
  assert.deepEqual(
    git.calls.map((call) => call.args),
    [
      ["rev-parse", "--verify", "refs/heads/agent-cage/gh-11-run-1"],
      ["ls-remote", "--exit-code", "--heads", "origin", "agent-cage/gh-11-run-1"],
    ],
  );
});

test("publishSuccessfulRun creates one branch, one commit, one push, and one ready PR", async () => {
  const git = recordingRunner([
    result(" M src/app.ts\n"),
    result("", 1),
    result("", 1),
    result(),
    result(),
    result(),
    result(),
    result(),
    result(),
  ]);
  const gh = recordingRunner([result("https://github.com/jhowliu/agent-cage/pull/23\n")]);

  const publish = await publishSuccessfulRun({
    cwd: "/repo",
    repo,
    issue: githubIssue,
    baseBranch: "main",
    authorName: "Agent Cage",
    authorEmail: "agent-cage@users.noreply.github.com",
    metadata,
    env: { GITHUB_TOKEN: "token-value" },
    git,
    gh,
  });

  assert.equal(publish.branchName, "agent-cage/gh-11-run-1234567890ab");
  assert.equal(publish.commitMessage, "#11 Publish successful runs");
  assert.equal(publish.prTitle, "#11 Publish successful runs");
  assert.equal(publish.prUrl, "https://github.com/jhowliu/agent-cage/pull/23");
  assert.deepEqual(
    git.calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["rev-parse", "--verify", "refs/heads/agent-cage/gh-11-run-1234567890ab"],
      [
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        "agent-cage/gh-11-run-1234567890ab",
      ],
      ["checkout", "-b", "agent-cage/gh-11-run-1234567890ab"],
      ["config", "user.name", "Agent Cage"],
      ["config", "user.email", "agent-cage@users.noreply.github.com"],
      ["add", "--all"],
      ["commit", "-m", "#11 Publish successful runs"],
      ["push", "-u", "origin", "agent-cage/gh-11-run-1234567890ab"],
    ],
  );
  assert.deepEqual(git.calls[2]?.env, { GITHUB_TOKEN: "token-value" });
  assert.deepEqual(git.calls[8]?.env, { GITHUB_TOKEN: "token-value" });
  assert.deepEqual(gh.calls[0]?.env, { GITHUB_TOKEN: "token-value" });
  assert.equal(
    git.calls.some(
      (call) => call.args.includes("--force") || call.args.includes("--force-with-lease"),
    ),
    false,
  );
  assert.equal(
    git.calls.some((call) => call.args[0] === "rebase"),
    false,
  );
  assert.deepEqual(gh.calls[0]?.args.slice(0, 8), [
    "pr",
    "create",
    "--repo",
    "jhowliu/agent-cage",
    "--base",
    "main",
    "--head",
    "agent-cage/gh-11-run-1234567890ab",
  ]);
  assert.equal(gh.calls[0]?.args.includes("--draft"), false);
});

test("publishSuccessfulRun supports explicit draft PRs only when requested", async () => {
  const git = recordingRunner([
    result(" M src/app.ts\n"),
    result("", 1),
    result("", 1),
    result(),
    result(),
    result(),
    result(),
    result(),
    result(),
  ]);
  const gh = recordingRunner([result("https://github.com/jhowliu/agent-cage/pull/24\n")]);

  await publishSuccessfulRun({
    cwd: "/repo",
    repo,
    issue: githubIssue,
    baseBranch: "main",
    authorName: "Agent Cage",
    authorEmail: "agent-cage@users.noreply.github.com",
    metadata,
    draft: true,
    git,
    gh,
  });

  assert.equal(gh.calls[0]?.args.includes("--draft"), true);
});

test("publishSuccessfulRun rejects empty diffs before branch creation", async () => {
  const git = recordingRunner([result("")]);
  const gh = recordingRunner([]);

  await assert.rejects(
    () =>
      publishSuccessfulRun({
        cwd: "/repo",
        repo,
        issue: githubIssue,
        baseBranch: "main",
        authorName: "Agent Cage",
        authorEmail: "agent-cage@users.noreply.github.com",
        metadata,
        git,
        gh,
      }),
    NoDiffError,
  );
  assert.deepEqual(
    git.calls.map((call) => call.args),
    [["status", "--porcelain"]],
  );
  assert.equal(gh.calls.length, 0);
});

test("publishSuccessfulRun fails branch collisions without force pushing", async () => {
  const git = recordingRunner([result(" M src/app.ts\n"), result("", 0)]);
  const gh = recordingRunner([]);

  await assert.rejects(
    () =>
      publishSuccessfulRun({
        cwd: "/repo",
        repo,
        issue: githubIssue,
        baseBranch: "main",
        authorName: "Agent Cage",
        authorEmail: "agent-cage@users.noreply.github.com",
        metadata,
        git,
        gh,
      }),
    BranchExistsError,
  );
  assert.equal(
    git.calls.some(
      (call) => call.args.includes("--force") || call.args.includes("--force-with-lease"),
    ),
    false,
  );
  assert.equal(gh.calls.length, 0);
});

const revision: RevisionContext = {
  pullRequest: {
    url: "https://github.com/jhowliu/agent-cage/pull/40",
    number: 40,
    repo,
    title: "#11 Publish successful runs",
    body: "Old description.",
    headBranch: "agent-cage/gh-11-run-abc",
    baseBranch: "main",
    agentCageRunId: "run-old",
    issueUrl: githubIssue.url,
  },
  feedback: [
    {
      kind: "review_thread",
      path: "src/publish.ts",
      line: 12,
      outdated: false,
      comments: [{ author: "alice", body: "Rename.", createdAt: "2026-11-12T00:00:00Z" }],
    },
    { kind: "command_line", body: "Keep the flag." },
  ],
  feedbackThrough: "2026-11-12T00:00:00Z",
};

test("publishRevision pushes one commit to the PR branch, rewrites the body, and comments with a marker", async () => {
  const git = recordingRunner([
    result(" M src/publish.ts\n"),
    result(),
    result(),
    result(),
    result(),
    result("abc1234\n"),
    result(),
  ]);
  const gh = recordingRunner([result(), result()]);

  const published = await publishRevision({
    cwd: "/repo",
    issue: githubIssue,
    revision,
    authorName: "Agent Cage",
    authorEmail: "agent-cage@users.noreply.github.com",
    env: { GITHUB_TOKEN: "token" },
    metadata: { ...metadata, runId: "run-revise" },
    git,
    gh,
  });

  assert.deepEqual(
    git.calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["config", "user.name", "Agent Cage"],
      ["config", "user.email", "agent-cage@users.noreply.github.com"],
      ["add", "--all"],
      ["commit", "-m", "#11 Address pull request feedback"],
      ["rev-parse", "--short", "HEAD"],
      ["push", "origin", "HEAD:refs/heads/agent-cage/gh-11-run-abc"],
    ],
  );
  assert.ok(git.calls.every((call) => !call.args.some((arg) => arg.includes("force"))));

  const [edit, commentCall] = gh.calls.map((call) => call.args);
  assert.deepEqual(edit?.slice(0, 4), [
    "api",
    "--method",
    "PATCH",
    "repos/jhowliu/agent-cage/pulls/40",
  ]);
  assert.match(edit?.[5] ?? "", /^body=Adds the publish flow\./);
  assert.match(edit?.[5] ?? "", /- Run ID: run-revise/);
  assert.deepEqual(commentCall?.slice(0, 4), [
    "api",
    "--method",
    "POST",
    "repos/jhowliu/agent-cage/issues/40/comments",
  ]);
  const commentBody = (commentCall?.[5] ?? "").replace(/^body=/, "");
  assert.deepEqual(parseReviseMarker(commentBody), {
    runId: "run-revise",
    through: "2026-11-12T00:00:00Z",
  });
  assert.match(commentBody, /with commit abc1234/);
  assert.match(commentBody, /- Review thread on `src\/publish.ts:12` from alice/);
  assert.match(commentBody, /- Feedback given on the command line/);
  assert.equal(published.prUrl, revision.pullRequest.url);
  assert.equal(published.branchName, "agent-cage/gh-11-run-abc");
});

test("publishRevision keeps the PR body when the review wrote no description", async () => {
  const git = recordingRunner([
    result(" M src/publish.ts\n"),
    result(),
    result(),
    result(),
    result(),
    result("abc1234\n"),
    result(),
  ]);
  const gh = recordingRunner([result()]);

  const published = await publishRevision({
    cwd: "/repo",
    issue: githubIssue,
    revision,
    authorName: "Agent Cage",
    authorEmail: "agent-cage@users.noreply.github.com",
    metadata: { ...metadata, description: null },
    git,
    gh,
  });

  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0]?.args[3], "repos/jhowliu/agent-cage/issues/40/comments");
  assert.equal(published.prBody, "Old description.");
});

test("publishRevision rejects a revision without changes before committing", async () => {
  const git = recordingRunner([result("")]);
  const gh = recordingRunner([]);

  await assert.rejects(
    () =>
      publishRevision({
        cwd: "/repo",
        issue: githubIssue,
        revision,
        authorName: "Agent Cage",
        authorEmail: "agent-cage@users.noreply.github.com",
        metadata,
        git,
        gh,
      }),
    NoDiffError,
  );
  assert.equal(git.calls.length, 1);
  assert.equal(gh.calls.length, 0);
});
