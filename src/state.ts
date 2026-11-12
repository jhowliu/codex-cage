import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DatabaseSync,
  SQLInputValue,
  SQLOutputValue,
  StatementResultingChanges,
} from "node:sqlite";

type Row = Record<string, SQLOutputValue>;

// How long a writer waits for another process's write lock before failing.
// Run writes are a few small statements per phase, so contention is brief.
const busyTimeoutMs = 5_000;

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
  "runtime_image_failed",
  "docker_unavailable",
  "clone_failed",
  "agent_auth_failed",
  "agent_model_unavailable",
  "implement_failed",
  "review_failed",
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
  "runtime_image",
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
  /** The process that executes the run. Defaults to the calling process. */
  pid?: number;
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
  /** The process that executes the run, or null for a run recorded by an earlier version. */
  pid: number | null;
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

/**
 * Opens the run store for writing. Every statement commits straight to the
 * SQLite file, and concurrent processes serialize through SQLite's file lock,
 * so parallel runs in one repository never overwrite each other's rows.
 */
export async function openRunStore(cwd: string): Promise<RunStore> {
  const paths = runStorePaths(cwd);

  await mkdir(paths.runsPath, { recursive: true });

  const sqlite = await loadSqlite();
  const database = new sqlite.DatabaseSync(paths.databasePath, {
    enableForeignKeyConstraints: true,
    timeout: busyTimeoutMs,
  });

  try {
    // WAL lets readers (runs list, a polling panel) proceed while a run writes.
    database.exec("PRAGMA journal_mode = WAL;");
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }

  return new RunStore(database, paths.databasePath, paths.runsPath);
}

/**
 * Opens the run store for inspection only. It never creates, migrates, or
 * rewrites the database, so it is safe to call while runs are in progress.
 * A repository without a database yet reads as having no runs.
 */
export async function openRunStoreReadOnly(cwd: string): Promise<RunStore> {
  const paths = runStorePaths(cwd);
  const sqlite = await loadSqlite();

  if (!existsSync(paths.databasePath)) {
    const empty = new sqlite.DatabaseSync(":memory:");
    migrate(empty);
    return new RunStore(empty, paths.databasePath, paths.runsPath);
  }

  const database = new sqlite.DatabaseSync(paths.databasePath, {
    readOnly: true,
    timeout: busyTimeoutMs,
  });

  return new RunStore(database, paths.databasePath, paths.runsPath);
}

type RunStorePaths = {
  databasePath: string;
  runsPath: string;
};

function runStorePaths(cwd: string): RunStorePaths {
  const statePath = join(cwd, stateDirectoryName);

  return {
    databasePath: join(statePath, databaseFileName),
    runsPath: join(statePath, runsDirectoryName),
  };
}

// Loaded lazily so the CLI can filter node:sqlite's experimental warning
// before the module is first evaluated.
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  return await import("node:sqlite");
}

function migrate(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");

  try {
    database.exec(schemaSql);
    applyMigrations(database);
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK;");
    }

    throw error;
  }
}

// Changes to databases created by earlier versions, each applied once, in order.
const migrations = [
  { version: 2, sql: "ALTER TABLE runs ADD COLUMN pid INTEGER;" },
] as const;

function applyMigrations(database: DatabaseSync): void {
  const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (applied.get(migration.version) === undefined) {
      database.exec(migration.sql);
      record.run(migration.version, new Date().toISOString());
    }
  }
}

const schemaSql = `
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
`;

export class RunStore {
  readonly databasePath: string;
  readonly runsPath: string;

  #database: DatabaseSync;

