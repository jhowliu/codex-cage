import { fetchGithubIssueContext, parseGithubIssueUrl } from "./issue-github.js";
import { fetchLinearIssueContext, parseLinearIssueUrl } from "./issue-linear.js";

export type IssueSource = "github" | "linear";

export type IssueComment = {
  author: string;
  body: string;
  createdAt: string | null;
};

export type IssueContext = {
  source: IssueSource;
  url: string;
  identifier: string;
  title: string;
  body: string;
  comments: IssueComment[];
  inferredRepo: string | null;
};

export type CommentSelection = number | "all";

export type FetchIssueContextOptions = {
  comments?: CommentSelection;
  githubToken?: string;
  linearApiKey?: string;
  fetch?: typeof fetch;
};

export type ParsedGithubIssueUrl = {
  source: "github";
  url: string;
  owner: string;
  repo: string;
  number: number;
  inferredRepo: string;
};

export type ParsedLinearIssueUrl = {
  source: "linear";
  url: string;
  organization: string;
  key: string;
};

export type ParsedIssueUrl = ParsedGithubIssueUrl | ParsedLinearIssueUrl;

export function parseIssueUrl(issueUrl: string): ParsedIssueUrl {
  const url = parseUrl(issueUrl);

  if (url.hostname === "github.com") {
    return parseGithubIssueUrl(url);
  }

  if (url.hostname === "linear.app") {
    return parseLinearIssueUrl(url);
  }

  throw new Error(`Unsupported issue URL host: ${url.hostname}`);
}

export async function fetchIssueContext(
  issueUrl: string,
  options: FetchIssueContextOptions = {},
): Promise<IssueContext> {
  const parsed = parseIssueUrl(issueUrl);

  if (parsed.source === "github") {
    return await fetchGithubIssueContext(parsed, options);
  }

  return await fetchLinearIssueContext(parsed, options);
}

function parseUrl(issueUrl: string): URL {
  try {
    return new URL(issueUrl);
  } catch {
    throw new Error(`Invalid issue URL: ${issueUrl}`);
  }
}
