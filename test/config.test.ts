import assert from "node:assert/strict";
import test from "node:test";
import {
  codexCageConfigSchema,
  parseCodexCageConfig,
  resolveExecutionMode,
} from "../src/config.js";
import { defaultSandboxImage } from "../src/docker.js";

test("config schema accepts a minimal valid config", () => {
  const config = codexCageConfigSchema.parse({
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
  assert.equal(config.actions.workflow, ".github/workflows/codex-cage.yml");
});

test("config schema rejects empty verify commands", () => {
  assert.throws(
    () =>
      codexCageConfigSchema.parse({
        verify: [],
      }),
    /Array must contain at least 1 element/,
  );
});

test("config schema accepts explicit runtime image and Dockerfile", () => {
  const config = codexCageConfigSchema.parse({
    verify: ["npm test"],
    runtime: {
      image: "registry.example.com/codex-cage/base:custom",
      dockerfile: ".codex-cage/Dockerfile",
    },
  });

  assert.deepEqual(config.runtime, {
    image: "registry.example.com/codex-cage/base:custom",
    dockerfile: ".codex-cage/Dockerfile",
  });
});

test("config schema preserves unknown keys for forward compatibility", () => {
  const result = parseCodexCageConfig({
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
      env: { CODEX_CAGE_EXECUTION: "direct" },
      config: { execution: "docker" },
    }),
    "direct",
  );
});

test("execution mode ignores empty env value and falls back", () => {
  assert.equal(
    resolveExecutionMode({
      env: { CODEX_CAGE_EXECUTION: "" },
      config: { execution: "direct" },
    }),
    "direct",
  );
});

test("execution mode rejects an invalid env value", () => {
  assert.throws(
    () => resolveExecutionMode({ env: { CODEX_CAGE_EXECUTION: "vm" } }),
    /must be "docker" or "direct"/,
  );
});

test("config schema accepts an explicit execution mode", () => {
  const config = codexCageConfigSchema.parse({
    verify: ["npm test"],
    execution: "direct",
  });

  assert.equal(config.execution, "direct");
});

test("config schema accepts GitHub Actions settings", () => {
  const config = codexCageConfigSchema.parse({
    verify: ["npm test"],
    actions: {
      enabled: true,
      codex_cage_version: "0.1.0",
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
      codexCageConfigSchema.parse({
        verify: ["npm test"],
        actions: { enabled: true },
      }),
    /must be set when GitHub Actions is enabled/,
  );
});
