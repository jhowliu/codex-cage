import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialsForCommand,
  githubTokenFromEnv,
  normalizeCredentialEnv,
} from "../src/credentials.js";

test("normalizeCredentialEnv drops empty placeholders and mirrors GITHUB_TOKEN to GH_TOKEN", () => {
  assert.deepEqual(
    normalizeCredentialEnv({
      OPENAI_API_KEY: "",
      GITHUB_TOKEN: "github-secret",
      APP_ENV: "test",
    }),
    {
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "github-secret",
      APP_ENV: "test",
    },
  );
});

test("setup and verify receive non-credential env only", () => {
  const env = normalizeCredentialEnv({
    OPENAI_API_KEY: "openai-secret",
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "gh-secret",
    LINEAR_API_KEY: "linear-secret",
    APP_ENV: "test",
  });

  assert.deepEqual(credentialsForCommand("setup", { env }).env, { APP_ENV: "test" });
  assert.deepEqual(credentialsForCommand("verify", { env }).env, { APP_ENV: "test" });
});

test("clone receives only GitHub auth", () => {
  const env = normalizeCredentialEnv({
    OPENAI_API_KEY: "openai-secret",
    GITHUB_TOKEN: "github-secret",
    APP_ENV: "test",
  });

  assert.deepEqual(credentialsForCommand("clone", { env }).env, {
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "github-secret",
  });
});

test("implementation and review receive only Codex auth", () => {
  const env = normalizeCredentialEnv({
    OPENAI_API_KEY: "openai-secret",
    GITHUB_TOKEN: "github-secret",
    APP_ENV: "test",
  });

  assert.deepEqual(credentialsForCommand("implement", { env }).env, {
    OPENAI_API_KEY: "openai-secret",
  });
  assert.deepEqual(credentialsForCommand("review", { env }).env, {
    OPENAI_API_KEY: "openai-secret",
  });
});

test("implementation and review use OAuth fallback only when OPENAI_API_KEY is absent", () => {
  assert.deepEqual(
    credentialsForCommand("implement", {
      env: { OPENAI_API_KEY: "openai-secret" },
      codexAuthFilePath: "/host/.codex/auth.json",
    }),
    { env: { OPENAI_API_KEY: "openai-secret" } },
  );
  assert.deepEqual(
    credentialsForCommand("review", {
      env: {},
      codexAuthFilePath: "/host/.codex/auth.json",
    }),
    { env: {}, codexAuthFilePath: "/host/.codex/auth.json" },
  );
});

test("publish receives only GitHub auth", () => {
  const env = normalizeCredentialEnv({
    OPENAI_API_KEY: "openai-secret",
    GITHUB_TOKEN: "github-secret",
    APP_ENV: "test",
  });

  assert.deepEqual(credentialsForCommand("publish", { env }).env, {
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "github-secret",
  });
  assert.equal(githubTokenFromEnv(env), "github-secret");
});
