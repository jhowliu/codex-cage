import { execa } from "execa";

export type DockerRunner = {
  run: (args: string[]) => Promise<void>;
};

export type DockerSandboxOptions = {
  runId: string;
  cloneUrl: string;
  image?: string;
  workspacePath?: string;
  serviceNetworkName?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
};

export type DockerSandbox = {
  runId: string;
  image: string;
  volumeName: string;
  networkName: string;
  ownedNetworkName: string | null;
  workspacePath: string;
  create(): Promise<void>;
  cloneRepository(): Promise<void>;
  runCommand(command: string): Promise<void>;
  cleanup(): Promise<void>;
};

export type DockerResourceNames = {
  volumeName: string;
  networkName: string;
};

export const defaultSandboxImage = "codex-cage/base:0.1.0";
export const defaultWorkspacePath = "/workspace";

const runIdLabelName = "codex-cage.run_id";

export const execaDockerRunner: DockerRunner = {
  async run(args: string[]): Promise<void> {
    await execa("docker", args, { stdio: "inherit" });
  },
};

export function createDockerSandbox(
  options: DockerSandboxOptions,
  runner: DockerRunner = execaDockerRunner,
): DockerSandbox {
  const image = options.image ?? defaultSandboxImage;
  const workspacePath = options.workspacePath ?? defaultWorkspacePath;
  const { volumeName, networkName } = dockerResourceNames(options.runId);
  const ownedNetworkName = options.serviceNetworkName === undefined ? networkName : null;
  const agentNetworkName = options.serviceNetworkName ?? networkName;
  const labels = {
    [runIdLabelName]: options.runId,
    ...options.labels,
  };

  return {
    runId: options.runId,
    image,
    volumeName,
    networkName: agentNetworkName,
    ownedNetworkName,
    workspacePath,
    async create(): Promise<void> {
      await runner.run(volumeCreateArgs(volumeName, labels));
      if (ownedNetworkName !== null) {
        await runner.run(networkCreateArgs(ownedNetworkName, labels));
      }
    },
    async cloneRepository(): Promise<void> {
      await runner.run(
        dockerRunArgs({
          image,
          networkName: agentNetworkName,
          volumeName,
          workspacePath,
          labels,
          env: options.env ?? {},
          command: `git clone ${shellQuote(options.cloneUrl)} .`,
        }),
      );
    },
    async runCommand(command: string): Promise<void> {
      await runner.run(
        dockerRunArgs({
          image,
          networkName: agentNetworkName,
          volumeName,
          workspacePath,
          labels,
          env: options.env ?? {},
          command,
        }),
      );
    },
    async cleanup(): Promise<void> {
      if (ownedNetworkName !== null) {
        await runner.run(["network", "rm", ownedNetworkName]);
      }
      await runner.run(["volume", "rm", volumeName]);
    },
  };
}

export async function cleanupDockerResources(
  resources: DockerResourceNames,
  runner: DockerRunner = execaDockerRunner,
): Promise<void> {
  await runner.run(["network", "rm", resources.networkName]);
  await runner.run(["volume", "rm", resources.volumeName]);
}

export function dockerResourceNames(runId: string): DockerResourceNames {
  const safeRunId = runId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (safeRunId === "") {
    throw new Error("Run id must contain at least one Docker-safe character.");
  }

  return {
    volumeName: `codex-cage-${safeRunId}-workspace`,
    networkName: `codex-cage-${safeRunId}`,
  };
}

export function volumeCreateArgs(
  volumeName: string,
  labels: Record<string, string>,
): string[] {
  return ["volume", "create", ...labelArgs(labels), volumeName];
}

export function networkCreateArgs(
  networkName: string,
  labels: Record<string, string>,
): string[] {
  return ["network", "create", ...labelArgs(labels), networkName];
}

type DockerRunArgsInput = {
  image: string;
  networkName: string;
  volumeName: string;
  workspacePath: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  command: string;
};

export function dockerRunArgs(input: DockerRunArgsInput): string[] {
  return [
    "run",
    "--rm",
    ...labelArgs(input.labels),
    "--network",
    input.networkName,
    "--mount",
    `type=volume,source=${input.volumeName},target=${input.workspacePath}`,
    "--workdir",
    input.workspacePath,
    "--user",
    "agent",
    ...envArgs(input.env),
    input.image,
    "sh",
    "-lc",
    input.command,
  ];
}

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries({ "codex-cage.managed": "true", ...labels }).flatMap(
    ([key, value]) => ["--label", `${key}=${value}`],
  );
}

function envArgs(env: Record<string, string>): string[] {
  return Object.keys(env)
    .sort()
    .flatMap((name) => ["--env", name]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
