import assert from "node:assert/strict";
import test from "node:test";
import type { IssueContext } from "../src/issue.js";
import { assertNoGuardViolations, scanDiffForGuardViolations } from "../src/guards.js";
import {
  NoDiffError,
  publishSuccessfulRun,
  type CommandResult,
  type CommandRunner,
  type PublishMetadata,
} from "../src/publish.js";
import type { GithubRepo } from "../src/repo.js";
import { runIndependentReview, type ReviewAgentRunner } from "../src/review.js";

type QaScenario =
  | "success"
  | "verify_failed"
  | "review_blocking"
  | "secret_guard_failed"
  | "no_diff";

type QaResult = {
  scenario: QaScenario;
  status: "succeeded" | "failed";
  failureCode: string | null;
  prUrl: string | null;
};

type FakeRunInput = {
  scenario: QaScenario;
};

type RecordedCall = {
  args: string[];
};

const repo: GithubRepo = {
  owner: "jhowliu",
  name: "codex-cage",
  fullName: "jhowliu/codex-cage",
};

const issue: IssueContext = {
  source: "github",
  url: "https://github.com/jhowliu/codex-cage/issues/13",
  identifier: "#13",
  title: "Docs and QA",
  body: "Document the workflow and add QA coverage.",
  comments: [],
  inferredRepo: "jhowliu/codex-cage",
};

const metadata: PublishMetadata = {
  runId: "run-qa-1234567890",
  summary: "Fake QA implementation completed.",
  verification: ["fake verify passed"],
  reviewStatus: "Independent review passed.",
  risks: [],
};

function commandResult(stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

function recordingCommandRunner(results: CommandResult[]): CommandRunner & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  return {
    calls,
    async run(args): Promise<CommandResult> {
      calls.push({ args });
      const next = results.shift();

      if (next === undefined) {
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      }

      return next;
    },
  };
}

function reviewRunner(report: unknown): ReviewAgentRunner {
  return {
    async run(): Promise<string> {
      return JSON.stringify(report);
    },
  };
}

async function runFakeQaScenario(input: FakeRunInput): Promise<QaResult> {
  const diff =
    input.scenario === "no_diff"
      ? ""
      : `diff --git a/src/app.ts b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const changed = true;
`;

  if (input.scenario === "verify_failed") {
    return {
      scenario: input.scenario,
      status: "failed",
      failureCode: "verify_failed",
      prUrl: null,
    };
  }

  const guardedDiff =
    input.scenario === "secret_guard_failed"
      ? `diff --git a/src/app.ts b/src/app.ts
@@ -1 +1,2 @@
 export const ok = true;
+export const token = "known-secret-value";
`
      : diff;
  const guardViolations = scanDiffForGuardViolations(guardedDiff, {
    injectedSecrets: { GITHUB_TOKEN: "known-secret-value" },
  });

  try {
    assertNoGuardViolations(guardViolations);
  } catch {
    return {
      scenario: input.scenario,
      status: "failed",
      failureCode: "secret_guard_failed",
      prUrl: null,
    };
  }

  const review = await runIndependentReview({
    cwd: "/repo",
    model: "gpt-5.4",
    cycle: 0,
    maxReviewCycles: 0,
    issueContext: issue.body,
    diff,
    verificationSummary: "fake verify passed",
    resultMetadata: { runId: metadata.runId },
    readCurrentDiff: async () => diff,
    runner: reviewRunner(
      input.scenario === "review_blocking"
        ? {
            decision: "blocking",
            summary: "Blocking review.",
            findings: [
              {
                severity: "blocking",
                message: "Missing required behavior.",
                path: "src/app.ts",
                line: 2,
              },
            ],
          }
        : {
            decision: "pass",
            summary: "No blocking issues.",
            findings: [],
          },
    ),
  });

  if (review.nextAction.action === "fail") {
    return {
      scenario: input.scenario,
      status: "failed",
      failureCode: review.nextAction.failureCode,
      prUrl: null,
    };
  }

  const git = recordingCommandRunner(
    input.scenario === "no_diff"
      ? [commandResult("")]
      : [
          commandResult(" M src/app.ts\n"),
          commandResult("", 1),
          commandResult("", 1),
          commandResult(),
          commandResult(),
          commandResult(),
          commandResult(),
          commandResult(),
          commandResult(),
        ],
  );
  const gh = recordingCommandRunner([
    commandResult("https://github.com/jhowliu/codex-cage/pull/99\n"),
  ]);

  try {
    const publish = await publishSuccessfulRun({
      cwd: "/repo",
      repo,
      issue,
      baseBranch: "main",
      authorName: "Codex Cage",
      authorEmail: "codex-cage@users.noreply.github.com",
      metadata,
      git,
      gh,
    });

    return {
      scenario: input.scenario,
      status: "succeeded",
      failureCode: null,
      prUrl: publish.prUrl,
    };
  } catch (error) {
    if (error instanceof NoDiffError) {
      return {
        scenario: input.scenario,
        status: "failed",
        failureCode: "no_diff",
        prUrl: null,
      };
    }

    throw error;
  }
}

test("QA harness covers success, verify failure, review blocking, secret guard failure, and no-op diff", async () => {
  const scenarios: QaScenario[] = [
    "success",
    "verify_failed",
    "review_blocking",
    "secret_guard_failed",
    "no_diff",
  ];
  const results = await Promise.all(
    scenarios.map((scenario) => runFakeQaScenario({ scenario })),
  );

  assert.deepEqual(results, [
    {
      scenario: "success",
      status: "succeeded",
      failureCode: null,
      prUrl: "https://github.com/jhowliu/codex-cage/pull/99",
    },
    {
      scenario: "verify_failed",
      status: "failed",
      failureCode: "verify_failed",
      prUrl: null,
    },
    {
      scenario: "review_blocking",
      status: "failed",
      failureCode: "review_blocking",
      prUrl: null,
    },
    {
      scenario: "secret_guard_failed",
      status: "failed",
      failureCode: "secret_guard_failed",
      prUrl: null,
    },
    {
      scenario: "no_diff",
      status: "failed",
      failureCode: "no_diff",
      prUrl: null,
    },
  ]);
});
