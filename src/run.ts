import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import YAML from "yaml";
import {
  createComposeProject,
  hasComposeServices,
  type ComposeProject,
} from "./compose.js";
import {
  parseCodexCageConfig,
  type CodexCageConfig,
  type RuntimeImageWarning,
} from "./config.js";
import {
  buildRuntimeImage,
  createDockerSandbox,
  dockerRunArgs,
  type DockerSandbox,
  type DockerSandboxOptions,
  type RuntimeImageBuildResult,
} from "./docker.js";
import {
  assertNoGuardViolations,
  createSecretRedactor,
  guardAttemptDecision,
  GuardViolationError,
  readCodexCageEnv,
  scanDiffForGuardViolations,
} from "./guards.js";
import { fetchIssueContext, type IssueContext } from "./issue.js";
import {
  NoDiffError,
  publishSuccessfulRun,
  type CommandResult,
  type CommandRunner,
} from "./publish.js";
import {
  buildPromptContext,
  formatInstructionsForPrompt,
  type PromptContext,
} from "./prompt-context.js";
import {
  createAuthenticatedRepo,
  resolveTargetRepo,
  type AuthenticatedRepo,
  type RepoResolution,
} from "./repo.js";
import {
  buildReviewPrompt,
  runIndependentReview,
  type ReviewAgentRunner,
  ReviewModifiedDiffError,
} from "./review.js";
import {
  openRunStore,
  type FailureCode,
  type PhaseName,
  type RunStore,
} from "./state.js";
import { generateBranchName } from "./publish.js";

export type RunCommandOptions = {
  cwd?: string;
  issueUrl: string;
  repo?: string | undefined;
  base?: string | undefined;
  model?: string | undefined;
  draft?: boolean | undefined;
};

export type RunCodexCageResult = {
  runId: string;
  status: "succeeded" | "failed";
  failureCode: FailureCode | null;
  prUrl: string | null;
};

export type RunProgressEvent =
  | {
      type: "run_started";
      runId: string;
      issueKey: string;
      issueTitle: string;
      repo: string;
      branch: string;
      artifactDir: string;
    }
  | {
      type: "warning";
      runId: string;
      message: string;
    }
  | {
      type: "phase_started" | "phase_passed" | "phase_failed";
      runId: string;
      phase: PhaseName;
      logPath: string;
    }
  | {
      type: "iteration_started";
      runId: string;
      iteration: number;
      maxIterations: number;
    }
  | {
      type: "run_finished";
      runId: string;
      status: "succeeded" | "failed";
      failureCode: FailureCode | null;
      prUrl: string | null;
    };

export type ShellRunner = {
  run(command: string): Promise<CommandResult>;
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
  createComposeProject?: typeof createComposeProject;
  runIndependentReview?: typeof runIndependentReview;
  publishSuccessfulRun?: typeof publishSuccessfulRun;
  generateRunId?: () => string;
  findCodexAuthFile?: typeof findCodexAuthFile;
  onProgress?: (event: RunProgressEvent) => void;
};

type RuntimeContext = {
  cwd: string;
  config: CodexCageConfig;
  configWarnings: string[];
  runtimeImageWarnings: RuntimeImageWarning[];
  secrets: Record<string, string>;
  issue: IssueContext;
  repoResolution: RepoResolution;
  authenticatedRepo: AuthenticatedRepo;
  baseBranch: string;
  model: string;
  draft: boolean;
  runId: string;
  branchName: string;
  runtimeImage: RuntimeImageBuildResult & {
    source: "configured" | "built";
    warnings: RuntimeImageWarning[];
  };
  promptContext: PromptContext;
  codexAuthFilePath: string | null;
};

type PhaseBody = () => Promise<string | undefined>;

const configPath = ".codex-cage.yml";

