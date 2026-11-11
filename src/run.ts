import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { codexHomePath } from "./agent/codex.js";
import type { AgentAssignments } from "./agent/providers.js";
import type { createComposeProject } from "./compose.js";
import {
  parseCodexCageConfig,
  resolveExecutionMode,
  type CodexCageConfig,
  type ExecutionMode,
} from "./config.js";
import { prepareRunCredentials, readRunEnv } from "./credentials.js";
import {
  type buildRuntimeImage,
  type DockerSandbox,
  type DockerSandboxOptions,
} from "./docker.js";
import { ghTokenLookup, type GithubTokenLookup } from "./github-auth.js";
import { fetchIssueContext } from "./issue.js";
import { fetchGithubIssueState } from "./issue-github.js";
import { checkIssueReadiness, type IssueStateLookup } from "./issue-readiness.js";
import { generateBranchName, type publishSuccessfulRun } from "./publish.js";
import { buildPromptContext } from "./prompt-context.js";
import { createAuthenticatedRepo, resolveTargetRepo } from "./repo.js";
import type { runIndependentReview } from "./review.js";
import { RunFailureError } from "./run/errors.js";
import type { RunEvent, RunEventSink } from "./run/events.js";
import { openRunStore } from "./state.js";
import type { createHostShellRunner, createHostWorkspace } from "./sandbox-execution.js";
import {
  runWorkflow,
  type RunCodexCageResult,
  type RunProgressEvent,
  type RuntimeContext,
  type ShellRunner,
} from "./run-workflow.js";

export type { RunCodexCageResult, RunEvent, RunEventSink, RunProgressEvent, ShellRunner };

export type RunCommandOptions = {
  cwd?: string;
  issueUrl: string;
  runId?: string | undefined;
  repo?: string | undefined;
  base?: string | undefined;
  model?: string | undefined;
  draft?: boolean | undefined;
  verbose?: boolean | undefined;
};

export type RunCodexCageDependencies = {
  fetchIssueContext?: typeof fetchIssueContext;
  lookupIssueState?: IssueStateLookup;
  resolveTargetRepo?: typeof resolveTargetRepo;
  createAuthenticatedRepo?: typeof createAuthenticatedRepo;
  readEnv?: (cwd: string) => Promise<Record<string, string>>;
  openRunStore?: typeof openRunStore;
  createDockerSandbox?: (options: DockerSandboxOptions) => DockerSandbox;
  buildRuntimeImage?: typeof buildRuntimeImage;
  createShellRunner?: (
    sandbox: DockerSandbox,
    env: Record<string, string>,
  ) => ShellRunner;
  createHostWorkspace?: typeof createHostWorkspace;
  createHostShellRunner?: typeof createHostShellRunner;
  createComposeProject?: typeof createComposeProject;
  runIndependentReview?: typeof runIndependentReview;
  publishSuccessfulRun?: typeof publishSuccessfulRun;
  generateRunId?: () => string;
  findCodexAuthFile?: typeof findCodexAuthFile;
  findGithubToken?: GithubTokenLookup;
  onProgress?: (event: RunProgressEvent) => void;
  onEvent?: RunEventSink;
  // Overrides mode resolution (env > config > docker). Tests pin this so they
  // are not influenced by an ambient CODEX_CAGE_EXECUTION.
  executionMode?: ExecutionMode;
};

const configPath = ".codex-cage.yml";

export async function runCodexCage(
  options: RunCommandOptions,
  dependencies: RunCodexCageDependencies = {},
): Promise<RunCodexCageResult> {
  const cwd = options.cwd ?? process.cwd();
  const context = await prepareRuntimeContext(cwd, options, dependencies);
  const openStore = dependencies.openRunStore ?? openRunStore;
  const store = await openStore(cwd);

  try {
    return await runWorkflow({
      context,
      store,
      ...(dependencies.createDockerSandbox === undefined
        ? {}
        : { createDockerSandbox: dependencies.createDockerSandbox }),
      ...(dependencies.buildRuntimeImage === undefined
        ? {}
        : { buildRuntimeImage: dependencies.buildRuntimeImage }),
      ...(dependencies.createShellRunner === undefined
        ? {}
        : { createShellRunner: dependencies.createShellRunner }),
      ...(dependencies.createHostWorkspace === undefined
        ? {}
        : { createHostWorkspace: dependencies.createHostWorkspace }),
      ...(dependencies.createHostShellRunner === undefined
        ? {}
        : { createHostShellRunner: dependencies.createHostShellRunner }),
      ...(dependencies.createComposeProject === undefined
        ? {}
        : { createComposeProject: dependencies.createComposeProject }),
      ...(dependencies.runIndependentReview === undefined
        ? {}
        : { runIndependentReview: dependencies.runIndependentReview }),
      ...(dependencies.publishSuccessfulRun === undefined
        ? {}
        : { publishSuccessfulRun: dependencies.publishSuccessfulRun }),
      ...(dependencies.onProgress === undefined
        ? {}
        : { onProgress: dependencies.onProgress }),
      ...(dependencies.onEvent === undefined ? {} : { onEvent: dependencies.onEvent }),
    });
  } finally {
    store.close();
  }
}

