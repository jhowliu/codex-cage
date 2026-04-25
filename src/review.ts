import { execa } from "execa";
import { z } from "zod";

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
  model: string;
  prompt: string;
  env?: Record<string, string> | undefined;
};

export type ReviewAgentRunner = {
  run: (input: ReviewAgentRunInput) => Promise<string>;
};

export type BuildReviewPromptInput = {
  issueContext: string;
  diff: string;
  verificationSummary: string;
  resultMetadata: Record<string, unknown>;
};

export type RunIndependentReviewInput = BuildReviewPromptInput & {
  cwd: string;
  model: string;
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
    path: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();

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

export const execaReviewAgentRunner: ReviewAgentRunner = {
  async run(input: ReviewAgentRunInput): Promise<string> {
    const args = ["exec", "--model", input.model, "--cwd", input.cwd, input.prompt];

    if (input.env === undefined) {
      const result = await execa("codex", args);
      return result.stdout;
    }

    const result = await execa("codex", args, { env: input.env });
    return result.stdout;
  },
};

export async function runIndependentReview(
  input: RunIndependentReviewInput,
): Promise<RunIndependentReviewResult> {
  const runner = input.runner ?? execaReviewAgentRunner;
  const prompt = buildReviewPrompt(input);
  const output = await runner.run({
    cwd: input.cwd,
    model: input.model,
    prompt,
    env: input.env,
  });
  const currentDiff = await input.readCurrentDiff();

  if (currentDiff !== input.diff) {
    throw new ReviewModifiedDiffError();
  }

  const report = parseReviewReport(output);

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
  return `You are the independent Codex Cage review agent.

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
      "path": "optional/file/path",
      "line": 123
    }
  ]
}

Issue context:
${input.issueContext}

Verification summary:
${input.verificationSummary}

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
