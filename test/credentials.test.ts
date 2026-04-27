import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialsForCommand,
  githubTokenFromEnv,
  normalizeCredentialEnv,
  prepareRunCredentials,
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

test("prepareRunCredentials centralizes run-level credential policy", async () => {
  let codexAuthLookups = 0;
  const credentials = await prepareRunCredentials({
    cwd: "/repo",
    readEnv: async (cwd) => {
      assert.equal(cwd, "/repo");
      return {
        OPENAI_API_KEY: "",
        GITHUB_TOKEN: "github-secret",
        LINEAR_API_KEY: "linear-secret",
        APP_ENV: "test",
      };
    },
    findCodexAuthFile: async () => {
      codexAuthLookups += 1;
      return "/host/.codex/auth.json";
    },
  });

  assert.equal(codexAuthLookups, 1);
  assert.deepEqual(credentials.issueOptions(3), {
    comments: 3,
    githubToken: "github-secret",
    linearApiKey: "linear-secret",
  });
  assert.equal(credentials.githubToken(), "github-secret");
  assert.deepEqual(credentials.command("setup").env, { APP_ENV: "test" });
  assert.deepEqual(credentials.command("implement"), {
    env: {},
    codexAuthFilePath: "/host/.codex/auth.json",
  });
  assert.deepEqual(credentials.command("publish").env, {
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "github-secret",
  });
  assert.equal(
    credentials.redactor()("token github-secret"),
    "token [REDACTED:GITHUB_TOKEN]",
  );
  assert.deepEqual(credentials.injectedSecrets(), {
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "github-secret",
    LINEAR_API_KEY: "linear-secret",
    APP_ENV: "test",
  });
});

test("prepareRunCredentials skips OAuth lookup when OpenAI API key is present", async () => {
  const credentials = await prepareRunCredentials({
    cwd: "/repo",
    readEnv: async () => ({
      OPENAI_API_KEY: "openai-secret",
    }),
    findCodexAuthFile: async () => {
      throw new Error("OAuth lookup should not be used.");
    },
  });

  assert.deepEqual(credentials.command("implement"), {
    env: { OPENAI_API_KEY: "openai-secret" },
  });
});
