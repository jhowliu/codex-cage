import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { claudeOptionArgs, extractClaudeResult } from "./agent/claude.js";
import type { AgentAssignment } from "./agent/providers.js";
import { RunFailureError } from "./run/errors.js";

export type ReviewFindingSeverity = "blocking" | "non_blocking";

export type ReviewFinding = {
  severity: ReviewFindingSeverity;
  message: string;
  path?: string | undefined;
  line?: number | undefined;
};

export type ReviewReport = {
  decision: "pass" | "blocking";
  summary: string;
  findings: ReviewFinding[];
};

export type ReviewNextAction =
  | { action: "continue" }
  | { action: "fix"; nextCycle: number; feedback: string }
  | { action: "fail"; failureCode: "review_blocking"; feedback: string };

export type ReviewAgentRunInput = {
  cwd: string;
  agent: AgentAssignment;
  prompt: string;
  outputSchema: Record<string, unknown>;
  env?: Record<string, string> | undefined;
};

export type ReviewAgentRunner = {
  run: (input: ReviewAgentRunInput) => Promise<string>;
};

export type BuildReviewPromptInput = {
  issueContext: string;
  diff: string;
  verificationSummary: string;
  reviewPolicyStatus?: string | undefined;
  resultMetadata: Record<string, unknown>;
};

export type RunIndependentReviewInput = BuildReviewPromptInput & {
  cwd: string;
  agent: AgentAssignment;
  cycle: number;
  maxReviewCycles: number;
  readCurrentDiff: () => Promise<string>;
  runner?: ReviewAgentRunner;
  env?: Record<string, string>;
};

export type RunIndependentReviewResult = {
  report: ReviewReport;
  nextAction: ReviewNextAction;
};

export class ReviewModifiedDiffError extends Error {
  constructor() {
    super("Review phase modified the diff. Review must be read-only.");
    this.name = "ReviewModifiedDiffError";
  }
}

const reviewFindingSchema = z
  .object({
    severity: z.enum(["blocking", "non_blocking"]),
    message: z.string().min(1),
    path: z.string().min(1).nullable().optional(),
    line: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .transform((finding): ReviewFinding => {
    return {
      severity: finding.severity,
      message: finding.message,
      ...(finding.path === null || finding.path === undefined
        ? {}
        : { path: finding.path }),
      ...(finding.line === null || finding.line === undefined
        ? {}
        : { line: finding.line }),
    };
  });

const reviewReportSchema = z
  .object({
    decision: z.enum(["pass", "blocking"]),
    summary: z.string().min(1),
    findings: z.array(reviewFindingSchema),
  })
  .strict()
  .superRefine((report, context) => {
    const hasBlockingFinding = report.findings.some(
      (finding) => finding.severity === "blocking",
    );

    if (report.decision === "pass" && hasBlockingFinding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Passing review reports cannot contain blocking findings.",
        path: ["findings"],
      });
    }

    if (report.decision === "blocking" && !hasBlockingFinding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Blocking review reports must contain at least one blocking finding.",
        path: ["findings"],
      });
    }
  });

