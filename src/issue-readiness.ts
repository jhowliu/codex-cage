import type { IssueContext } from "./issue.js";

/** Sections a delegated task should describe. Missing ones only warn. */
export const recommendedIssueSections = ["What to build", "Acceptance criteria"] as const;
export type RecommendedIssueSection = (typeof recommendedIssueSections)[number];

/** Issues listed under this heading must all be closed before a run starts. */
export const blockedBySectionName = "Blocked by";

export type GithubIssueReference = {
  owner: string;
  repo: string;
  number: number;
};

export type IssueState = "open" | "closed";
export type IssueStateLookup = (reference: GithubIssueReference) => Promise<IssueState>;

export type ReadinessFinding =
  | { level: "error"; code: "blocked_by_open_issue"; reference: string; message: string }
  | { level: "error"; code: "blocker_unverified"; reference: string; message: string }
  | {
      level: "warning";
      code: "missing_section" | "empty_section";
      section: RecommendedIssueSection;
      message: string;
    }
  | {
      level: "warning";
      code: "blocker_unresolvable";
      reference: string;
      message: string;
    };

export type IssueReadinessReport = {
  ready: boolean;
  findings: ReadinessFinding[];
};

/**
 * Decides whether an issue can start a run. Open or unverifiable blockers are
 * errors; missing template sections are warnings, because the implement agent
 * can still ask for clarification.
 */
export async function checkIssueReadiness(
  issue: IssueContext,
  lookupIssueState: IssueStateLookup,
): Promise<IssueReadinessReport> {
  const sections = parseMarkdownSections(issue.body);
  const findings: ReadinessFinding[] = [];

  for (const section of recommendedIssueSections) {
    const content = sections.get(normalizeHeading(section));

    if (content === undefined) {
      findings.push({
        level: "warning",
        code: "missing_section",
        section,
        message: `Missing "## ${section}" section.`,
      });
    } else if (content.trim() === "") {
      findings.push({
        level: "warning",
        code: "empty_section",
        section,
        message: `"## ${section}" section is empty.`,
      });
    }
  }

  const blockedBy = sections.get(normalizeHeading(blockedBySectionName));

  if (blockedBy !== undefined) {
    const parsed = parseBlockerReferences(blockedBy, issue.inferredRepo);

    for (const reference of parsed.unresolvable) {
      findings.push({
        level: "warning",
        code: "blocker_unresolvable",
        reference,
        message: `Cannot tell which repository blocker ${reference} belongs to; it was not checked.`,
      });
    }

    findings.push(
      ...(
        await Promise.all(
          parsed.references.map((reference) => checkBlocker(reference, lookupIssueState)),
        )
      ).filter((finding): finding is ReadinessFinding => finding !== null),
    );
  }

  return {
    ready: findings.every((finding) => finding.level !== "error"),
    findings,
  };
}

export function formatReadinessFinding(finding: ReadinessFinding): string {
  return `${finding.level}: ${finding.message}`;
}

/**
 * Splits Markdown into sections keyed by normalized heading text. A section
 * runs until the next heading of the same or a higher level; headings inside
 * fenced code blocks are ignored. The first section with a given name wins.
 */
export function parseMarkdownSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const open: { key: string; level: number; lines: string[] }[] = [];
  let fence: string | null = null;

  const close = (minimumLevel: number): void => {
    while (open.length > 0 && (open.at(-1)?.level ?? 0) >= minimumLevel) {
      const section = open.pop();

      if (section !== undefined && !sections.has(section.key)) {
        sections.set(section.key, section.lines.join("\n"));
      }
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);

    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      fence = fence === null ? marker : fence === marker ? null : fence;
    }

    const heading = fence === null ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;

    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      close(level);
      open.push({ key: normalizeHeading(heading[2] ?? ""), level, lines: [] });
      continue;
    }

    for (const section of open) {
      section.lines.push(line);
    }
  }

  close(1);
  return sections;
}

export type ParsedBlockerReferences = {
  references: GithubIssueReference[];
  unresolvable: string[];
};

/**
 * Finds GitHub issue references in a "Blocked by" section: full issue or pull
 * request URLs, `owner/repo#N`, and `#N` (resolved against the issue's own
 * repository when it has one).
 */
export function parseBlockerReferences(
  text: string,
  defaultRepo: string | null,
): ParsedBlockerReferences {
  const references = new Map<string, GithubIssueReference>();
  const unresolvable: string[] = [];
  const add = (owner: string, repo: string, number: number): void => {
    references.set(`${owner}/${repo}#${number}`.toLowerCase(), { owner, repo, number });
  };

  let remaining = text.replace(
    /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/g,
    (_match, owner: string, repo: string, number: string) => {
      add(owner, repo, Number(number));
      return " ";
    },
  );

  remaining = remaining.replace(
    /\b([\w.-]+)\/([\w.-]+)#(\d+)\b/g,
    (_match, owner: string, repo: string, number: string) => {
      add(owner, repo, Number(number));
      return " ";
    },
  );

  for (const match of remaining.matchAll(/(?<![\w/&])#(\d+)\b/g)) {
    const number = Number(match[1]);
    const [owner, repo] = defaultRepo?.split("/") ?? [];

    if (owner !== undefined && repo !== undefined) {
      add(owner, repo, number);
    } else {
      unresolvable.push(`#${number}`);
    }
  }

  return { references: [...references.values()], unresolvable };
}

export function formatIssueReference(reference: GithubIssueReference): string {
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

async function checkBlocker(
  reference: GithubIssueReference,
  lookupIssueState: IssueStateLookup,
): Promise<ReadinessFinding | null> {
  const label = formatIssueReference(reference);

  try {
    const state = await lookupIssueState(reference);

    return state === "open"
      ? {
          level: "error",
          code: "blocked_by_open_issue",
          reference: label,
          message: `Blocked by open issue ${label}.`,
        }
      : null;
  } catch (error) {
    return {
      level: "error",
      code: "blocker_unverified",
      reference: label,
      message: `Could not check blocker ${label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/:$/, "").trim().toLowerCase();
}
