import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeImage,
  cleanupManagedDockerResources,
  createDockerSandbox,
  defaultSandboxImage,
  dockerBuildArgs,
  dockerResourceNames,
  dockerRunArgs,
  networkCreateArgs,
  runtimeImageName,
  unauthenticatedRemoteUrl,
  volumeCreateArgs,
  type DockerCommandResult,
  type DockerCommandRunner,
  type DockerRunOptions,
  type DockerRunner,
} from "../src/docker.js";

function recordingRunner(): DockerRunner & {
  calls: Array<{ args: string[]; options: DockerRunOptions }>;
} {
  const calls: Array<{ args: string[]; options: DockerRunOptions }> = [];

  return {
    calls,
    async run(args: string[], options: DockerRunOptions = {}): Promise<void> {
      calls.push({ args, options });
    },
  };
}

function result(stdout = "", exitCode = 0, stderr = ""): DockerCommandResult {
  return { exitCode, stdout, stderr };
}

function recordingCommandRunner(results: DockerCommandResult[]): DockerCommandRunner & {
  calls: string[][];
} {
  const calls: string[][] = [];

  return {
    calls,
    async run(args: string[]): Promise<DockerCommandResult> {
      calls.push(args);
      const next = results.shift();

      if (next === undefined) {
        throw new Error(`Unexpected docker command: docker ${args.join(" ")}`);
      }

      return next;
    },
  };
}

test("dockerResourceNames creates stable Docker-safe resource names", () => {
  assert.deepEqual(dockerResourceNames("RUN 123/ABC"), {
    volumeName: "codex-cage-run-123-abc-workspace",
    networkName: "codex-cage-run-123-abc",
  });
  assert.equal(runtimeImageName("RUN 123/ABC"), "codex-cage/runtime-run-123-abc:latest");
});

test("unauthenticatedRemoteUrl strips HTTPS credentials", () => {
  assert.equal(
    unauthenticatedRemoteUrl(
      "https://x-access-token:ghp_secret%40value@github.com/jhowliu/codex-cage.git",
    ),
    "https://github.com/jhowliu/codex-cage.git",
  );
  assert.equal(
    unauthenticatedRemoteUrl("git@github.com:jhowliu/codex-cage.git"),
    "git@github.com:jhowliu/codex-cage.git",
  );
});

test("volume and network resources carry managed labels", () => {
  assert.deepEqual(volumeCreateArgs("workspace", { "codex-cage.run_id": "run-1" }), [
    "volume",
    "create",
    "--label",
    "codex-cage.managed=true",
    "--label",
    "codex-cage.run_id=run-1",
    "workspace",
  ]);
  assert.deepEqual(networkCreateArgs("network", { "codex-cage.run_id": "run-1" }), [
    "network",
    "create",
    "--label",
    "codex-cage.managed=true",
    "--label",
    "codex-cage.run_id=run-1",
    "network",
  ]);
});

test("dockerRunArgs uses volume workspace and avoids host-sensitive mounts", () => {
  const args = dockerRunArgs({
    image: defaultSandboxImage,
    networkName: "codex-cage-run-1",
    volumeName: "codex-cage-run-1-workspace",
    workspacePath: "/workspace",
    labels: { "codex-cage.run_id": "run-1" },
    env: { APP_ENV: "test" },
    command: "npm test",
  });
  const joinedArgs = args.join(" ");

  assert.equal(args.includes("--user"), true);
  assert.equal(args.at(args.indexOf("--user") + 1), "agent");
  assert.equal(args.includes("--publish"), false);
  assert.equal(args.includes("-p"), false);
  assert.equal(joinedArgs.includes("/var/run/docker.sock"), false);
  assert.equal(joinedArgs.includes(".ssh"), false);
  assert.equal(joinedArgs.includes(".config/gh"), false);
  assert.equal(joinedArgs.includes("type=bind"), false);
  assert.equal(
    joinedArgs.includes(
      "--mount type=volume,source=codex-cage-run-1-workspace,target=/workspace",
    ),
    true,
  );
  assert.equal(joinedArgs.includes("secret"), false);
  assert.deepEqual(args.slice(-3), ["sh", "-lc", "npm test"]);
});