  constructor(database: DatabaseSync, databasePath: string, runsPath: string) {
    this.#database = database;
    this.databasePath = databasePath;
    this.runsPath = runsPath;
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const startedAt = toIsoString(input.startedAt ?? new Date());

    await mkdir(this.runDirectory(input.id), { recursive: true });

    this.execute(
      `
        INSERT INTO runs (
          id,
          issue_url,
          issue_key,
          repo,
          base_branch,
          branch,
          status,
          started_at,
          pid
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.pid ?? process.pid,
      ],
    );

    return this.getRun(input.id);
  }

  async updateRunStatus(runId: string, update: RunStatusUpdate): Promise<RunRecord> {
    const result = this.execute(
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

    assertRowsChanged(result, `Run ${runId} does not exist.`);
    return this.getRun(runId);
  }

  async startPhase(input: StartPhaseInput): Promise<PhaseRecord> {
    const result = this.execute(
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

    return this.getPhase(toNumber(result.lastInsertRowid));
  }

  async finishPhase(input: FinishPhaseInput): Promise<PhaseRecord> {
    const result = this.execute(
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

    assertRowsChanged(result, `Phase ${input.phaseId} does not exist.`);
    return this.getPhase(input.phaseId);
  }

  async addReviewCycle(input: AddReviewCycleInput): Promise<ReviewCycleRecord> {
    const result = this.execute(
      `
        INSERT INTO review_cycles (run_id, cycle, decision, report_path)
        VALUES (?, ?, ?, ?)
      `,
      [input.runId, input.cycle, input.decision, input.reportPath],
    );

    return this.getReviewCycle(toNumber(result.lastInsertRowid));
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
    return this.selectRows("SELECT * FROM runs ORDER BY started_at DESC").map(
      rowToRunRecord,
    );
  }

  getRun(runId: string): RunRecord {
    const row = this.selectOne("SELECT * FROM runs WHERE id = ?", [runId]);

    if (row === undefined) {
      throw new Error(`Run ${runId} does not exist.`);
    }

    return rowToRunRecord(row);
  }

  getRunDetails(runId: string): RunDetails {
    const run = this.getRun(runId);
    const phases = this.selectRows(
      "SELECT * FROM phases WHERE run_id = ? ORDER BY id ASC",
      [runId],
    ).map(rowToPhaseRecord);
    const reviewCycles = this.selectRows(
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

  private execute(sql: string, params: SQLInputValue[]): StatementResultingChanges {
    return this.#database.prepare(sql).run(...params);
  }

  private selectRows(sql: string, params: SQLInputValue[] = []): Row[] {
    return this.#database.prepare(sql).all(...params);
  }

  private selectOne(sql: string, params: SQLInputValue[] = []): Row | undefined {
    return this.#database.prepare(sql).get(...params);
  }

  private getPhase(phaseId: number): PhaseRecord {
    const row = this.selectOne("SELECT * FROM phases WHERE id = ?", [phaseId]);

    if (row === undefined) {
      throw new Error(`Phase ${phaseId} does not exist.`);
    }

    return rowToPhaseRecord(row);
  }

  private getReviewCycle(reviewCycleId: number): ReviewCycleRecord {
    const row = this.selectOne("SELECT * FROM review_cycles WHERE id = ?", [
      reviewCycleId,
    ]);

    if (row === undefined) {
      throw new Error(`Review cycle ${reviewCycleId} does not exist.`);
    }

    return rowToReviewCycleRecord(row);
  }
}

/**
 * A run is interrupted when it never finished and the process that ran it is
 * gone, for example after a crash or a closed terminal. A run recorded without
 * a pid is never reported as interrupted, because there is nothing to check.
 */
export function isRunInterrupted(
  run: RunRecord,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  return run.finishedAt === null && run.pid !== null && !isAlive(run.pid);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
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

function rowToRunRecord(row: Row): RunRecord {
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
    pid: readPid(row),
  };
}

// A read-only store never migrates, so a database from before pids were
// recorded has no pid column at all.
function readPid(row: Row): number | null {
  const value = row["pid"];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number") {
    throw new Error("Expected pid to be a number or null.");
  }

  return value;
}

function rowToPhaseRecord(row: Row): PhaseRecord {
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

function rowToReviewCycleRecord(row: Row): ReviewCycleRecord {
  return {
    id: readNumber(row, "id"),
    runId: readString(row, "run_id"),
    cycle: readNumber(row, "cycle"),
    decision: readReviewDecision(row, "decision"),
    reportPath: readString(row, "report_path"),
  };
}

function readString(row: Row, key: string): string {
  const value = row[key];

  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }

  return value;
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key];

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string or null.`);
  }

  return value;
}

function readNumber(row: Row, key: string): number {
  const value = row[key];

  if (typeof value !== "number") {
    throw new Error(`Expected ${key} to be a number.`);
  }

  return value;
}

function readRunStatus(row: Row, key: string): RunStatus {
  return readEnum(row, key, runStatuses);
}

function readNullableFailureCode(row: Row, key: string): FailureCode | null {
  const value = row[key];

  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || !isOneOf(value, failureCodes)) {
    throw new Error(`Expected ${key} to be a known failure code or null.`);
  }

  return value;
}

function readPhaseName(row: Row, key: string): PhaseName {
  return readEnum(row, key, phaseNames);
}

function readPhaseStatus(row: Row, key: string): PhaseStatus {
  return readEnum(row, key, ["running", "passed", "failed", "skipped"] as const);
}

function readReviewDecision(row: Row, key: string): ReviewDecision {
  return readEnum(row, key, ["pass", "blocking"] as const);
}

function readEnum<const TValue extends string>(
  row: Row,
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

function assertRowsChanged(result: StatementResultingChanges, message: string): void {
  if (toNumber(result.changes) === 0) {
    throw new Error(message);
  }
}

function toIsoString(date: Date): string {
  return date.toISOString();
}
