import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { codexHomePath } from "./agent/codex.js";
import type { AgentAssignments } from "./agent/providers.js";
import type { createComposeProject } from "./compose.js";
import {
  parseAgentCageConfig,
  resolveExecutionMode,
  type AgentCageConfig,
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
import { generateBranchName, type publishSuccessfulRun } from "./publish.js";
import { buildPromptContext } from "./prompt-context.js";
import { fetchRevision } from "./pull-request.js";
import { createAuthenticatedRepo, resolveTargetRepo } from "./repo.js";
import type { runIndependentReview } from "./review.js";
import { RunFailureError } from "./run/errors.js";
import type { RunEvent, RunEventSink } from "./run/events.js";
import { openRunStore } from "./state.js";
import type { createHostShellRunner, createHostWorkspace } from "./sandbox-execution.js";
import type { publishRevision } from "./publish.js";
import {
  runWorkflow,
  type RunAgentCageResult,
  type RunProgressEvent,
  type RuntimeContext,
  type ShellRunner,
} from "./run-workflow.js";

export type { RunAgentCageResult, RunEvent, RunEventSink, RunProgressEvent, ShellRunner };

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

export type ReviseCommandOptions = {
  cwd?: string;
  prUrl: string;
  feedback?: string | undefined;
  runId?: string | undefined;
  model?: string | undefined;
  verbose?: boolean | undefined;
};

export type RunAgentCageDependencies = {
  fetchIssueContext?: typeof fetchIssueContext;
  fetchRevision?: typeof fetchRevision;
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
  publishRevision?: typeof publishRevision;
  generateRunId?: () => string;
  findCodexAuthFile?: typeof findCodexAuthFile;
  findGithubToken?: GithubTokenLookup;
  onProgress?: (event: RunProgressEvent) => void;
  onEvent?: RunEventSink;
  // Overrides mode resolution (env > config > docker). Tests pin this so they
  // are not influenced by an ambient AGENT_CAGE_EXECUTION.
  executionMode?: ExecutionMode;
};

const configPath = ".agent-cage.yml";

export async function runAgentCage(
  options: RunCommandOptions,
  dependencies: RunAgentCageDependencies = {},
): Promise<RunAgentCageResult> {
  const cwd = options.cwd ?? process.cwd();
  const context = await prepareRuntimeContext(cwd, options, dependencies);
  return await executeRun(cwd, context, dependencies);
}

/**
 * Revises an open pull request that an Agent Cage run opened: the same
 * implement, verify and review loop on the pull request's branch, driven by
 * its unresolved review threads, new comments, and --feedback.
 */
export async function reviseAgentCagePullRequest(
  options: ReviseCommandOptions,
  dependencies: RunAgentCageDependencies = {},
): Promise<RunAgentCageResult> {
  const cwd = options.cwd ?? process.cwd();
  const context = await prepareRevisionContext(cwd, options, dependencies);
  return await executeRun(cwd, context, dependencies);
}

async function executeRun(
  cwd: string,
  context: RuntimeContext,
  dependencies: RunAgentCageDependencies,
): Promise<RunAgentCageResult> {
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
      ...(dependencies.publishRevision === undefined
        ? {}
        : { publishRevision: dependencies.publishRevision }),
      ...(dependencies.onProgress === undefined
        ? {}
        : { onProgress: dependencies.onProgress }),
      ...(dependencies.onEvent === undefined ? {} : { onEvent: dependencies.onEvent }),
    });
  } finally {
    store.close();
  }
}

type RunFoundation = Pick<
  RuntimeContext,
  | "cwd"
  | "config"
  | "configWarnings"
  | "credentials"
  | "agents"
  | "runId"
  | "runtimeImage"
  | "promptContext"
  | "executionMode"
  | "verbose"
>;

