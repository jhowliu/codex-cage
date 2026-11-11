import { loadCodexCageConfigFile } from "./config-file.js";
import { prepareRunCredentials, readRunEnv } from "./credentials.js";
import { ghTokenLookup, type GithubTokenLookup } from "./github-auth.js";
import { fetchIssueContext } from "./issue.js";
import { fetchGithubIssueState } from "./issue-github.js";
import {
  checkIssueReadiness,
  type IssueStateLookup,
  type ReadinessFinding,
} from "./issue-readiness.js";

export type ConfigFinding = {
  level: "error";
  code: "missing_config" | "invalid_config";
  message: string;
};

export type CheckFinding = ReadinessFinding | ConfigFinding;

export type IssueCheckResult = {
  issueUrl: string;
  issue: { identifier: string; title: string } | null;
  ready: boolean;
  findings: CheckFinding[];
};

export type CheckIssueDependencies = {
  fetchIssueContext?: typeof fetchIssueContext;
  lookupIssueState?: IssueStateLookup;
  readEnv?: (cwd: string) => Promise<Record<string, string>>;
  findGithubToken?: GithubTokenLookup;
};

/**
 * Checks whether an issue is ready to hand to `codex-cage run`: the repository
 * config must be valid and every issue under "Blocked by" must be closed.
 * Missing template sections only warn. `run` does not repeat this check, so
 * callers such as a delegating agent run it first.
 */
export async function checkIssue(
  cwd: string,
  issueUrl: string,
  dependencies: CheckIssueDependencies = {},
): Promise<IssueCheckResult> {
  const configFile = await loadCodexCageConfigFile(cwd);

  switch (configFile.status) {
    case "missing":
      return notReady(issueUrl, {
        level: "error",
        code: "missing_config",
        message: ".codex-cage.yml was not found. Run `codex-cage setup` first.",
      });
    case "invalid":
      return notReady(issueUrl, {
        level: "error",
        code: "invalid_config",
        message: `.codex-cage.yml is invalid: ${configFile.errors
          .map((error) => error.message)
          .join("; ")}`,
      });
    case "valid":
      break;
    default: {
      const exhaustive: never = configFile;
      return exhaustive;
    }
  }

  const { config } = configFile;
  const credentials = await prepareRunCredentials({
    cwd,
    agents: {
      implement: config.agent.implement.provider,
      review: config.agent.review.provider,
    },
    readEnv: dependencies.readEnv ?? readRunEnv,
    // The check only reads issues; it never starts an agent.
    findCodexAuthFile: async () => null,
    findGithubToken: dependencies.findGithubToken ?? ghTokenLookup,
  });
  const fetchIssue = dependencies.fetchIssueContext ?? fetchIssueContext;
  const issue = await fetchIssue(
    issueUrl,
    credentials.issueOptions(config.issue.comments),
  );
  const lookupIssueState =
    dependencies.lookupIssueState ??
    ((reference) =>
      fetchGithubIssueState(reference, { githubToken: credentials.githubToken() }));
  const readiness = await checkIssueReadiness(issue, lookupIssueState);

  return {
    issueUrl,
    issue: { identifier: issue.identifier, title: issue.title },
    ready: readiness.ready,
    findings: readiness.findings,
  };
}

function notReady(issueUrl: string, finding: ConfigFinding): IssueCheckResult {
  return { issueUrl, issue: null, ready: false, findings: [finding] };
}
