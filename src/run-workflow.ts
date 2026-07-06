import { resolve } from "node:path";
import {
  createComposeProject,
  hasComposeServices,
  type ComposeProject,
} from "./compose.js";
import type { CodexCageConfig, ExecutionMode } from "./config.js";
import type { CommandCredentialIntent, RunCredentials } from "./credentials.js";
import {
  buildRuntimeImage,
  createDockerSandbox,
  unauthenticatedRemoteUrl,
  type DockerCommandOptions,
  type DockerSandbox,
  type DockerSandboxOptions,
  type RuntimeImageBuildResult,
} from "./docker.js";
import type { IssueContext } from "./issue.js";
import { NoDiffError, publishSuccessfulRun } from "./publish.js";
import type { PromptContext } from "./prompt-context.js";
import type { AuthenticatedRepo, RepoResolution } from "./repo.js";
import { runIndependentReview, ReviewModifiedDiffError } from "./review.js";
import { RunFailureError } from "./run/errors.js";
import {
  runPublishGate,
  runReviewGate,
  runSecretGuardGate,
  type VerificationResult,
} from "./run/gates.js";
import { RunJournal } from "./run/journal.js";
import { buildImplementationPrompt } from "./run/prompts.js";
import {
  codexExecCommand,
  createDockerShellRunner,
  createHostShellRunner,
  createHostWorkspace,
  createLineStreamSink,
  formatCommandLog,
  readCurrentDiff,
  requiredShell,
  shellQuote,
  type HostWorkspace,
  type ShellRunner,
  type StreamSink,
} from "./sandbox-execution.js";
import type { FailureCode, PhaseName, RunStore } from "./state.js";

export type { ShellRunner } from "./sandbox-execution.js";

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

export type RuntimeContext = {
  cwd: string;
  config: CodexCageConfig;
  configWarnings: string[];
  credentials: RunCredentials;
  issue: IssueContext;
  repoResolution: RepoResolution;
  authenticatedRepo: AuthenticatedRepo;
  baseBranch: string;
  model: string;
  draft: boolean;
  runId: string;
  branchName: string;
  runtimeImage: RuntimeImageBuildResult & { source: "configured" | "built" };
  promptContext: PromptContext;
  executionMode: ExecutionMode;
  verbose: boolean;
};

export type RunWorkflowInput = {
  context: RuntimeContext;
  store: RunStore;
  createDockerSandbox?: (options: DockerSandboxOptions) => DockerSandbox;
  buildRuntimeImage?: typeof buildRuntimeImage;
  createShellRunner?: (
    sandbox: DockerSandbox,
    env: Record<string, string>,
    sink?: StreamSink,
  ) => ShellRunner;
  createHostWorkspace?: typeof createHostWorkspace;
  createHostShellRunner?: typeof createHostShellRunner;
  createComposeProject?: typeof createComposeProject;
  runIndependentReview?: typeof runIndependentReview;
  publishSuccessfulRun?: typeof publishSuccessfulRun;
  onProgress?: (event: RunProgressEvent) => void;
};

