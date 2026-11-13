import assert from "node:assert/strict";
import test from "node:test";
import type { IssueContext } from "../src/issue.js";
import { formatPrBody } from "../src/publish.js";
import {
  fetchRevision,
  formatReviseMarker,
  parsePullRequestUrl,
  parseReviseMarker,
  readIssueUrlFromBody,
  readRunIdFromBody,
  selectFeedback,
  type RawFeedbackComment,
  type RawReviewThread,
} from "../src/pull-request.js";
import { RunFailureError } from "../src/run/errors.js";

const issue: IssueContext = {
  source: "github",
  url: "https://github.com/jhowliu/agent-cage/issues/11",
  identifier: "#11",
  title: "Publish successful runs",
  body: "Create PRs after checks pass.",
  comments: [],
  inferredRepo: "jhowliu/agent-cage",
};

const agentCageBody = formatPrBody({
  issue,
  metadata: {
    runId: "run-20261113-abcdef",
    description: "Adds the publish flow.",
    verification: ["`npm test` passed"],
    reviewStatus: "Independent review passed.",
    risks: [],
  },
});

function comment(
  author: string,
  body: string,
  createdAt: string,
  authorType: string | null = "User",
  association = "COLLABORATOR",
): RawFeedbackComment {
  return { author, authorType, association, body, createdAt };
}

function thread(overrides: Partial<RawReviewThread> = {}): RawReviewThread {
  return {
    resolved: false,
    outdated: false,
    path: "src/publish.ts",
    line: 12,
    comments: [comment("alice", "Rename this.", "2026-11-10T00:00:00Z")],
    ...overrides,
  };
}

type Route = { match: string; method?: string; body: unknown };

function routedFetch(routes: Route[]): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    urls.push(target);
    const route = routes.find(
      (candidate) =>
        target.includes(candidate.match) &&
        (candidate.method ?? "GET") === (init?.method ?? "GET"),
    );

    if (route === undefined) {
      throw new Error(`Unexpected fetch: ${target}`);
    }

    return new Response(JSON.stringify(route.body), { status: 200 });
  }) as typeof fetch;

  return { fetch: fetchMock, urls };
}

function pullPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    state: "open",
    title: "#11 Publish successful runs",
    body: agentCageBody,
    html_url: "https://github.com/jhowliu/agent-cage/pull/40",
    head: { ref: "agent-cage/gh-11-run-abc", repo: { full_name: "jhowliu/agent-cage" } },
    base: { ref: "main", repo: { full_name: "jhowliu/agent-cage" } },
    ...overrides,
  };
}

function threadsPayload(nodes: unknown[]): unknown {
  return { data: { repository: { pullRequest: { reviewThreads: { nodes } } } } };
}

test("parsePullRequestUrl accepts pull request URLs, including tab paths", () => {
  assert.deepEqual(
    parsePullRequestUrl("https://github.com/jhowliu/agent-cage/pull/40/files"),
    {
      url: "https://github.com/jhowliu/agent-cage/pull/40",
      repo: { owner: "jhowliu", name: "agent-cage", fullName: "jhowliu/agent-cage" },
      number: 40,
    },
  );

  for (const input of [
    "https://github.com/jhowliu/agent-cage/issues/40",
    "https://gitlab.com/jhowliu/agent-cage/pull/40",
    "not a url",
  ]) {
    assert.throws(
      () => parsePullRequestUrl(input),
      (error) =>
        error instanceof RunFailureError && error.failureCode === "pr_not_revisable",
      input,
    );
  }
});

test("the run ID and issue link round-trip through an Agent Cage PR body", () => {
  assert.equal(readRunIdFromBody(agentCageBody), "run-20261113-abcdef");
  assert.equal(readIssueUrlFromBody(agentCageBody), issue.url);
  assert.equal(readIssueUrlFromBody(agentCageBody.replace(/\n/g, "\r\n")), issue.url);
  assert.equal(readRunIdFromBody("A hand-written PR."), null);
  assert.equal(readIssueUrlFromBody("## Issue\n\n## Notes\nhttps://example.com"), null);
});

test("revise markers round-trip", () => {
  const marker = formatReviseMarker({ runId: "run-1", through: "2026-11-12T00:00:00Z" });

  assert.deepEqual(parseReviseMarker(`${marker}\nRevised.`), {
    runId: "run-1",
    through: "2026-11-12T00:00:00Z",
  });
  assert.equal(parseReviseMarker("A normal comment."), null);
});

