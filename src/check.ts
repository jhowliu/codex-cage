import type { ReadinessFinding } from "./issue-readiness.js";
import { RunFailureError } from "./run/errors.js";
import {
  resolveRunTarget,
  type RunTarget,
  type RunTargetDependencies,
  type RunTargetOptions,
} from "./run.js";
import type { FailureCode } from "./state.js";

/**
 * A setup problem that would stop `codex-cage run` before it starts, with the
 * failure code the run would report.
 */
export type RunSetupFinding = {
  level: "error";
  code: FailureCode;
  message: string;
};

export type CheckFinding = ReadinessFinding | RunSetupFinding;

export type IssueCheckResult = {
  issueUrl: string;
  issue: { identifier: string; title: string } | null;
  ready: boolean;
  findings: CheckFinding[];
};

export type CheckIssueOptions = RunTargetOptions;
export type CheckIssueDependencies = RunTargetDependencies;

/**
 * Answers "would `codex-cage run` start on this issue?" without creating a
 * run. It resolves the run's inputs through the same `resolveRunTarget` the
 * run uses, so a setup failure (config, issue, target repo, GitHub token)
 * or an unready issue stops both commands alike.
 */
export async function checkIssue(
  cwd: string,
  options: CheckIssueOptions,
  dependencies: CheckIssueDependencies = {},
): Promise<IssueCheckResult> {
  let target: RunTarget;

  try {
    target = await resolveRunTarget(cwd, options, dependencies);
  } catch (error) {
    return {
      issueUrl: options.issueUrl,
      issue: null,
      ready: false,
      findings: [
        {
          level: "error",
          // `codex-cage run` reports the same code for an error at this point.
          code: error instanceof RunFailureError ? error.failureCode : "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  return {
    issueUrl: options.issueUrl,
    issue: { identifier: target.issue.identifier, title: target.issue.title },
    ready: target.issueReadiness.ready,
    findings: target.issueReadiness.findings,
  };
}
