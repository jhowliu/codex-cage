import assert from "node:assert/strict";
import test from "node:test";
import { codexCageConfigSchema, parseCodexCageConfig } from "../src/config.js";
import { defaultSandboxImage } from "../src/docker.js";

test("config schema accepts a minimal valid config", () => {
  const config = codexCageConfigSchema.parse({
    verify: ["npm test"],
  });

  assert.deepEqual(config.setup, []);
  assert.deepEqual(config.verify, ["npm test"]);
  assert.equal(config.git.base, "main");
  assert.equal(config.pr.draft, false);
  assert.equal(config.pr.publish, true);
  assert.equal(config.issue.comments, 10);
  assert.deepEqual(config.runtime, {
    image: defaultSandboxImage,
    dockerfile: null,
  });
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

test("config schema accepts disabling automatic publishing", () => {
  const config = codexCageConfigSchema.parse({
    verify: ["npm test"],
    pr: {
      publish: false,
    },
  });

  assert.equal(config.pr.draft, false);
  assert.equal(config.pr.publish, false);
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
