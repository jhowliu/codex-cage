import {
  type FetchIssueContextOptions,
  type IssueContext,
  type ParsedGithubIssueUrl,
} from "./issue.js";
import {
  defaultCommentSelection,
  readOptionalString,
  readRequiredString,
  requestJson,
  selectComments,
  type RawIssueComment,
} from "./issue-shared.js";

type GithubIssueResponse = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
};

type GithubCommentResponse = {
  body?: unknown;
  created_at?: unknown;
  user?: {
    login?: unknown;
    type?: unknown;
  } | null;
};

export function parseGithubIssueUrl(url: URL): ParsedGithubIssueUrl {
  const [owner, repo, kind, issueNumber, ...rest] = url.pathname
    .split("/")
    .filter(Boolean);

  if (
    owner === undefined ||
    repo === undefined ||
    kind !== "issues" ||
    issueNumber === undefined ||
    rest.length > 0
  ) {
    throw new Error(
      "GitHub issue URL must match https://github.com/{owner}/{repo}/issues/{number}",
    );
  }

  const number = Number(issueNumber);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid GitHub issue number: ${issueNumber}`);
  }

  return {
    source: "github",
    url: url.toString(),
    owner,
    repo,
    number,
    inferredRepo: `${owner}/${repo}`,
  };
}

export async function fetchGithubIssueContext(
  issue: ParsedGithubIssueUrl,
  options: FetchIssueContextOptions = {},
): Promise<IssueContext> {
  const fetcher = options.fetch ?? fetch;
  const headers = githubHeaders(options.githubToken);
  const issueApiUrl = `https://api.github.com/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;
  const commentsApiUrl = `${issueApiUrl}/comments`;
  const [issuePayload, commentsPayload] = await Promise.all([
    requestJson<GithubIssueResponse>(fetcher, issueApiUrl, { headers }),
    requestJson<GithubCommentResponse[]>(fetcher, commentsApiUrl, { headers }),
  ]);
  const comments = selectComments(
    commentsPayload.map(
      (comment): RawIssueComment => ({
        author: readOptionalString(comment.user?.login) ?? "unknown",
        authorType: readOptionalString(comment.user?.type),
        body: readOptionalString(comment.body) ?? "",
        createdAt: readOptionalString(comment.created_at),
      }),
    ),
    options.comments ?? defaultCommentSelection,
  );

  return {
    source: "github",
    url: issue.url,
    identifier: `#${issue.number}`,
    title: readRequiredString(issuePayload.title, "GitHub issue title"),
    body: readOptionalString(issuePayload.body) ?? "",
    comments,
    inferredRepo: issue.inferredRepo,
  };
}

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token !== undefined && token.trim() !== "") {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}
