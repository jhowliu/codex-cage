import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import initSqlJs from "sql.js";
import type { Database, ParamsObject, SqlJsStatic, SqlValue } from "sql.js";

const require = createRequire(import.meta.url);

export const stateDirectoryName = ".codex-cage";
export const runsDirectoryName = "runs";
export const databaseFileName = "codex-cage.sqlite";

export const runStatuses = [
  "queued",
  "preflight",
  "cloning",
  "setup",
  "implementing",
  "verifying",
  "reviewing",
  "guard_failed",
  "creating_pr",
  "succeeded",
  "failed",
  "aborted",
] as const;

export type RunStatus = (typeof runStatuses)[number];

export const failureCodes = [
  "missing_config",
  "invalid_config",
  "setup_failed",
  "verify_failed",
  "review_blocking",
  "secret_guard_failed",
  "denylist_failed",
  "no_diff",
  "timeout",
  "pr_failed",
  "internal_error",
] as const;

export type FailureCode = (typeof failureCodes)[number];

export const phaseNames = [
  "preflight",
  "cloning",
  "setup",
  "implement",
  "verify",
  "review",
  "pr",
] as const;

export type PhaseName = (typeof phaseNames)[number];
export type PhaseStatus = "running" | "passed" | "failed" | "skipped";
export type ReviewDecision = "pass" | "blocking";

export type CreateRunInput = {
  id: string;
  issueUrl: string;
  issueKey: string;
  repo: string;
  baseBranch: string;
  branch: string;
  startedAt?: Date;
};