test("dockerRunArgs wires GitHub auth through command-scoped askpass", () => {
  const args = dockerRunArgs({
    image: defaultSandboxImage,
    networkName: "codex-cage-run-1",
    volumeName: "codex-cage-run-1-workspace",
    workspacePath: "/workspace",
    labels: { "codex-cage.run_id": "run-1" },
    env: { GITHUB_TOKEN: "secret" },
    command: "git fetch origin main",
  });
  const command = args.at(-1) ?? "";
  const joinedArgs = args.join(" ");

  assert.equal(joinedArgs.includes("secret"), false);
  assert.equal(joinedArgs.includes("--env GITHUB_TOKEN"), true);
  assert.match(command, /GIT_ASKPASS/);
  assert.match(command, /\$\{GITHUB_TOKEN:-\$\{GH_TOKEN:-\}\}/);
  assert.match(command, /git fetch origin main/);
});

test("dockerRunArgs can mount only the Codex auth file for OAuth fallback", () => {
  const args = dockerRunArgs({
    image: defaultSandboxImage,
    networkName: "codex-cage-run-1",
    volumeName: "codex-cage-run-1-workspace",
    workspacePath: "/workspace",
    labels: { "codex-cage.run_id": "run-1" },
    env: { GITHUB_TOKEN: "secret" },
    codexAuthFilePath: "/Users/example/.codex/auth.json",
    command: "codex exec hello",
  });
  const joinedArgs = args.join(" ");

  assert.equal(
    joinedArgs.includes(
      "--mount type=bind,source=/Users/example/.codex/auth.json,target=/tmp/codex-auth.json,readonly",
    ),
    true,
  );
  assert.equal(joinedArgs.includes("target=/home/agent/.codex"), false);
  assert.equal(joinedArgs.includes(".config/gh"), false);
  assert.equal((args.at(-1) ?? "").includes("then;"), false);
  assert.match(args.at(-1) ?? "", /cp \/tmp\/codex-auth\.json/);
  assert.match(args.at(-1) ?? "", /codex exec hello/);
  assert.equal(joinedArgs.includes("secret"), false);
});

test("dockerRunArgs omits credential env and OAuth mount for setup and verify commands", () => {
  for (const command of ["npm install", "npm test"]) {
    const args = dockerRunArgs({
      image: defaultSandboxImage,
      networkName: "codex-cage-run-1",
      volumeName: "codex-cage-run-1-workspace",
      workspacePath: "/workspace",
      labels: { "codex-cage.run_id": "run-1" },
      env: { APP_ENV: "test" },
      command,
    });
    const joinedArgs = args.join(" ");

    assert.equal(joinedArgs.includes("GITHUB_TOKEN"), false);
    assert.equal(joinedArgs.includes("GH_TOKEN"), false);
    assert.equal(joinedArgs.includes("OPENAI_API_KEY"), false);
    assert.equal(joinedArgs.includes("/tmp/codex-auth.json"), false);
    assert.deepEqual(args.slice(-3), ["sh", "-lc", command]);
  }
});

test("createDockerSandbox uses command-scoped env and Codex auth mounts", async () => {
  const runner = recordingRunner();
  const sandbox = createDockerSandbox(
    {
      runId: "run-1",
      cloneUrl: "https://github.com/jhowliu/codex-cage.git",
      env: {
        GITHUB_TOKEN: "token",
        OPENAI_API_KEY: "openai",
      },
    },
    runner,
  );

  await sandbox.create();
  await sandbox.cloneRepository();
  await sandbox.runCommand("npm test", { env: { APP_ENV: "test" } });
  await sandbox.runCommand("codex exec hello", {
    env: { OPENAI_API_KEY: "openai" },
    codexAuthFilePath: "/Users/example/.codex/auth.json",
  });

  const verifyArgs = runner.calls[3]?.args ?? [];
  const implementArgs = runner.calls[4]?.args ?? [];

  assert.deepEqual(runner.calls[2]?.options.env, {
    GITHUB_TOKEN: "token",
    OPENAI_API_KEY: "openai",
  });
  assert.deepEqual(runner.calls[3]?.options.env, { APP_ENV: "test" });
  assert.deepEqual(runner.calls[4]?.options.env, { OPENAI_API_KEY: "openai" });
  assert.equal(verifyArgs.join(" ").includes("OPENAI_API_KEY"), false);
  assert.equal(verifyArgs.join(" ").includes("GITHUB_TOKEN"), false);
  assert.equal(verifyArgs.join(" ").includes("/tmp/codex-auth.json"), false);
  assert.equal(implementArgs.join(" ").includes("--env OPENAI_API_KEY"), true);
  assert.equal(implementArgs.join(" ").includes("/tmp/codex-auth.json"), true);
});

