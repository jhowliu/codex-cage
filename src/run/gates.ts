import {
  assertNoGuardViolations,
  guardAttemptDecision,
  GuardViolationError,
  scanDiffForGuardViolations,
} from "../guards.js";
import {
  NoDiffError,
  publishSuccessfulRun,
  type PublishSuccessfulRunResult,
} from "../publish.js";
import { formatReviewPolicyForPrompt } from "../prompt-context.js";
import type { RuntimeContext } from "../run-workflow.js";
import {
  buildReviewPrompt,
  runIndependentReview,
  type ReviewNextAction,
} from "../review.js";
import {
  createGhCommandRunner,
  createGitCommandRunner,
  createReviewAgentRunner,
  readCurrentDiff,
  type ShellRunner,
} from "../sandbox-execution.js";
import type { FailureCode, PhaseName, ReviewDecision, RunStatus } from "../state.js";
import { RunFailureError } from "./errors.js";
import { formatReviewIssueContext } from "./prompts.js";

export type VerificationResult =
  | { passed: true; summary: string; items: string[] }
  | { passed: false; feedback: string };

type RunGatePhaseBody = () => Promise<string | undefined>;

export type RunGateJournal = {
  setRunStatus: (status: RunStatus) => Promise<void>;
  runPhase: <TValue = undefined>(
    name: PhaseName,
    body: RunGatePhaseBody | (() => Promise<{ log: string; value: TValue }>),
  ) => Promise<TValue>;
  addReviewCycle: (input: {
    cycle: number;
    decision: ReviewDecision;
    report: unknown;
  }) => Promise<void>;
  writeArtifact: (name: string, content: string) => Promise<string>;
  writeJsonArtifact: (name: string, value: unknown) => Promise<void>;
  recordSuccess: (prUrl: string) => Promise<void>;
};

export type SecretGuardGateResult =
  | { action: "pass" }
  | {
      action: "retry";
      feedback: string;
      guardAttempt: number;
      lastFailure: FailureCode;
    };

export function runSecretGuardGate(input: {
  context: RuntimeContext;
  diff: string;
  guardAttempt: number;
}): SecretGuardGateResult {
  const violations = scanDiffForGuardViolations(input.diff, {
    injectedSecrets: input.context.credentials.injectedSecrets(),
  });

  try {
    assertNoGuardViolations(violations);
    return { action: "pass" };
  } catch (error) {
    if (!(error instanceof GuardViolationError)) {
      throw error;
    }

    const decision = guardAttemptDecision({
      attempt: input.guardAttempt,
      maxAttempts: input.context.config.guards.max_secret_fix_attempts,
    });

    if (decision.action === "fail") {
      throw new RunFailureError("secret_guard_failed", error.message);
    }

    return {
      action: "retry",
      feedback: `Secret guard violations must be fixed:\n${error.message}`,
      guardAttempt: decision.nextAttempt,
      lastFailure: "secret_guard_failed",
    };
  }
}

export async function runReviewGate(input: {
  context: RuntimeContext;
  journal: RunGateJournal;
  shell: ShellRunner;
  redactor: (input: string) => string;
  review: typeof runIndependentReview;
  diff: string;
  verification: Extract<VerificationResult, { passed: true }>;
  iteration: number;
  reviewCycle: number;
}): Promise<ReviewNextAction> {
  await input.journal.setRunStatus("reviewing");
  const reviewResult = await input.journal.runPhase("review", async () => {
    const reviewIssueContext = formatReviewIssueContext(input.context);
    const reviewPolicyStatus = formatReviewPolicyForPrompt(input.context.promptContext);
    const resultMetadata = {
      runId: input.context.runId,
      iteration: input.iteration,
      repo: input.context.repoResolution.repo.fullName,
    };
    const reviewPrompt = buildReviewPrompt({
      issueContext: reviewIssueContext,
      verificationSummary: input.verification.summary,
      reviewPolicyStatus,
      resultMetadata,
      diff: input.diff,
    });
    await input.journal.writeArtifact(
      `review-prompt-${input.reviewCycle}.md`,
      input.redactor(reviewPrompt),
    );
    const reviewCredentials = input.context.credentials.command("review");
    const result = await input.review({
      cwd: input.context.cwd,
      model: input.context.model,
      cycle: input.reviewCycle,
      maxReviewCycles: input.context.config.agent.max_review_cycles,
      issueContext: reviewIssueContext,
      diff: input.diff,
      verificationSummary: input.verification.summary,
      reviewPolicyStatus,
      resultMetadata,
      readCurrentDiff: async () => await readCurrentDiff(input.shell),
      runner: createReviewAgentRunner(input.shell, reviewCredentials),
      ...(reviewCredentials.env === undefined ? {} : { env: reviewCredentials.env }),
    });

    await input.journal.addReviewCycle({
      cycle: input.reviewCycle,
      decision: result.report.decision,
      report: result.report,
    });

    return {
      log: input.redactor(JSON.stringify(result.report, null, 2)),
      value: result,
    };
  });

  return reviewResult.nextAction;
}

export async function runPublishGate(input: {
  context: RuntimeContext;
  journal: RunGateJournal;
  shell: ShellRunner;
  redactor: (input: string) => string;
  publish: typeof publishSuccessfulRun;
  verification: Extract<VerificationResult, { passed: true }>;
}): Promise<PublishSuccessfulRunResult> {
  await input.journal.setRunStatus("creating_pr");
  const publishResult = await input.journal.runPhase("pr", async () => {
    let result;
    const publishCredentials = input.context.credentials.command("publish");

    try {
      result = await input.publish({
        cwd: input.context.cwd,
        repo: input.context.repoResolution.repo,
        issue: input.context.issue,
        baseBranch: input.context.baseBranch,
        authorName: input.context.config.git.author_name,
        authorEmail: input.context.config.git.author_email,
        branchName: input.context.branchName,
        draft: input.context.draft,
        env: publishCredentials.env,
        metadata: {
          runId: input.context.runId,
          summary: `Implemented ${input.context.issue.identifier}: ${input.context.issue.title}`,
          verification: input.verification.items,
          reviewStatus: "Independent review passed.",
          risks: [],
        },
        git: createGitCommandRunner(input.shell, publishCredentials),
        gh: createGhCommandRunner(input.shell, publishCredentials),
      });
    } catch (error) {
      if (error instanceof NoDiffError) {
        throw error;
      }

      throw new RunFailureError("pr_failed", input.redactor(formatError(error)));
    }

    return {
      log: input.redactor(JSON.stringify(result, null, 2)),
      value: result,
    };
  });

  await input.journal.writeJsonArtifact("pr.json", publishResult);
  await input.journal.writeArtifact("final.patch", await readCurrentDiff(input.shell));
  await input.journal.recordSuccess(publishResult.prUrl);

  return publishResult;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
