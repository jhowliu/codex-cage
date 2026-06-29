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

export type DockerCommandOptions = {
  env?: Record<string, string>;
  codexAuthFilePath?: string | undefined;
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
  runCommand(command: string, options?: DockerCommandOptions): Promise<void>;
  cleanup(): Promise<void>;
};

export type DockerResourceNames = {
  volumeName: string;
  networkName: string;
};

export type RuntimeImageBuildOptions = {
  runId: string;
  dockerfilePath: string;
  contextPath: string;
  imageName?: string;
  labels?: Record<string, string>;
  runner?: DockerRunner;
};

export type RuntimeImageBuildResult = {
  image: string;
  dockerfilePath: string;
  contextPath: string;
};

export type CleanupDockerOptions = {
  all?: boolean;
  runner?: DockerCommandRunner;
};

export type CleanupDockerReport = {
  containers: string[];
  images: string[];
  networks: string[];
  volumes: string[];
  skippedActiveRunIds: string[];
};

export const defaultSandboxImage = "ghcr.io/jhowliu/codex-cage/base:0.1.1";
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
      const env = options.env ?? {};
      const remoteUrl = unauthenticatedRemoteUrl(options.cloneUrl);
      await runner.run(
        dockerRunArgs({
          image,
          networkName: agentNetworkName,
          volumeName,
          workspacePath,
          labels,
          env,
          command: [
            `git clone ${shellQuote(remoteUrl)} .`,
            `git remote set-url origin ${shellQuote(remoteUrl)}`,
          ].join(" && "),
        }),
        { env },
      );
    },
    async runCommand(
      command: string,
      commandOptions: DockerCommandOptions = {},
    ): Promise<void> {
      const env = commandOptions.env ?? {};
      await runner.run(
        dockerRunArgs({
          image,
          networkName: agentNetworkName,
          volumeName,
          workspacePath,
          labels,
          env,
          codexAuthFilePath: commandOptions.codexAuthFilePath,
          command,
        }),
        { env },
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

export async function buildRuntimeImage(
  options: RuntimeImageBuildOptions,
): Promise<RuntimeImageBuildResult> {
  const runner = options.runner ?? execaDockerRunner;
  const image = options.imageName ?? runtimeImageName(options.runId);
  const labels = {
    [runIdLabelName]: options.runId,
    "codex-cage.kind": "runtime-image",
    ...options.labels,
  };

  await runner.run(
    dockerBuildArgs({
      image,
      dockerfilePath: options.dockerfilePath,
      contextPath: options.contextPath,
      labels,
    }),
  );

  return {
    image,
    dockerfilePath: options.dockerfilePath,
    contextPath: options.contextPath,
  };
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
  const imagesToRemove = all ? await listManagedImages(runner) : [];

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

  if (imagesToRemove.length > 0) {
    await runRequiredDockerCommand(runner, [
      "image",
      "rm",
      ...imagesToRemove.map((image) => image.id),
    ]);
  }

  return {
    containers: containersToRemove,
    images: imagesToRemove.map((image) => image.name),
    networks: networksToRemove.map((resource) => resource.name),
    volumes: volumesToRemove.map((resource) => resource.name),
    skippedActiveRunIds: all ? [] : [...activeRunIds].sort(),
  };
}

export function dockerResourceNames(runId: string): DockerResourceNames {
  const safeRunId = safeDockerNameSegment(runId);

  return {
    volumeName: `codex-cage-${safeRunId}-workspace`,
    networkName: `codex-cage-${safeRunId}`,
  };
}

export function runtimeImageName(runId: string): string {
  return `codex-cage/runtime-${safeDockerNameSegment(runId)}:latest`;
}

export function unauthenticatedRemoteUrl(cloneUrl: string): string {
  let url: URL;

  try {
    url = new URL(cloneUrl);
  } catch {
    return cloneUrl;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return cloneUrl;
  }

  url.username = "";
  url.password = "";
  return url.toString();
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

export function dockerBuildArgs(input: {
  image: string;
  dockerfilePath: string;
  contextPath: string;
  labels: Record<string, string>;
}): string[] {
  return [
    "build",
    "--file",
    input.dockerfilePath,
    "--tag",
    input.image,
    ...labelArgs(input.labels),
    input.contextPath,
  ];
}

type DockerRunArgsInput = {
  image: string;
  networkName: string;
  volumeName: string;
  workspacePath: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  codexAuthFilePath?: string | undefined;
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
    ...codexAuthMountArgs(input.codexAuthFilePath),
    ...envArgs(input.env),
    input.image,
    "sh",
    "-lc",
    commandWithAuth(input.command, input),
  ];
}

function commandWithAuth(command: string, input: DockerRunArgsInput): string {
  return commandWithGitHubAuth(
    commandWithCodexAuth(command, input.codexAuthFilePath),
    input.env,
  );
}

function codexAuthMountArgs(codexAuthFilePath: string | undefined): string[] {
  if (codexAuthFilePath === undefined) {
    return [];
  }

  return [
    "--mount",
    `type=bind,source=${codexAuthFilePath},target=/tmp/codex-auth.json,readonly`,
  ];
}

function commandWithCodexAuth(
  command: string,
  codexAuthFilePath: string | undefined,
): string {
  if (codexAuthFilePath === undefined) {
    return command;
  }

  return [
    'if [ -f /tmp/codex-auth.json ] && [ -z "${OPENAI_API_KEY:-}" ]; then mkdir -p /home/agent/.codex',
    "cp /tmp/codex-auth.json /home/agent/.codex/auth.json",
    "chmod 600 /home/agent/.codex/auth.json",
    "fi",
    command,
  ].join("; ");
}

export function commandWithGitHubAuth(
  command: string,
  env: Record<string, string>,
): string {
  if (env.GITHUB_TOKEN === undefined && env.GH_TOKEN === undefined) {
    return command;
  }

  return [
    "tmp_git_askpass=$(mktemp)",
    "cat > \"$tmp_git_askpass\" <<'EOF'",
    "#!/bin/sh",
    'case "$1" in',
    '*Username*) printf "%s\\n" "x-access-token" ;;',
    '*Password*) printf "%s\\n" "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;;',
    '*) printf "%s\\n" ;;',
    "esac",
    "EOF",
    'chmod 700 "$tmp_git_askpass"',
    'export GIT_ASKPASS="$tmp_git_askpass" GIT_TERMINAL_PROMPT=0',
    "trap 'rm -f \"$tmp_git_askpass\"' EXIT",
    command,
  ].join("\n");
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

type ManagedImage = {
  id: string;
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

async function listManagedImages(runner: DockerCommandRunner): Promise<ManagedImage[]> {
  const result = await runRequiredDockerCommand(runner, [
    "image",
    "ls",
    "--filter",
    `label=${managedLabel}`,
    "--format",
    `{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Label "${runIdLabelName}"}}`,
  ]);

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [id, name, runId] = line.split("\t");

      if (id === undefined || name === undefined) {
        throw new Error(`Unexpected docker image ls output: ${line}`);
      }

      return {
        id,
        name,
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

function safeDockerNameSegment(value: string): string {
  const safeValue = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (safeValue === "") {
    throw new Error("Value must contain at least one Docker-safe character.");
  }

  return safeValue;
}
