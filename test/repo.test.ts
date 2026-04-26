import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthenticatedRepo,
  parseGithubRepo,
  redactGithubToken,
  resolveTargetRepo,
  type GitRemoteReader,
} from "../src/repo.js";
import type { IssueContext } from "../src/issue.js";

function issueContext(inferredRepo: string | null): IssueContext {
  return {
    source: inferredRepo === null ? "linear" : "github",
    url:
      inferredRepo === null
        ? "https://linear.app/acme/issue/ENG-123/fix-login"
        : `https://github.com/${inferredRepo}/issues/123`,
    identifier: inferredRepo === null ? "ENG-123" : "#123",
    title: "Issue title",
    body: "Issue body",
    comments: [],
    inferredRepo,
  };
}

function gitOrigin(originUrl: string | null): GitRemoteReader {
  return {
    async getOriginUrl(): Promise<string | null> {
      return originUrl;
    },
  };
}

test("parseGithubRepo normalizes owner/name strings", () => {
  assert.deepEqual(parseGithubRepo("jhowliu/codex-cage"), {
    owner: "jhowliu",
    name: "codex-cage",
    fullName: "jhowliu/codex-cage",
  });
});

test("parseGithubRepo normalizes GitHub HTTPS remotes", () => {
  assert.equal(
    parseGithubRepo("https://github.com/jhowliu/codex-cage.git").fullName,
    "jhowliu/codex-cage",
  );
});

test("parseGithubRepo normalizes GitHub SSH remotes", () => {
  assert.equal(
    parseGithubRepo("git@github.com:jhowliu/codex-cage.git").fullName,
    "jhowliu/codex-cage",
  );
});

test("resolveTargetRepo prefers explicit repo", async () => {
  const result = await resolveTargetRepo({
    explicitRepo: "jhowliu/override",
    issue: issueContext("jhowliu/codex-cage"),
    git: gitOrigin("https://github.com/jhowliu/local.git"),
  });

  assert.equal(result.source, "explicit");
  assert.equal(result.repo.fullName, "jhowliu/override");
});

test("resolveTargetRepo uses GitHub issue inferred repo", async () => {
  const result = await resolveTargetRepo({
    issue: issueContext("jhowliu/codex-cage"),
    git: gitOrigin("https://github.com/jhowliu/codex-cage.git"),
  });

  assert.equal(result.source, "issue");
  assert.equal(result.repo.fullName, "jhowliu/codex-cage");
});

test("resolveTargetRepo fails on GitHub issue and cwd origin mismatch", async () => {
  await assert.rejects(
    () =>
      resolveTargetRepo({
        issue: issueContext("jhowliu/codex-cage"),
        git: gitOrigin("https://github.com/jhowliu/other.git"),
      }),
    /does not match current git origin/,
  );
});

test("resolveTargetRepo uses cwd origin for Linear issue", async () => {
  const result = await resolveTargetRepo({
    issue: issueContext(null),
    git: gitOrigin("git@github.com:jhowliu/codex-cage.git"),
  });

  assert.equal(result.source, "cwd");
  assert.equal(result.repo.fullName, "jhowliu/codex-cage");
});

test("resolveTargetRepo fails when no repo source exists", async () => {
  await assert.rejects(
    () =>
      resolveTargetRepo({
        issue: issueContext(null),
        git: gitOrigin(null),
      }),
    /Could not resolve target repo/,
  );
});

test("createAuthenticatedRepo validates token but returns tokenless HTTPS clone URL", () => {
  const authenticatedRepo = createAuthenticatedRepo(
    parseGithubRepo("jhowliu/codex-cage"),
    "ghp_secret",
  );

  assert.equal(authenticatedRepo.cloneUrl, "https://github.com/jhowliu/codex-cage.git");
  assert.equal(
    authenticatedRepo.redactedCloneUrl,
    "https://github.com/jhowliu/codex-cage.git",
  );
});

test("createAuthenticatedRepo requires GITHUB_TOKEN", () => {
  assert.throws(
    () => createAuthenticatedRepo(parseGithubRepo("jhowliu/codex-cage"), ""),
    /GITHUB_TOKEN is required/,
  );
});

test("redactGithubToken removes token values from logs", () => {
  assert.equal(
    redactGithubToken(
      "push https://x-access-token:ghp_secret%40value@github.com",
      "ghp_secret@value",
    ),
    "push https://x-access-token:[REDACTED]@github.com",
  );
});
