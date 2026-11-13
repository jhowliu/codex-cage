import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkIssue, type IssueCheckResult } from "./check.js";
import { cleanupManagedDockerResources, type CleanupDockerReport } from "./docker.js";
import { doctorProject, type DoctorResult } from "./doctor.js";
import {
  reviseAgentCagePullRequest,
  runAgentCage,
  type RunAgentCageResult,
  type RunProgressEvent,
} from "./run.js";
import { RunFailureError } from "./run/errors.js";
import { setupProject, type SetupResult } from "./setup.js";
import {
  failureCodes,
  isRunInterrupted,
  openRunStoreReadOnly,
  type RunRecord,
} from "./state.js";
import { readPackageVersion } from "./version.js";

export const RESULT_FILE_ENV = "AGENT_CAGE_RESULT_FILE";
export const VERBOSE_ENV = "AGENT_CAGE_VERBOSE";

export type CliDependencies = {
  runAgentCage?: typeof runAgentCage;
  reviseAgentCagePullRequest?: typeof reviseAgentCagePullRequest;
  setupProject?: typeof setupProject;
  doctorProject?: typeof doctorProject;
};

export function createCli(dependencies: CliDependencies = {}): Command {
  const program = new Command();
  const run = dependencies.runAgentCage ?? runAgentCage;
  const revise = dependencies.reviseAgentCagePullRequest ?? reviseAgentCagePullRequest;
  const setup = dependencies.setupProject ?? setupProject;
  const doctor = dependencies.doctorProject ?? doctorProject;

  program
    .name("agent-cage")
    .description(
      "Run Codex in an isolated Docker workspace and publish verified PRs from issue links.",
    )
    .version(readPackageVersion());

  program
    .command("setup")
    .description("Configure local Docker runs and optional GitHub Actions automation.")
    .option("--yes", "accept detected defaults without prompting")
    .option("--dry-run", "show planned file changes without writing them")
    .option(
      "--actions <enabled>",
      "set GitHub Actions automation to on or off",
      parseOnOff,
    )
    .option("--github", "create GitHub labels and configure missing Actions secrets")
    .action(
      async (options: {
        yes?: boolean;
        dryRun?: boolean;
        actions?: boolean;
        github?: boolean;
      }) => {
        const result = await setup(process.cwd(), {
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.actions === undefined ? {} : { actions: options.actions }),
          ...(options.github === undefined ? {} : { github: options.github }),
        });
        const color = createColorizer(process.stdout);
        printSetupResult(result, color);
        if (!result.dryRun) {
          // Interactive setup also probes the agents; --yes stays offline and token-free.
          const diagnostics = await doctor(process.cwd(), undefined, {
            probe: options.yes !== true,
          });
          printDoctorResult(diagnostics, color);
          if (!diagnostics.healthy) process.exitCode = 1;
        }
      },
    );

  program
    .command("doctor")
    .description("Check local and GitHub Actions Agent Cage configuration.")
    .option("--json", "print the machine-readable diagnostic result")
    .option(
      "--probe",
      "make one minimal call per configured agent in the runtime image (uses a few tokens)",
    )
    .action(async (options: { json?: boolean; probe?: boolean }) => {
      const result = await doctor(process.cwd(), undefined, {
        probe: options.probe === true,
      });
      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printDoctorResult(result, createColorizer(process.stdout));
      }
      if (!result.healthy) process.exitCode = 1;
    });

  program
    .command("check")
    .description("Check whether an issue is ready for a Agent Cage run.")
    .argument("<issue-url>", "GitHub or Linear issue URL")
    .option("--json", "print the machine-readable check result")
    .action(async (issueUrl: string, options: { json?: boolean }) => {
      const result = await checkIssue(process.cwd(), issueUrl);
      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printIssueCheckResult(result, createColorizer(process.stdout));
      }
      if (!result.ready) process.exitCode = 1;
    });

  program
    .command("run")
    .description("Run Agent Cage for a GitHub or Linear issue URL.")
    .argument("<issue-url>", "GitHub or Linear issue URL")
    .option("--repo <repo>", "target GitHub repository override")
    .option("--base <branch>", "base branch override")
    .option("--model <model>", "implementation agent model override")
    .option("--draft", "create a draft pull request")
    .option("--run-id <id>", "use a supplied Run identifier")
    .option(
      "--result-json <path>",
      `write the machine-readable run result to <path> (also settable via ${RESULT_FILE_ENV})`,
    )
    .option(
      "--verbose",
      `stream redacted command output live to stdout (also settable via ${VERBOSE_ENV})`,
    )
    .action(
      async (
        issueArgument: string | undefined,
        options: {
          runId?: string;
          repo?: string;
          base?: string;
          model?: string;
          draft?: boolean;
          resultJson?: string;
          verbose?: boolean;
        },
        command: Command,
      ) => {
        const issueUrl = issueArgument;

        if (issueUrl === undefined) {
          command.error("error: missing required issue URL");
        }

        await executeRunCommand({
          resultJson: options.resultJson,
          start: async (onProgress) =>
            await run(
              removeUndefinedProperties({
                issueUrl,
                runId: options.runId,
                repo: options.repo,
                base: options.base,
                model: options.model,
                draft: options.draft,
                verbose: isVerbose(options.verbose) ? true : undefined,
              }),
              { onProgress },
            ),
        });
      },
    );

  program
    .command("revise")
    .description(
      "Revise an open pull request that Agent Cage opened, from its review threads, comments, and --feedback.",
    )
    .argument("<pr-url>", "GitHub pull request URL")
    .option(
      "--feedback <text>",
      "feedback to address besides what the pull request holds",
    )
    .option("--model <model>", "implementation agent model override")
    .option("--run-id <id>", "use a supplied Run identifier")
    .option(
      "--result-json <path>",
      `write the machine-readable run result to <path> (also settable via ${RESULT_FILE_ENV})`,
    )
    .option(
      "--verbose",
      `stream redacted command output live to stdout (also settable via ${VERBOSE_ENV})`,
    )
    .action(
      async (
        prUrl: string,
        options: {
          feedback?: string;
          runId?: string;
          model?: string;
          resultJson?: string;
          verbose?: boolean;
        },
      ) => {
        await executeRunCommand({
          resultJson: options.resultJson,
          start: async (onProgress) =>
            await revise(
              removeUndefinedProperties({
                prUrl,
                feedback: options.feedback,
                runId: options.runId,
                model: options.model,
                verbose: isVerbose(options.verbose) ? true : undefined,
              }),
              { onProgress },
            ),
        });
      },
    );

  const runs = program.command("runs").description("Inspect prior Agent Cage runs.");

  runs
    .command("list")
    .description("List known runs from local metadata.")
    .option("--json", "print the runs as JSON, newest first")
    .action(async (options: { json?: boolean }) => {
      const store = await openRunStoreReadOnly(process.cwd());
      const color = createColorizer(process.stdout);

      try {
        const runs = store.listRuns();

        if (options.json === true) {
          console.log(JSON.stringify(runs.map(toRunListEntry), null, 2));
          return;
        }

        if (runs.length === 0) {
          console.log(color.muted("No runs found."));
          return;
        }

        for (const run of runs) {
          const details = [
            color.info(run.id),
            run.issueKey,
            formatRunStatus(run, color),
            run.failureCode === null ? "-" : color.failure(run.failureCode),
            run.prUrl === null ? "-" : color.link(run.prUrl),
          ];

          console.log(details.join("  "));
        }
      } finally {
        store.close();
      }
    });

  runs
    .command("show")
    .description("Show metadata and artifact paths for a run.")
    .argument("<run-id>", "run id")
    .action(async (runId: string) => {
      const store = await openRunStoreReadOnly(process.cwd());
      const color = createColorizer(process.stdout);

      try {
        const details = store.getRunDetails(runId);

        console.log(`${color.label("Run")}: ${color.info(details.run.id)}`);
        console.log(`${color.label("Status")}: ${formatRunStatus(details.run, color)}`);
        console.log(
          `${color.label("Failure")}: ${
            details.run.failureCode === null
              ? "-"
              : color.failure(details.run.failureCode)
          }`,
        );
        console.log(`${color.label("Issue")}: ${details.run.issueKey}`);
        console.log(`${color.label("Repo")}: ${details.run.repo}`);
        console.log(`${color.label("Base")}: ${details.run.baseBranch}`);
        console.log(`${color.label("Branch")}: ${color.info(details.run.branch)}`);

        if (details.run.prUrl !== null) {
          console.log(`${color.label("PR")}: ${color.link(details.run.prUrl)}`);
        }

        console.log("");
        console.log(color.heading("Phases:"));

        if (details.phases.length === 0) {
          console.log("  none");
        } else {
          for (const phase of details.phases) {
            console.log(
              `  ${phase.name}  ${color.status(phase.status)}  ${phase.logPath ?? "-"}`,
            );
          }
        }

        console.log("");
        console.log(color.heading("Artifacts:"));

        for (const [name, path] of Object.entries(details.artifacts)) {
          console.log(`  ${color.label(name)}: ${path}`);
        }
      } finally {
        store.close();
      }
    });

  program
    .command("cleanup")
    .description("Remove stale Docker resources managed by Agent Cage.")
    .option("--all", "remove all managed Docker resources, including active ones")
    .action(async (options: { all?: boolean }) => {
      const report = await cleanupManagedDockerResources({ all: options.all === true });
      console.log(formatCleanupReport(report, createColorizer(process.stdout)));
    });

  return program;
}

