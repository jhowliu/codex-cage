import assert from "node:assert/strict";
import test from "node:test";
import {
  composeBaseArgs,
  composeProjectName,
  createComposeProject,
  hasComposeServices,
  readyCommandRunArgs,
  type ComposeRunner,
} from "../src/compose.js";
import type { DockerRunner } from "../src/docker.js";

function recordingComposeRunner(): ComposeRunner & { calls: string[][] } {
  const calls: string[][] = [];

  return {
    calls,
    async run(args: string[]): Promise<void> {
      calls.push(args);
    },
  };
}

function recordingDockerRunner(): DockerRunner & { calls: string[][] } {
  const calls: string[][] = [];

  return {
    calls,
    async run(args: string[]): Promise<void> {
      calls.push(args);
    },
  };
}

test("composeProjectName creates stable per-run project names", () => {
  assert.equal(composeProjectName("RUN 123/ABC"), "codex-cage-run-123-abc");
});

test("composeBaseArgs scopes compose to project name and project directory", () => {
  assert.deepEqual(
    composeBaseArgs({
      runId: "run-1",
      composeFile: "docker-compose.yml",
      projectDirectory: "/workspace",
    }),
    [
      "--project-name",
      "codex-cage-run-1",
      "--project-directory",
      "/workspace",
      "-f",
      "docker-compose.yml",
    ],
  );
});

test("hasComposeServices reports whether compose is configured", () => {
  assert.equal(hasComposeServices({ compose: null, ready: [] }), false);
  assert.equal(hasComposeServices({ compose: "docker-compose.yml", ready: [] }), true);
});

test("compose project starts and tears down services with volumes", async () => {
  const runner = recordingComposeRunner();
  const project = createComposeProject({
    runId: "run-1",
    composeFile: "docker-compose.yml",
    projectDirectory: "/workspace",
    runner,
  });

  await project.up();
  await project.down();

  assert.equal(project.projectName, "codex-cage-run-1");
  assert.equal(project.networkName, "codex-cage-run-1_default");
  assert.deepEqual(runner.calls, [
    [
      "--project-name",
      "codex-cage-run-1",
      "--project-directory",
      "/workspace",
      "-f",
      "docker-compose.yml",
      "up",
      "-d",
    ],
    [
      "--project-name",
      "codex-cage-run-1",
      "--project-directory",
      "/workspace",
      "-f",
      "docker-compose.yml",
      "down",
      "-v",
    ],
  ]);
});

test("compose readiness commands run on compose network without Docker socket or host ports", async () => {
  const dockerRunner = recordingDockerRunner();
  const project = createComposeProject({
    runId: "run-1",
    composeFile: "docker-compose.yml",
    projectDirectory: "/workspace",
    readyCommands: ["pg_isready -h db -U postgres"],
    dockerRunner,
  });

  await project.waitUntilReady();

  const readyArgs = dockerRunner.calls[0] ?? [];
  const joinedArgs = readyArgs.join(" ");

  assert.equal(readyArgs.includes("--network"), true);
  assert.equal(
    readyArgs.at(readyArgs.indexOf("--network") + 1),
    "codex-cage-run-1_default",
  );
  assert.equal(readyArgs.includes("--publish"), false);
  assert.equal(readyArgs.includes("-p"), false);
  assert.equal(joinedArgs.includes("/var/run/docker.sock"), false);
  assert.equal(joinedArgs.includes("type=bind"), false);
  assert.equal(joinedArgs.includes("type=volume"), false);
  assert.deepEqual(readyArgs.slice(-3), ["sh", "-lc", "pg_isready -h db -U postgres"]);
});

test("readyCommandRunArgs is explicit about the no-workspace readiness container", () => {
  const args = readyCommandRunArgs({
    image: "codex-cage/base:0.1.0",
    networkName: "codex-cage-run-1_default",
    runId: "run-1",
    command: "redis-cli -h redis ping",
  });

  assert.equal(args.includes("--mount"), false);
  assert.equal(args.includes("--workdir"), false);
  assert.equal(args.at(args.indexOf("--user") + 1), "agent");
  assert.deepEqual(args.slice(-3), ["sh", "-lc", "redis-cli -h redis ping"]);
});
