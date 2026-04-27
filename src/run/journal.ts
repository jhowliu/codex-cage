import type { RunProgressEvent, RuntimeContext } from "../run-workflow.js";
import type {
  FailureCode,
  PhaseName,
  ReviewDecision,
  RunStatus,
  RunStore,
} from "../state.js";

type PhaseBody = () => Promise<string | undefined>;

export class RunJournal {
  readonly #store: RunStore;
  readonly #context: RuntimeContext;
  readonly #onProgress: (event: RunProgressEvent) => void;

  constructor(
    store: RunStore,
    context: RuntimeContext,
    onProgress: (event: RunProgressEvent) => void,
  ) {
    this.#store = store;
    this.#context = context;
    this.#onProgress = onProgress;
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
    this.#onProgress({
      type: "run_started",
      runId: this.#context.runId,
      issueKey: this.#context.issue.identifier,
      issueTitle: this.#context.issue.title,
      repo: this.#context.repoResolution.repo.fullName,
      branch: this.#context.branchName,
      artifactDir: this.#store.runDirectory(this.#context.runId),
    });
  }

  async setRunStatus(status: RunStatus): Promise<void> {
    await this.#store.updateRunStatus(this.#context.runId, { status });
  }

  iterationStarted(iteration: number, maxIterations: number): void {
    this.#onProgress({
      type: "iteration_started",
      runId: this.#context.runId,
      iteration,
      maxIterations,
    });
  }

  async recordFailure(failureCode: FailureCode, error: unknown): Promise<void> {
    await this.writeArtifact(
      "summary.md",
      `# ${this.#context.runId}\n\nFailure:\n\n\`\`\`\n${formatError(error)}\n\`\`\`\n`,
    );
    await this.#store.updateRunStatus(this.#context.runId, {
      status: failureCode === "secret_guard_failed" ? "guard_failed" : "failed",
      failureCode,
      finishedAt: new Date(),
    });
  }

  async recordSuccess(prUrl: string): Promise<void> {
    await this.writeArtifact("summary.md", `# ${this.#context.runId}\n\nPR: ${prUrl}\n`);
    await this.#store.updateRunStatus(this.#context.runId, {
      status: "succeeded",
      prUrl,
      finishedAt: new Date(),
    });
  }

  async addReviewCycle(input: {
    cycle: number;
    decision: ReviewDecision;
    report: unknown;
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
  }

  async writeArtifact(name: string, content: string): Promise<string> {
    return await this.#store.writeArtifact(this.#context.runId, name, content);
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

  async startPhase(name: PhaseName): Promise<RunJournalPhase> {
    const logPath = this.artifactPath(`${name}.log`);
    this.#onProgress({
      type: "phase_started",
      runId: this.#context.runId,
      phase: name,
      logPath,
    });
    const phase = await this.#store.startPhase({
      runId: this.#context.runId,
      name,
      logPath,
    });

    return new RunJournalPhase({
      store: this.#store,
      runId: this.#context.runId,
      phaseId: phase.id,
      name,
      logPath,
      onProgress: this.#onProgress,
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
}

class RunJournalPhase {
  readonly logPath: string;

  readonly #store: RunStore;
  readonly #runId: string;
  readonly #phaseId: number;
  readonly #name: PhaseName;
  readonly #onProgress: (event: RunProgressEvent) => void;

  constructor(input: {
    store: RunStore;
    runId: string;
    phaseId: number;
    name: PhaseName;
    logPath: string;
    onProgress: (event: RunProgressEvent) => void;
  }) {
    this.#store = input.store;
    this.#runId = input.runId;
    this.#phaseId = input.phaseId;
    this.#name = input.name;
    this.logPath = input.logPath;
    this.#onProgress = input.onProgress;
  }

  async pass(log: string): Promise<void> {
    await this.finish("passed", log);
  }

  async fail(log: string): Promise<void> {
    await this.finish("failed", log);
  }

  private async finish(status: "passed" | "failed", log: string): Promise<void> {
    await this.#store.writeArtifact(this.#runId, `${this.#name}.log`, log);
    await this.#store.finishPhase({
      phaseId: this.#phaseId,
      status,
      logPath: this.logPath,
    });
    this.#onProgress({
      type: status === "passed" ? "phase_passed" : "phase_failed",
      runId: this.#runId,
      phase: this.#name,
      logPath: this.logPath,
    });
  }
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
