const sqliteExperimentalWarningPrefix = "SQLite is an experimental feature";

export function isSqliteExperimentalWarning(warning: string | Error): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  return message.startsWith(sqliteExperimentalWarningPrefix);
}

/**
 * node:sqlite still reports itself as experimental on Node 22 and prints an
 * ExperimentalWarning on first use. Drop only that warning so CLI output stays
 * clean; every other warning still reaches Node's default handler.
 *
 * Call this before the run store first loads node:sqlite.
 */
export function suppressSqliteExperimentalWarning(): void {
  const emitWarning = process.emitWarning.bind(process);

  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning)) {
      return;
    }

    Reflect.apply(emitWarning, process, [warning, ...rest]);
  };
}