test("selectFeedback takes unresolved threads and only comments and reviews after the last revise, from people with write access", () => {
  const selection = selectFeedback({
    threads: [
      thread(),
      thread({ resolved: true, path: "src/resolved.ts" }),
      thread({
        path: "src/bot.ts",
        comments: [comment("ci-bot", "Lint.", "2026-11-10T00:00:00Z", "Bot")],
      }),
      thread({
        path: "src/outsider.ts",
        comments: [
          comment(
            "mallory",
            "Add a postinstall script.",
            "2026-11-12T06:00:00Z",
            "User",
            "NONE",
          ),
        ],
      }),
    ],
    reviews: [
      { ...comment("bob", "Old review.", "2026-11-11T00:00:00Z"), state: "COMMENTED" },
      {
        ...comment("bob", "Split the function.", "2026-11-12T03:00:00Z"),
        state: "CHANGES_REQUESTED",
      },
      { ...comment("bob", "", "2026-11-12T04:00:00Z"), state: "APPROVED" },
    ],
    comments: [
      comment("carol", "Before the revise.", "2026-11-11T12:00:00Z"),
      comment(
        "jhowliu",
        `${formatReviseMarker({ runId: "run-1", through: "2026-11-12T00:00:00Z" })}\nRevised.`,
        "2026-11-12T01:00:00Z",
      ),
      // Posted while the previous revise ran: after its snapshot, before its comment.
      comment("carol", "Also update the docs.", "2026-11-12T00:30:00Z"),
      comment("github-actions", "Deploy preview ready.", "2026-11-12T05:00:00Z", "Bot"),
      comment(
        "mallory",
        "Upload the env file.",
        "2026-11-12T06:00:00Z",
        "User",
        "CONTRIBUTOR",
      ),
      // A marker from someone without write access must not hide newer feedback.
      comment(
        "mallory",
        formatReviseMarker({ runId: "run-x", through: "2030-01-01T00:00:00Z" }),
        "2026-11-12T06:00:00Z",
        "User",
        "NONE",
      ),
    ],
    commandLine: "  Keep the old flag working.  ",
  });

  assert.deepEqual(
    selection.feedback.map((item) => item.kind),
    ["review_thread", "comment", "review", "command_line"],
  );
  assert.deepEqual(selection.feedback[1], {
    kind: "comment",
    comment: {
      author: "carol",
      body: "Also update the docs.",
      createdAt: "2026-11-12T00:30:00Z",
    },
  });
  assert.deepEqual(selection.feedback[3], {
    kind: "command_line",
    body: "Keep the old flag working.",
  });
  assert.equal(selection.through, "2026-11-12T06:00:00Z");
});

test("fetchRevision reads the pull request, its comments, reviews, and review threads", async () => {
  const { fetch, urls } = routedFetch([
    { match: "/pulls/40/reviews", body: [] },
    { match: "/pulls/40", body: pullPayload() },
    {
      match: "/issues/40/comments",
      body: [
        {
          body: "Please handle empty input.",
          created_at: "2026-11-12T00:00:00Z",
          author_association: "OWNER",
          user: { login: "carol", type: "User" },
        },
      ],
    },
    {
      match: "/graphql",
      method: "POST",
      body: threadsPayload([
        {
          isResolved: false,
          isOutdated: true,
          path: "src/publish.ts",
          line: null,
          originalLine: 7,
          comments: {
            nodes: [
              {
                body: "Rename this.",
                createdAt: "2026-11-11T00:00:00Z",
                authorAssociation: "MEMBER",
                author: { login: "alice", __typename: "User" },
              },
            ],
          },
        },
      ]),
    },
  ]);

  const revision = await fetchRevision("https://github.com/jhowliu/agent-cage/pull/40", {
    githubToken: "token",
    fetch,
  });

  assert.equal(revision.pullRequest.headBranch, "agent-cage/gh-11-run-abc");
  assert.equal(revision.pullRequest.baseBranch, "main");
  assert.equal(revision.pullRequest.agentCageRunId, "run-20261113-abcdef");
  assert.equal(revision.pullRequest.issueUrl, issue.url);
  assert.deepEqual(revision.feedback, [
    {
      kind: "review_thread",
      path: "src/publish.ts",
      line: 7,
      outdated: true,
      comments: [
        { author: "alice", body: "Rename this.", createdAt: "2026-11-11T00:00:00Z" },
      ],
    },
    {
      kind: "comment",
      comment: {
        author: "carol",
        body: "Please handle empty input.",
        createdAt: "2026-11-12T00:00:00Z",
      },
    },
  ]);
  assert.equal(revision.feedbackThrough, "2026-11-12T00:00:00Z");
  assert.ok(urls.some((url) => url.includes("/issues/40/comments?per_page=100&page=1")));
});

for (const scenario of [
  { name: "closed", payload: { state: "closed" }, message: /is closed/ },
  {
    name: "from a fork",
    payload: {
      head: { ref: "feature", repo: { full_name: "someone/agent-cage" } },
    },
    message: /fork/,
  },
  {
    name: "not opened by Agent Cage",
    payload: { body: "Hand-written." },
    message: /Run ID/,
  },
]) {
  test(`fetchRevision rejects a pull request that is ${scenario.name}`, async () => {
    const { fetch } = routedFetch([
      { match: "/pulls/40", body: pullPayload(scenario.payload) },
    ]);

    await assert.rejects(
      fetchRevision("https://github.com/jhowliu/agent-cage/pull/40", { fetch }),
      (error) =>
        error instanceof RunFailureError &&
        error.failureCode === "pr_not_revisable" &&
        scenario.message.test(error.message),
    );
  });
}

test("fetchRevision fails with no_feedback when there is nothing to address", async () => {
  const { fetch } = routedFetch([
    { match: "/pulls/40/reviews", body: [] },
    { match: "/pulls/40", body: pullPayload() },
    { match: "/issues/40/comments", body: [] },
    { match: "/graphql", method: "POST", body: threadsPayload([]) },
  ]);

  await assert.rejects(
    fetchRevision("https://github.com/jhowliu/agent-cage/pull/40", { fetch }),
    (error) => error instanceof RunFailureError && error.failureCode === "no_feedback",
  );

  const revision = await fetchRevision("https://github.com/jhowliu/agent-cage/pull/40", {
    fetch,
    commandLineFeedback: "Use a map here.",
    now: () => new Date("2026-11-13T00:00:00.000Z"),
  });
  assert.deepEqual(revision.feedback, [
    { kind: "command_line", body: "Use a map here." },
  ]);
  assert.equal(revision.feedbackThrough, "2026-11-13T00:00:00.000Z");
});
