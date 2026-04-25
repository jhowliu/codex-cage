import { Command } from "commander";
import { cleanupManagedDockerResources, type CleanupDockerReport } from "./docker.js";
import { initProject } from "./init.js";
import { runCodexCage, type RunProgressEvent } from "./run.js";
import { openRunStore } from "./state.js";
import { readPackageVersion } from "./version.js";

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

      for (const path of result.created) {
        console.log(`created ${path}`);
      }

      for (const path of result.updated) {
        console.log(`updated ${path}`);
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
    .action(
      async (
        issueArgument: string | undefined,
        options: {
          issue?: string;
          repo?: string;
          base?: string;
          model?: string;
          draft?: boolean;
        },
        command: Command,
      ) => {
        const issueUrl = options.issue ?? issueArgument;

        if (issueUrl === undefined) {
          command.error("error: missing required issue URL");
        }

        const result = await run(
          removeUndefinedProperties({
            issueUrl,
            repo: options.repo,
            base: options.base,
            model: options.model,
            draft: options.draft,
          }),
          {
            onProgress: (event) => {
              console.error(formatRunProgressEvent(event));
            },
          },
        );

        console.log(`Run: ${result.runId}`);
        console.log(`Status: ${result.status}`);

        if (result.failureCode !== null) {
          console.log(`Failure: ${result.failureCode}`);
        }

        if (result.prUrl !== null) {
          console.log(`PR: ${result.prUrl}`);
        }
      },
    );

  const runs = program.command("runs").description("Inspect prior Codex Cage runs.");

  runs
    .command("list")
    .description("List known runs from local metadata.")
    .action(async () => {
      const store = await openRunStore(process.cwd());

      try {
        const runs = store.listRuns();

        if (runs.length === 0) {
          console.log("No runs found.");
          return;
        }

        for (const run of runs) {
          const details = [
            run.id,
            run.issueKey,
            run.status,
            run.failureCode ?? "-",
            run.prUrl ?? "-",
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

      try {
        const details = store.getRunDetails(runId);

        console.log(`Run: ${details.run.id}`);
        console.log(`Status: ${details.run.status}`);
        console.log(`Failure: ${details.run.failureCode ?? "-"}`);
        console.log(`Issue: ${details.run.issueKey}`);
        console.log(`Repo: ${details.run.repo}`);
        console.log(`Base: ${details.run.baseBranch}`);
        console.log(`Branch: ${details.run.branch}`);

        if (details.run.prUrl !== null) {
          console.log(`PR: ${details.run.prUrl}`);
        }

        console.log("");
        console.log("Phases:");

        if (details.phases.length === 0) {
          console.log("  none");
        } else {
          for (const phase of details.phases) {
            console.log(`  ${phase.name}  ${phase.status}  ${phase.logPath ?? "-"}`);
          }
        }

        console.log("");
        console.log("Artifacts:");

        for (const [name, path] of Object.entries(details.artifacts)) {
          console.log(`  ${name}: ${path}`);
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
      console.log(formatCleanupReport(report));
    });

  return program;
}

function formatRunProgressEvent(event: RunProgressEvent): string {
  switch (event.type) {
    case "run_started":
      return [
        `Run ${event.runId}`,
        `Issue: ${event.issueKey} ${event.issueTitle}`,
        `Repo: ${event.repo}`,
        `Branch: ${event.branch}`,
        `Artifacts: ${event.artifactDir}`,
      ].join("\n");
    case "iteration_started":
      return `[iteration ${event.iteration}/${event.maxIterations}] implementing`;
    case "phase_started":
      return `[${event.phase}] started`;
    case "phase_passed":
      return `[${event.phase}] passed (${event.logPath})`;
    case "phase_failed":
      return `[${event.phase}] failed (${event.logPath})`;
    case "run_finished":
      return event.status === "succeeded"
        ? `Run ${event.runId} succeeded${event.prUrl === null ? "" : `: ${event.prUrl}`}`
        : `Run ${event.runId} failed: ${event.failureCode ?? "unknown"}`;
  }
}

function removeUndefinedProperties<TValue extends Record<string, unknown>>(
  value: TValue,
): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as TValue;
}

function formatCleanupReport(report: CleanupDockerReport): string {
  const lines = [
    `Removed containers: ${formatRemovedResources(report.containers)}`,
    `Removed images: ${formatRemovedResources(report.images)}`,
    `Removed networks: ${formatRemovedResources(report.networks)}`,
    `Removed volumes: ${formatRemovedResources(report.volumes)}`,
  ];

  if (report.skippedActiveRunIds.length > 0) {
    lines.push(`Skipped active runs: ${report.skippedActiveRunIds.join(", ")}`);
  }

  if (
    report.containers.length === 0 &&
    report.images.length === 0 &&
    report.networks.length === 0 &&
    report.volumes.length === 0
  ) {
    lines.push("No managed Docker resources removed.");
  }

  return lines.join("\n");
}

function formatRemovedResources(resources: string[]): string {
  return resources.length === 0 ? "none" : resources.join(", ");
}
