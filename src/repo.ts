import { execa } from "execa";
import type { IssueContext } from "./issue.js";

export type GithubRepo = {
  owner: string;
  name: string;
  fullName: string;
};

export type RepoResolutionInput = {
  explicitRepo?: string;
  issue: IssueContext;
  cwd?: string;
  git?: GitRemoteReader;
};

export type RepoResolution = {
  repo: GithubRepo;
  source: "explicit" | "issue" | "cwd";
};

export type GitRemoteReader = {
  getOriginUrl: (cwd: string) => Promise<string | null>;
};

export type AuthenticatedRepo = {
  repo: GithubRepo;
  cloneUrl: string;
  redactedCloneUrl: string;
};

export const defaultGitRemoteReader: GitRemoteReader = {
  async getOriginUrl(cwd: string): Promise<string | null> {
    try {
      const result = await execa("git", ["remote", "get-url", "origin"], { cwd });
      return result.stdout.trim() === "" ? null : result.stdout.trim();
    } catch {
      return null;
    }
  },
};

export async function resolveTargetRepo(
  input: RepoResolutionInput,
): Promise<RepoResolution> {
  const cwd = input.cwd ?? process.cwd();
  const git = input.git ?? defaultGitRemoteReader;
  const explicitRepo =
    input.explicitRepo === undefined ? null : parseGithubRepo(input.explicitRepo);
  const issueRepo =
    input.issue.inferredRepo === null ? null : parseGithubRepo(input.issue.inferredRepo);
  const cwdRepo = await readCwdRepo(git, cwd);

  if (explicitRepo !== null) {
    return { repo: explicitRepo, source: "explicit" };
  }

  if (issueRepo !== null) {
    if (cwdRepo !== null && cwdRepo.fullName !== issueRepo.fullName) {
      throw new Error(
        `GitHub issue repo ${issueRepo.fullName} does not match current git origin ${cwdRepo.fullName}. Pass --repo to override.`,
      );
    }

    return { repo: issueRepo, source: "issue" };
  }

  if (cwdRepo !== null) {
    return { repo: cwdRepo, source: "cwd" };
  }

  throw new Error(
    "Could not resolve target repo. Pass --repo or run inside a GitHub repo.",
  );
}

export function parseGithubRepo(repo: string): GithubRepo {
  const trimmed = repo.trim();
  const normalized = normalizeGithubRemote(trimmed);
  const [owner, name, ...rest] = normalized.split("/");

  if (owner === undefined || name === undefined || rest.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
  };
}

export function createAuthenticatedRepo(
  repo: GithubRepo,
  githubToken: string | undefined,
): AuthenticatedRepo {
  if (githubToken === undefined || githubToken.trim() === "") {
    throw new Error(
      "GITHUB_TOKEN is required for GitHub clone, push, issue, and pull request operations.",
    );
  }

  return {
    repo,
    cloneUrl: `https://github.com/${repo.fullName}.git`,
    redactedCloneUrl: `https://github.com/${repo.fullName}.git`,
  };
}

export function redactGithubToken(
  value: string,
  githubToken: string | undefined,
): string {
  if (githubToken === undefined || githubToken === "") {
    return value;
  }

  return value
    .split(githubToken)
    .join("[REDACTED]")
    .split(encodeURIComponent(githubToken))
    .join("[REDACTED]")
    .replace(
      /https:\/\/x-access-token:[^@\s]+@github\.com/g,
      "https://x-access-token:[REDACTED]@github.com",
    );
}

async function readCwdRepo(
  git: GitRemoteReader,
  cwd: string,
): Promise<GithubRepo | null> {
  const originUrl = await git.getOriginUrl(cwd);

  if (originUrl === null) {
    return null;
  }

  return parseGithubRepo(originUrl);
}

function normalizeGithubRemote(remote: string): string {
  const withoutTrailingGit = remote.endsWith(".git") ? remote.slice(0, -4) : remote;
  const sshMatch = withoutTrailingGit.match(/^git@github\.com:([^/]+)\/([^/]+)$/);

  if (sshMatch !== null) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  const sshUrlMatch = withoutTrailingGit.match(
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
  );

  if (sshUrlMatch !== null) {
    return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  if (/^[^/:]+\/[^/:]+$/.test(withoutTrailingGit)) {
    return withoutTrailingGit;
  }

  let url: URL;

  try {
    url = new URL(withoutTrailingGit);
  } catch {
    throw new Error(`Invalid GitHub repository: ${remote}`);
  }

  if (url.hostname !== "github.com") {
    throw new Error(`Only github.com repositories are supported: ${remote}`);
  }

  const [owner, repo, ...rest] = url.pathname.split("/").filter(Boolean);

  if (owner === undefined || repo === undefined || rest.length > 0) {
    throw new Error(`Invalid GitHub repository: ${remote}`);
  }

  return `${owner}/${repo}`;
}
