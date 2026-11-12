import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorProject, type DoctorCommandRunner } from "../src/doctor.js";
import { GENERATED_WORKFLOW_MARKER } from "../src/setup.js";

// Doctor reads the machine-wide credential file; isolate it per test process.
const configHome = await mkdtemp(join(tmpdir(), "agent-cage-config-"));
process.env.XDG_CONFIG_HOME = configHome;
const globalEnvPath = join(configHome, "agent-cage", "env");
// Keep the developer's real Codex login out of these tests.
process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "agent-cage-codex-home-"));

const quietRunner: DoctorCommandRunner = async () => ({
  exitCode: 0,
  stdout: "true",
  stderr: "",
});

// Like quietRunner, but gh has no signed-in account.
const signedOutRunner: DoctorCommandRunner = async (command, args, cwd) =>
  command === "gh" && args[0] === "auth"
    ? { exitCode: 1, stdout: "", stderr: "not logged in" }
    : quietRunner(command, args, cwd);

test("doctor reports missing configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-doctor-"));
  try {
    const result = await doctorProject(cwd);
    assert.equal(result.healthy, false);
    assert.equal(result.checks[0]?.name, "configuration");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor validates configured Actions resources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-doctor-"));
  const names = [
    "agent-cage:run",
    "agent-cage:in-progress",
    "agent-cage:ready-for-review",
    "agent-cage:blocked",
  ];
  const runner: DoctorCommandRunner = async (command, args) => {
    if (command === "gh" && args[0] === "secret") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: "OPENAI_API_KEY" },
          { name: "AGENT_CAGE_GITHUB_TOKEN" },
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
      join(cwd, ".agent-cage.yml"),
      "verify:\n  - npm test\nactions:\n  enabled: true\n  agent_cage_version: 0.1.0\n",
      "utf8",
    );
    await writeFile(
      join(cwd, ".github", "workflows", "agent-cage.yml"),
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
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-doctor-"));
  const runner: DoctorCommandRunner = async (command) => ({
    exitCode: command === "docker" ? 1 : 0,
    stdout: "true",
    stderr: "",
  });
  try {
    await writeFile(
      join(cwd, ".agent-cage.yml"),
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

test("doctor checks Claude credentials when Claude implements", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-doctor-"));
  try {
    await writeFile(
      join(cwd, ".agent-cage.yml"),
      "verify:\n  - npm test\nagent:\n  implement:\n    provider: claude\n",
      "utf8",
    );
    const missing = await doctorProject(cwd, quietRunner);
    assert.ok(
      missing.checks.some(
        (check) => check.name === "claude-auth" && check.status === "warning",
      ),
    );

    await mkdir(join(configHome, "agent-cage"), { recursive: true });
    await writeFile(globalEnvPath, "CLAUDE_CODE_OAUTH_TOKEN=claude-token\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const present = await doctorProject(cwd, quietRunner);
    assert.ok(
      present.checks.some(
        (check) => check.name === "claude-auth" && check.status === "pass",
      ),
    );
  } finally {
    await rm(globalEnvPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor warns about GitHub credentials and loose permissions in the global file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-doctor-"));
  try {
    await writeFile(join(cwd, ".agent-cage.yml"), "verify:\n  - npm test\n", "utf8");
    await mkdir(join(configHome, "agent-cage"), { recursive: true });
    await writeFile(globalEnvPath, "GITHUB_TOKEN=github-token\n", {
      encoding: "utf8",
      mode: 0o644,
    });
    await chmod(globalEnvPath, 0o644);

    const result = await doctorProject(cwd, signedOutRunner);
    const messages = result.checks
      .filter((check) => check.name === "global-credentials")
      .map((check) => check.message);

    assert.ok(messages.some((message) => message.includes("readable by other users")));
    assert.ok(messages.some((message) => message.includes("ignored GITHUB_TOKEN")));
    assert.ok(
      result.checks.some(
        (check) => check.name === "github-auth" && check.status === "warning",
      ),
    );
  } finally {
    await rm(globalEnvPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor reports which gh account local runs use", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-doctor-"));
  const tokenCalls: (readonly string[])[] = [];
  const runner: DoctorCommandRunner = async (command, args, commandCwd) => {
    if (command === "gh" && args[0] === "auth" && args[1] === "token") {
      tokenCalls.push(args);
      return args.includes("work-account")
        ? { exitCode: 0, stdout: "gh-token\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "no such account" };
    }
    return quietRunner(command, args, commandCwd);
  };
  const githubAuth = async () =>
    (await doctorProject(cwd, runner)).checks.find(
      (check) => check.name === "github-auth",
    );
  try {
    await writeFile(join(cwd, ".agent-cage.yml"), "verify:\n  - npm test\n", "utf8");

    await writeFile(
      join(cwd, ".agent-cage.env"),
      "AGENT_CAGE_GH_USER=work-account\n",
      "utf8",
    );
    const pinned = await githubAuth();
    assert.equal(pinned?.status, "pass");
    assert.match(pinned?.message ?? "", /gh account work-account/);
    assert.ok(tokenCalls.at(-1)?.includes("--user"));

    await writeFile(join(cwd, ".agent-cage.env"), "AGENT_CAGE_GH_USER=gone\n", "utf8");
    const stale = await githubAuth();
    assert.equal(stale?.status, "warning");
    assert.match(stale?.message ?? "", /not signed in as gone/);

    await writeFile(join(cwd, ".agent-cage.env"), "GITHUB_TOKEN=repo-token\n", "utf8");
    const calls = tokenCalls.length;
    assert.equal((await githubAuth())?.status, "pass");
    assert.equal(tokenCalls.length, calls);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function probeProject(config: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-doctor-"));
  await writeFile(join(cwd, ".agent-cage.yml"), config, "utf8");
  await mkdir(join(configHome, "agent-cage"), { recursive: true });
  await writeFile(
    globalEnvPath,
    "CLAUDE_CODE_OAUTH_TOKEN=claude-secret\nOPENAI_API_KEY=sk-secret\n",
    "utf8",
  );
  return cwd;
}

// Answers like quietRunner, except agent probes (`docker run`) get `probe`.
function probeRunner(
  probe: (args: readonly string[]) => {
    exitCode: number;
    stdout: string;
    stderr: string;
  },
  calls: { args: readonly string[]; env: Record<string, string> | undefined }[] = [],
): DoctorCommandRunner {
  return async (command, args, cwd, options) => {
    if (command === "docker" && args[0] === "run") {
      calls.push({ args, env: options?.env });
      return probe(args);
    }
    return quietRunner(command, args, cwd);
  };
}

const twoAgentConfig =
  "verify:\n  - npm test\nruntime:\n  image: agent-cage/base:local\nagent:\n  implement:\n    provider: claude\n  review:\n    provider: codex\n    model: gpt-6.1-sol\n";

test("doctor --probe runs each agent once in the runtime image with its own credentials", async () => {
  const cwd = await probeProject(twoAgentConfig);
  const calls: { args: readonly string[]; env: Record<string, string> | undefined }[] =
    [];
  try {
    const result = await doctorProject(
      cwd,
      probeRunner(() => ({ exitCode: 0, stdout: "{}", stderr: "" }), calls),
      { probe: true },
    );
    const probes = result.checks.filter((check) => check.name.startsWith("agent-probe"));

    assert.equal(result.healthy, true);
    assert.deepEqual(
      probes.map((check) => [check.name, check.status]),
      [
        ["agent-probe:implement", "pass"],
        ["agent-probe:review", "pass"],
      ],
    );
    assert.equal(calls.length, 2);
    const [claudeCall, codexCall] = calls;
    assert.ok(claudeCall?.args.includes("agent-cage/base:local"));
    assert.match(
      claudeCall?.args.at(-1) ?? "",
      /claude -p .*'--model' 'claude-opus-5-5'/,
    );
    assert.deepEqual(Object.keys(claudeCall?.env ?? {}), ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assert.match(codexCall?.args.at(-1) ?? "", /codex exec --model 'gpt-6\.1-sol'/);
    assert.deepEqual(Object.keys(codexCall?.env ?? {}), ["OPENAI_API_KEY"]);
  } finally {
    await rm(globalEnvPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor --probe probes a shared agent assignment once", async () => {
  const cwd = await probeProject("verify:\n  - npm test\n");
  const calls: { args: readonly string[]; env: Record<string, string> | undefined }[] =
    [];
  try {
    const result = await doctorProject(
      cwd,
      probeRunner(() => ({ exitCode: 0, stdout: "{}", stderr: "" }), calls),
      { probe: true },
    );

    assert.equal(calls.length, 1);
    assert.ok(
      result.checks.some((check) => check.name === "agent-probe:implement+review"),
    );
  } finally {
    await rm(globalEnvPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor --probe explains rejected credentials and unavailable models", async () => {
  const cwd = await probeProject(twoAgentConfig);
  try {
    const result = await doctorProject(
      cwd,
      probeRunner((args) =>
        (args.at(-1) ?? "").includes("claude -p")
          ? {
              exitCode: 1,
              stdout:
                '{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate."}',
              stderr: "",
            }
          : {
              exitCode: 1,
              stdout: "",
              stderr:
                "ERROR: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account. key=sk-secret",
            },
      ),
      { probe: true },
    );
    const byName = new Map(result.checks.map((check) => [check.name, check]));

    assert.equal(result.healthy, false);
    assert.equal(byName.get("agent-probe:implement")?.status, "fail");
    assert.match(
      byName.get("agent-probe:implement")?.message ?? "",
      /claude setup-token/,
    );
    assert.equal(byName.get("agent-probe:review")?.status, "fail");
    assert.match(
      byName.get("agent-probe:review")?.message ?? "",
      /codex gpt-6\.1-sol is not available .* too old/,
    );
  } finally {
    await rm(globalEnvPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor --probe reports other failures with the last output line, redacted", async () => {
  const cwd = await probeProject("verify:\n  - npm test\n");
  try {
    const result = await doctorProject(
      cwd,
      probeRunner(() => ({
        exitCode: 2,
        stdout: "",
        stderr: "starting\nboom with sk-secret",
      })),
      { probe: true },
    );
    const probe = result.checks.find((check) => check.name.startsWith("agent-probe"));

    assert.equal(probe?.status, "fail");
    assert.match(probe?.message ?? "", /exit 2\): boom with/);
    assert.doesNotMatch(probe?.message ?? "", /sk-secret/);
  } finally {
    await rm(globalEnvPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor --probe skips agents when Docker is unavailable or in direct mode", async () => {
  const docker = await probeProject("verify:\n  - npm test\n");
  const direct = await probeProject("verify:\n  - npm test\nexecution: direct\n");
  const noDocker: DoctorCommandRunner = async (command, args, cwd) =>
    command === "docker"
      ? { exitCode: 1, stdout: "", stderr: "" }
      : quietRunner(command, args, cwd);
  try {
    const withoutDocker = await doctorProject(docker, noDocker, { probe: true });
    const directMode = await doctorProject(
      direct,
      probeRunner(() => {
        throw new Error("direct mode must not start a container");
      }),
      { probe: true },
    );

    for (const result of [withoutDocker, directMode]) {
      const probe = result.checks.find((check) => check.name === "agent-probe");
      assert.equal(probe?.status, "warning");
      assert.match(probe?.message ?? "", /^Skipped/);
    }
  } finally {
    await rm(globalEnvPath, { force: true });
    await rm(docker, { recursive: true, force: true });
    await rm(direct, { recursive: true, force: true });
  }
});
