import assert from "node:assert/strict";
import test from "node:test";
import {
  createDockerSandbox,
  dockerResourceNames,
  dockerRunArgs,
  networkCreateArgs,
  volumeCreateArgs,
  type DockerRunner,
} from "../src/docker.js";

function recordingRunner(): DockerRunner & { calls: string[][] } {
  const calls: string[][] = [];

  return {
    calls,
    async run(args: string[]): Promise<void> {
      calls.push(args);
    },
  };
}

test("dockerResourceNames creates stable Docker-safe resource names", () => {
  assert.deepEqual(dockerResourceNames("RUN 123/ABC"), {
    volumeName: "codex-cage-run-123-abc-workspace",
    networkName: "codex-cage-run-123-abc",
  });
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
    image: "codex-cage/base:0.1.0",
    networkName: "codex-cage-run-1",
    volumeName: "codex-cage-run-1-workspace",
    workspacePath: "/workspace",
    labels: { "codex-cage.run_id": "run-1" },
    env: { GITHUB_TOKEN: "secret", OPENAI_API_KEY: "secret" },
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
  assert.deepEqual(runner.calls[0]?.slice(0, 2), ["volume", "create"]);
  assert.deepEqual(runner.calls[1]?.slice(0, 2), ["network", "create"]);
  assert.equal(
    runner.calls[2]?.some((arg) => arg.includes("git clone")),
    true,
  );
  assert.equal(runner.calls[3]?.at(-1), "npm test");
  assert.deepEqual(runner.calls[4], ["network", "rm", "codex-cage-run-1"]);
  assert.deepEqual(runner.calls[5], ["volume", "rm", "codex-cage-run-1-workspace"]);
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
  assert.deepEqual(runner.calls[0]?.slice(0, 2), ["volume", "create"]);
  assert.equal(
    runner.calls.some((call) => call[0] === "network"),
    false,
  );
  assert.equal(
    runner.calls[1]?.at((runner.calls[1] ?? []).indexOf("--network") + 1),
    "codex-cage-run-1_default",
  );
  assert.equal(
    runner.calls[2]?.at((runner.calls[2] ?? []).indexOf("--network") + 1),
    "codex-cage-run-1_default",
  );
  assert.equal(runner.calls.flat().includes("/var/run/docker.sock"), false);
  assert.deepEqual(runner.calls[3], ["volume", "rm", "codex-cage-run-1-workspace"]);
});