export async function runCodexCage(
  options: RunCommandOptions,
  dependencies: RunCodexCageDependencies = {},
): Promise<RunCodexCageResult> {
  const cwd = options.cwd ?? process.cwd();
  const context = await prepareRuntimeContext(cwd, options, dependencies);
  const openStore = dependencies.openRunStore ?? openRunStore;
  const createSandbox = dependencies.createDockerSandbox ?? createDockerSandbox;
  const buildImage = dependencies.buildRuntimeImage ?? buildRuntimeImage;
  const makeShellRunner = dependencies.createShellRunner ?? createDockerShellRunner;
  const makeComposeProject = dependencies.createComposeProject ?? createComposeProject;
  const review = dependencies.runIndependentReview ?? runIndependentReview;
  const publish = dependencies.publishSuccessfulRun ?? publishSuccessfulRun;
  const onProgress = dependencies.onProgress ?? (() => undefined);
  const redactor = createSecretRedactor(context.secrets);
  const store = await openStore(cwd);
  let sandbox: DockerSandbox | null = null;
  let shell: ShellRunner | null = null;
  let compose: ComposeProject | null = null;

  try {
    await store.createRun({
      id: context.runId,
      issueUrl: context.issue.url,
      issueKey: context.issue.identifier,
      repo: context.repoResolution.repo.fullName,
      baseBranch: context.baseBranch,
      branch: context.branchName,
    });
    onProgress({
      type: "run_started",
      runId: context.runId,
      issueKey: context.issue.identifier,
      issueTitle: context.issue.title,
      repo: context.repoResolution.repo.fullName,
      branch: context.branchName,
      artifactDir: store.runDirectory(context.runId),
    });
    for (const warning of context.configWarnings) {
      onProgress({
        type: "warning",
        runId: context.runId,
        message: warning,
      });
    }
    await writeJsonArtifact(store, context.runId, "issue.json", context.issue);
    await writePromptContextArtifacts(store, context);
    await writeJsonArtifact(store, context.runId, "resolved-config.json", {
      config: context.config,
      warnings: context.configWarnings,
      runtimeImageWarnings: context.runtimeImageWarnings,
      repoSource: context.repoResolution.source,
      runtimeImage: context.runtimeImage,
    });

    await runPhase(store, context.runId, "preflight", onProgress, async () => {
      return [
        `Issue: ${context.issue.identifier} ${context.issue.title}`,
        `Repo: ${context.repoResolution.repo.fullName}`,
        `Base: ${context.baseBranch}`,
        `Branch: ${context.branchName}`,
      ].join("\n");
    });

    const runtimeDockerfile = context.config.runtime.dockerfile;

    if (runtimeDockerfile !== null) {
      try {
        context.runtimeImage = await runPhase(
          store,
          context.runId,
          "runtime_image",
          onProgress,
          async () => {
            const result = await buildImage({
              runId: context.runId,
              dockerfilePath: resolve(cwd, runtimeDockerfile),
              contextPath: resolve(cwd, ".codex-cage"),
            });

            return {
              log: [
                `Built runtime image: ${result.image}`,
                `Dockerfile: ${result.dockerfilePath}`,
                `Build context: ${result.contextPath}`,
              ].join("\n"),
              value: { ...result, source: "built" as const, warnings: [] },
            };
          },
        );
      } catch (error) {
        throw new RunFailureError("runtime_image_failed", formatError(error));
      }
    }

    await writeJsonArtifact(
      store,
      context.runId,
      "runtime-image.json",
      context.runtimeImage,
    );

    if (hasComposeServices(context.config.services)) {
      const composeFile = context.config.services.compose;

      if (composeFile === null) {
        throw new RunFailureError("invalid_config", "Compose file is not configured.");
      }

      compose = makeComposeProject({
        runId: context.runId,
        composeFile: resolve(cwd, composeFile),
        projectDirectory: cwd,
        readyCommands: context.config.services.ready,
      });
      try {
        await runPhase(store, context.runId, "setup", onProgress, async () => {
          await compose?.up();
          await compose?.waitUntilReady();
          return "Compose services are ready.";
        });
      } catch (error) {
        throw new RunFailureError("setup_failed", formatError(error));
      }
    }

    const sandboxOptions: DockerSandboxOptions = {
      runId: context.runId,
      cloneUrl: context.authenticatedRepo.cloneUrl,
      image: context.runtimeImage.image,
      env: context.secrets,
    };

    if (context.codexAuthFilePath !== null) {
      sandboxOptions.codexAuthFilePath = context.codexAuthFilePath;
    }

    if (compose !== null) {
      sandboxOptions.serviceNetworkName = compose.networkName;
    }

    sandbox = createSandbox(sandboxOptions);
    shell = makeShellRunner(sandbox, context.secrets);
    const shellRunner = shell;

    await store.updateRunStatus(context.runId, { status: "cloning" });
    await runPhase(store, context.runId, "cloning", onProgress, async () => {
      await sandbox?.create();
      await sandbox?.cloneRepository();
      const checkout = await requiredShell(
        shellRunner,
        `git fetch origin ${shellQuote(context.baseBranch)} && git checkout ${shellQuote(
          context.baseBranch,
        )} && git pull --ff-only origin ${shellQuote(context.baseBranch)}`,
        redactor,
      );
      return checkout;
    });

    if (context.config.setup.length > 0) {
      await store.updateRunStatus(context.runId, { status: "setup" });
      try {
        await runPhase(store, context.runId, "setup", onProgress, async () => {
          const logs: string[] = [];
          for (const command of context.config.setup) {
            logs.push(await requiredShell(shellRunner, command, redactor));
          }
          return logs.join("\n");
        });
      } catch (error) {
        throw new RunFailureError("setup_failed", formatError(error));
      }
    }

    const runResult = await runImplementationLoop({
      context,
      store,
      shell: shellRunner,
      redactor,
      review,
      publish,
      onProgress,
    });

    onProgress({
      type: "run_finished",
      runId: runResult.runId,
      status: runResult.status,
      failureCode: runResult.failureCode,
      prUrl: runResult.prUrl,
    });
    return runResult;
  } catch (error) {
    const failureCode = failureCodeFromError(error);
    await writeFailureSummary(store, context.runId, error);
    await store.updateRunStatus(context.runId, {
      status: failureCode === "secret_guard_failed" ? "guard_failed" : "failed",
      failureCode,
      finishedAt: new Date(),
    });

    const runResult: RunCodexCageResult = {
      runId: context.runId,
      status: "failed",
      failureCode,
      prUrl: null,
    };

    onProgress({
      type: "run_finished",
      ...runResult,
    });

    return runResult;
  } finally {
    await cleanupRuntime(compose, sandbox);
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
  const secrets = normalizeRuntimeEnv(await readEnv(cwd));
  const issueOptions: Parameters<typeof fetchIssueContext>[1] = {
    comments: configResult.config.issue.comments,
  };

  if (secrets.GITHUB_TOKEN !== undefined) {
    issueOptions.githubToken = secrets.GITHUB_TOKEN;
  }

  if (secrets.LINEAR_API_KEY !== undefined) {
    issueOptions.linearApiKey = secrets.LINEAR_API_KEY;
  }

  const issue = await fetchContext(options.issueUrl, issueOptions);
  const repoInput: Parameters<typeof resolveTargetRepo>[0] = {
    issue,
    cwd,
  };

  if (options.repo !== undefined) {
    repoInput.explicitRepo = options.repo;
  }

  const repoResolution = await resolveRepo(repoInput);
  const authenticatedRepo = authenticateRepo(repoResolution.repo, secrets.GITHUB_TOKEN);
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
    warnings: configResult.runtimeImageWarnings,
  };
  const promptContext = await buildPromptContext(cwd);
  const codexAuthFilePath =
    secrets.OPENAI_API_KEY === undefined ? await locateCodexAuthFile() : null;

  return {
    cwd,
    config: configResult.config,
    configWarnings: configResult.warnings,
    runtimeImageWarnings: configResult.runtimeImageWarnings,
    secrets,
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
    codexAuthFilePath,
  };
}

