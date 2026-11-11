import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkIssue, type CheckIssueDependencies } from "../src/check.js";
import type { IssueContext } from "../src/issue.js";
import { runCodexCage } from "../src/run.js";

const issueUrl = "https://github.com/jhowliu/codex-cage/issues/200";

function dependencies(
  body: string,
  fetched: string[] = [],
  overrides: Partial<IssueContext> = {},
): CheckIssueDependencies {
  const issue: IssueContext = {
    source: "github",
    url: issueUrl,
    identifier: "#200",
    title: "Add multiply()",
    body,
    comments: [],
    inferredRepo: "jhowliu/codex-cage",
    ...overrides,
  };

  return {
    readEnv: async () => ({ GITHUB_TOKEN: "token-value" }),
    findGithubToken: async () => null,
    fetchIssueContext: async (url) => {
      fetched.push(url);
      return issue;
    },
    lookupIssueState: async (reference) => (reference.number === 1 ? "open" : "closed"),
  };
}

async function withProject(config: string | null, body: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-check-"));
  try {
    if (config !== null) await writeFile(join(cwd, ".codex-cage.yml"), config, "utf8");
    await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("checkIssue reports a missing config without fetching the issue", async () => {
  await withProject(null, async (cwd) => {
    const fetched: string[] = [];
    const result = await checkIssue(cwd, { issueUrl }, dependencies("", fetched));

    assert.equal(result.ready, false);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["missing_config"],
    );
    assert.deepEqual(fetched, []);
  });
});

test("checkIssue is not ready while a blocker is open and lists template warnings", async () => {
  await withProject("verify:\n  - npm test\n", async (cwd) => {
    const result = await checkIssue(
      cwd,
      { issueUrl },
      dependencies("## What to build\nMultiply.\n\n## Blocked by\n- #1\n- #2\n"),
    );

    assert.equal(result.ready, false);
    assert.deepEqual(result.issue, { identifier: "#200", title: "Add multiply()" });
    assert.deepEqual(
      result.findings.map((finding) => [finding.level, finding.code]),
      [
        ["warning", "missing_section"],
        ["error", "blocked_by_open_issue"],
      ],
    );
  });
});

test("checkIssue is ready when every blocker is closed", async () => {
  await withProject("verify:\n  - npm test\n", async (cwd) => {
    const result = await checkIssue(
      cwd,
      { issueUrl },
      dependencies(
        "## What to build\nA\n\n## Acceptance criteria\n- B\n\n## Blocked by\n- #2\n",
      ),
    );

    assert.deepEqual(
      { ready: result.ready, findings: result.findings },
      { ready: true, findings: [] },
    );
  });
});

test("checkIssue reports the setup failure that stops run, with the same message", async () => {
  await withProject("verify:\n  - npm test\n", async (cwd) => {
    const withoutToken: CheckIssueDependencies = {
      ...dependencies("## What to build\nA\n\n## Acceptance criteria\n- B\n"),
      readEnv: async () => ({}),
    };
    const result = await checkIssue(cwd, { issueUrl }, withoutToken);

    assert.equal(result.ready, false);
    assert.deepEqual(
      result.findings.map((finding) => [finding.level, finding.code]),
      [["error", "internal_error"]],
    );
    assert.match(result.findings[0]?.message ?? "", /GITHUB_TOKEN is required/);
    await assert.rejects(
      runCodexCage({ cwd, issueUrl }, withoutToken),
      (error) => error instanceof Error && error.message === result.findings[0]?.message,
    );
  });
});

test("checkIssue resolves the target repository like run, including --repo", async () => {
  await withProject("verify:\n  - npm test\n", async (cwd) => {
    const linearIssue = dependencies(
      "## What to build\nA\n\n## Acceptance criteria\n- B\n",
      [],
      { source: "linear", identifier: "ENG-1", inferredRepo: null },
    );

    const withoutRepo = await checkIssue(cwd, { issueUrl }, linearIssue);
    assert.equal(withoutRepo.ready, false);
    assert.match(withoutRepo.findings[0]?.message ?? "", /Could not resolve target repo/);

    const withRepo = await checkIssue(
      cwd,
      { issueUrl, repo: "jhowliu/codex-cage" },
      linearIssue,
    );
    assert.deepEqual(
      { ready: withRepo.ready, findings: withRepo.findings },
      { ready: true, findings: [] },
    );
  });
});
