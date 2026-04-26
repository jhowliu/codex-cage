import { execa } from "execa";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  env?: Record<string, string> | undefined;
};

export type PublishMetadata = {
  runId: string;
  summary: string;
  verification: string[];
  reviewStatus: string;
  risks: string[];
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
  env?: Record<string, string> | undefined;
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
    return await runWithTemporaryGitHubAskpass("git", args, options);
  },
};

export const execaGhRunner: CommandRunner = {
  async run(args: string[], options: CommandRunOptions = {}): Promise<CommandResult> {
    const result = await execa("gh", args, execaOptions(options));

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

  if (await branchExists({ cwd: input.cwd, branchName, git, env: input.env })) {
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
  await runRequired(git, ["push", "-u", "origin", branchName], input.cwd, input.env);

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

  const prResult = await runRequired(gh, prCreateArgs, input.cwd, input.env);
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
  env?: Record<string, string> | undefined;
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
    { cwd: input.cwd, env: input.env },
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
  env?: Record<string, string> | undefined,
): Promise<CommandResult> {
  const result = await runner.run(args, { cwd, env });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stderr}`);
  }

  return result;
}

async function runWithTemporaryGitHubAskpass(
  executable: string,
  args: string[],
  options: CommandRunOptions,
): Promise<CommandResult> {
  const token = options.env?.GITHUB_TOKEN ?? options.env?.GH_TOKEN;

  if (token === undefined || token === "") {
    const result = await execa(executable, args, execaOptions(options));

    return commandResultFromExeca(result);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "codex-cage-git-auth-"));
  const askpassPath = join(tempDir, "askpass.sh");

  try {
    await writeFile(
      askpassPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        '*Username*) printf "%s\\n" "x-access-token" ;;',
        '*Password*) printf "%s\\n" "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;;',
        '*) printf "%s\\n" ;;',
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(askpassPath, 0o700);

    const result = await execa(executable, args, {
      ...execaOptions({ cwd: options.cwd }),
      env: {
        ...options.env,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
      },
      reject: false,
    });

    return commandResultFromExeca(result);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function execaOptions(options: CommandRunOptions): {
  cwd?: string;
  env?: Record<string, string>;
  reject: false;
} {
  return {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    reject: false,
  };
}

function commandResultFromExeca(result: {
  exitCode?: number;
  stdout?: unknown;
  stderr?: unknown;
}): CommandResult {
  return {
    exitCode: result.exitCode ?? 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}
