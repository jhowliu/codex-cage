import { Command } from "commander";
import { initProject } from "./init.js";
import { readPackageVersion } from "./version.js";

type CommandHandler = () => Promise<void> | void;

const notImplemented =
  (commandName: string): CommandHandler =>
  () => {
    throw new Error(`${commandName} is not implemented yet.`);
  };

export function createCli(): Command {
  const program = new Command();

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
    .requiredOption("--issue <url>", "GitHub or Linear issue URL")
    .option("--repo <repo>", "target GitHub repository override")
    .option("--base <branch>", "base branch override")
    .option("--model <model>", "Codex model override")
    .option("--draft", "create a draft pull request")
    .action(notImplemented("run"));

  const runs = program.command("runs").description("Inspect prior Codex Cage runs.");

  runs
    .command("list")
    .description("List known runs from local metadata.")
    .action(notImplemented("runs list"));

  runs
    .command("show")
    .description("Show metadata and artifact paths for a run.")
    .argument("<run-id>", "run id")
    .action(notImplemented("runs show"));

  program
    .command("cleanup")
    .description("Remove stale Docker resources managed by Codex Cage.")
    .option("--all", "remove all managed Docker resources, including active ones")
    .action(notImplemented("cleanup"));

  return program;
}