export type RunRecord = {
  id: string;
  issueUrl: string;
  issueKey: string;
  repo: string;
  baseBranch: string;
  branch: string;
  status: RunStatus;
  failureCode: FailureCode | null;
  prUrl: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type PhaseRecord = {
  id: number;
  runId: string;
  name: PhaseName;
  status: PhaseStatus;
  startedAt: string;
  finishedAt: string | null;
  logPath: string | null;
};

export type ReviewCycleRecord = {
  id: number;
  runId: string;
  cycle: number;
  decision: ReviewDecision;
  reportPath: string;
};

export type RunDetails = {
  run: RunRecord;
  phases: PhaseRecord[];
  reviewCycles: ReviewCycleRecord[];
  artifacts: Record<string, string>;
};

export type RunStatusUpdate = {
  status: RunStatus;
  failureCode?: FailureCode | null;
  prUrl?: string | null;
  finishedAt?: Date | null;
};

export type StartPhaseInput = {
  runId: string;
  name: PhaseName;
  startedAt?: Date;
  logPath?: string | null;
};

export type FinishPhaseInput = {
  phaseId: number;
  status: Exclude<PhaseStatus, "running">;
  finishedAt?: Date;
  logPath?: string | null;
};

export type AddReviewCycleInput = {
  runId: string;
  cycle: number;
  decision: ReviewDecision;
  reportPath: string;
};

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

export async function openRunStore(cwd: string): Promise<RunStore> {
  const statePath = join(cwd, stateDirectoryName);
  const runsPath = join(statePath, runsDirectoryName);
  const databasePath = join(statePath, databaseFileName);

  await mkdir(runsPath, { recursive: true });

  const sqlJs = await loadSqlJs();
  const database = await openDatabase(sqlJs, databasePath);
  const store = new RunStore(database, databasePath, runsPath);

  store.migrate();
  await store.save();

  return store;
}

export class RunStore {
  readonly databasePath: string;
  readonly runsPath: string;

  #database: Database;

  constructor(database: Database, databasePath: string, runsPath: string) {
    this.#database = database;
    this.databasePath = databasePath;
    this.runsPath = runsPath;
  }

  migrate(): void {
    this.#database.run(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        issue_url TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_code TEXT,
        pr_url TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS phases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        log_path TEXT
      );

      CREATE INDEX IF NOT EXISTS phases_run_id_idx ON phases(run_id);

      CREATE TABLE IF NOT EXISTS review_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        cycle INTEGER NOT NULL,
        decision TEXT NOT NULL,
        report_path TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS review_cycles_run_id_idx ON review_cycles(run_id);

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (1, '${new Date(0).toISOString()}');
    `);
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const startedAt = toIsoString(input.startedAt ?? new Date());

    await mkdir(this.runDirectory(input.id), { recursive: true });

    this.#database.run(
      `
        INSERT INTO runs (
          id,
          issue_url,
          issue_key,
          repo,
          base_branch,
          branch,
          status,
          started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.id,
        input.issueUrl,
        input.issueKey,
        input.repo,
        input.baseBranch,
        input.branch,
        "queued",
        startedAt,
      ],
    );

    await this.save();
    return this.getRun(input.id);
  }

  async updateRunStatus(runId: string, update: RunStatusUpdate): Promise<RunRecord> {
    this.#database.run(
      `
        UPDATE runs
        SET status = ?,
            failure_code = ?,
            pr_url = COALESCE(?, pr_url),
            finished_at = ?
        WHERE id = ?
      `,
      [
        update.status,
        update.failureCode ?? null,
        update.prUrl ?? null,
        update.finishedAt === undefined
          ? null
          : update.finishedAt === null
            ? null
            : toIsoString(update.finishedAt),
        runId,
      ],
    );

    assertRowsChanged(this.#database, `Run ${runId} does not exist.`);
    await this.save();
    return this.getRun(runId);
  }

  async startPhase(input: StartPhaseInput): Promise<PhaseRecord> {
    this.#database.run(
      `
        INSERT INTO phases (run_id, name, status, started_at, log_path)
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        input.runId,
        input.name,
        "running",
        toIsoString(input.startedAt ?? new Date()),
        input.logPath ?? null,
      ],
    );

    const phaseId = getLastInsertId(this.#database);
    await this.save();
    return this.getPhase(phaseId);
  }

  async finishPhase(input: FinishPhaseInput): Promise<PhaseRecord> {
    this.#database.run(
      `
        UPDATE phases
        SET status = ?,
            finished_at = ?,
            log_path = COALESCE(?, log_path)
        WHERE id = ?
      `,
      [
        input.status,
        toIsoString(input.finishedAt ?? new Date()),
        input.logPath ?? null,
        input.phaseId,
      ],
    );

    assertRowsChanged(this.#database, `Phase ${input.phaseId} does not exist.`);
    await this.save();
    return this.getPhase(input.phaseId);
  }

  async addReviewCycle(input: AddReviewCycleInput): Promise<ReviewCycleRecord> {
    this.#database.run(
      `
        INSERT INTO review_cycles (run_id, cycle, decision, report_path)
        VALUES (?, ?, ?, ?)
      `,
      [input.runId, input.cycle, input.decision, input.reportPath],
    );

    const reviewCycleId = getLastInsertId(this.#database);
    await this.save();
    return this.getReviewCycle(reviewCycleId);
  }

  async writeArtifact(runId: string, name: string, content: string): Promise<string> {
    const path = this.artifactPath(runId, name);

    await mkdir(this.runDirectory(runId), { recursive: true });
    await writeFile(path, content, "utf8");

    return path;
  }

  artifactPath(runId: string, name: string): string {
    return join(this.runDirectory(runId), name);
  }

  runDirectory(runId: string): string {
    return join(this.runsPath, runId);
  }

  listRuns(): RunRecord[] {
    return selectRows(this.#database, "SELECT * FROM runs ORDER BY started_at DESC").map(
      rowToRunRecord,
    );
  }

  getRun(runId: string): RunRecord {
    const row = selectOne(this.#database, "SELECT * FROM runs WHERE id = ?", [runId]);

    if (row === undefined) {
      throw new Error(`Run ${runId} does not exist.`);
    }

    return rowToRunRecord(row);
  }

  getRunDetails(runId: string): RunDetails {
    const run = this.getRun(runId);
    const phases = selectRows(
      this.#database,
      "SELECT * FROM phases WHERE run_id = ? ORDER BY id ASC",
      [runId],
    ).map(rowToPhaseRecord);
    const reviewCycles = selectRows(
      this.#database,
      "SELECT * FROM review_cycles WHERE run_id = ? ORDER BY cycle ASC",
      [runId],
    ).map(rowToReviewCycleRecord);

    return {
      run,
      phases,
      reviewCycles,
      artifacts: defaultArtifactPaths(this, runId),
    };
  }

  close(): void {
    this.#database.close();
  }

  async save(): Promise<void> {
    await writeFile(this.databasePath, this.#database.export());
  }

  private getPhase(phaseId: number): PhaseRecord {
    const row = selectOne(this.#database, "SELECT * FROM phases WHERE id = ?", [phaseId]);

    if (row === undefined) {
      throw new Error(`Phase ${phaseId} does not exist.`);
    }

    return rowToPhaseRecord(row);
  }

  private getReviewCycle(reviewCycleId: number): ReviewCycleRecord {
    const row = selectOne(this.#database, "SELECT * FROM review_cycles WHERE id = ?", [
      reviewCycleId,
    ]);

    if (row === undefined) {
      throw new Error(`Review cycle ${reviewCycleId} does not exist.`);
    }

    return rowToReviewCycleRecord(row);
  }
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({
    locateFile: (fileName) => require.resolve(`sql.js/dist/${fileName}`),
  });

  return await sqlJsPromise;
}

async function openDatabase(sqlJs: SqlJsStatic, databasePath: string): Promise<Database> {
  try {
    const data = await readFile(databasePath);
    return new sqlJs.Database(data);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return new sqlJs.Database();
    }

    throw error;
  }
}

function selectRows(
  database: Database,
  sql: string,
  params: SqlValue[] = [],
): ParamsObject[] {
  const statement = database.prepare(sql);

  try {
    statement.bind(params);
    const rows: ParamsObject[] = [];

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }

    return rows;
  } finally {
    statement.free();
  }
}

function selectOne(
  database: Database,
  sql: string,
  params: SqlValue[] = [],
): ParamsObject | undefined {
  return selectRows(database, sql, params).at(0);
}

function getLastInsertId(database: Database): number {
  const row = selectOne(database, "SELECT last_insert_rowid() AS id");

  if (row === undefined) {
    throw new Error("Could not read last inserted id.");
  }

  return readNumber(row, "id");
}

function defaultArtifactPaths(store: RunStore, runId: string): Record<string, string> {
  return {
    summary: store.artifactPath(runId, "summary.md"),
    issue: store.artifactPath(runId, "issue.json"),
    resolvedConfig: store.artifactPath(runId, "resolved-config.json"),
    finalPatch: store.artifactPath(runId, "final.patch"),
    pr: store.artifactPath(runId, "pr.json"),
  };
}

function rowToRunRecord(row: ParamsObject): RunRecord {
  return {
    id: readString(row, "id"),
    issueUrl: readString(row, "issue_url"),
    issueKey: readString(row, "issue_key"),
    repo: readString(row, "repo"),
    baseBranch: readString(row, "base_branch"),
    branch: readString(row, "branch"),
    status: readRunStatus(row, "status"),
    failureCode: readNullableFailureCode(row, "failure_code"),
    prUrl: readNullableString(row, "pr_url"),
    startedAt: readString(row, "started_at"),
    finishedAt: readNullableString(row, "finished_at"),
  };
}

function rowToPhaseRecord(row: ParamsObject): PhaseRecord {
  return {
    id: readNumber(row, "id"),
    runId: readString(row, "run_id"),
    name: readPhaseName(row, "name"),
    status: readPhaseStatus(row, "status"),
    startedAt: readString(row, "started_at"),
    finishedAt: readNullableString(row, "finished_at"),
    logPath: readNullableString(row, "log_path"),
  };
}

function rowToReviewCycleRecord(row: ParamsObject): ReviewCycleRecord {
  return {
    id: readNumber(row, "id"),
    runId: readString(row, "run_id"),
    cycle: readNumber(row, "cycle"),
    decision: readReviewDecision(row, "decision"),
    reportPath: readString(row, "report_path"),
  };
}

function readString(row: ParamsObject, key: string): string {
  const value = row[key];

  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }

  return value;
}

function readNullableString(row: ParamsObject, key: string): string | null {
  const value = row[key];

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string or null.`);
  }

  return value;
}

