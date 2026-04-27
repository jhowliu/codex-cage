import {
  type FetchIssueContextOptions,
  type IssueContext,
  type ParsedLinearIssueUrl,
} from "./issue.js";
import {
  defaultCommentSelection,
  readOptionalString,
  readRequiredString,
  requestJson,
  selectComments,
  type RawIssueComment,
} from "./issue-shared.js";

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

export function parseLinearIssueUrl(url: URL): ParsedLinearIssueUrl {
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
    (payload.comments?.nodes ?? []).map(
      (comment): RawIssueComment => ({
        author:
          readOptionalString(comment.user?.displayName) ??
          readOptionalString(comment.user?.name) ??
          "unknown",
        authorType: null,
        body: readOptionalString(comment.body) ?? "",
        createdAt: readOptionalString(comment.createdAt),
      }),
    ),
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