test("dockerBuildArgs labels per-run runtime images", () => {
  assert.deepEqual(
    dockerBuildArgs({
      image: "codex-cage/runtime-run-1:latest",
      dockerfilePath: "/repo/.codex-cage/Dockerfile",
      contextPath: "/repo/.codex-cage",
      labels: {
        "codex-cage.run_id": "run-1",
        "codex-cage.kind": "runtime-image",
      },
    }),
    [
      "build",
      "--file",
      "/repo/.codex-cage/Dockerfile",
      "--tag",
      "codex-cage/runtime-run-1:latest",
      "--label",
      "codex-cage.managed=true",
      "--label",
      "codex-cage.run_id=run-1",
      "--label",
      "codex-cage.kind=runtime-image",
      "/repo/.codex-cage",
    ],
  );
});

test("buildRuntimeImage builds a labeled per-run image", async () => {
  const runner = recordingRunner();
  const result = await buildRuntimeImage({
    runId: "run-1",
    dockerfilePath: "/repo/.codex-cage/Dockerfile",
    contextPath: "/repo/.codex-cage",
    runner,
  });

  assert.deepEqual(result, {
    image: "codex-cage/runtime-run-1:latest",
    dockerfilePath: "/repo/.codex-cage/Dockerfile",
    contextPath: "/repo/.codex-cage",
  });
  assert.deepEqual(runner.calls[0]?.args.slice(0, 5), [
    "build",
    "--file",
    "/repo/.codex-cage/Dockerfile",
    "--tag",
    "codex-cage/runtime-run-1:latest",
  ]);
});

test("createDockerSandbox creates resources, clones into volume, runs commands, and cleans up", async () => {
  const runner = recordingRunner();
  const sandbox = createDockerSandbox(
    {
      runId: "run-1",
      cloneUrl: "https://x-access-token:token@github.com/jhowliu/codex-cage.git",
      env: {
        GITHUB_TOKEN: "token",
      },
    },
    runner,
  );

  await sandbox.create();
  await sandbox.cloneRepository();
  await sandbox.runCommand("npm test");
  await sandbox.cleanup();

  assert.equal(sandbox.volumeName, "codex-cage-run-1-workspace");
  assert.equal(sandbox.networkName, "codex-cage-run-1");
  assert.equal(sandbox.ownedNetworkName, "codex-cage-run-1");
  assert.equal(runner.calls.length, 6);
  assert.deepEqual(runner.calls[0]?.args.slice(0, 2), ["volume", "create"]);
  assert.deepEqual(runner.calls[1]?.args.slice(0, 2), ["network", "create"]);
  assert.equal(
    runner.calls[2]?.args.some((arg) => arg.includes("git clone")),
    true,
  );
  assert.match(
    runner.calls[2]?.args.at(-1) ?? "",
    /git clone 'https:\/\/github\.com\/jhowliu\/codex-cage\.git' \./,
  );
  assert.match(
    runner.calls[2]?.args.at(-1) ?? "",
    /git remote set-url origin 'https:\/\/github\.com\/jhowliu\/codex-cage\.git'/,
  );
  assert.doesNotMatch(
    (runner.calls[2]?.args.at(-1) ?? "").split("git remote set-url origin").at(1) ?? "",
    /token/,
  );
  assert.equal(runner.calls[3]?.args.at(-1), "npm test");
  assert.deepEqual(runner.calls[2]?.options.env, { GITHUB_TOKEN: "token" });
  assert.deepEqual(runner.calls[3]?.options.env, {});
  assert.deepEqual(runner.calls[4]?.args, ["network", "rm", "codex-cage-run-1"]);
  assert.deepEqual(runner.calls[5]?.args, ["volume", "rm", "codex-cage-run-1-workspace"]);
});

test("createDockerSandbox can attach agent commands to an externally managed service network", async () => {
  const runner = recordingRunner();
  const sandbox = createDockerSandbox(
    {
      runId: "run-1",
      cloneUrl: "https://github.com/jhowliu/codex-cage.git",
      serviceNetworkName: "codex-cage-run-1_default",
    },
    runner,
  );

  await sandbox.create();
  await sandbox.cloneRepository();
  await sandbox.runCommand("npm test");
  await sandbox.cleanup();

  assert.equal(sandbox.networkName, "codex-cage-run-1_default");
  assert.equal(sandbox.ownedNetworkName, null);
  assert.equal(runner.calls.length, 4);
  assert.deepEqual(runner.calls[0]?.args.slice(0, 2), ["volume", "create"]);
  assert.equal(
    runner.calls.some((call) => call.args[0] === "network"),
    false,
  );
  assert.equal(
    runner.calls[1]?.args.at((runner.calls[1]?.args ?? []).indexOf("--network") + 1),
    "codex-cage-run-1_default",
  );
  assert.equal(
    runner.calls[2]?.args.at((runner.calls[2]?.args ?? []).indexOf("--network") + 1),
    "codex-cage-run-1_default",
  );
  assert.equal(
    runner.calls.flatMap((call) => call.args).includes("/var/run/docker.sock"),
    false,
  );
  assert.deepEqual(runner.calls[3]?.args, ["volume", "rm", "codex-cage-run-1-workspace"]);
});

