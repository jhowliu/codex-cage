import assert from "node:assert/strict";
import test from "node:test";
import {
  blockingReviewFeedback,
  buildReviewPrompt,
  parseReviewReport,
  reviewReportJsonSchema,
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
  prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.\n",
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
  prDescription: null,
});

test("buildReviewPrompt includes read-only instructions and required context", () => {
  const prompt = buildReviewPrompt({
    issueContext: "Issue: add review",
    diff: "diff --git a/src/app.ts b/src/app.ts",
    verificationSummary: "npm test passed",
    reviewPolicyStatus:
      "Target review policy: present at /workspace/.agent-cage/review-policy.md.",
    resultMetadata: {
      runId: "run-1",
      verify: ["npm test"],
    },
  });

  assert.match(prompt, /read-only reviewer/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /Issue: add review/);
  assert.match(prompt, /npm test passed/);
  assert.match(prompt, /Target review policy: present/);
  assert.match(prompt, /"runId": "run-1"/);
  assert.match(prompt, /diff --git/);
});

test("buildReviewPrompt asks a passing review for a PR description that follows the repo's rules", () => {
  const prompt = buildReviewPrompt({
    issueContext: "Issue: add review",
    diff: "diff --git a/src/app.ts b/src/app.ts",
    verificationSummary: "npm test passed",
    resultMetadata: { runId: "run-1" },
  });

  assert.match(prompt, /"prDescription": "Markdown pull request description" or null/);
  assert.match(
    prompt,
    /pull request description rules in the AGENTS\.md and CLAUDE\.md files/,
  );
  assert.match(
    prompt,
    /Agent Cage appends the verification results, this review's status, the run ID and the issue link/,
  );
  assert.match(prompt, /When the decision is "blocking", set "prDescription" to null/);
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
    prDescription: null,
  });
});

test("parseReviewReport ignores non-json fenced blocks before JSON", () => {
  assert.deepEqual(
    parseReviewReport(`\n\`\`\`bash\n-code\n\`\`\`\n\n${passReportJson}\n`),
    {
      decision: "pass",
      summary: "No blocking issues.",
      findings: [],
      prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.",
    },
  );
});

test("parseReviewReport normalizes nullable structured output fields", () => {
  assert.deepEqual(
    parseReviewReport(
      JSON.stringify({
        decision: "blocking",
        summary: "Needs a fix.",
        findings: [
          {
            severity: "blocking",
            message: "Missing required behavior.",
            path: null,
            line: null,
          },
        ],
      }),
    ),
    {
      decision: "blocking",
      summary: "Needs a fix.",
      findings: [
        {
          severity: "blocking",
          message: "Missing required behavior.",
        },
      ],
      prDescription: null,
    },
  );
});

test("parseReviewReport keeps a PR description only from a passing review", () => {
  const pass = { decision: "pass", summary: "ok", findings: [] };
  const blocking = JSON.parse(blockingReportJson) as Record<string, unknown>;

  assert.equal(parseReviewReport(JSON.stringify(pass)).prDescription, null, "left out");
  assert.equal(
    parseReviewReport(JSON.stringify({ ...pass, prDescription: "  \n" })).prDescription,
    null,
    "blank",
  );
  assert.equal(
    parseReviewReport(JSON.stringify({ ...blocking, prDescription: "Adds review." }))
      .prDescription,
    null,
    "a blocking review's diff changes before publish",
  );
});

test("review report JSON schema requires every finding property", () => {
  assert.deepEqual(reviewReportJsonSchema.properties.findings.items.required, [
    "severity",
    "message",
    "path",
    "line",
  ]);
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
    {
      action: "continue",
      prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.",
    },
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
    agent: { provider: "codex", model: "gpt-5.4" },
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
  assert.deepEqual(runner.calls[0]?.agent, { provider: "codex", model: "gpt-5.4" });
  assert.equal(runner.calls[0]?.outputSchema.type, "object");
  assert.deepEqual(runner.calls[0]?.outputSchema.required, [
    "decision",
    "summary",
    "findings",
    "prDescription",
  ]);
  assert.deepEqual(runner.calls[0]?.env, { OPENAI_API_KEY: "secret" });
  assert.equal(result.report.decision, "pass");
  assert.deepEqual(result.nextAction, {
    action: "continue",
    prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.",
  });
});

test("runIndependentReview fails if the read-only review changes the diff", async () => {
  const runner = recordingReviewRunner(passReportJson);

  await assert.rejects(
    () =>
      runIndependentReview({
        cwd: "/repo",
        agent: { provider: "codex", model: "gpt-5.4" },
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
