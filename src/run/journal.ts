import type { PublishSuccessfulRunResult } from "../publish.js";
import type { ReviewReport } from "../review.js";
import type { RunProgressEvent, RuntimeContext } from "../run-workflow.js";
import type { ShellRunner } from "../sandbox-execution.js";
import type { FailureCode, PhaseName, RunStatus, RunStore } from "../state.js";
import {
  phaseToCanonicalStage,
  runEventJournalFileName,
  RunEventJournal,
  type CanonicalStage,
  type RunEvent,
  type RunEventSink,
} from "./events.js";

type PhaseBody = () => Promise<string | undefined>;

type ActiveStage = {
  stage: CanonicalStage;
  attempt: number;
};

type ActiveActivity = {
  phase: PhaseName;
  logPath: string;
};

export class RunJournal {
  readonly #store: RunStore;
  readonly #context: RuntimeContext;
  readonly #redact: (value: string) => string;
  readonly #events: RunEventJournal;
  readonly #stageAttempts: Record<CanonicalStage, number> = {
    prepare: 0,
    implement: 0,
    verify: 0,
    review: 0,
    publish: 0,
  };

  #activeStage: ActiveStage | null = null;
  #activeActivity: ActiveActivity | null = null;

  constructor(
    store: RunStore,
    context: RuntimeContext,
    onProgress: (event: RunProgressEvent) => void,
    onEvent?: RunEventSink | undefined,
  ) {
    this.#store = store;
    this.#context = context;
    this.#redact = context.credentials.redactor();
    this.#events = new RunEventJournal({
      runId: context.runId,
      path: store.artifactPath(context.runId, runEventJournalFileName),
      redact: this.#redact,
      sink: async (event) => {
        const deliveryErrors: unknown[] = [];
        const progressEvent = progressEventFromRunEvent(event);
        if (progressEvent !== null) {
          try {
            onProgress(progressEvent);
          } catch (error) {
            deliveryErrors.push(error);
          }
        }

        try {
          await onEvent?.(event);
        } catch (error) {
          deliveryErrors.push(error);
        }

        if (deliveryErrors.length > 0) {
          throw new AggregateError(deliveryErrors, "Run event observer delivery failed.");
        }
      },
    });
  }

  async startRun(): Promise<void> {
    await this.#store.createRun({
      id: this.#context.runId,
      issueUrl: this.#context.issue.url,
      issueKey: this.#context.issue.identifier,
      repo: this.#context.repoResolution.repo.fullName,
      baseBranch: this.#context.baseBranch,
      branch: this.#context.branchName,
    });
    await this.#events.append({
      type: "run.started",
      payload: {
        issueKey: this.#context.issue.identifier,
        issueTitle: this.#context.issue.title,
        repository: this.#context.repoResolution.repo.fullName,
        baseBranch: this.#context.baseBranch,
        branch: this.#context.branchName,
        artifactDirectory: this.#store.runDirectory(this.#context.runId),
        executionMode: this.#context.executionMode,
      },
    });
  }

  async startStage(stage: CanonicalStage): Promise<void> {
    if (this.#activeStage !== null) {
      throw new Error(
        `Cannot start ${stage} while ${this.#activeStage.stage} Stage Attempt ${this.#activeStage.attempt} is running.`,
      );
    }

    const attempt = this.#stageAttempts[stage] + 1;
    this.#stageAttempts[stage] = attempt;
    this.#activeStage = { stage, attempt };
    await this.#events.append({
      type: "stage.started",
      stage,
      stageAttempt: attempt,
      payload: {},
    });
  }

  async finishStage(): Promise<void> {
    const active = this.#requireActiveStage();
    this.#assertNoActiveActivity();
    await this.#events.append({
      type: "stage.finished",
      stage: active.stage,
      stageAttempt: active.attempt,
      payload: {},
    });
    this.#activeStage = null;
  }

  async failStage(failureCode: FailureCode): Promise<void> {
    const active = this.#requireActiveStage();
    await this.#events.append({
      type: "stage.failed",
      stage: active.stage,
      stageAttempt: active.attempt,
      payload: { failureCode },
    });
    this.#activeActivity = null;
    this.#activeStage = null;
  }

  async setRunStatus(status: RunStatus): Promise<void> {
    await this.#store.updateRunStatus(this.#context.runId, { status });
  }

  async iterationStarted(iteration: number, maxIterations: number): Promise<void> {
    const active = this.#requireActiveStage("implement");
    await this.#events.append({
      type: "implementation.iteration_started",
      stage: "implement",
      stageAttempt: active.attempt,
      payload: { iteration, maxIterations },
    });
  }

  async recordFailure(failureCode: FailureCode, error: unknown): Promise<void> {
    await this.writeArtifact(
      "summary.md",
      `# ${this.#context.runId}\n\nFailure:\n\n\`\`\`\n${formatError(error)}\n\`\`\`\n`,
    );

    if (this.#activeStage !== null) {
      await this.failStage(failureCode);
    }

    await this.#store.updateRunStatus(this.#context.runId, {
      status: failureCode === "secret_guard_failed" ? "guard_failed" : "failed",
      failureCode,
      finishedAt: new Date(),
    });
    await this.#events.append({
      type: "run.finished",
      payload: {
        status: "failed",
        failureCode,
        prUrl: null,
      },
    });
  }

  async recordSuccess(result: PublishSuccessfulRunResult): Promise<void> {
    await this.writeArtifact(
      "summary.md",
      `# ${this.#context.runId}\n\nPR: ${result.prUrl}\n`,
    );
    await this.#store.updateRunStatus(this.#context.runId, {
      status: "succeeded",
      prUrl: result.prUrl,
      finishedAt: new Date(),
    });
    const active = this.#requireActiveStage("publish");
    await this.#events.append({
      type: "change.created",
      stage: "publish",
      stageAttempt: active.attempt,
      payload: {
        branch: result.branchName,
        commitMessage: result.commitMessage,
        title: result.prTitle,
        url: result.prUrl,
        metadataRef: this.artifactPath("pr.json"),
      },
    });
    await this.finishStage();
    await this.#events.append({
      type: "run.finished",
      payload: {
        status: "succeeded",
        failureCode: null,
        prUrl: result.prUrl,
      },
    });
  }

  async addReviewCycle(input: {
    cycle: number;
    decision: ReviewReport["decision"];
    report: ReviewReport;
  }): Promise<void> {
    const reportPath = await this.writeArtifact(
      `review-${input.cycle}.json`,
      `${JSON.stringify(input.report, null, 2)}\n`,
    );

    await this.#store.addReviewCycle({
      runId: this.#context.runId,
      cycle: input.cycle,
      decision: input.decision,
      reportPath,
    });
    const active = this.#requireActiveStage("review");
    await this.#events.append({
      type: "review.finished",
      stage: "review",
      stageAttempt: active.attempt,
      payload: {
        cycle: input.cycle,
        decision: input.decision,
        summary: input.report.summary,
        findingCount: input.report.findings.length,
        reportRef: reportPath,
      },
    });
  }

  async recordVerificationCommands(input: {
    status: "passed" | "failed";
    commandCount: number;
    passedCount: number;
    logRef: string;
  }): Promise<void> {
    const active = this.#requireActiveStage("verify");
    await this.#events.append({
      type: "verification.updated",
      stage: "verify",
      stageAttempt: active.attempt,
      payload: {
        kind: "commands",
        status: input.status,
        commandCount: input.commandCount,
        passedCount: input.passedCount,
        logRef: input.logRef,
      },
    });
  }

  async recordSecretGuard(
    input:
      | { status: "passed"; retryable: false }
      | { status: "failed"; retryable: boolean },
  ): Promise<void> {
    const active = this.#requireActiveStage("verify");
    await this.#events.append({
      type: "verification.updated",
      stage: "verify",
      stageAttempt: active.attempt,
      payload: {
        kind: "secret_guard",
        ...input,
      },
    });
  }

  async writeArtifact(name: string, content: string): Promise<string> {
    const path = await this.#store.writeArtifact(
      this.#context.runId,
      name,
      this.#redact(content),
    );
    const active = this.#activeStage;
    await this.#events.append({
      type: "artifact.created",
      stage: active?.stage ?? null,
      stageAttempt: active?.attempt ?? null,
      payload: {
        name,
        kind: artifactKind(name),
        artifactRef: path,
      },
    });
    return path;
  }

  async writeJsonArtifact(name: string, value: unknown): Promise<void> {
    await this.writeArtifact(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writePromptContextArtifact(): Promise<void> {
    await this.writeJsonArtifact("prompt-context.json", {
      reviewPolicy: this.#context.promptContext.reviewPolicy,
    });
  }

  artifactPath(name: string): string {
    return this.#store.artifactPath(this.#context.runId, name);
  }

  instrumentShell(shell: ShellRunner): ShellRunner {
    return {
      run: async (command, options) => {
        const active = this.#requireActiveStage();
        const commandName = summarizeCommand(command);
        const logRef = this.#activeActivity?.logPath ?? null;
        const startedEvent = await this.#events.append({
          type: "command.started",
          stage: active.stage,
          stageAttempt: active.attempt,
          payload: { command: commandName, logRef },
        });

        try {
          const result = await shell.run(command, options);
          const completion =
            result.exitCode === 0
              ? ({ outcome: "succeeded", exitCode: 0 } as const)
              : result.exitCode === 124
                ? ({ outcome: "timed_out", exitCode: 124 } as const)
                : ({ outcome: "failed", exitCode: result.exitCode } as const);
          await this.#events.append({
            type: "command.finished",
            stage: active.stage,
            stageAttempt: active.attempt,
            payload: {
              startedEventId: startedEvent.eventId,
              command: commandName,
              logRef,
              ...completion,
            },
          });
          return result;
        } catch (error) {
          await this.#events.append({
            type: "command.finished",
            stage: active.stage,
            stageAttempt: active.attempt,
            payload: {
              startedEventId: startedEvent.eventId,
              command: commandName,
              outcome: "failed",
              exitCode: null,
              logRef,
            },
          });
          throw error;
        }
      },
    };
  }

  async startPhase(name: PhaseName): Promise<RunJournalPhase> {
    const stage = phaseToCanonicalStage(name);
    const active = this.#requireActiveStage(stage);
    this.#assertNoActiveActivity();
    const logPath = this.artifactPath(`${name}.log`);
    const phase = await this.#store.startPhase({
      runId: this.#context.runId,
      name,
      logPath,
    });
    await this.#events.append({
      type: "activity.started",
      stage,
      stageAttempt: active.attempt,
      payload: { activity: name, logRef: logPath },
    });
    this.#activeActivity = { phase: name, logPath };

    return new RunJournalPhase({
      logPath,
      finish: async (status, log) => {
        const currentStage = this.#requireActiveStage(stage);
        const activity = this.#activeActivity;
        if (activity === null || activity.phase !== name) {
          throw new Error(`Activity ${name} is not running.`);
        }

        await this.writeArtifact(`${name}.log`, log);
        await this.#store.finishPhase({
          phaseId: phase.id,
          status,
          logPath,
        });
        await this.#events.append({
          type: status === "passed" ? "activity.finished" : "activity.failed",
          stage,
          stageAttempt: currentStage.attempt,
          payload: { activity: name, logRef: logPath },
        });
        this.#activeActivity = null;
      },
    });
  }

  async runPhase<TValue = undefined>(
    name: PhaseName,
    body: PhaseBody | (() => Promise<{ log: string; value: TValue }>),
  ): Promise<TValue> {
    const phase = await this.startPhase(name);

    try {
      const result = await body();
      await phase.pass(normalizePhaseLog(result));
      return extractPhaseValue(result);
    } catch (error) {
      await phase.fail(formatError(error));
      throw error;
    }
  }

  #requireActiveStage(expected?: CanonicalStage): ActiveStage {
    const active = this.#activeStage;
    if (active === null) {
      throw new Error("No canonical Stage Attempt is running.");
    }

    if (expected !== undefined && active.stage !== expected) {
      throw new Error(
        `Expected ${expected} Stage, found ${active.stage} Stage Attempt ${active.attempt}.`,
      );
    }

    return active;
  }

  #assertNoActiveActivity(): void {
    if (this.#activeActivity !== null) {
      throw new Error(`Activity ${this.#activeActivity.phase} is still running.`);
    }
  }
}