/**
 * What a run resolves before it creates a run record: config, credentials,
 * the issue and its readiness, and the target repository with its token.
 */
export type RunTarget = Pick<
  RuntimeContext,
  | "config"
  | "configWarnings"
  | "credentials"
  | "issue"
  | "issueReadiness"
  | "repoResolution"
  | "authenticatedRepo"
>;

export type RunTargetOptions = Pick<RunCommandOptions, "issueUrl" | "repo">;

export type RunTargetDependencies = Pick<
  RunCodexCageDependencies,
  | "fetchIssueContext"
  | "lookupIssueState"
  | "resolveTargetRepo"
  | "createAuthenticatedRepo"
  | "readEnv"
  | "findCodexAuthFile"
  | "findGithubToken"
>;

/**
 * Resolves a run's inputs without starting it. `codex-cage run` and
 * `codex-cage check` both call this, so `check` fails on exactly the setup
 * problems that would stop a run, with the same failure codes. Readiness
 * findings are returned, not thrown: `run` turns an unready issue into
 * `issue_blocked` in its preflight phase so the failure is recorded.
 */
export async function resolveRunTarget(
  cwd: string,
  options: RunTargetOptions,
  dependencies: RunTargetDependencies = {},
): Promise<RunTarget> {
  const { config, warnings } = await readConfig(cwd);
  const credentials = await prepareRunCredentials({
    cwd,
    agents: {
      implement: config.agent.implement.provider,
      review: config.agent.review.provider,
    },
    readEnv: dependencies.readEnv ?? readRunEnv,
    findCodexAuthFile: dependencies.findCodexAuthFile ?? findCodexAuthFile,
    findGithubToken: dependencies.findGithubToken ?? ghTokenLookup,
  });
  const fetchContext = dependencies.fetchIssueContext ?? fetchIssueContext;
  const issue = await fetchContext(
    options.issueUrl,
    credentials.issueOptions(config.issue.comments),
  );
  const lookupIssueState =
    dependencies.lookupIssueState ??
    ((reference) =>
      fetchGithubIssueState(reference, { githubToken: credentials.githubToken() }));
  const issueReadiness = await checkIssueReadiness(issue, lookupIssueState);
  const repoInput: Parameters<typeof resolveTargetRepo>[0] = {
    issue,
    cwd,
  };

  if (options.repo !== undefined) {
    repoInput.explicitRepo = options.repo;
  }

  const resolveRepo = dependencies.resolveTargetRepo ?? resolveTargetRepo;
  const repoResolution = await resolveRepo(repoInput);
  const authenticateRepo =
    dependencies.createAuthenticatedRepo ?? createAuthenticatedRepo;
  const authenticatedRepo = authenticateRepo(
    repoResolution.repo,
    credentials.githubToken(),
  );

  return {
    config,
    configWarnings: warnings,
    credentials,
    issue,
    issueReadiness,
    repoResolution,
    authenticatedRepo,
  };
}

async function prepareRuntimeContext(
  cwd: string,
  options: RunCommandOptions,
  dependencies: RunCodexCageDependencies,
): Promise<RuntimeContext> {
  const target = await resolveRunTarget(cwd, options, dependencies);
  const { config, issue } = target;
  const agents: AgentAssignments = {
    implement: {
      provider: config.agent.implement.provider,
      model: options.model ?? config.agent.implement.model,
    },
    review: config.agent.review,
  };
  const baseBranch = options.base ?? config.git.base;
  const draft = options.draft ?? config.pr.draft;
  const runId = options.runId ?? dependencies.generateRunId?.() ?? generateRunId();
  const branchName = generateBranchName({ issue, runId });
  const runtimeImage = {
    image: config.runtime.image,
    dockerfilePath: "",
    contextPath: "",
    source: "configured" as const,
  };
  const promptContext = await buildPromptContext(cwd);
  const executionMode =
    dependencies.executionMode ??
    resolveExecutionMode({
      env: process.env,
      config,
    });

  return {
    ...target,
    cwd,
    baseBranch,
    agents,
    draft,
    runId,
    branchName,
    runtimeImage,
    promptContext,
    executionMode,
    verbose: options.verbose ?? false,
  };
}

async function readConfig(cwd: string): Promise<{
  config: CodexCageConfig;
  warnings: string[];
}> {
  let content: string;

  try {
    content = await readFile(resolve(cwd, configPath), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RunFailureError("missing_config", `${configPath} was not found.`);
    }

    throw error;
  }

  try {
    return parseCodexCageConfig(YAML.parse(content) as unknown);
  } catch (error) {
    throw new RunFailureError(
      "invalid_config",
      error instanceof Error ? error.message : "Invalid Codex Cage config.",
    );
  }
}

async function findCodexAuthFile(): Promise<string | null> {
  const authFilePath = join(codexHomePath(), "auth.json");

  try {
    await access(authFilePath, constants.R_OK);
    return authFilePath;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
      return null;
    }

    throw error;
  }
}

function generateRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);

  return `run-${timestamp}-${random}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
