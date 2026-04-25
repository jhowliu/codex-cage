import { execa } from "execa";
import {
  formatDependencyChangesMarkdown,
  type DependencyChangeSummary,
} from "./dependencies.js";
import type { IssueContext } from "./issue.js";
import type { GithubRepo } from "./repo.js";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = {
  run: (args: string[], options?: CommandRunOptions) => Promise<CommandResult>;
};

export type CommandRunOptions = {
  cwd?: string | undefined;
};

export type PublishMetadata = {
  runId: string;
  summary: string;
  verification: string[];
  reviewStatus: string;
  risks: string[];
  dependencyChanges?: DependencyChangeSummary | undefined;
};

export type PublishSuccessfulRunInput = {
  cwd: string;
  repo: GithubRepo;
  issue: IssueContext;
  baseBranch: string;
  authorName: string;
  authorEmail: string;
  metadata: PublishMetadata;
  branchName?: string | undefined;
  draft?: boolean | undefined;
  git?: CommandRunner | undefined;
  gh?: CommandRunner | undefined;
};

export type PublishSuccessfulRunResult = {
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  prUrl: string;
};

export class NoDiffError extends Error {
  constructor() {
    super("No changes to publish.");
    this.name = "NoDiffError";
  }
}

export class BranchExistsError extends Error {
  constructor(branchName: string) {
    super(`Branch "${branchName}" already exists.`);
    this.name = "BranchExistsError";
  }
}

export const execaGitRunner: CommandRunner = {
  async run(args: string[], options: CommandRunOptions = {}): Promise<CommandResult> {
    const result =
      options.cwd === undefined
        ? await execa("git", args, { reject: false })
        : await execa("git", args, {
            cwd: options.cwd,
            reject: false,
          });

    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
};

export const execaGhRunner: CommandRunner = {
  async run(args: string[], options: CommandRunOptions = {}): Promise<CommandResult> {
    const result =
      options.cwd === undefined
        ? await execa("gh", args, { reject: false })
        : await execa("gh", args, {
            cwd: options.cwd,
            reject: false,
          });

    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
};

export async function publishSuccessfulRun(
  input: PublishSuccessfulRunInput,
): Promise<PublishSuccessfulRunResult> {
  const git = input.git ?? execaGitRunner;
  const gh = input.gh ?? execaGhRunner;
  const branchName =
    input.branchName ??
    generateBranchName({
      issue: input.issue,
      runId: input.metadata.runId,
    });

  if (!(await hasPublishableChanges({ cwd: input.cwd, git }))) {
    throw new NoDiffError();
  }

  if (await branchExists({ cwd: input.cwd, branchName, git })) {
    throw new BranchExistsError(branchName);
  }

  const prTitle = prTitleFromIssue(input.issue);
  const commitMessage = prTitle;
  const prBody = formatPrBody({
    issue: input.issue,
    metadata: input.metadata,
  });

  await runRequired(git, ["checkout", "-b", branchName], input.cwd);
  await runRequired(git, ["config", "user.name", input.authorName], input.cwd);
  await runRequired(git, ["config", "user.email", input.authorEmail], input.cwd);
  await runRequired(git, ["add", "--all"], input.cwd);
  await runRequired(git, ["commit", "-m", commitMessage], input.cwd);
  await runRequired(git, ["push", "-u", "origin", branchName], input.cwd);

  const prCreateArgs = [
    "pr",
    "create",
    "--repo",
    input.repo.fullName,
    "--base",
    input.baseBranch,
    "--head",
    branchName,
    "--title",
    prTitle,
    "--body",
    prBody,
  ];

  if (input.draft === true) {
    prCreateArgs.push("--draft");
  }

  const prResult = await runRequired(gh, prCreateArgs, input.cwd);
  const prUrl = prResult.stdout.trim();

  return {
    branchName,
    commitMessage,
    prTitle,
    prBody,
    prUrl,
  };
}

export function generateBranchName(input: {
  issue: IssueContext;
  runId: string;
}): string {
  const source = input.issue.source === "github" ? "gh" : "linear";
  const issueId = sanitizeBranchSegment(input.issue.identifier);
  const runId = sanitizeBranchSegment(input.runId)
    .replace(/^run-?/, "")
    .slice(0, 12);

  return `codex-cage/${source}-${issueId}-run-${runId}`;
}

export async function hasPublishableChanges(input: {
  cwd: string;
  git?: CommandRunner;
}): Promise<boolean> {
  const git = input.git ?? execaGitRunner;
  const result = await git.run(["status", "--porcelain"], { cwd: input.cwd });

  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect git status: ${result.stderr}`);
  }

  return result.stdout.trim() !== "";
}

export async function branchExists(input: {
  cwd: string;
  branchName: string;
  git?: CommandRunner;
}): Promise<boolean> {
  const git = input.git ?? execaGitRunner;
  const local = await git.run(
    ["rev-parse", "--verify", `refs/heads/${input.branchName}`],
    { cwd: input.cwd },
  );

  if (local.exitCode === 0) {
    return true;
  }

  const remote = await git.run(
    ["ls-remote", "--exit-code", "--heads", "origin", input.branchName],
    { cwd: input.cwd },
  );

  return remote.exitCode === 0;
}

export function formatPrBody(input: {
  issue: IssueContext;
  metadata: PublishMetadata;
}): string {
  const risks =
    input.metadata.risks.length === 0
      ? "- None noted."
      : input.metadata.risks.map((risk) => `- ${risk}`).join("\n");
  const verification =
    input.metadata.verification.length === 0
      ? "- Not recorded."
      : input.metadata.verification.map((item) => `- ${item}`).join("\n");

  return `## Summary
${input.metadata.summary}

## Dependency Changes
${formatDependencyChangesMarkdown(input.metadata.dependencyChanges ?? emptyDependencyChanges)}

## Verification
${verification}

## Review
${input.metadata.reviewStatus}

## Risks
${risks}

## Run
- Run ID: ${input.metadata.runId}

## Issue
${formatIssueLinkage(input.issue)}
`;
}

const emptyDependencyChanges: DependencyChangeSummary = {
  changed: false,
  files: [],
};

export function formatIssueLinkage(issue: IssueContext): string {
  if (issue.source === "github") {
    return `- ${issue.url}\n- Closes ${issue.identifier}`;
  }

  return `- Linear: ${issue.url}`;
}

function prTitleFromIssue(issue: IssueContext): string {
  return `${issue.identifier} ${issue.title}`;
}

function sanitizeBranchSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalized === "") {
    return "issue";
  }

  return normalized;
}

async function runRequired(
  runner: CommandRunner,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  const result = await runner.run(args, { cwd });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stderr}`);
  }

  return result;
}