async function readConfig(cwd: string): Promise<{
  config: CodexCageConfig;
  warnings: string[];
  runtimeImageWarnings: RuntimeImageWarning[];
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

function normalizeRuntimeEnv(env: Record<string, string>): Record<string, string> {
  const nonEmptyEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value.trim() !== ""),
  );

  if (nonEmptyEnv.GITHUB_TOKEN === undefined || nonEmptyEnv.GH_TOKEN !== undefined) {
    return nonEmptyEnv;
  }

  return {
    ...nonEmptyEnv,
    GH_TOKEN: nonEmptyEnv.GITHUB_TOKEN,
  };
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

async function runImplementationLoop(input: {
  context: RuntimeContext;
  store: RunStore;
  shell: ShellRunner;
  redactor: (input: string) => string;
  review: typeof runIndependentReview;
  publish: typeof publishSuccessfulRun;
  onProgress: (event: RunProgressEvent) => void;
}): Promise<RunCodexCageResult> {
  const feedback: string[] = [];
  let reviewCycle = 0;
  let guardAttempt = 0;
  let lastFailure: FailureCode = "verify_failed";

  for (
    let iteration = 1;
    iteration <= input.context.config.agent.max_iterations;
    iteration += 1
  ) {
    input.onProgress({
      type: "iteration_started",
      runId: input.context.runId,
      iteration,
      maxIterations: input.context.config.agent.max_iterations,
    });
    await input.store.updateRunStatus(input.context.runId, { status: "implementing" });
    await runPhase(
      input.store,
      input.context.runId,
      "implement",
      input.onProgress,
      async () => {
        const prompt = buildImplementationPrompt({
          context: input.context,
          iteration,
          feedback,
        });
        await input.store.writeArtifact(
          input.context.runId,
          `implementation-prompt-${iteration}.md`,
          input.redactor(prompt),
        );

        return await requiredShell(
          input.shell,
          codexExecCommand({
            model: input.context.model,
            sandbox: "workspace-write",
            prompt,
          }),
          input.redactor,
        );
      },
    );

    await input.store.updateRunStatus(input.context.runId, { status: "verifying" });
    const verification = await runVerificationCommands({
      store: input.store,
      runId: input.context.runId,
      shell: input.shell,
      commands: input.context.config.verify,
      redactor: input.redactor,
      onProgress: input.onProgress,
    });

    if (!verification.passed) {
      lastFailure = "verify_failed";
      feedback.push(verification.feedback);
      continue;
    }

    const diff = await readCurrentDiff(input.shell);
    const violations = scanDiffForGuardViolations(diff, {
      injectedSecrets: input.context.secrets,
    });

    try {
      assertNoGuardViolations(violations);
    } catch (error) {
      if (!(error instanceof GuardViolationError)) {
        throw error;
      }

      const decision = guardAttemptDecision({
        attempt: guardAttempt,
        maxAttempts: input.context.config.guards.max_secret_fix_attempts,
      });

      if (decision.action === "fail") {
        throw new RunFailureError("secret_guard_failed", error.message);
      }

      guardAttempt = decision.nextAttempt;
      lastFailure = "secret_guard_failed";
      feedback.push(`Secret guard violations must be fixed:\n${error.message}`);
      continue;
    }

    await input.store.updateRunStatus(input.context.runId, { status: "reviewing" });
    const reviewResult = await runPhase(
      input.store,
      input.context.runId,
      "review",
      input.onProgress,
      async () => {
        const reviewIssueContext = formatReviewIssueContext(input.context);
        const resultMetadata = {
          runId: input.context.runId,
          iteration,
          repo: input.context.repoResolution.repo.fullName,
        };
        const reviewPrompt = buildReviewPrompt({
          issueContext: reviewIssueContext,
          verificationSummary: verification.summary,
          resultMetadata,
          diff,
        });
        await input.store.writeArtifact(
          input.context.runId,
          `review-prompt-${reviewCycle}.md`,
          input.redactor(reviewPrompt),
        );
        const result = await input.review({
          cwd: input.context.cwd,
          model: input.context.model,
          cycle: reviewCycle,
          maxReviewCycles: input.context.config.agent.max_review_cycles,
          issueContext: reviewIssueContext,
          diff,
          verificationSummary: verification.summary,
          resultMetadata,
          readCurrentDiff: async () => await readCurrentDiff(input.shell),
          runner: reviewAgentRunner(input.shell),
          env: input.context.secrets,
        });

        await input.store.addReviewCycle({
          runId: input.context.runId,
          cycle: reviewCycle,
          decision: result.report.decision,
          reportPath: await input.store.writeArtifact(
            input.context.runId,
            `review-${reviewCycle}.json`,
            `${JSON.stringify(result.report, null, 2)}\n`,
          ),
        });

        return {
          log: input.redactor(JSON.stringify(result.report, null, 2)),
          value: result,
        };
      },
    );

    if (reviewResult.nextAction.action === "fix") {
      reviewCycle = reviewResult.nextAction.nextCycle;
      lastFailure = "review_blocking";
      feedback.push(
        `Independent review found blocking issues:\n${reviewResult.nextAction.feedback}`,
      );
      continue;
    }

    if (reviewResult.nextAction.action === "fail") {
      throw new RunFailureError("review_blocking", reviewResult.nextAction.feedback);
    }

    await input.store.updateRunStatus(input.context.runId, { status: "creating_pr" });
    const publishResult = await runPhase(
      input.store,
      input.context.runId,
      "pr",
      input.onProgress,
      async () => {
        let result;

        try {
          result = await input.publish({
            cwd: input.context.cwd,
            repo: input.context.repoResolution.repo,
            issue: input.context.issue,
            baseBranch: input.context.baseBranch,
            authorName: input.context.config.git.author_name,
            authorEmail: input.context.config.git.author_email,
            branchName: input.context.branchName,
            draft: input.context.draft,
            metadata: {
              runId: input.context.runId,
              summary: `Implemented ${input.context.issue.identifier}: ${input.context.issue.title}`,
              verification: verification.items,
              reviewStatus: "Independent review passed.",
              risks: [],
            },
            git: shellCommandRunner(input.shell, "git"),
            gh: shellCommandRunner(input.shell, "gh"),
          });
        } catch (error) {
          if (error instanceof NoDiffError) {
            throw error;
          }

          throw new RunFailureError("pr_failed", formatError(error));
        }

        return {
          log: input.redactor(JSON.stringify(result, null, 2)),
          value: result,
        };
      },
    );

    await writeJsonArtifact(input.store, input.context.runId, "pr.json", publishResult);
    await input.store.writeArtifact(
      input.context.runId,
      "final.patch",
      await readCurrentDiff(input.shell),
    );
    await input.store.writeArtifact(
      input.context.runId,
      "summary.md",
      `# ${input.context.runId}\n\nPR: ${publishResult.prUrl}\n`,
    );
    await input.store.updateRunStatus(input.context.runId, {
      status: "succeeded",
      prUrl: publishResult.prUrl,
      finishedAt: new Date(),
    });

    return {
      runId: input.context.runId,
      status: "succeeded",
      failureCode: null,
      prUrl: publishResult.prUrl,
    };
  }

  throw new RunFailureError(lastFailure, `Exceeded max_iterations without success.`);
}