function isVerbose(flag: boolean | undefined): boolean {
  return flag === true || process.env[VERBOSE_ENV] === "1";
}

/**
 * Runs a run-shaped command and reports it: progress on stderr, the result on
 * stdout, the optional result file, and a non-zero exit code on failure.
 */
async function executeRunCommand(input: {
  resultJson: string | undefined;
  start: (onProgress: (event: RunProgressEvent) => void) => Promise<RunAgentCageResult>;
}): Promise<void> {
  const stdoutColor = createColorizer(process.stdout);
  const stderrColor = createColorizer(process.stderr);
  let result: RunAgentCageResult;

  try {
    result = await input.start((event) => {
      console.error(formatRunProgressEvent(event, stderrColor));
    });
  } catch (error) {
    console.error(
      stderrColor.failure(error instanceof Error ? error.message : String(error)),
    );
    result = {
      runId: "unstarted",
      status: "failed",
      failureCode:
        error instanceof RunFailureError ? error.failureCode : "internal_error",
      prUrl: null,
    };
  }

  console.log(`${stdoutColor.label("Run")}: ${stdoutColor.info(result.runId)}`);
  console.log(`${stdoutColor.label("Status")}: ${stdoutColor.status(result.status)}`);

  if (result.failureCode !== null) {
    console.log(
      `${stdoutColor.label("Failure")}: ${stdoutColor.failure(result.failureCode)}`,
    );
  }

  if (result.prUrl !== null) {
    console.log(`${stdoutColor.label("PR")}: ${stdoutColor.link(result.prUrl)}`);
  }

  const resultPath = input.resultJson ?? process.env[RESULT_FILE_ENV];
  if (resultPath !== undefined && resultPath !== "") {
    await writeRunResultFile(resultPath, result);
  }

  if (result.status === "failed") {
    process.exitCode = 1;
  }
}

