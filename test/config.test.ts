import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCageConfigSchema,
  parseAgentCageConfig,
  resolveExecutionMode,
} from "../src/config.js";
import { defaultSandboxImage } from "../src/docker.js";

test("config schema accepts a minimal valid config", () => {
  const config = agentCageConfigSchema.parse({
    verify: ["npm test"],
  });

  assert.deepEqual(config.setup, []);
  assert.deepEqual(config.verify, ["npm test"]);
  assert.equal(config.git.base, "main");
  assert.equal(config.pr.draft, false);
  assert.equal(config.issue.comments, 10);
  assert.deepEqual(config.runtime, {
    image: defaultSandboxImage,
    dockerfile: null,
  });
  assert.equal(config.actions.enabled, false);
  assert.equal(config.actions.workflow, ".github/workflows/agent-cage.yml");
});

test("config schema rejects empty verify commands", () => {
  const result = agentCageConfigSchema.safeParse({ verify: [] });

  assert.equal(result.success, false);
  assert.ok(
    result.error?.issues.some(
      (issue) => issue.code === "too_small" && issue.path.join(".") === "verify",
    ),
  );
});

test("config schema accepts explicit runtime image and Dockerfile", () => {
  const config = agentCageConfigSchema.parse({
    verify: ["npm test"],
    runtime: {
      image: "registry.example.com/agent-cage/base:custom",
      dockerfile: ".agent-cage/Dockerfile",
    },
  });

  assert.deepEqual(config.runtime, {
    image: "registry.example.com/agent-cage/base:custom",
    dockerfile: ".agent-cage/Dockerfile",
  });
});

test("config schema preserves unknown keys for forward compatibility", () => {
  const result = parseAgentCageConfig({
    verify: ["npm test"],
    future_option: true,
  });

  assert.equal(result.config.future_option, true);
  assert.deepEqual(result.warnings, [
    'Unknown config key "future_option" is not used by this version.',
  ]);
});

test("execution mode defaults to docker", () => {
  assert.equal(resolveExecutionMode({}), "docker");
  assert.equal(resolveExecutionMode({ env: {}, config: {} }), "docker");
});

test("execution mode reads from config when no env override", () => {
  assert.equal(resolveExecutionMode({ config: { execution: "direct" } }), "direct");
  assert.equal(resolveExecutionMode({ config: { execution: "docker" } }), "docker");
});

test("execution mode env overrides config", () => {
  assert.equal(
    resolveExecutionMode({
      env: { AGENT_CAGE_EXECUTION: "direct" },
      config: { execution: "docker" },
    }),
    "direct",
  );
});

test("execution mode ignores empty env value and falls back", () => {
  assert.equal(
    resolveExecutionMode({
      env: { AGENT_CAGE_EXECUTION: "" },
      config: { execution: "direct" },
    }),
    "direct",
  );
});

test("execution mode rejects an invalid env value", () => {
  assert.throws(
    () => resolveExecutionMode({ env: { AGENT_CAGE_EXECUTION: "vm" } }),
    /must be "docker" or "direct"/,
  );
});

test("config schema accepts an explicit execution mode", () => {
  const config = agentCageConfigSchema.parse({
    verify: ["npm test"],
    execution: "direct",
  });

  assert.equal(config.execution, "direct");
});

test("config schema accepts GitHub Actions settings", () => {
  const config = agentCageConfigSchema.parse({
    verify: ["npm test"],
    actions: {
      enabled: true,
      agent_cage_version: "0.1.0",
      services: {
        postgres: {
          image: "postgres:17",
          env: { POSTGRES_PASSWORD: "postgres" },
        },
      },
    },
  });

  assert.equal(config.actions.enabled, true);
  assert.equal(config.actions.runner, "ubuntu-latest");
  assert.equal(config.actions.services.postgres?.image, "postgres:17");
});

test("config schema requires a pinned version when Actions is enabled", () => {
  assert.throws(
    () =>
      agentCageConfigSchema.parse({
        verify: ["npm test"],
        actions: { enabled: true },
      }),
    /must be set when GitHub Actions is enabled/,
  );
});

test("agents default to Codex for both roles", () => {
  const config = agentCageConfigSchema.parse({ verify: ["npm test"] });

  assert.deepEqual(config.agent, {
    implement: { provider: "codex", model: "gpt-5.4-mini" },
    review: { provider: "codex", model: "gpt-5.4-mini" },
    max_iterations: 5,
    max_review_cycles: 2,
  });
});

test("legacy agent.model applies to every Codex role", () => {
  const config = agentCageConfigSchema.parse({
    verify: ["npm test"],
    agent: { model: "gpt-5.4", max_iterations: 3 },
  });

  assert.deepEqual(config.agent.implement, { provider: "codex", model: "gpt-5.4" });
  assert.deepEqual(config.agent.review, { provider: "codex", model: "gpt-5.4" });
  assert.equal(config.agent.max_iterations, 3);
});

test("agent roles pick a provider default model unless one is configured", () => {
  const config = agentCageConfigSchema.parse({
    verify: ["npm test"],
    agent: {
      model: "gpt-5.4",
      implement: { provider: "claude" },
      review: { provider: "codex" },
    },
  });

  assert.deepEqual(config.agent.implement, {
    provider: "claude",
    model: "claude-opus-5-5",
  });
  assert.deepEqual(config.agent.review, { provider: "codex", model: "gpt-5.4" });
});

test("resolved agent config round-trips through the schema", () => {
  const resolved = agentCageConfigSchema.parse({
    verify: ["npm test"],
    agent: { implement: { provider: "claude", model: "claude-sonnet-5-5" } },
  });

  assert.deepEqual(
    agentCageConfigSchema.parse({ verify: ["npm test"], agent: resolved.agent }).agent,
    resolved.agent,
  );
});

test("config schema rejects unknown agent providers", () => {
  assert.throws(
    () =>
      agentCageConfigSchema.parse({
        verify: ["npm test"],
        agent: { implement: { provider: "gemini" } },
      }),
    /provider/,
  );
});
