import assert from "node:assert/strict";
import test from "node:test";
import {
  blockingReviewFeedback,
  buildReviewPrompt,
  parseReviewReport,
  reviewNextAction,
  runIndependentReview,
  type ReviewAgentRunner,
} from "../src/review.js";

function recordingReviewRunner(output: string): ReviewAgentRunner & {
  calls: Array<Parameters<ReviewAgentRunner["run"]>[0]>;
} {
  const calls: Array<Parameters<ReviewAgentRunner["run"]>[0]> = [];

  return {
    calls,
    async run(input): Promise<string> {
      calls.push(input);
      return output;
    },
  };
}

const passReportJson = JSON.stringify({
  decision: "pass",
  summary: "No blocking issues.",
  findings: [],
});

const blockingReportJson = JSON.stringify({
  decision: "blocking",
  summary: "Needs a fix.",
  findings: [
    {
      severity: "blocking",
      message: "Verification command is not wired.",
      path: "src/run.ts",
      line: 42,
    },
  ],
});

test("buildReviewPrompt includes read-only instructions and required context", () => {
  const prompt = buildReviewPrompt({
    issueContext: "Issue: add review",
    diff: "diff --git a/src/app.ts b/src/app.ts",
    verificationSummary: "npm test passed",
    resultMetadata: {
      runId: "run-1",
      verify: ["npm test"],
    },
  });

  assert.match(prompt, /read-only reviewer/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /Issue: add review/);
  assert.match(prompt, /npm test passed/);
  assert.match(prompt, /"runId": "run-1"/);
  assert.match(prompt, /diff --git/);
});

test("parseReviewReport accepts strict structured JSON from the review agent", () => {
  assert.deepEqual(parseReviewReport(`\n\`\`\`json\n${blockingReportJson}\n\`\`\`\n`), {
    decision: "blocking",
    summary: "Needs a fix.",
    findings: [
      {
        severity: "blocking",
        message: "Verification command is not wired.",
        path: "src/run.ts",
        line: 42,
      },
    ],
  });
});

test("parseReviewReport ignores non-json fenced blocks before JSON", () => {
  assert.deepEqual(
    parseReviewReport(`\n\`\`\`bash\n-code\n\`\`\`\n\n${passReportJson}\n`),
    {
      decision: "pass",
      summary: "No blocking issues.",
      findings: [],
    },
  );
});

test("parseReviewReport rejects passing reports with blocking findings", () => {
  assert.throws(
    () =>
      parseReviewReport(
        JSON.stringify({
          decision: "pass",
          summary: "looks good",
          findings: [{ severity: "blocking", message: "bug" }],
        }),
      ),
    /Passing review reports cannot contain blocking findings/,
  );
});

test("reviewNextAction allows passing review to continue", () => {
  assert.deepEqual(
    reviewNextAction({
      report: parseReviewReport(passReportJson),
      cycle: 0,
      maxReviewCycles: 2,
    }),
    { action: "continue" },
  );
});

test("reviewNextAction feeds blocking findings back until max review cycles", () => {
  assert.deepEqual(
    reviewNextAction({
      report: parseReviewReport(blockingReportJson),
      cycle: 0,
      maxReviewCycles: 2,
    }),
    {
      action: "fix",
      nextCycle: 1,
      feedback: "1. Verification command is not wired. (src/run.ts:42)",
    },
  );

  assert.deepEqual(
    reviewNextAction({
      report: parseReviewReport(blockingReportJson),
      cycle: 2,
      maxReviewCycles: 2,
    }),
    {
      action: "fail",
      failureCode: "review_blocking",
      feedback: "1. Verification command is not wired. (src/run.ts:42)",
    },
  );
});

test("blockingReviewFeedback formats blocking findings for the implementer", () => {
  assert.equal(
    blockingReviewFeedback(parseReviewReport(blockingReportJson)),
    "1. Verification command is not wired. (src/run.ts:42)",
  );
});

test("runIndependentReview runs a fresh review runner and returns parsed action", async () => {
  const runner = recordingReviewRunner(passReportJson);
  const diff = "diff --git a/src/app.ts b/src/app.ts";
  const result = await runIndependentReview({
    cwd: "/repo",
    model: "gpt-5.4",
    cycle: 0,
    maxReviewCycles: 2,
    issueContext: "Issue context",
    diff,
    verificationSummary: "npm test passed",
    resultMetadata: { runId: "run-1" },
    readCurrentDiff: async () => diff,
    runner,
    env: { OPENAI_API_KEY: "secret" },
  });

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.cwd, "/repo");
  assert.equal(runner.calls[0]?.model, "gpt-5.4");
  assert.deepEqual(runner.calls[0]?.env, { OPENAI_API_KEY: "secret" });
  assert.equal(result.report.decision, "pass");
  assert.deepEqual(result.nextAction, { action: "continue" });
});

test("runIndependentReview fails if the read-only review changes the diff", async () => {
  const runner = recordingReviewRunner(passReportJson);

  await assert.rejects(
    () =>
      runIndependentReview({
        cwd: "/repo",
        model: "gpt-5.4",
        cycle: 0,
        maxReviewCycles: 2,
        issueContext: "Issue context",
        diff: "before",
        verificationSummary: "npm test passed",
        resultMetadata: { runId: "run-1" },
        readCurrentDiff: async () => "after",
        runner,
      }),
    { name: "ReviewModifiedDiffError" },
  );
});