function parseOnOff(value: string): boolean {
  switch (value.toLowerCase()) {
    case "on":
    case "true":
    case "yes":
      return true;
    case "off":
    case "false":
    case "no":
      return false;
    default:
      throw new Error('--actions must be "on" or "off".');
  }
}

function printSetupResult(result: SetupResult, color: Colorizer): void {
  for (const path of result.created) console.log(`${color.success("created")} ${path}`);
  for (const path of result.updated) console.log(`${color.warning("updated")} ${path}`);
  for (const path of result.removed) console.log(`${color.muted("removed")} ${path}`);
  console.log(
    `${color.label("GitHub Actions")}: ${result.actionsEnabled ? color.success("enabled") : color.muted("disabled")}`,
  );
  if (result.dryRun) console.log(color.warning("Dry run only; no files were changed."));
  for (const notice of result.notices) console.log(color.warning(notice));
}

function printIssueCheckResult(result: IssueCheckResult, color: Colorizer): void {
  if (result.issue !== null) {
    console.log(
      `${color.label("Issue")}: ${result.issue.identifier} ${result.issue.title}`,
    );
  }

  for (const finding of result.findings) {
    const marker =
      finding.level === "error" ? color.failure("fail") : color.warning("warn");
    console.log(`${marker} ${finding.message}`);
  }

  console.log(
    result.ready
      ? `${color.success("ready")}: the issue can start a run`
      : `${color.failure("not ready")}: fix the failures above before running`,
  );
}

function printDoctorResult(result: DoctorResult, color: Colorizer): void {
  for (const check of result.checks) {
    const marker =
      check.status === "pass"
        ? color.success("pass")
        : check.status === "warning"
          ? color.warning("warn")
          : color.failure("fail");
    console.log(`${marker} ${color.label(check.name)}: ${check.message}`);
  }
}

