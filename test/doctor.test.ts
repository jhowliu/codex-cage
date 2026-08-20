import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorProject, type DoctorCommandRunner } from "../src/doctor.js";
import { GENERATED_WORKFLOW_MARKER } from "../src/setup.js";

test("doctor reports missing configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-doctor-"));
  try {
    const result = await doctorProject(cwd);
    assert.equal(result.healthy, false);
    assert.equal(result.checks[0]?.name, "configuration");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor validates configured Actions resources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-doctor-"));
  const names = [
    "codex-cage:run",
    "codex-cage:in-progress",
    "codex-cage:ready-for-review",
    "codex-cage:blocked",
  ];
  const runner: DoctorCommandRunner = async (command, args) => {
    if (command === "gh" && args[0] === "secret") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: "OPENAI_API_KEY" },
          { name: "CODEX_CAGE_GITHUB_TOKEN" },
        ]),
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "label") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(names.map((name) => ({ name }))),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  try {
    await mkdir(join(cwd, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(cwd, ".codex-cage.yml"),
      "verify:\n  - npm test\nactions:\n  enabled: true\n  codex_cage_version: 0.1.0\n",
      "utf8",
    );
    await writeFile(
      join(cwd, ".github", "workflows", "codex-cage.yml"),
      `${GENERATED_WORKFLOW_MARKER}name: test\n`,
      "utf8",
    );

    const result = await doctorProject(cwd, runner);
    assert.equal(result.healthy, true);
    assert.ok(result.checks.some((check) => check.name === "workflow"));
    assert.ok(result.checks.some((check) => check.name === "secret:OPENAI_API_KEY"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor checks local requirements without requiring Actions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-cage-doctor-"));
  const runner: DoctorCommandRunner = async (command) => ({
    exitCode: command === "docker" ? 1 : 0,
    stdout: "true",
    stderr: "",
  });
  try {
    await writeFile(
      join(cwd, ".codex-cage.yml"),
      "verify:\n  - npm test\nactions:\n  enabled: false\n",
      "utf8",
    );
    const result = await doctorProject(cwd, runner);

    assert.equal(result.healthy, true);
    assert.ok(
      result.checks.some(
        (check) => check.name === "docker" && check.status === "warning",
      ),
    );
    assert.ok(
      result.checks.some(
        (check) => check.name === "github-actions" && check.status === "pass",
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
