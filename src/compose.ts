import { execa } from "execa";
import { defaultSandboxImage, type DockerRunner } from "./docker.js";

export type ComposeServicesConfig = {
  compose: string | null;
  ready: string[];
};

export type ComposeProjectOptions = {
  runId: string;
  composeFile: string;
  projectDirectory: string;
  readyCommands?: string[];
  runner?: ComposeRunner;
  dockerRunner?: DockerRunner;
  readyImage?: string;
};

export type ComposeProject = {
  projectName: string;
  networkName: string;
  composeFile: string;
  projectDirectory: string;
  up(): Promise<void>;
  waitUntilReady(): Promise<void>;
  down(): Promise<void>;
};

export type ComposeRunner = {
  run: (args: string[]) => Promise<void>;
};

export const execaComposeRunner: ComposeRunner = {
  async run(args: string[]): Promise<void> {
    await execa("docker", ["compose", ...args], { stdio: "inherit" });
  },
};

export function createComposeProject(options: ComposeProjectOptions): ComposeProject {
  const runner = options.runner ?? execaComposeRunner;
  const dockerRunner = options.dockerRunner ?? {
    async run(args: string[]): Promise<void> {
      await execa("docker", args, { stdio: "inherit" });
    },
  };
  const projectName = composeProjectName(options.runId);
  const networkName = `${projectName}_default`;

  return {
    projectName,
    networkName,
    composeFile: options.composeFile,
    projectDirectory: options.projectDirectory,
    async up(): Promise<void> {
      await runner.run(composeBaseArgs(options).concat(["up", "-d"]));
    },
    async waitUntilReady(): Promise<void> {
      for (const command of options.readyCommands ?? []) {
        await dockerRunner.run(
          readyCommandRunArgs({
            image: options.readyImage ?? defaultSandboxImage,
            networkName,
            runId: options.runId,
            command,
          }),
        );
      }
    },
    async down(): Promise<void> {
      await runner.run(composeBaseArgs(options).concat(["down", "-v"]));
    },
  };
}

export function composeProjectName(runId: string): string {
  const safeRunId = runId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (safeRunId === "") {
    throw new Error("Run id must contain at least one Compose-safe character.");
  }

  return `codex-cage-${safeRunId}`;
}

export function composeBaseArgs(options: {
  runId: string;
  composeFile: string;
  projectDirectory: string;
}): string[] {
  return [
    "--project-name",
    composeProjectName(options.runId),
    "--project-directory",
    options.projectDirectory,
    "-f",
    options.composeFile,
  ];
}

export function hasComposeServices(config: ComposeServicesConfig): boolean {
  return config.compose !== null;
}

type ReadyCommandRunArgsInput = {
  image: string;
  networkName: string;
  runId: string;
  command: string;
};

export function readyCommandRunArgs(input: ReadyCommandRunArgsInput): string[] {
  return [
    "run",
    "--rm",
    "--label",
    "codex-cage.managed=true",
    "--label",
    `codex-cage.run_id=${input.runId}`,
    "--label",
    "codex-cage.phase=ready",
    "--network",
    input.networkName,
    "--user",
    "agent",
    input.image,
    "sh",
    "-lc",
    input.command,
  ];
}
