import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupManagedDockerResources, type CleanupDockerReport } from "./docker.js";
import { initProject } from "./init.js";
import { runCodexCage, type RunCodexCageResult, type RunProgressEvent } from "./run.js";
import { openRunStore } from "./state.js";
import { readPackageVersion } from "./version.js";

export const RESULT_FILE_ENV = "CODEX_CAGE_RESULT_FILE";
export const VERBOSE_ENV = "CODEX_CAGE_VERBOSE";

export type CliDependencies = {
  runCodexCage?: typeof runCodexCage;
};

export function createCli(dependencies: CliDependencies = {}): Command {
  const program = new Command();
  const run = dependencies.runCodexCage ?? runCodexCage;

  program
    .name("codex-cage")
    .description(
      "Run Codex in an isolated Docker workspace and publish verified PRs from issue links.",
    )
    .version(readPackageVersion());

  program
    .command("init")
    .description("Create Codex Cage config files in the current repository.")
    .option("--dockerfile", "also create .codex-cage/Dockerfile")
    .action(async (options: { dockerfile?: boolean }) => {
      const result = await initProject(process.cwd(), options);
      const color = createColorizer(process.stdout);

      for (const path of result.created) {
        console.log(`${color.success("created")} ${color.info(path)}`);
      }

      for (const path of result.updated) {
        console.log(`${color.warning("updated")} ${color.info(path)}`);
      }
    });

  program
    .command("run")
    .description("Run Codex Cage for a GitHub or Linear issue URL.")
    .argument("[issue-url]", "GitHub or Linear issue URL")
    .option("--issue <url>", "GitHub or Linear issue URL")
    .option("--repo <repo>", "target GitHub repository override")
    .option("--base <branch>", "base branch override")
    .option("--model <model>", "Codex model override")
    .option("--draft", "create a draft pull request")
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
          issue?: string;
          repo?: string;
          base?: string;
          model?: string;
          draft?: boolean;
          resultJson?: string;
          verbose?: boolean;
        },
        command: Command,
      ) => {
        const issueUrl = options.issue ?? issueArgument;
        const stdoutColor = createColorizer(process.stdout);
        const stderrColor = createColorizer(process.stderr);

        if (issueUrl === undefined) {
          command.error("error: missing required issue URL");
        }

        const verbose = options.verbose === true || process.env[VERBOSE_ENV] === "1";
        const result = await run(
          removeUndefinedProperties({
            issueUrl,
            repo: options.repo,
            base: options.base,
            model: options.model,
            draft: options.draft,
            verbose: verbose ? true : undefined,
          }),
          {
            onProgress: (event) => {
              console.error(formatRunProgressEvent(event, stderrColor));
            },
          },
        );

        console.log(`${stdoutColor.label("Run")}: ${stdoutColor.info(result.runId)}`);
        console.log(
          `${stdoutColor.label("Status")}: ${stdoutColor.status(result.status)}`,
        );

        if (result.failureCode !== null) {
          console.log(
            `${stdoutColor.label("Failure")}: ${stdoutColor.failure(result.failureCode)}`,
          );
        }

        if (result.prUrl !== null) {
          console.log(`${stdoutColor.label("PR")}: ${stdoutColor.link(result.prUrl)}`);
        }

        const resultPath = options.resultJson ?? process.env[RESULT_FILE_ENV];
        if (resultPath !== undefined && resultPath !== "") {
          await writeRunResultFile(resultPath, result);
        }

        if (result.status === "failed") {
          process.exitCode = 1;
        }
      },
    );

  const runs = program.command("runs").description("Inspect prior Codex Cage runs.");

  runs
    .command("list")
    .description("List known runs from local metadata.")
    .action(async () => {
      const store = await openRunStore(process.cwd());
      const color = createColorizer(process.stdout);

      try {
        const runs = store.listRuns();

        if (runs.length === 0) {
          console.log(color.muted("No runs found."));
          return;
        }

        for (const run of runs) {
          const details = [
            color.info(run.id),
            run.issueKey,
            color.status(run.status),
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
      const store = await openRunStore(process.cwd());
      const color = createColorizer(process.stdout);

      try {
        const details = store.getRunDetails(runId);

        console.log(`${color.label("Run")}: ${color.info(details.run.id)}`);
        console.log(`${color.label("Status")}: ${color.status(details.run.status)}`);
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
    .description("Remove stale Docker resources managed by Codex Cage.")
    .option("--all", "remove all managed Docker resources, including active ones")
    .action(async (options: { all?: boolean }) => {
      const report = await cleanupManagedDockerResources({ all: options.all === true });
      console.log(formatCleanupReport(report, createColorizer(process.stdout)));
    });

  return program;
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
  result: RunCodexCageResult,
): Promise<void> {
  const payload: RunCodexCageResult = {
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
        value === "verify_failed" ||
        value === "review_blocking" ||
        value === "internal_error"
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