async function runVerificationCommands(input: {
  store: RunStore;
  runId: string;
  shell: ShellRunner;
  commands: string[];
  redactor: (input: string) => string;
  onProgress: (event: RunProgressEvent) => void;
}): Promise<
  { passed: true; summary: string; items: string[] } | { passed: false; feedback: string }
> {
  const items: string[] = [];
  const logPath = input.store.artifactPath(input.runId, "verify.log");
  input.onProgress({
    type: "phase_started",
    runId: input.runId,
    phase: "verify",
    logPath,
  });
  const phase = await input.store.startPhase({
    runId: input.runId,
    name: "verify",
    logPath,
  });
  const logs: string[] = [];

  for (const command of input.commands) {
    const result = await input.shell.run(command);
    const log = formatCommandLog(command, result);
    logs.push(log);

    if (result.exitCode !== 0) {
      const redactedLog = input.redactor(logs.join("\n"));
      await input.store.writeArtifact(input.runId, "verify.log", redactedLog);
      await input.store.finishPhase({
        phaseId: phase.id,
        status: "failed",
        logPath,
      });
      input.onProgress({
        type: "phase_failed",
        runId: input.runId,
        phase: "verify",
        logPath,
      });
      return {
        passed: false,
        feedback: `Verification failed for command: ${command}\n${redactedLog}`,
      };
    }

    items.push(`\`${command}\` passed`);
  }

  const summary = input.redactor(logs.join("\n"));
  await input.store.writeArtifact(input.runId, "verify.log", summary);
  await input.store.finishPhase({
    phaseId: phase.id,
    status: "passed",
    logPath,
  });
  input.onProgress({
    type: "phase_passed",
    runId: input.runId,
    phase: "verify",
    logPath,
  });

  return {
    passed: true,
    summary,
    items,
  };
}

