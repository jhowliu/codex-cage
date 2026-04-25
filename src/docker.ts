import { execa } from "execa";

export type DockerRunner = {
  run: (args: string[], options?: DockerRunOptions) => Promise<void>;
};

export type DockerCommandRunner = {
  run: (args: string[]) => Promise<DockerCommandResult>;
};

export type DockerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DockerRunOptions = {
  env?: Record<string, string>;
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

export type CleanupDockerOptions = {
  all?: boolean;
  runner?: DockerCommandRunner;
};

export type CleanupDockerReport = {
  containers: string[];
  networks: string[];
  volumes: string[];
  skippedActiveRunIds: string[];
};

export const defaultSandboxImage = "codex-cage/base:0.1.0";
export const defaultWorkspacePath = "/workspace";

const runIdLabelName = "codex-cage.run_id";
const managedLabelName = "codex-cage.managed";
const managedLabel = `${managedLabelName}=true`;

export const execaDockerRunner: DockerRunner = {
  async run(args: string[], options: DockerRunOptions = {}): Promise<void> {
    if (options.env === undefined) {
      await execa("docker", args, { stdio: "inherit" });
      return;
    }

    await execa("docker", args, { env: options.env, stdio: "inherit" });
  },
};

export const execaDockerCommandRunner: DockerCommandRunner = {
  async run(args: string[]): Promise<DockerCommandResult> {
    const result = await execa("docker", args, { reject: false });

    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
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
        { env: options.env ?? {} },
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
        { env: options.env ?? {} },
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

export async function cleanupManagedDockerResources(
  options: CleanupDockerOptions = {},
): Promise<CleanupDockerReport> {
  const runner = options.runner ?? execaDockerCommandRunner;
  const all = options.all === true;
  const containers = await listManagedContainers(runner);
  const activeRunIds = new Set(
    containers
      .filter((container) => container.state === "running")
      .map((container) => container.runId)
      .filter((runId): runId is string => runId !== null),
  );
  const containersToRemove = containers
    .filter((container) => all || container.state !== "running")
    .map((container) => container.id);
  const networksToRemove = (await listManagedNamedResources(runner, "network")).filter(
    (resource) => all || resource.runId === null || !activeRunIds.has(resource.runId),
  );
  const volumesToRemove = (await listManagedNamedResources(runner, "volume")).filter(
    (resource) => all || resource.runId === null || !activeRunIds.has(resource.runId),
  );

  if (containersToRemove.length > 0) {
    await runRequiredDockerCommand(runner, [
      "rm",
      ...(all ? ["--force"] : []),
      ...containersToRemove,
    ]);
  }

  if (networksToRemove.length > 0) {
    await runRequiredDockerCommand(runner, [
      "network",
      "rm",
      ...networksToRemove.map((resource) => resource.name),
    ]);
  }

  if (volumesToRemove.length > 0) {
    await runRequiredDockerCommand(runner, [
      "volume",
      "rm",
      ...volumesToRemove.map((resource) => resource.name),
    ]);
  }

  return {
    containers: containersToRemove,
    networks: networksToRemove.map((resource) => resource.name),
    volumes: volumesToRemove.map((resource) => resource.name),
    skippedActiveRunIds: all ? [] : [...activeRunIds].sort(),
  };
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
  return Object.entries({ [managedLabelName]: "true", ...labels }).flatMap(
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

type ManagedContainer = {
  id: string;
  state: string;
  runId: string | null;
};

type ManagedNamedResource = {
  name: string;
  runId: string | null;
};

async function listManagedContainers(
  runner: DockerCommandRunner,
): Promise<ManagedContainer[]> {
  const result = await runRequiredDockerCommand(runner, [
    "ps",
    "--all",
    "--filter",
    `label=${managedLabel}`,
    "--format",
    `{{.ID}}\t{{.State}}\t{{.Label "${runIdLabelName}"}}`,
  ]);

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [id, state, runId] = line.split("\t");

      if (id === undefined || state === undefined) {
        throw new Error(`Unexpected docker ps output: ${line}`);
      }

      return {
        id,
        state,
        runId: runId === undefined || runId === "" ? null : runId,
      };
    });
}

async function listManagedNamedResources(
  runner: DockerCommandRunner,
  resourceType: "network" | "volume",
): Promise<ManagedNamedResource[]> {
  const result = await runRequiredDockerCommand(runner, [
    resourceType,
    "ls",
    "--filter",
    `label=${managedLabel}`,
    "--format",
    `{{.Name}}\t{{.Label "${runIdLabelName}"}}`,
  ]);

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name, runId] = line.split("\t");

      if (name === undefined) {
        throw new Error(`Unexpected docker ${resourceType} ls output: ${line}`);
      }

      return {
        name,
        runId: runId === undefined || runId === "" ? null : runId,
      };
    });
}

async function runRequiredDockerCommand(
  runner: DockerCommandRunner,
  args: string[],
): Promise<DockerCommandResult> {
  const result = await runner.run(args);

  if (result.exitCode !== 0) {
    throw new Error(`Docker command failed: docker ${args.join(" ")}\n${result.stderr}`);
  }

  return result;
}