export async function runWorkflow(input: RunWorkflowInput): Promise<RunCodexCageResult> {
  const context = input.context;
  const createSandbox = input.createDockerSandbox ?? createDockerSandbox;
  const buildImage = input.buildRuntimeImage ?? buildRuntimeImage;
  const makeShellRunner = input.createShellRunner ?? createDockerShellRunner;
  const makeHostWorkspace = input.createHostWorkspace ?? createHostWorkspace;
  const makeHostShellRunner = input.createHostShellRunner ?? createHostShellRunner;
  const makeComposeProject = input.createComposeProject ?? createComposeProject;
  const review = input.runIndependentReview ?? runIndependentReview;
  const publish = input.publishSuccessfulRun ?? publishSuccessfulRun;
  const onProgress = input.onProgress ?? (() => undefined);
  const journal = new RunJournal(input.store, context, onProgress);
  const redactor = context.credentials.redactor();
  // In verbose mode, stream redacted command output to stdout so progress is
  // visible live (locally and, crucially, in CI logs where files are not).
  const streamSink = context.verbose
    ? createLineStreamSink((line) => process.stdout.write(line), redactor)
    : undefined;
  let sandbox: DockerSandbox | null = null;
  let shell: ShellRunner | null = null;
  let compose: ComposeProject | null = null;
  let hostWorkspace: HostWorkspace | null = null;

  try {
    await journal.startRun();
    await journal.writeJsonArtifact("issue.json", context.issue);
    await journal.writePromptContextArtifact();
    await journal.writeJsonArtifact("resolved-config.json", {
      config: context.config,
      warnings: context.configWarnings,
      repoSource: context.repoResolution.source,
      runtimeImage: context.runtimeImage,
    });

    await journal.runPhase("preflight", async () => {
      return [
        `Issue: ${context.issue.identifier} ${context.issue.title}`,
        `Repo: ${context.repoResolution.repo.fullName}`,
        `Base: ${context.baseBranch}`,
        `Branch: ${context.branchName}`,
      ].join("\n");
    });

    if (context.executionMode === "direct") {
      shell = await provisionDirectWorkspace({
        context,
        journal,
        redactor,
        sink: streamSink,
        createHostWorkspace: makeHostWorkspace,
        createHostShellRunner: makeHostShellRunner,
        registerWorkspace: (workspace) => {
          hostWorkspace = workspace;
        },
      });
    } else {
      const provisioned = await provisionDockerSandbox({
        context,
        journal,
        redactor,
        sink: streamSink,
        createSandbox,
        buildImage,
        makeShellRunner,
        makeComposeProject,
        registerCompose: (project) => {
          compose = project;
        },
        registerSandbox: (created) => {
          sandbox = created;
        },
      });
      shell = provisioned;
    }

    const shellRunner = shell;

    if (context.config.setup.length > 0) {
      await journal.setRunStatus("setup");
      try {
        await journal.runPhase("setup", async () => {
          const logs: string[] = [];
          for (const command of context.config.setup) {
            logs.push(
              await requiredShell(
                shellRunner,
                command,
                redactor,
                runtimeCommandCredentials("setup", context),
              ),
            );
          }
          return logs.join("\n");
        });
      } catch (error) {
        throw new RunFailureError("setup_failed", formatError(error));
      }
    }

    const runResult = await runImplementationLoop({
      context,
      journal,
      shell: shellRunner,
      redactor,
      review,
      publish,
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
    await journal.recordFailure(failureCode, error);

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
    await cleanupRuntime(compose, sandbox, hostWorkspace);
  }
}

async function provisionDockerSandbox(input: {
  context: RuntimeContext;
  journal: RunJournal;
  redactor: (value: string) => string;
  sink: StreamSink | undefined;
  createSandbox: (options: DockerSandboxOptions) => DockerSandbox;
  buildImage: typeof buildRuntimeImage;
  makeShellRunner: (
    sandbox: DockerSandbox,
    env: Record<string, string>,
    sink?: StreamSink,
  ) => ShellRunner;
  makeComposeProject: typeof createComposeProject;
  registerCompose: (project: ComposeProject) => void;
  registerSandbox: (sandbox: DockerSandbox) => void;
}): Promise<ShellRunner> {
  const { context, journal, redactor } = input;
  const runtimeDockerfile = context.config.runtime.dockerfile;

  if (runtimeDockerfile !== null) {
    try {
      context.runtimeImage = await journal.runPhase("runtime_image", async () => {
        const result = await input.buildImage({
          runId: context.runId,
          dockerfilePath: resolve(context.cwd, runtimeDockerfile),
          contextPath: resolve(context.cwd, ".codex-cage"),
        });

        return {
          log: [
            `Built runtime image: ${result.image}`,
            `Dockerfile: ${result.dockerfilePath}`,
            `Build context: ${result.contextPath}`,
          ].join("\n"),
          value: { ...result, source: "built" as const },
        };
      });
    } catch (error) {
      throw new RunFailureError("runtime_image_failed", formatError(error));
    }
  }

  await journal.writeJsonArtifact("runtime-image.json", context.runtimeImage);

  let compose: ComposeProject | null = null;

  if (hasComposeServices(context.config.services)) {
    const composeFile = context.config.services.compose;

    if (composeFile === null) {
      throw new RunFailureError("invalid_config", "Compose file is not configured.");
    }

    compose = input.makeComposeProject({
      runId: context.runId,
      composeFile: resolve(context.cwd, composeFile),
      projectDirectory: context.cwd,
      readyCommands: context.config.services.ready,
    });
    input.registerCompose(compose);
    try {
      await journal.runPhase("setup", async () => {
        await compose?.up();
        await compose?.waitUntilReady();
        return "Compose services are ready.";
      });
    } catch (error) {
      throw new RunFailureError("setup_failed", formatError(error));
    }
  }

  const cloneCredentials = runtimeCommandCredentials("clone", context);
  const sandboxOptions: DockerSandboxOptions = {
    runId: context.runId,
    cloneUrl: context.authenticatedRepo.cloneUrl,
    image: context.runtimeImage.image,
    env: cloneCredentials.env ?? {},
  };

  if (compose !== null) {
    sandboxOptions.serviceNetworkName = compose.networkName;
  }

  const sandbox = input.createSandbox(sandboxOptions);
  input.registerSandbox(sandbox);
  const shell = input.makeShellRunner(sandbox, {}, input.sink);

  await journal.setRunStatus("cloning");
  await journal.runPhase("cloning", async () => {
    await sandbox.create();
    await sandbox.cloneRepository();
    return await requiredShell(
      shell,
      `git fetch origin ${shellQuote(context.baseBranch)} && git checkout ${shellQuote(
        context.baseBranch,
      )} && git pull --ff-only origin ${shellQuote(context.baseBranch)}`,
      redactor,
      cloneCredentials,
    );
  });

  return shell;
}

async function provisionDirectWorkspace(input: {
  context: RuntimeContext;
  journal: RunJournal;
  redactor: (value: string) => string;
  sink: StreamSink | undefined;
  createHostWorkspace: typeof createHostWorkspace;
  createHostShellRunner: typeof createHostShellRunner;
  registerWorkspace: (workspace: HostWorkspace) => void;
}): Promise<ShellRunner> {
  const { context, journal, redactor } = input;

  await journal.writeJsonArtifact("runtime-image.json", context.runtimeImage);

  const cloneCredentials = runtimeCommandCredentials("clone", context);
  const workspace = await input.createHostWorkspace(context.runId);
  input.registerWorkspace(workspace);
  const shell = input.createHostShellRunner(workspace.workspacePath, {}, input.sink);

  await journal.setRunStatus("cloning");
  await journal.runPhase("cloning", async () => {
    const remoteUrl = unauthenticatedRemoteUrl(context.authenticatedRepo.cloneUrl);
    await requiredShell(
      shell,
      `git clone ${shellQuote(remoteUrl)} . && git remote set-url origin ${shellQuote(
        remoteUrl,
      )}`,
      redactor,
      cloneCredentials,
    );
    return await requiredShell(
      shell,
      `git fetch origin ${shellQuote(context.baseBranch)} && git checkout ${shellQuote(
        context.baseBranch,
      )} && git pull --ff-only origin ${shellQuote(context.baseBranch)}`,
      redactor,
      cloneCredentials,
    );
  });

  return shell;
}

function runtimeCommandCredentials(
  intent: CommandCredentialIntent,
  context: RuntimeContext,
): DockerCommandOptions {
  return context.credentials.command(intent);
}

async function runImplementationLoop(input: {
  context: RuntimeContext;
  journal: RunJournal;
  shell: ShellRunner;
  redactor: (input: string) => string;
  review: typeof runIndependentReview;
  publish: typeof publishSuccessfulRun;
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
    input.journal.iterationStarted(iteration, input.context.config.agent.max_iterations);
    await input.journal.setRunStatus("implementing");
    await input.journal.runPhase("implement", async () => {
      const prompt = buildImplementationPrompt({
        context: input.context,
        iteration,
        feedback,
      });
      await input.journal.writeArtifact(
        `implementation-prompt-${iteration}.md`,
        input.redactor(prompt),
      );

      return await requiredShell(
        input.shell,
        codexExecCommand({
          model: input.context.model,
          sandbox: "workspace-write",
          prompt,
          bypassSandbox: input.context.executionMode === "direct",
        }),
        input.redactor,
        runtimeCommandCredentials("implement", input.context),
      );
    });

    await input.journal.setRunStatus("verifying");
    const verification = await runVerificationCommands({
      journal: input.journal,
      shell: input.shell,
      commands: input.context.config.verify,
      redactor: input.redactor,
      commandOptions: runtimeCommandCredentials("verify", input.context),
    });

    if (!verification.passed) {
      lastFailure = "verify_failed";
      feedback.push(verification.feedback);
      continue;
    }

    const diff = await readCurrentDiff(input.shell);
    const secretGuard = runSecretGuardGate({
      context: input.context,
      diff,
      guardAttempt,
    });

    if (secretGuard.action === "retry") {
      guardAttempt = secretGuard.guardAttempt;
      lastFailure = secretGuard.lastFailure;
      feedback.push(secretGuard.feedback);
      continue;
    }

    const reviewAction = await runReviewGate({
      context: input.context,
      journal: input.journal,
      shell: input.shell,
      redactor: input.redactor,
      review: input.review,
      diff,
      verification,
      iteration,
      reviewCycle,
    });

    if (reviewAction.action === "fix") {
      reviewCycle = reviewAction.nextCycle;
      lastFailure = "review_blocking";
      feedback.push(
        `Independent review found blocking issues:\n${reviewAction.feedback}`,
      );
      continue;
    }

    if (reviewAction.action === "fail") {
      throw new RunFailureError("review_blocking", reviewAction.feedback);
    }

    const publishResult = await runPublishGate({
      context: input.context,
      journal: input.journal,
      shell: input.shell,
      redactor: input.redactor,
      publish: input.publish,
      verification,
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
  journal: RunJournal;
  shell: ShellRunner;
  commands: string[];
  redactor: (input: string) => string;
  commandOptions?: DockerCommandOptions | undefined;
}): Promise<VerificationResult> {
  const items: string[] = [];
  const phase = await input.journal.startPhase("verify");
  const logs: string[] = [];

  for (const command of input.commands) {
    const result = await input.shell.run(command, input.commandOptions);
    const log = formatCommandLog(command, result);
    logs.push(log);

    if (result.exitCode !== 0) {
      const redactedLog = input.redactor(logs.join("\n"));
      await phase.fail(redactedLog);
      return {
        passed: false,
        feedback: `Verification failed for command: ${command}\n${redactedLog}`,
      };
    }

    items.push(`\`${command}\` passed`);
  }

  const summary = input.redactor(logs.join("\n"));
  await phase.pass(summary);

  return {
    passed: true,
    summary,
    items,
  };
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

async function cleanupRuntime(
  compose: ComposeProject | null,
  sandbox: DockerSandbox | null,
  hostWorkspace: HostWorkspace | null,
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

  if (hostWorkspace !== null) {
    try {
      await hostWorkspace.cleanup();
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  if (errors.length > 0) {
    console.error(`Cleanup failed:\n${errors.join("\n")}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
