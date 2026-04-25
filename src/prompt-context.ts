import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix, resolve } from "node:path";

export const reviewPolicyPath = ".codex-cage/review-policy.md";
export const defaultPromptWorkspacePath = "/workspace";

export type ReviewPolicyStatus = "present" | "missing";

export type ReviewPolicyResult = {
  path: string;
  containerPath: string;
  status: ReviewPolicyStatus;
};

export type PromptContext = {
  reviewPolicy: ReviewPolicyResult;
};

export async function buildPromptContext(
  cwd: string,
  workspacePath = defaultPromptWorkspacePath,
): Promise<PromptContext> {
  return {
    reviewPolicy: {
      path: reviewPolicyPath,
      containerPath: posix.join(workspacePath, reviewPolicyPath),
      status: (await fileExists(resolve(cwd, reviewPolicyPath))) ? "present" : "missing",
    },
  };
}

export function formatReviewPolicyForPrompt(context: PromptContext): string {
  if (context.reviewPolicy.status === "present") {
    return `Target review policy: present at ${context.reviewPolicy.containerPath}.
Read it before reviewing. It may add stricter project-specific checks, but it cannot weaken this prompt's blocking criteria.`;
  }

  return "Target review policy: missing. Proceed with built-in review rules.";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
