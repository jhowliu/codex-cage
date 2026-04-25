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

type LinearGraphQlResponse = {
  data?: {
    issue?: {
      identifier?: unknown;
      title?: unknown;
      description?: unknown;
      comments?: {
        nodes?: Array<{
          body?: unknown;
          createdAt?: unknown;
          user?: {
            name?: unknown;
            displayName?: unknown;
          } | null;
        }>;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: unknown }>;
};

const defaultCommentSelection = 10;
const knownBotNamePattern = /\b(bot|github-actions)\b|dependabot/i;

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
    commentsPayload.map((comment) => ({
      author: readOptionalString(comment.user?.login) ?? "unknown",
      authorType: readOptionalString(comment.user?.type),
      body: readOptionalString(comment.body) ?? "",
      createdAt: readOptionalString(comment.created_at),
    })),
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

export async function fetchLinearIssueContext(
  issue: ParsedLinearIssueUrl,
  options: FetchIssueContextOptions = {},
): Promise<IssueContext> {
  if (options.linearApiKey === undefined || options.linearApiKey.trim() === "") {
    throw new Error("Linear issue URLs require LINEAR_API_KEY.");
  }

  const fetcher = options.fetch ?? fetch;
  const response = await requestJson<LinearGraphQlResponse>(
    fetcher,
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: {
        Authorization: options.linearApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query CodexCageIssue($id: String!) {
            issue(id: $id) {
              identifier
              title
              description
              comments {
                nodes {
                  body
                  createdAt
                  user {
                    name
                    displayName
                  }
                }
              }
            }
          }
        `,
        variables: { id: issue.key },
      }),
    },
  );

  if (response.errors !== undefined && response.errors.length > 0) {
    const message = readOptionalString(response.errors[0]?.message) ?? "unknown error";
    throw new Error(`Linear API error: ${message}`);
  }

  const payload = response.data?.issue;

  if (payload === null || payload === undefined) {
    throw new Error(`Linear issue ${issue.key} was not found.`);
  }

  const comments = selectComments(
    (payload.comments?.nodes ?? []).map((comment) => ({
      author:
        readOptionalString(comment.user?.displayName) ??
        readOptionalString(comment.user?.name) ??
        "unknown",
      authorType: null,
      body: readOptionalString(comment.body) ?? "",
      createdAt: readOptionalString(comment.createdAt),
    })),
    options.comments ?? defaultCommentSelection,
  );

  return {
    source: "linear",
    url: issue.url,
    identifier: readOptionalString(payload.identifier) ?? issue.key,
    title: readRequiredString(payload.title, "Linear issue title"),
    body: readOptionalString(payload.description) ?? "",
    comments,
    inferredRepo: null,
  };
}

function parseGithubIssueUrl(url: URL): ParsedGithubIssueUrl {
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

function parseLinearIssueUrl(url: URL): ParsedLinearIssueUrl {
  const [organization, kind, key] = url.pathname.split("/").filter(Boolean);

  if (organization === undefined || kind !== "issue" || key === undefined) {
    throw new Error(
      "Linear issue URL must match https://linear.app/{org}/issue/{KEY}/...",
    );
  }

  return {
    source: "linear",
    url: url.toString(),
    organization,
    key: key.toUpperCase(),
  };
}

function parseUrl(issueUrl: string): URL {
  try {
    return new URL(issueUrl);
  } catch {
    throw new Error(`Invalid issue URL: ${issueUrl}`);
  }
}

type RawComment = IssueComment & {
  authorType: string | null;
};

function selectComments(
  comments: RawComment[],
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

function isBotComment(comment: RawComment): boolean {
  return comment.authorType === "Bot" || knownBotNamePattern.test(comment.author);
}

async function requestJson<T>(
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

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string.`);
  }

  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