async function prepareRuntimeContext(
  cwd: string,
  options: RunCommandOptions,
  dependencies: RunAgentCageDependencies,
): Promise<RuntimeContext> {
  const foundation = await prepareRunFoundation(cwd, options, dependencies);
  const { config, credentials } = foundation;
  const fetchContext = dependencies.fetchIssueContext ?? fetchIssueContext;
  const resolveRepo = dependencies.resolveTargetRepo ?? resolveTargetRepo;
  const authenticateRepo =
    dependencies.createAuthenticatedRepo ?? createAuthenticatedRepo;
  const issue = await fetchContext(
    options.issueUrl,
    credentials.issueOptions(config.issue.comments),
  );
  const repoInput: Parameters<typeof resolveTargetRepo>[0] = {
    issue,
    cwd,
  };

  if (options.repo !== undefined) {
    repoInput.explicitRepo = options.repo;
  }

  const repoResolution = await resolveRepo(repoInput);

  return {
    ...foundation,
    issue,
    repoResolution,
    authenticatedRepo: authenticateRepo(repoResolution.repo, credentials.githubToken()),
    baseBranch: options.base ?? config.git.base,
    draft: options.draft ?? config.pr.draft,
    branchName: generateBranchName({ issue, runId: foundation.runId }),
    revision: null,
  };
}

async function prepareRevisionContext(
  cwd: string,
  options: ReviseCommandOptions,
  dependencies: RunAgentCageDependencies,
): Promise<RuntimeContext> {
  const foundation = await prepareRunFoundation(cwd, options, dependencies);
  const { config, credentials } = foundation;
  const fetchContext = dependencies.fetchIssueContext ?? fetchIssueContext;
  const readRevision = dependencies.fetchRevision ?? fetchRevision;
  const authenticateRepo =
    dependencies.createAuthenticatedRepo ?? createAuthenticatedRepo;
  const revision = await readRevision(options.prUrl, {
    githubToken: credentials.githubToken(),
    commandLineFeedback: options.feedback,
  });
  const pullRequest = revision.pullRequest;
  const issue = await fetchContext(
    pullRequest.issueUrl,
    credentials.issueOptions(config.issue.comments),
  );

  return {
    ...foundation,
    issue,
    repoResolution: { repo: pullRequest.repo, source: "pull_request" },
    authenticatedRepo: authenticateRepo(pullRequest.repo, credentials.githubToken()),
    baseBranch: pullRequest.baseBranch,
    draft: config.pr.draft,
    branchName: pullRequest.headBranch,
    revision,
  };
}

async function prepareRunFoundation(
  cwd: string,
  options: {
    model?: string | undefined;
    runId?: string | undefined;
    verbose?: boolean | undefined;
  },
  dependencies: RunAgentCageDependencies,
): Promise<RunFoundation> {
  const configResult = await readConfig(cwd);
  const readEnv = dependencies.readEnv ?? readRunEnv;
  const locateCodexAuthFile = dependencies.findCodexAuthFile ?? findCodexAuthFile;
  const agentConfig = configResult.config.agent;
  const agents: AgentAssignments = {
    implement: {
      provider: agentConfig.implement.provider,
      model: options.model ?? agentConfig.implement.model,
    },
    review: agentConfig.review,
  };
  const credentials = await prepareRunCredentials({
    cwd,
    agents: { implement: agents.implement.provider, review: agents.review.provider },
    readEnv,
    findCodexAuthFile: locateCodexAuthFile,
    findGithubToken: dependencies.findGithubToken ?? ghTokenLookup,
  });
  const runId = options.runId ?? dependencies.generateRunId?.() ?? generateRunId();
  const runtimeImage = {
    image: configResult.config.runtime.image,
    dockerfilePath: "",
    contextPath: "",
    source: "configured" as const,
  };
  const promptContext = await buildPromptContext(cwd);
  const executionMode =
    dependencies.executionMode ??
    resolveExecutionMode({
      env: process.env,
      config: configResult.config,
    });

  return {
    cwd,
    config: configResult.config,
    configWarnings: configResult.warnings,
    credentials,
    agents,
    runId,
    runtimeImage,
    promptContext,
    executionMode,
    verbose: options.verbose ?? false,
  };
}

async function readConfig(cwd: string): Promise<{
  config: AgentCageConfig;
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
    return parseAgentCageConfig(YAML.parse(content) as unknown);
  } catch (error) {
    throw new RunFailureError(
      "invalid_config",
      error instanceof Error ? error.message : "Invalid Agent Cage config.",
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
