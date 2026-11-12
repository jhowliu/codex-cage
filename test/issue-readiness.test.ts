import assert from "node:assert/strict";
import test from "node:test";
import type { IssueContext } from "../src/issue.js";
import {
  checkIssueReadiness,
  parseBlockerReferences,
  parseMarkdownSections,
  type GithubIssueReference,
  type IssueState,
} from "../src/issue-readiness.js";

function githubIssue(body: string): IssueContext {
  return {
    source: "github",
    url: "https://github.com/jhowliu/agent-cage/issues/200",
    identifier: "#200",
    title: "Task",
    body,
    comments: [],
    inferredRepo: "jhowliu/agent-cage",
  };
}

function states(map: Record<number, IssueState>) {
  const seen: string[] = [];
  const lookup = async (reference: GithubIssueReference): Promise<IssueState> => {
    seen.push(`${reference.owner}/${reference.repo}#${reference.number}`);
    const state = map[reference.number];
    if (state === undefined) throw new Error("Request failed: 404 Not Found");
    return state;
  };
  return { lookup, seen };
}

const template = (blockedBy: string) =>
  `## What to build\nAdd it.\n\n## Acceptance criteria\n- [ ] works\n\n## Blocked by\n${blockedBy}\n`;

test("parseMarkdownSections nests subsections and ignores headings in code fences", () => {
  const sections = parseMarkdownSections(
    [
      "## What to build",
      "Intro",
      "### Details",
      "More",
      "```md",
      "## Blocked by",
      "```",
      "## Acceptance Criteria:",
      "- ok",
    ].join("\n"),
  );

  assert.match(sections.get("what to build") ?? "", /Intro[\s\S]*More/);
  assert.equal(sections.get("details")?.includes("More"), true);
  assert.equal(sections.has("blocked by"), false);
  assert.equal(sections.get("acceptance criteria")?.trim(), "- ok");
});

test("parseBlockerReferences resolves URLs, owner/repo#N, and #N against the issue repo", () => {
  const parsed = parseBlockerReferences(
    "- #105\n- jhowliu/herdr-issues#3\n- https://github.com/jhowliu/agent-cage/pull/128\n- #105 again",
    "jhowliu/agent-cage",
  );

  assert.deepEqual(
    parsed.references.map((r) => `${r.owner}/${r.repo}#${r.number}`).sort(),
    ["jhowliu/agent-cage#105", "jhowliu/agent-cage#128", "jhowliu/herdr-issues#3"],
  );
  assert.deepEqual(parsed.unresolvable, []);
  assert.deepEqual(
    parseBlockerReferences("None - can start immediately", "a/b").references,
    [],
  );
  assert.deepEqual(parseBlockerReferences("- #7", null).unresolvable, ["#7"]);
});

test("checkIssueReadiness fails on open blockers and passes once they are closed", async () => {
  const open = states({ 105: "closed", 106: "open" });
  const blocked = await checkIssueReadiness(
    githubIssue(template("- #105\n- #106")),
    open.lookup,
  );

  assert.equal(blocked.ready, false);
  assert.deepEqual(
    blocked.findings.map((finding) => [finding.level, finding.code]),
    [["error", "blocked_by_open_issue"]],
  );
  assert.deepEqual(open.seen.sort(), [
    "jhowliu/agent-cage#105",
    "jhowliu/agent-cage#106",
  ]);

  const closed = states({ 105: "closed", 106: "closed" });
  const ready = await checkIssueReadiness(
    githubIssue(template("- #105\n- #106")),
    closed.lookup,
  );
  assert.deepEqual(ready, { ready: true, findings: [] });
});

test("checkIssueReadiness fails closed when a blocker cannot be looked up", async () => {
  const report = await checkIssueReadiness(
    githubIssue(template("- #999")),
    states({}).lookup,
  );

  assert.equal(report.ready, false);
  assert.equal(report.findings[0]?.code, "blocker_unverified");
  assert.match(report.findings[0]?.message ?? "", /#999: Request failed: 404/);
});

test("checkIssueReadiness only warns about missing or empty template sections", async () => {
  const report = await checkIssueReadiness(
    githubIssue("## What to build\n\n## Notes\nfree text"),
    states({}).lookup,
  );

  assert.equal(report.ready, true);
  assert.deepEqual(
    report.findings.map((finding) => [finding.level, finding.code]),
    [
      ["warning", "empty_section"],
      ["warning", "missing_section"],
    ],
  );
});

test("checkIssueReadiness warns when a Linear issue lists #N blockers without a repository", async () => {
  const linear: IssueContext = {
    ...githubIssue(template("- #12")),
    source: "linear",
    inferredRepo: null,
  };
  const report = await checkIssueReadiness(linear, states({}).lookup);

  assert.equal(report.ready, true);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ["blocker_unresolvable"],
  );
});