function readNumber(row: ParamsObject, key: string): number {
  const value = row[key];

  if (typeof value !== "number") {
    throw new Error(`Expected ${key} to be a number.`);
  }

  return value;
}

function readRunStatus(row: ParamsObject, key: string): RunStatus {
  return readEnum(row, key, runStatuses);
}

function readNullableFailureCode(row: ParamsObject, key: string): FailureCode | null {
  const value = row[key];

  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || !isOneOf(value, failureCodes)) {
    throw new Error(`Expected ${key} to be a known failure code or null.`);
  }

  return value;
}

function readPhaseName(row: ParamsObject, key: string): PhaseName {
  return readEnum(row, key, phaseNames);
}

function readPhaseStatus(row: ParamsObject, key: string): PhaseStatus {
  return readEnum(row, key, ["running", "passed", "failed", "skipped"] as const);
}

function readReviewDecision(row: ParamsObject, key: string): ReviewDecision {
  return readEnum(row, key, ["pass", "blocking"] as const);
}

function readEnum<const TValue extends string>(
  row: ParamsObject,
  key: string,
  values: readonly TValue[],
): TValue {
  const value = row[key];

  if (typeof value !== "string" || !isOneOf(value, values)) {
    throw new Error(`Expected ${key} to be one of ${values.join(", ")}.`);
  }

  return value;
}

function isOneOf<const TValue extends string>(
  value: string,
  values: readonly TValue[],
): value is TValue {
  return values.includes(value as TValue);
}

function assertRowsChanged(database: Database, message: string): void {
  if (database.getRowsModified() === 0) {
    throw new Error(message);
  }
}

function toIsoString(date: Date): string {
  return date.toISOString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