class RunJournalPhase {
  readonly logPath: string;

  readonly #finish: (status: "passed" | "failed", log: string) => Promise<void>;
  #finished = false;

  constructor(input: {
    logPath: string;
    finish: (status: "passed" | "failed", log: string) => Promise<void>;
  }) {
    this.logPath = input.logPath;
    this.#finish = input.finish;
  }

  async pass(log: string): Promise<void> {
    await this.finish("passed", log);
  }

  async fail(log: string): Promise<void> {
    await this.finish("failed", log);
  }

  private async finish(status: "passed" | "failed", log: string): Promise<void> {
    if (this.#finished) {
      throw new Error("Run activity has already finished.");
    }

    await this.#finish(status, log);
    this.#finished = true;
  }
}

function progressEventFromRunEvent(event: RunEvent): RunProgressEvent | null {
  switch (event.type) {
    case "run.started":
      return {
        type: "run_started",
        runId: event.runId,
        issueKey: event.payload.issueKey,
        issueTitle: event.payload.issueTitle,
        repo: event.payload.repository,
        branch: event.payload.branch,
        artifactDir: event.payload.artifactDirectory,
      };
    case "activity.started":
      return {
        type: "phase_started",
        runId: event.runId,
        phase: event.payload.activity,
        logPath: event.payload.logRef,
      };
    case "activity.finished":
      return {
        type: "phase_passed",
        runId: event.runId,
        phase: event.payload.activity,
        logPath: event.payload.logRef,
      };
    case "activity.failed":
      return {
        type: "phase_failed",
        runId: event.runId,
        phase: event.payload.activity,
        logPath: event.payload.logRef,
      };
    case "implementation.iteration_started":
      return {
        type: "iteration_started",
        runId: event.runId,
        iteration: event.payload.iteration,
        maxIterations: event.payload.maxIterations,
      };
    case "run.finished":
      return {
        type: "run_finished",
        runId: event.runId,
        status: event.payload.status,
        failureCode: event.payload.failureCode,
        prUrl: event.payload.prUrl,
      };
    case "stage.started":
    case "stage.finished":
    case "stage.failed":
    case "command.started":
    case "command.finished":
    case "verification.updated":
    case "review.finished":
    case "artifact.created":
    case "change.created":
      return null;
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}

function artifactKind(name: string): "json" | "log" | "markdown" | "patch" | "other" {
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".log")) return "log";
  if (name.endsWith(".md")) return "markdown";
  if (name.endsWith(".patch")) return "patch";
  return "other";
}

function summarizeCommand(command: string): string {
  if (command.includes("codex exec")) {
    return "codex exec";
  }

  const toolCommand = command.match(/^'(git|gh)'\s+'([^']+)'/);
  if (toolCommand?.[1] !== undefined && toolCommand[2] !== undefined) {
    return `${toolCommand[1]} ${toolCommand[2]}`;
  }

  return command.replaceAll(/\s+/g, " ").trim();
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