async function runPhase<TValue = undefined>(
  store: RunStore,
  runId: string,
  name: PhaseName,
  onProgress: (event: RunProgressEvent) => void,
  body: PhaseBody | (() => Promise<{ log: string; value: TValue }>),
): Promise<TValue> {
  const logPath = store.artifactPath(runId, `${name}.log`);
  onProgress({ type: "phase_started", runId, phase: name, logPath });
  const phase = await store.startPhase({ runId, name, logPath });

  try {
    const result = await body();
    const log = normalizePhaseLog(result);
    await store.writeArtifact(runId, `${name}.log`, log);
    await store.finishPhase({ phaseId: phase.id, status: "passed", logPath });
    onProgress({ type: "phase_passed", runId, phase: name, logPath });
    return extractPhaseValue(result);
  } catch (error) {
    await store.writeArtifact(runId, `${name}.log`, formatError(error));
    await store.finishPhase({ phaseId: phase.id, status: "failed", logPath });
    onProgress({ type: "phase_failed", runId, phase: name, logPath });
    throw error;
  }
}

function createDockerShellRunner(
  sandbox: DockerSandbox,
  env: Record<string, string>,
): ShellRunner {
  return {
    async run(command: string): Promise<CommandResult> {
      const result = await execa(
        "docker",
        dockerRunArgs({
          image: sandbox.image,
          networkName: sandbox.networkName,
          volumeName: sandbox.volumeName,
          workspacePath: sandbox.workspacePath,
          labels: { "codex-cage.run_id": sandbox.runId },
          env,
          codexAuthFilePath: sandbox.codexAuthFilePath ?? undefined,
          command,
        }),
        {
          env,
          reject: false,
        },
      );

      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

function shellCommandRunner(shell: ShellRunner, executable: string): CommandRunner {
  return {
    async run(args: string[]): Promise<CommandResult> {
      return await shell.run([executable, ...args].map(shellQuote).join(" "));
    },
  };
}

function reviewAgentRunner(shell: ShellRunner): ReviewAgentRunner {
  return {
    async run(input): Promise<string> {
      const outputSchemaPath = "/tmp/codex-cage-review-output-schema.json";
      const writeOutputSchemaCommand = `printf %s ${shellQuote(
        JSON.stringify(input.outputSchema),
      )} > ${shellQuote(outputSchemaPath)}`;

      const command = `${writeOutputSchemaCommand} && ${codexExecCommand({
        model: input.model,
        sandbox: "read-only",
        outputSchemaPath,
        prompt: input.prompt,
      })}`;
      const result = await shell.run(command);

      if (result.exitCode !== 0) {
        throw new Error(formatCommandLog(command, result));
      }

      return result.stdout;
    },
  };
}

async function requiredShell(
  shell: ShellRunner,
  command: string,
  redactor: (input: string) => string = (input) => input,
): Promise<string> {
  const result = await shell.run(command);
  const log = redactor(formatCommandLog(command, result));

  if (result.exitCode !== 0) {
    throw new Error(log);
  }

  return log;
}

async function readCurrentDiff(shell: ShellRunner): Promise<string> {
  const result = await shell.run(
    "git add --intent-to-add -- . && git diff --binary HEAD",
  );

  if (result.exitCode !== 0) {
    throw new Error(formatCommandLog("git diff", result));
  }

  return result.stdout;
}

function buildImplementationPrompt(input: {
  context: RuntimeContext;
  iteration: number;
  feedback: string[];
}): string {
  const feedback =
    input.feedback.length === 0
      ? "No prior feedback."
      : input.feedback.map((item, index) => `${index + 1}. ${item}`).join("\n\n");

  return `Implement the issue below inside the current repository.

Rules:
- Work only in this repository.
- Do not commit, push, create pull requests, or write secrets.
- Run only commands needed to implement the issue; Codex Cage will run verification separately.
- If the issue lacks enough detail to implement safely, stop and explain the blocker.

Iteration: ${input.iteration}
Repository: ${input.context.repoResolution.repo.fullName}
Base branch: ${input.context.baseBranch}

${formatInstructionsForPrompt(input.context.promptContext)}

Issue:
${formatIssueContext(input.context.issue)}

Feedback to address:
${feedback}
`;
}

function formatReviewIssueContext(context: RuntimeContext): string {
  return `${formatInstructionsForPrompt(context.promptContext)}

Issue:
${formatIssueContext(context.issue)}`;
}

function formatIssueContext(issue: IssueContext): string {
  const comments =
    issue.comments.length === 0
      ? "No human comments included."
      : issue.comments
          .map((comment) => {
            const createdAt =
              comment.createdAt === null ? "" : ` at ${comment.createdAt}`;
            return `- ${comment.author}${createdAt}: ${comment.body}`;
          })
          .join("\n");

  return `URL: ${issue.url}
Identifier: ${issue.identifier}
Title: ${issue.title}

Body:
${issue.body}

Comments:
${comments}
`;
}

function codexExecCommand(input: {
  model: string;
  sandbox: "read-only" | "workspace-write";
  outputSchemaPath?: string | undefined;
  prompt: string;
}): string {
  const args = [
    "codex exec",
    "--model",
    shellQuote(input.model),
    "--sandbox",
    shellQuote(input.sandbox),
  ];

  if (input.outputSchemaPath !== undefined) {
    args.push("--output-schema", shellQuote(input.outputSchemaPath));
  }

  args.push(shellQuote(input.prompt));

  return args.join(" ");
}

function generateRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);

  return `run-${timestamp}-${random}`;
}

function failureCodeFromError(error: unknown): FailureCode {
  if (error instanceof RunFailureError) {
    return error.failureCode;
  }

  if (error instanceof NoDiffError) {
    return "no_diff";
  }

  if (error instanceof ReviewModifiedDiffError) {
    return "review_blocking";
  }

  return "internal_error";
}

class RunFailureError extends Error {
  readonly failureCode: FailureCode;

  constructor(failureCode: FailureCode, message: string) {
    super(message);
    this.name = "RunFailureError";
    this.failureCode = failureCode;
  }
}

async function cleanupRuntime(
  compose: ComposeProject | null,
  sandbox: DockerSandbox | null,
): Promise<void> {
  const errors: string[] = [];

  if (compose !== null) {
    try {
      await compose.down();
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  if (sandbox !== null) {
    try {
      await sandbox.cleanup();
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  if (errors.length > 0) {
    console.error(`Cleanup failed:\n${errors.join("\n")}`);
  }
}

async function writeJsonArtifact(
  store: RunStore,
  runId: string,
  name: string,
  value: unknown,
): Promise<void> {
  await store.writeArtifact(runId, name, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePromptContextArtifacts(
  store: RunStore,
  context: RuntimeContext,
): Promise<void> {
  await writeJsonArtifact(store, context.runId, "prompt-context.json", {
    instructionFiles: context.promptContext.instructionFiles,
    limitBytes: context.promptContext.limitBytes,
    truncated: context.promptContext.truncated,
  });

  if (context.promptContext.instructions !== "") {
    await store.writeArtifact(
      context.runId,
      "instructions.md",
      context.promptContext.instructions,
    );
  }
}

async function writeFailureSummary(
  store: RunStore,
  runId: string,
  error: unknown,
): Promise<void> {
  await store.writeArtifact(
    runId,
    "summary.md",
    `# ${runId}\n\nFailure:\n\n\`\`\`\n${formatError(error)}\n\`\`\`\n`,
  );
}

function formatCommandLog(command: string, result: CommandResult): string {
  return [
    `$ ${command}`,
    `exit code: ${result.exitCode}`,
    result.stdout.trim() === "" ? "" : `stdout:\n${result.stdout}`,
    result.stderr.trim() === "" ? "" : `stderr:\n${result.stderr}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function normalizePhaseLog(
  result: Awaited<ReturnType<PhaseBody>> | { log: string },
): string {
  if (typeof result === "object" && result !== null && "log" in result) {
    return result.log;
  }

  return result ?? "";
}

function extractPhaseValue<TValue>(
  result: Awaited<ReturnType<PhaseBody>> | { log: string; value: TValue },
): TValue {
  if (typeof result === "object" && result !== null && "value" in result) {
    return result.value;
  }

  return undefined as TValue;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
