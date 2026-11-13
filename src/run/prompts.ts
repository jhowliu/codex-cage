import type { AgentProvider } from "../agent/providers.js";
import type { IssueContext } from "../issue.js";
import { formatLocation, type PullRequestFeedback } from "../pull-request.js";
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

  const revision = input.context.revision;

  if (revision !== null) {
    const pullRequest = revision.pullRequest;

    return `Revise the pull request below so it addresses its feedback.

Rules:
- Work only in this repository. The checked-out branch holds the pull request's earlier commits; keep that work and change what the feedback asks for.
- Do not commit, push, create pull requests, or write secrets.
- Run only commands needed to address the feedback; Agent Cage will run verification separately.
- ${agentInstructionFilesRule(input.context.agents.implement.provider)}
- Where the feedback conflicts with the issue, follow the feedback: it is the newer decision.
- If a piece of feedback is unclear, stop and explain the blocker.

Iteration: ${input.iteration}
Repository: ${input.context.repoResolution.repo.fullName}
Pull request: ${pullRequest.url}
Branch: ${pullRequest.headBranch} (base ${pullRequest.baseBranch})

Issue:
${formatIssueContext(input.context.issue)}

Pull request feedback:
${formatPullRequestFeedback(revision.feedback)}

Feedback from earlier iterations of this run:
${feedback}
`;
  }

  return `Implement the issue below inside the current repository.

Rules:
- Work only in this repository.
- Do not commit, push, create pull requests, or write secrets.
- Run only commands needed to implement the issue; Agent Cage will run verification separately.
- ${agentInstructionFilesRule(input.context.agents.implement.provider)}
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

function agentInstructionFilesRule(provider: AgentProvider): string {
  switch (provider) {
    case "codex":
      return "Follow applicable native Codex AGENTS.md files discovered in this repository.";
    case "claude":
      // Claude Code's native memory is CLAUDE.md; name AGENTS.md explicitly so
      // repos that only document conventions there are still followed.
      return "Before editing, read and follow the AGENTS.md and CLAUDE.md files that apply to the paths you change.";
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

export function formatReviewIssueContext(context: RuntimeContext): string {
  const issue = `Issue:
${formatIssueContext(context.issue)}`;

  if (context.revision === null) {
    return issue;
  }

  const pullRequest = context.revision.pullRequest;

  return `${issue}
Pull request: ${pullRequest.url}
This run revises the pull request above. The diff is the whole pull request against ${pullRequest.baseBranch}, including commits from earlier runs. Besides the issue, the change must address the pull request feedback below. Where the feedback conflicts with the issue, the feedback wins: it is the newer decision.

Pull request feedback:
${formatPullRequestFeedback(context.revision.feedback)}
`;
}

export function formatPullRequestFeedback(feedback: PullRequestFeedback[]): string {
  return feedback
    .map((item, index) => `${index + 1}. ${formatFeedbackItem(item)}`)
    .join("\n\n");
}

function formatFeedbackItem(item: PullRequestFeedback): string {
  switch (item.kind) {
    case "review_thread": {
      const outdated = item.outdated ? " (outdated: the code moved since)" : "";
      const comments = item.comments
        .map((comment) => `   - ${comment.author}: ${indent(comment.body, "     ")}`)
        .join("\n");
      return `Review thread on \`${formatLocation(item)}\`${outdated}:\n${comments}`;
    }
    case "review":
      return `Review (${item.state.toLowerCase().replace(/_/g, " ")}) from ${item.comment.author}:\n   ${indent(item.comment.body, "   ")}`;
    case "comment":
      return `Comment from ${item.comment.author}:\n   ${indent(item.comment.body, "   ")}`;
    case "command_line":
      return `From the person who started this run:\n   ${indent(item.body, "   ")}`;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function indent(text: string, prefix: string): string {
  return text.trim().replace(/\r?\n/g, `\n${prefix}`);
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