function formatRunProgressEvent(
  event: RunProgressEvent,
  color: Colorizer = createColorizer(process.stderr),
): string {
  switch (event.type) {
    case "run_started":
      return [
        `${color.heading("Run")} ${color.info(event.runId)}`,
        `${color.label("Issue")}: ${event.issueKey} ${event.issueTitle}`,
        `${color.label("Repo")}: ${event.repo}`,
        `${color.label("Branch")}: ${color.info(event.branch)}`,
        `${color.label("Artifacts")}: ${event.artifactDir}`,
      ].join("\n");
    case "iteration_started":
      return `${color.warning(
        `[iteration ${event.iteration}/${event.maxIterations}]`,
      )} implementing`;
    case "phase_started":
      return `${color.info(`[${event.phase}]`)} started`;
    case "phase_passed":
      return `${color.success(`[${event.phase}] passed`)} (${event.logPath})`;
    case "phase_failed":
      return `${color.failure(`[${event.phase}] failed`)} (${event.logPath})`;
    case "run_finished":
      return event.status === "succeeded"
        ? `${color.heading("Run")} ${color.info(event.runId)} ${color.success(
            "succeeded",
          )}${event.prUrl === null ? "" : `: ${color.link(event.prUrl)}`}`
        : `${color.heading("Run")} ${color.info(event.runId)} ${color.failure(
            "failed",
          )}: ${color.failure(event.failureCode ?? "unknown")}`;
  }
}

function removeUndefinedProperties<TValue extends Record<string, unknown>>(
  value: TValue,
): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as TValue;
}

async function writeRunResultFile(
  path: string,
  result: RunAgentCageResult,
): Promise<void> {
  const payload: RunAgentCageResult = {
    runId: result.runId,
    status: result.status,
    failureCode: result.failureCode,
    prUrl: result.prUrl,
  };

  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function formatCleanupReport(
  report: CleanupDockerReport,
  color: Colorizer = createColorizer(process.stdout),
): string {
  const lines = [
    `${color.label("Removed containers")}: ${formatRemovedResources(
      report.containers,
      color,
    )}`,
    `${color.label("Removed images")}: ${formatRemovedResources(report.images, color)}`,
    `${color.label("Removed networks")}: ${formatRemovedResources(
      report.networks,
      color,
    )}`,
    `${color.label("Removed volumes")}: ${formatRemovedResources(report.volumes, color)}`,
  ];

  if (report.skippedActiveRunIds.length > 0) {
    lines.push(
      `${color.label("Skipped active runs")}: ${report.skippedActiveRunIds
        .map((runId) => color.warning(runId))
        .join(", ")}`,
    );
  }

  if (
    report.containers.length === 0 &&
    report.images.length === 0 &&
    report.networks.length === 0 &&
    report.volumes.length === 0
  ) {
    lines.push(color.muted("No managed Docker resources removed."));
  }

  return lines.join("\n");
}

function formatRemovedResources(resources: string[], color: Colorizer): string {
  return resources.length === 0
    ? color.muted("none")
    : resources.map((resource) => color.info(resource)).join(", ");
}

type Colorizer = {
  heading: (value: string) => string;
  label: (value: string) => string;
  info: (value: string) => string;
  link: (value: string) => string;
  success: (value: string) => string;
  warning: (value: string) => string;
  failure: (value: string) => string;
  muted: (value: string) => string;
  status: (value: string) => string;
};

/** One run in `runs list --json`. */
export type RunListEntry = RunRecord & { interrupted: boolean };

function toRunListEntry(run: RunRecord): RunListEntry {
  return { ...run, interrupted: isRunInterrupted(run) };
}

function formatRunStatus(run: RunRecord, color: Colorizer): string {
  const status = color.status(run.status);
  return isRunInterrupted(run) ? `${status} ${color.failure("interrupted")}` : status;
}

function createColorizer(stream: NodeJS.WriteStream): Colorizer {
  const enabled = colorEnabled(stream);
  const style = (code: string, value: string): string =>
    enabled ? `\u001B[${code}m${value}\u001B[0m` : value;

  return {
    heading: (value) => style("1", value),
    label: (value) => style("36", value),
    info: (value) => style("36", value),
    link: (value) => style("4;36", value),
    success: (value) => style("32", value),
    warning: (value) => style("33", value),
    failure: (value) => style("31", value),
    muted: (value) => style("2", value),
    status: (value) => {
      if (value === "succeeded" || value === "passed") {
        return style("32", value);
      }

      if (
        value === "failed" ||
        value === "guard_failed" ||
        failureCodes.some((code) => code === value)
      ) {
        return style("31", value);
      }

      if (
        value === "running" ||
        value === "setup" ||
        value === "implementing" ||
        value === "verifying" ||
        value === "reviewing" ||
        value === "creating_pr"
      ) {
        return style("33", value);
      }

      return value;
    },
  };
}

function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === "dumb") {
    return false;
  }

  if (
    process.env.FORCE_COLOR !== undefined &&
    process.env.FORCE_COLOR !== "" &&
    process.env.FORCE_COLOR !== "0"
  ) {
    return true;
  }

  return stream.isTTY === true;
}
