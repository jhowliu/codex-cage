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

test("config parser warns on runtime image latest tag", () => {
  const result = parseCodexCageConfig({
    verify: ["npm test"],
    runtime: {
      image: "registry.example.com/codex-cage/base:latest",
    },
  });

  assert.deepEqual(result.runtimeImageWarnings, [
    {
      code: "runtime_image_latest_tag",
      image: "registry.example.com/codex-cage/base:latest",
      message:
        'runtime.image "registry.example.com/codex-cage/base:latest" uses the mutable "latest" tag; use a pinned tag or digest for reproducible runs.',
    },
  ]);
  assert.deepEqual(result.warnings, [result.runtimeImageWarnings[0]?.message]);
});

test("config parser warns on runtime image without tag or digest", () => {
  const result = parseCodexCageConfig({
    verify: ["npm test"],
    runtime: {
      image: "registry.example.com:5000/codex-cage/base",
    },
  });

  assert.deepEqual(result.runtimeImageWarnings, [
    {
      code: "runtime_image_missing_tag_or_digest",
      image: "registry.example.com:5000/codex-cage/base",
      message:
        'runtime.image "registry.example.com:5000/codex-cage/base" has no explicit tag or digest; use a pinned tag or digest for reproducible runs.',
    },
  ]);
});

test("config parser does not warn on pinned runtime image tag", () => {
  const result = parseCodexCageConfig({
    verify: ["npm test"],
    runtime: {
      image: "registry.example.com/codex-cage/base:1.2.3",
    },
  });

  assert.deepEqual(result.runtimeImageWarnings, []);
  assert.deepEqual(result.warnings, []);
});

test("config parser does not warn on digest runtime image reference", () => {
  const result = parseCodexCageConfig({
    verify: ["npm test"],
    runtime: {
      image:
        "registry.example.com/codex-cage/base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });

  assert.deepEqual(result.runtimeImageWarnings, []);
  assert.deepEqual(result.warnings, []);
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
