import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchIssueContext,
  parseIssueUrl,
  type ParsedGithubIssueUrl,
  type ParsedLinearIssueUrl,
} from "../src/issue.js";
import { fetchGithubIssueContext } from "../src/issue-github.js";
import { fetchLinearIssueContext } from "../src/issue-linear.js";

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function jsonResponse(payload: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  };
}

function failingResponse(status: number, statusText: string): MockResponse {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
  };
}

function createFetchMock(responses: MockResponse[]): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();

    if (response === undefined) {
      throw new Error("Unexpected fetch call.");
    }

    return response as Response;
  }) as typeof fetch;

  return { fetch: fetchMock, calls };
}

test("parseIssueUrl parses GitHub issue URLs and infers repo", () => {
  const parsed = parseIssueUrl("https://github.com/jhowliu/codex-cage/issues/42");

  assert.deepEqual(parsed, {
    source: "github",
    url: "https://github.com/jhowliu/codex-cage/issues/42",
    owner: "jhowliu",
    repo: "codex-cage",
    number: 42,
    inferredRepo: "jhowliu/codex-cage",
  });
});

test("parseIssueUrl parses Linear issue URLs and keys", () => {
  const parsed = parseIssueUrl("https://linear.app/acme/issue/ENG-123/fix-login");

  assert.deepEqual(parsed, {
    source: "linear",
    url: "https://linear.app/acme/issue/ENG-123/fix-login",
    organization: "acme",
    key: "ENG-123",
  });
});

test("parseIssueUrl rejects unsupported issue URLs", () => {
  assert.throws(
    () => parseIssueUrl("https://example.com/issue/1"),
    /Unsupported issue URL host/,
  );
});

test("fetchGithubIssueContext fetches issue context and selected human comments", async () => {
  const issue: ParsedGithubIssueUrl = {
    source: "github",
    url: "https://github.com/jhowliu/codex-cage/issues/4",
    owner: "jhowliu",
    repo: "codex-cage",
    number: 4,
    inferredRepo: "jhowliu/codex-cage",
  };
  const { fetch, calls } = createFetchMock([
    jsonResponse({
      title: "Persist run metadata",
      body: "Store metadata in SQLite.",
    }),
    jsonResponse([
      {
        body: "Older human context",
        created_at: "2026-04-25T00:00:00Z",
        user: { login: "alice", type: "User" },
      },
      {
        body: "Bot noise",
        created_at: "2026-04-25T00:01:00Z",
        user: { login: "dependabot", type: "Bot" },
      },
      {
        body: "",
        created_at: "2026-04-25T00:02:00Z",
        user: { login: "bob", type: "User" },
      },
      {
        body: "Latest human context",
        created_at: "2026-04-25T00:03:00Z",
        user: { login: "carol", type: "User" },
      },
    ]),
  ]);

  const context = await fetchGithubIssueContext(issue, {
    comments: 1,
    githubToken: "github-token",
    fetch,
  });

  assert.equal(context.source, "github");
  assert.equal(context.identifier, "#4");
  assert.equal(context.inferredRepo, "jhowliu/codex-cage");
  assert.equal(context.title, "Persist run metadata");
  assert.deepEqual(context.comments, [
    {
      author: "carol",
      body: "Latest human context",
      createdAt: "2026-04-25T00:03:00Z",
    },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.init?.headers, {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer github-token",
    "X-GitHub-Api-Version": "2022-11-28",
  });
});

test("fetchLinearIssueContext requires LINEAR_API_KEY", async () => {
  const issue: ParsedLinearIssueUrl = {
    source: "linear",
    url: "https://linear.app/acme/issue/ENG-123/fix-login",
    organization: "acme",
    key: "ENG-123",
  };

  await assert.rejects(
    () => fetchLinearIssueContext(issue),
    /Linear issue URLs require LINEAR_API_KEY/,
  );
});

test("fetchLinearIssueContext fetches issue context and filters comments", async () => {
  const issue: ParsedLinearIssueUrl = {
    source: "linear",
    url: "https://linear.app/acme/issue/ENG-123/fix-login",
    organization: "acme",
    key: "ENG-123",
  };
  const { fetch, calls } = createFetchMock([
    jsonResponse({
      data: {
        issue: {
          identifier: "ENG-123",
          title: "Fix login",
          description: "Full PRD",
          comments: {
            nodes: [
              {
                body: "First human comment",
                createdAt: "2026-04-25T00:00:00Z",
                user: { name: "Alice", displayName: null },
              },
              {
                body: "Second human comment",
                createdAt: "2026-04-25T00:01:00Z",
                user: { name: "Bob", displayName: "Bobby" },
              },
            ],
          },
        },
      },
    }),
  ]);

  const context = await fetchLinearIssueContext(issue, {
    comments: "all",
    linearApiKey: "linear-token",
    fetch,
  });

  assert.equal(context.source, "linear");
  assert.equal(context.identifier, "ENG-123");
  assert.equal(context.inferredRepo, null);
  assert.deepEqual(context.comments, [
    {
      author: "Alice",
      body: "First human comment",
      createdAt: "2026-04-25T00:00:00Z",
    },
    {
      author: "Bobby",
      body: "Second human comment",
      createdAt: "2026-04-25T00:01:00Z",
    },
  ]);
  assert.equal(calls[0]?.url, "https://api.linear.app/graphql");
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: "linear-token",
    "Content-Type": "application/json",
  });
});

test("fetchIssueContext dispatches based on URL provider", async () => {
  const { fetch } = createFetchMock([
    jsonResponse({
      title: "Issue title",
      body: "Issue body",
    }),
    jsonResponse([]),
  ]);

  const context = await fetchIssueContext(
    "https://github.com/jhowliu/codex-cage/issues/5",
    { fetch },
  );

  assert.equal(context.source, "github");
  assert.equal(context.identifier, "#5");
});

test("fetchIssueContext reports HTTP failures", async () => {
  const { fetch } = createFetchMock([failingResponse(404, "Not Found")]);

  await assert.rejects(
    () =>
      fetchIssueContext("https://github.com/jhowliu/codex-cage/issues/5", {
        fetch,
      }),
    /Request failed: 404 Not Found/,
  );
});
