import type { CommentSelection, IssueComment } from "./issue.js";

export type RawIssueComment = IssueComment & {
  authorType: string | null;
};

export const defaultCommentSelection = 10;

const knownBotNamePattern = /\b(bot|github-actions)\b|dependabot/i;

export function selectComments(
  comments: RawIssueComment[],
  selection: CommentSelection,
): IssueComment[] {
  const humanComments = comments
    .filter((comment) => comment.body.trim() !== "")
    .filter((comment) => !isBotComment(comment));
  const selected = selection === "all" ? humanComments : humanComments.slice(-selection);

  return selected.map(({ author, body, createdAt }) => ({
    author,
    body,
    createdAt,
  }));
}

export async function requestJson<T>(
  fetcher: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetcher(url, init);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string.`);
  }

  return value;
}

export function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isBotComment(comment: RawIssueComment): boolean {
  return comment.authorType === "Bot" || knownBotNamePattern.test(comment.author);
}