test("cleanupManagedDockerResources removes stopped resources and skips active runs by default", async () => {
  const runner = recordingCommandRunner([
    result("active1\trunning\trun-active\nstopped1\texited\trun-stale\n"),
    result("codex-cage-run-active\trun-active\ncodex-cage-run-stale\trun-stale\n"),
    result(
      "codex-cage-run-active-workspace\trun-active\ncodex-cage-run-stale-workspace\trun-stale\n",
    ),
    result(),
    result(),
    result(),
  ]);

  const report = await cleanupManagedDockerResources({ runner });

  assert.deepEqual(report, {
    containers: ["stopped1"],
    images: [],
    networks: ["codex-cage-run-stale"],
    volumes: ["codex-cage-run-stale-workspace"],
    skippedActiveRunIds: ["run-active"],
  });
  assert.deepEqual(runner.calls, [
    [
      "ps",
      "--all",
      "--filter",
      "label=codex-cage.managed=true",
      "--format",
      '{{.ID}}\t{{.State}}\t{{.Label "codex-cage.run_id"}}',
    ],
    [
      "network",
      "ls",
      "--filter",
      "label=codex-cage.managed=true",
      "--format",
      '{{.Name}}\t{{.Label "codex-cage.run_id"}}',
    ],
    [
      "volume",
      "ls",
      "--filter",
      "label=codex-cage.managed=true",
      "--format",
      '{{.Name}}\t{{.Label "codex-cage.run_id"}}',
    ],
    ["rm", "stopped1"],
    ["network", "rm", "codex-cage-run-stale"],
    ["volume", "rm", "codex-cage-run-stale-workspace"],
  ]);
});

test("cleanupManagedDockerResources --all removes active managed resources explicitly", async () => {
  const runner = recordingCommandRunner([
    result("active1\trunning\trun-active\nstopped1\texited\trun-stale\n"),
    result("codex-cage-run-active\trun-active\ncodex-cage-run-stale\trun-stale\n"),
    result(
      "codex-cage-run-active-workspace\trun-active\ncodex-cage-run-stale-workspace\trun-stale\n",
    ),
    result("image1\tcodex-cage/runtime-run-stale:latest\trun-stale\n"),
    result(),
    result(),
    result(),
    result(),
  ]);

  const report = await cleanupManagedDockerResources({ all: true, runner });

  assert.deepEqual(report, {
    containers: ["active1", "stopped1"],
    images: ["codex-cage/runtime-run-stale:latest"],
    networks: ["codex-cage-run-active", "codex-cage-run-stale"],
    volumes: ["codex-cage-run-active-workspace", "codex-cage-run-stale-workspace"],
    skippedActiveRunIds: [],
  });
  assert.deepEqual(runner.calls.at(3), [
    "image",
    "ls",
    "--filter",
    "label=codex-cage.managed=true",
    "--format",
    '{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Label "codex-cage.run_id"}}',
  ]);
  assert.deepEqual(runner.calls.at(4), ["rm", "--force", "active1", "stopped1"]);
  assert.deepEqual(runner.calls.at(5), [
    "network",
    "rm",
    "codex-cage-run-active",
    "codex-cage-run-stale",
  ]);
  assert.deepEqual(runner.calls.at(6), [
    "volume",
    "rm",
    "codex-cage-run-active-workspace",
    "codex-cage-run-stale-workspace",
  ]);
  assert.deepEqual(runner.calls.at(7), ["image", "rm", "image1"]);
});

test("cleanupManagedDockerResources reports no-op cleanup without touching artifacts", async () => {
  const runner = recordingCommandRunner([result(), result(), result()]);

  const report = await cleanupManagedDockerResources({ runner });

  assert.deepEqual(report, {
    containers: [],
    images: [],
    networks: [],
    volumes: [],
    skippedActiveRunIds: [],
  });
  assert.equal(runner.calls.length, 3);
});
