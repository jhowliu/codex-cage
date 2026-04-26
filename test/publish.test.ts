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
  publishSuccessfulRun,
  type CommandResult,
  type CommandRunner,
} from "../src/publish.js";
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
  name: "codex-cage",
  fullName: "jhowliu/codex-cage",
};

const githubIssue: IssueContext = {
  source: "github",
  url: "https://github.com/jhowliu/codex-cage/issues/11",
  identifier: "#11",
  title: "Publish successful runs",
  body: "Create PRs after checks pass.",
  comments: [],
  inferredRepo: "jhowliu/codex-cage",
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
  summary: "Implemented publish flow.",
  verification: ["npm test", "npm run format"],
  reviewStatus: "Independent review passed.",
  risks: ["GitHub API unavailable would fail publishing."],
};

test("generateBranchName creates run-specific branch names", () => {
  assert.equal(
    generateBranchName({ issue: githubIssue, runId: metadata.runId }),
    "codex-cage/gh-11-run-1234567890ab",
  );
  assert.equal(
    generateBranchName({ issue: linearIssue, runId: metadata.runId }),
    "codex-cage/linear-eng-123-run-1234567890ab",
  );
});

test("formatPrBody includes summary, verification, review, risks, run id, and GitHub closing keyword", () => {
  const body = formatPrBody({ issue: githubIssue, metadata });

  assert.match(body, /## Summary\nImplemented publish flow/);
  assert.match(body, /- npm test/);
  assert.match(body, /Independent review passed/);
  assert.match(body, /GitHub API unavailable/);
  assert.match(body, /Run ID: run-1234567890abcdef/);
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
      branchName: "codex-cage/gh-11-run-1",
      git,
    }),
    true,
  );
  assert.deepEqual(
    git.calls.map((call) => call.args),
    [
      ["rev-parse", "--verify", "refs/heads/codex-cage/gh-11-run-1"],
      ["ls-remote", "--exit-code", "--heads", "origin", "codex-cage/gh-11-run-1"],
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
  const gh = recordingRunner([result("https://github.com/jhowliu/codex-cage/pull/23\n")]);

  const publish = await publishSuccessfulRun({
    cwd: "/repo",
    repo,
    issue: githubIssue,
    baseBranch: "main",
    authorName: "Codex Cage",
    authorEmail: "codex-cage@users.noreply.github.com",
    metadata,
    env: { GITHUB_TOKEN: "token-value" },
    git,
    gh,
  });

  assert.equal(publish.branchName, "codex-cage/gh-11-run-1234567890ab");
  assert.equal(publish.commitMessage, "#11 Publish successful runs");
  assert.equal(publish.prTitle, "#11 Publish successful runs");
  assert.equal(publish.prUrl, "https://github.com/jhowliu/codex-cage/pull/23");
  assert.deepEqual(
    git.calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["rev-parse", "--verify", "refs/heads/codex-cage/gh-11-run-1234567890ab"],
      [
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        "codex-cage/gh-11-run-1234567890ab",
      ],
      ["checkout", "-b", "codex-cage/gh-11-run-1234567890ab"],
      ["config", "user.name", "Codex Cage"],
      ["config", "user.email", "codex-cage@users.noreply.github.com"],
      ["add", "--all"],
      ["commit", "-m", "#11 Publish successful runs"],
      ["push", "-u", "origin", "codex-cage/gh-11-run-1234567890ab"],
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
    "jhowliu/codex-cage",
    "--base",
    "main",
    "--head",
    "codex-cage/gh-11-run-1234567890ab",
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
  const gh = recordingRunner([result("https://github.com/jhowliu/codex-cage/pull/24\n")]);

  await publishSuccessfulRun({
    cwd: "/repo",
    repo,
    issue: githubIssue,
    baseBranch: "main",
    authorName: "Codex Cage",
    authorEmail: "codex-cage@users.noreply.github.com",
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
        authorName: "Codex Cage",
        authorEmail: "codex-cage@users.noreply.github.com",
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
        authorName: "Codex Cage",
        authorEmail: "codex-cage@users.noreply.github.com",
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