export const reviewReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "findings"],
  properties: {
    decision: {
      type: "string",
      enum: ["pass", "blocking"],
    },
    summary: {
      type: "string",
      minLength: 1,
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message", "path", "line"],
        properties: {
          severity: {
            type: "string",
            enum: ["blocking", "non_blocking"],
          },
          message: {
            type: "string",
            minLength: 1,
          },
          path: {
            type: ["string", "null"],
          },
          line: {
            type: ["integer", "null"],
          },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

export const execaReviewAgentRunner: ReviewAgentRunner = {
  async run(input: ReviewAgentRunInput): Promise<string> {
    switch (input.agent.provider) {
      case "codex":
        return await runCodexReviewOnHost(input);
      case "claude":
        return await runClaudeReviewOnHost(input);
      default: {
        const exhaustiveProvider: never = input.agent.provider;
        return exhaustiveProvider;
      }
    }
  },
};

async function runCodexReviewOnHost(input: ReviewAgentRunInput): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "agent-cage-review-"));
  const outputSchemaPath = join(tempDirectory, "review-output-schema.json");

  try {
    await writeFile(
      outputSchemaPath,
      `${JSON.stringify(input.outputSchema, null, 2)}\n`,
      "utf8",
    );
    const args = [
      "exec",
      "--model",
      input.agent.model,
      "--sandbox",
      "read-only",
      "--cd",
      input.cwd,
      "--output-schema",
      outputSchemaPath,
      input.prompt,
    ];

    if (input.env === undefined) {
      const result = await execa("codex", args);
      return result.stdout;
    }

    const result = await execa("codex", args, { env: input.env });
    return result.stdout;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function runClaudeReviewOnHost(input: ReviewAgentRunInput): Promise<string> {
  const args = [
    "-p",
    input.prompt,
    ...claudeOptionArgs({
      access: "read-only",
      model: input.agent.model,
      prompt: input.prompt,
      outputSchema: input.outputSchema,
    }),
  ];
  const result = await execa("claude", args, {
    cwd: input.cwd,
    env: { ...input.env, DISABLE_AUTOUPDATER: "1" },
  });

  return extractClaudeResult(result.stdout);
}

export async function runIndependentReview(
  input: RunIndependentReviewInput,
): Promise<RunIndependentReviewResult> {
  const runner = input.runner ?? execaReviewAgentRunner;
  const prompt = buildReviewPrompt(input);
  const output = await runner.run({
    cwd: input.cwd,
    agent: input.agent,
    prompt,
    outputSchema: reviewReportJsonSchema,
    env: input.env,
  });
  const currentDiff = await input.readCurrentDiff();

  if (currentDiff !== input.diff) {
    throw new ReviewModifiedDiffError();
  }

  let report: ReviewReport;
  try {
    report = parseReviewReport(output);
  } catch (error) {
    throw new RunFailureError(
      "review_failed",
      `Review output was not a valid report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    report,
    nextAction: reviewNextAction({
      report,
      cycle: input.cycle,
      maxReviewCycles: input.maxReviewCycles,
    }),
  };
}

export function buildReviewPrompt(input: BuildReviewPromptInput): string {
  return `You are the independent Agent Cage review agent.

Review the implementation as a read-only reviewer. Do not edit files, commit, push, run destructive commands, create PRs, or write secrets.

Evaluate whether the diff satisfies the issue and whether verified behavior is credible. Treat security, data loss, broken tests, and missing required behavior as blocking.

Return only JSON matching this schema:
{
  "decision": "pass" | "blocking",
  "summary": "short review summary",
  "findings": [
    {
      "severity": "blocking" | "non_blocking",
      "message": "specific finding",
      "path": "optional/file/path or null",
      "line": 123 or null
    }
  ]
}

Issue context:
${input.issueContext}

Verification summary:
${input.verificationSummary}

Review policy:
${input.reviewPolicyStatus ?? "Target review policy: missing. Proceed with built-in review rules."}

Result metadata:
${JSON.stringify(input.resultMetadata, null, 2)}

Diff against base:
${input.diff}
`;
}

export function parseReviewReport(output: string): ReviewReport {
  const jsonText = extractJsonObject(output);
  const parsed = JSON.parse(jsonText) as unknown;

  return reviewReportSchema.parse(parsed);
}

export function reviewNextAction(input: {
  report: ReviewReport;
  cycle: number;
  maxReviewCycles: number;
}): ReviewNextAction {
  if (input.report.decision === "pass") {
    return { action: "continue" };
  }

  const feedback = blockingReviewFeedback(input.report);

  if (input.cycle >= input.maxReviewCycles) {
    return { action: "fail", failureCode: "review_blocking", feedback };
  }

  return {
    action: "fix",
    nextCycle: input.cycle + 1,
    feedback,
  };
}

export function blockingReviewFeedback(report: ReviewReport): string {
  const blockingFindings = report.findings.filter(
    (finding) => finding.severity === "blocking",
  );

  if (blockingFindings.length === 0) {
    return report.summary;
  }

  return blockingFindings
    .map((finding, index) => {
      const location =
        finding.path === undefined
          ? ""
          : finding.line === undefined
            ? ` (${finding.path})`
            : ` (${finding.path}:${finding.line})`;

      return `${index + 1}. ${finding.message}${location}`;
    })
    .join("\n");
}

function extractJsonObject(output: string): string {
  const fencedJson = output.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim();

  if (fencedJson !== undefined) {
    return fencedJson;
  }

  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error("Review agent did not return a JSON object.");
  }

  return output.slice(firstBrace, lastBrace + 1);
}
