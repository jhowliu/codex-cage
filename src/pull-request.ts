import { z } from "zod";
import { githubHeaders } from "./issue-github.js";
import { isBotComment, requestJson } from "./issue-shared.js";
import type { GithubRepo } from "./repo.js";
import { RunFailureError } from "./run/errors.js";

/** The pull request an Agent Cage run opened, as a revise run needs it. */
export type PullRequestContext = {
  url: string;
  number: number;
  repo: GithubRepo;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  // The run its description names: the run that opened or last revised it.
  agentCageRunId: string;
  issueUrl: string;
};

export type FeedbackComment = {
  author: string;
  body: string;
  createdAt: string;
};

export type PullRequestFeedback =
  | {
      kind: "review_thread";
      path: string;
      line: number | null;
      outdated: boolean;
      comments: FeedbackComment[];
    }
  | { kind: "review"; state: string; comment: FeedbackComment }
  | { kind: "comment"; comment: FeedbackComment }
  | { kind: "command_line"; body: string };

export type RevisionContext = {
  pullRequest: PullRequestContext;
  feedback: PullRequestFeedback[];
  // The newest feedback this run read. The revise comment records it, so the
  // next revise reads only comments and reviews posted after it.
  feedbackThrough: string;
};

export type FetchRevisionOptions = {
  githubToken?: string | undefined;
  commandLineFeedback?: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
};

export const reviseMarkerPrefix = "<!-- agent-cage:revise";

const pageSize = 100;
const maxPages = 10;

const userSchema = z.object({ login: z.string(), type: z.string() }).nullable();

const pullSchema = z.object({
  state: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
});

const issueCommentSchema = z.object({
  body: z.string().nullable(),
  created_at: z.string(),
  author_association: z.string(),
  user: userSchema,
});

const reviewSchema = z.object({
  body: z.string().nullable(),
  state: z.string(),
  submitted_at: z.string().nullable().optional(),
  author_association: z.string(),
  user: userSchema,
});

const reviewThreadsSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              reviewThreads: z.object({
                nodes: z.array(
                  z.object({
                    isResolved: z.boolean(),
                    isOutdated: z.boolean(),
                    path: z.string(),
                    line: z.number().nullable(),
                    originalLine: z.number().nullable(),
                    comments: z.object({
                      nodes: z.array(
                        z.object({
                          body: z.string(),
                          createdAt: z.string(),
                          authorAssociation: z.string(),
                          author: z
                            .object({ login: z.string(), __typename: z.string() })
                            .nullable(),
                        }),
                      ),
                    }),
                  }),
                ),
              }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const reviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 50) {
            nodes { body createdAt authorAssociation author { login __typename } }
          }
        }
      }
    }
  }
}`;

export type RawFeedbackComment = FeedbackComment & {
  authorType: string | null;
  // GitHub's author association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...
  association: string;
};

// Only people with write access steer a revise run. On a public repository
// anyone can comment, and a revise run turns comments into agent instructions.
const trustedAssociations: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export type RawReview = RawFeedbackComment & { state: string };

export type RawReviewThread = {
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  comments: RawFeedbackComment[];
};

export function parsePullRequestUrl(input: string): {
  url: string;
  repo: GithubRepo;
  number: number;
} {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw notRevisable(`"${input}" is not a pull request URL.`);
  }

  const [owner, name, kind, numberText] = url.pathname.split("/").filter(Boolean);
  const number = Number(numberText);

  if (
    url.hostname !== "github.com" ||
    owner === undefined ||
    name === undefined ||
    kind !== "pull" ||
    !Number.isInteger(number) ||
    number <= 0
  ) {
    throw notRevisable(
      "Pull request URL must match https://github.com/{owner}/{repo}/pull/{number}.",
    );
  }

  return {
    url: `https://github.com/${owner}/${name}/pull/${number}`,
    repo: { owner, name, fullName: `${owner}/${name}` },
    number,
  };
}

/**
 * Reads an open pull request that an Agent Cage run opened, and the feedback
 * on it that a revise run should address. Fails with pr_not_revisable or
 * no_feedback before any sandbox work starts.
 */
