import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { createComposeProject } from "./compose.js";
import {
  parseCodexCageConfig,
  resolveExecutionMode,
  type CodexCageConfig,
} from "./config.js";
import { prepareRunCredentials } from "./credentials.js";
import {
  type buildRuntimeImage,
  type DockerSandbox,
  type DockerSandboxOptions,
} from "./docker.js";
import { readCodexCageEnv } from "./guards.js";
import { fetchIssueContext } from "./issue.js";
import { generateBranchName, type publishSuccessfulRun } from "./publish.js";
import { buildPromptContext } from "./prompt-context.js";
import { createAuthenticatedRepo, resolveTargetRepo } from "./repo.js";
import type { runIndependentReview } from "./review.js";
import { RunFailureError } from "./run/errors.js";
import { openRunStore } from "./state.js";
import type { createHostShellRunner, createHostWorkspace } from "./sandbox-execution.js";
import {
  runWorkflow,
  type RunCodexCageResult,
  type RunProgressEvent,
  type RuntimeContext,
  type ShellRunner,
} from "./run-workflow.js";

export type { RunCodexCageResult, RunProgressEvent, ShellRunner };

export type RunCommandOptions = {
  cwd?: string;
  issueUrl: string;
  repo?: string | undefined;
  base?: string | undefined;
  model?: string | undefined;
  draft?: boolean | undefined;
};

export type RunCodexCageDependencies = {
  fetchIssueContext?: typeof fetchIssueContext;
  resolveTargetRepo?: typeof resolveTargetRepo;
  createAuthenticatedRepo?: typeof createAuthenticatedRepo;
  readEnv?: typeof readCodexCageEnv;
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
  onProgress?: (event: RunProgressEvent) => void;
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
    });
  } finally {
    store.close();
  }
}

async function prepareRuntimeContext(
  cwd: string,
  options: RunCommandOptions,
  dependencies: RunCodexCageDependencies,
): Promise<RuntimeContext> {
  const configResult = await readConfig(cwd);
  const readEnv = dependencies.readEnv ?? readCodexCageEnv;
  const fetchContext = dependencies.fetchIssueContext ?? fetchIssueContext;
  const resolveRepo = dependencies.resolveTargetRepo ?? resolveTargetRepo;
  const authenticateRepo =
    dependencies.createAuthenticatedRepo ?? createAuthenticatedRepo;
  const locateCodexAuthFile = dependencies.findCodexAuthFile ?? findCodexAuthFile;
  const credentials = await prepareRunCredentials({
    cwd,
    readEnv,
    findCodexAuthFile: locateCodexAuthFile,
  });
  const issue = await fetchContext(
    options.issueUrl,
    credentials.issueOptions(configResult.config.issue.comments),
  );
  const repoInput: Parameters<typeof resolveTargetRepo>[0] = {
    issue,
    cwd,
  };

  if (options.repo !== undefined) {
    repoInput.explicitRepo = options.repo;
  }

  const repoResolution = await resolveRepo(repoInput);
  const authenticatedRepo = authenticateRepo(
    repoResolution.repo,
    credentials.githubToken(),
  );
  const baseBranch = options.base ?? configResult.config.git.base;
  const model = options.model ?? configResult.config.agent.model;
  const draft = options.draft ?? configResult.config.pr.draft;
  const runId = dependencies.generateRunId?.() ?? generateRunId();
  const branchName = generateBranchName({ issue, runId });
  const runtimeImage = {
    image: configResult.config.runtime.image,
    dockerfilePath: "",
    contextPath: "",
    source: "configured" as const,
  };
  const promptContext = await buildPromptContext(cwd);
  const executionMode = resolveExecutionMode({
    env: process.env,
    config: configResult.config,
  });

  return {
    cwd,
    config: configResult.config,
    configWarnings: configResult.warnings,
    credentials,
    issue,
    repoResolution,
    authenticatedRepo,
    baseBranch,
    model,
    draft,
    runId,
    branchName,
    runtimeImage,
    promptContext,
    executionMode,
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
  const authFilePath = join(homedir(), ".codex", "auth.json");

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
