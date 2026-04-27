import type { IssueContext } from "../issue.js";
import type { RuntimeContext } from "../run-workflow.js";

export function buildImplementationPrompt(input: {
  context: RuntimeContext;
  iteration: number;
  feedback: string[];
}): string {
  const feedback =
    input.feedback.length === 0
      ? "No prior feedback."
      : input.feedback.map((item, index) => `${index + 1}. ${item}`).join("\n\n");

  return `Implement the issue below inside the current repository.

Rules:
- Work only in this repository.
- Do not commit, push, create pull requests, or write secrets.
- Run only commands needed to implement the issue; Codex Cage will run verification separately.
- Follow applicable native Codex AGENTS.md files discovered in this repository.
- If the issue lacks enough detail to implement safely, stop and explain the blocker.

Iteration: ${input.iteration}
Repository: ${input.context.repoResolution.repo.fullName}
Base branch: ${input.context.baseBranch}

Issue:
${formatIssueContext(input.context.issue)}

Feedback to address:
${feedback}
`;
}

export function formatReviewIssueContext(context: RuntimeContext): string {
  return `Issue:
${formatIssueContext(context.issue)}`;
}

function formatIssueContext(issue: IssueContext): string {
  const comments =
    issue.comments.length === 0
      ? "No human comments included."
      : issue.comments
          .map((comment) => {
            const createdAt =
              comment.createdAt === null ? "" : ` at ${comment.createdAt}`;
            return `- ${comment.author}${createdAt}: ${comment.body}`;
          })
          .join("\n");

  return `URL: ${issue.url}
Identifier: ${issue.identifier}
Title: ${issue.title}

Body:
${issue.body}

Comments:
${comments}
`;
}