export async function fetchRevision(
  prUrl: string,
  options: FetchRevisionOptions = {},
): Promise<RevisionContext> {
  const parsed = parsePullRequestUrl(prUrl);
  const fetcher = options.fetch ?? fetch;
  const headers = githubHeaders(options.githubToken);
  const apiUrl = `https://api.github.com/repos/${parsed.repo.fullName}`;
  const pull = pullSchema.parse(
    await requestJson<unknown>(fetcher, `${apiUrl}/pulls/${parsed.number}`, { headers }),
  );
  const pullRequest = revisablePullRequest(parsed.number, pull);
  const [comments, reviews, threads] = await Promise.all([
    requestPages(
      fetcher,
      `${apiUrl}/issues/${parsed.number}/comments`,
      headers,
      issueCommentSchema,
    ),
    requestPages(
      fetcher,
      `${apiUrl}/pulls/${parsed.number}/reviews`,
      headers,
      reviewSchema,
    ),
    fetchReviewThreads(fetcher, headers, pullRequest),
  ]);
  const selection = selectFeedback({
    comments: comments.map((comment) => ({
      author: comment.user?.login ?? "unknown",
      authorType: comment.user?.type ?? null,
      association: comment.author_association,
      body: comment.body ?? "",
      createdAt: comment.created_at,
    })),
    reviews: reviews.flatMap((review) =>
      review.submitted_at === undefined || review.submitted_at === null
        ? []
        : [
            {
              author: review.user?.login ?? "unknown",
              authorType: review.user?.type ?? null,
              association: review.author_association,
              body: review.body ?? "",
              createdAt: review.submitted_at,
              state: review.state,
            },
          ],
    ),
    threads,
    commandLine: options.commandLineFeedback,
  });

  if (selection.feedback.length === 0) {
    throw new RunFailureError(
      "no_feedback",
      `${pullRequest.url} has no unresolved review threads and no comments or reviews since the last revise. Pass --feedback to say what to change.`,
    );
  }

  return {
    pullRequest,
    feedback: selection.feedback,
    feedbackThrough:
      selection.through ?? (options.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * Picks the feedback a revise run addresses: every unresolved review thread,
 * plus comments and reviews posted after the previous revise, plus the
 * command-line feedback. Only people with write access count, bots excluded.
 */
export function selectFeedback(input: {
  comments: RawFeedbackComment[];
  reviews: RawReview[];
  threads: RawReviewThread[];
  commandLine?: string | undefined;
}): { feedback: PullRequestFeedback[]; through: string | null } {
  const isTrusted = (comment: RawFeedbackComment): boolean =>
    trustedAssociations.has(comment.association);
  const markers = input.comments.filter(isTrusted).flatMap((comment) => {
    const marker = parseReviseMarker(comment.body);
    return marker === null ? [] : [marker.through ?? comment.createdAt];
  });
  const since = latest(markers);
  const isNew = (comment: FeedbackComment): boolean =>
    since === null || Date.parse(comment.createdAt) > Date.parse(since);
  const isHuman = (comment: RawFeedbackComment): boolean =>
    comment.body.trim() !== "" && isTrusted(comment) && !isBotComment(comment);
  const conversation = input.comments.filter(
    (comment) => parseReviseMarker(comment.body) === null,
  );
  const feedback: PullRequestFeedback[] = [];

  for (const thread of input.threads) {
    const comments = thread.comments.filter(isHuman).map(toFeedbackComment);

    if (!thread.resolved && comments.length > 0) {
      feedback.push({
        kind: "review_thread",
        path: thread.path,
        line: thread.line,
        outdated: thread.outdated,
        comments,
      });
    }
  }

  const timeline: Array<{ createdAt: string; item: PullRequestFeedback }> = [
    ...input.reviews
      .filter((review) => isHuman(review) && isNew(review))
      .map((review) => ({
        createdAt: review.createdAt,
        item: {
          kind: "review" as const,
          state: review.state,
          comment: toFeedbackComment(review),
        },
      })),
    ...conversation
      .filter((comment) => isHuman(comment) && isNew(comment))
      .map((comment) => ({
        createdAt: comment.createdAt,
        item: { kind: "comment" as const, comment: toFeedbackComment(comment) },
      })),
  ];
  timeline.sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  feedback.push(...timeline.map((entry) => entry.item));

  const commandLine = input.commandLine?.trim() ?? "";
  if (commandLine !== "") {
    feedback.push({ kind: "command_line", body: commandLine });
  }

  return {
    feedback,
    through: latest([
      ...conversation.map((comment) => comment.createdAt),
      ...input.reviews.map((review) => review.createdAt),
      ...input.threads.flatMap((thread) =>
        thread.comments.map((comment) => comment.createdAt),
      ),
    ]),
  };
}

export function formatReviseMarker(input: { runId: string; through: string }): string {
  return `${reviseMarkerPrefix} ${input.runId} through=${input.through} -->`;
}

export function parseReviseMarker(
  body: string,
): { runId: string; through: string | null } | null {
  const match = /<!-- agent-cage:revise (\S+)(?: through=(\S+))? -->/.exec(body);

  if (match?.[1] === undefined) {
    return null;
  }

  return { runId: match[1], through: match[2] ?? null };
}

/** A one-line label for a feedback item, for the revise comment. */
export function describeFeedback(item: PullRequestFeedback): string {
  switch (item.kind) {
    case "review_thread":
      return `Review thread on \`${formatLocation(item)}\` from ${uniqueAuthors(item.comments)}`;
    case "review":
      return `Review from ${item.comment.author}`;
    case "comment":
      return `Comment from ${item.comment.author}`;
    case "command_line":
      return "Feedback given on the command line";
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

export function formatLocation(item: { path: string; line: number | null }): string {
  return item.line === null ? item.path : `${item.path}:${item.line}`;
}

export function readRunIdFromBody(body: string): string | null {
  return /^- Run ID: (\S+)\s*$/m.exec(body)?.[1] ?? null;
}

export function readIssueUrlFromBody(body: string): string | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Issue");

  if (start === -1) {
    return null;
  }

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      return null;
    }

    const url = /https?:\/\/\S+/.exec(line)?.[0];
    if (url !== undefined) {
      return url;
    }
  }

  return null;
}

function revisablePullRequest(
  number: number,
  pull: z.infer<typeof pullSchema>,
): PullRequestContext {
  const url = pull.html_url;

  if (pull.state !== "open") {
    throw notRevisable(
      `${url} is ${pull.state}; only open pull requests can be revised.`,
    );
  }

  const baseRepo = pull.base.repo.full_name;
  if (pull.head.repo?.full_name.toLowerCase() !== baseRepo.toLowerCase()) {
    throw notRevisable(
      `${url} comes from a fork; Agent Cage pushes only to ${baseRepo}.`,
    );
  }

  const body = pull.body ?? "";
  const agentCageRunId = readRunIdFromBody(body);
  if (agentCageRunId === null) {
    throw notRevisable(
      `${url} was not opened by Agent Cage: its description has no Run ID.`,
    );
  }

  const issueUrl = readIssueUrlFromBody(body);
  if (issueUrl === null) {
    throw notRevisable(`${url} has no issue link under "## Issue" in its description.`);
  }

  const [owner = "", name = ""] = baseRepo.split("/");

  return {
    url,
    number,
    repo: { owner, name, fullName: baseRepo },
    title: pull.title,
    body,
    headBranch: pull.head.ref,
    baseBranch: pull.base.ref,
    agentCageRunId,
    issueUrl,
  };
}

async function fetchReviewThreads(
  fetcher: typeof fetch,
  headers: Record<string, string>,
  pullRequest: PullRequestContext,
): Promise<RawReviewThread[]> {
  const payload = reviewThreadsSchema.parse(
    await requestJson<unknown>(fetcher, "https://api.github.com/graphql", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: reviewThreadsQuery,
        variables: {
          owner: pullRequest.repo.owner,
          name: pullRequest.repo.name,
          number: pullRequest.number,
        },
      }),
    }),
  );
  const threads = payload.data?.repository?.pullRequest?.reviewThreads.nodes;

  if (threads === undefined) {
    const messages = payload.errors?.map((error) => error.message).join("; ");
    throw new Error(`Could not read review threads: ${messages ?? "no data returned"}`);
  }

  return threads.map((thread) => ({
    resolved: thread.isResolved,
    outdated: thread.isOutdated,
    path: thread.path,
    line: thread.line ?? thread.originalLine,
    comments: thread.comments.nodes.map((comment) => ({
      author: comment.author?.login ?? "unknown",
      authorType: comment.author?.__typename ?? null,
      association: comment.authorAssociation,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  }));
}

async function requestPages<TItem>(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  schema: z.ZodType<TItem>,
): Promise<TItem[]> {
  const items: TItem[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await requestJson<unknown>(
      fetcher,
      `${url}?per_page=${pageSize}&page=${page}`,
      { headers },
    );
    const pageItems = z.array(schema).parse(payload);
    items.push(...pageItems);

    if (pageItems.length < pageSize) {
      break;
    }
  }

  return items;
}

function toFeedbackComment(comment: RawFeedbackComment): FeedbackComment {
  return { author: comment.author, body: comment.body, createdAt: comment.createdAt };
}

function uniqueAuthors(comments: FeedbackComment[]): string {
  return [...new Set(comments.map((comment) => comment.author))].join(", ");
}

function latest(timestamps: string[]): string | null {
  let newest: string | null = null;

  for (const timestamp of timestamps) {
    if (newest === null || Date.parse(timestamp) > Date.parse(newest)) {
      newest = timestamp;
    }
  }

  return newest;
}

function notRevisable(message: string): RunFailureError {
  return new RunFailureError("pr_not_revisable", message);
}
