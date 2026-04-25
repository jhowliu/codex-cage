import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCredentialEnv,
  selectCredentialsForIntent,
} from "../src/credentials.js";

const env = {
  GITHUB_TOKEN: "github",
  GH_TOKEN: "gh",
  OPENAI_API_KEY: "openai",
  LINEAR_API_KEY: "linear",
  TARGET_APP_SECRET: "target",
};

test("normalizeCredentialEnv drops empty placeholders and derives GH_TOKEN", () => {
  assert.deepEqual(
    normalizeCredentialEnv({
      GITHUB_TOKEN: "github",
      GH_TOKEN: "",
      OPENAI_API_KEY: "   ",
      TARGET_APP_SECRET: "target",
    }),
    {
      GITHUB_TOKEN: "github",
      GH_TOKEN: "github",
      TARGET_APP_SECRET: "target",
    },
  );
});

test("setup and verify exclude Codex, OpenAI, and GitHub credentials", () => {
  assert.deepEqual(selectCredentialsForIntent({ env, intent: "setup" }), {
    env: {
      LINEAR_API_KEY: "linear",
      TARGET_APP_SECRET: "target",
    },
  });
  assert.deepEqual(selectCredentialsForIntent({ env, intent: "verify" }), {
    env: {
      LINEAR_API_KEY: "linear",
      TARGET_APP_SECRET: "target",
    },
  });
});

test("codex intent receives only Codex/OpenAI auth", () => {
  assert.deepEqual(
    selectCredentialsForIntent({
      env,
      intent: "codex",
      codexAuthFilePath: "/host/.codex/auth.json",
    }),
    {
      env: {
        OPENAI_API_KEY: "openai",
      },
    },
  );
});

test("codex intent uses OAuth fallback only when OPENAI_API_KEY is absent", () => {
  assert.deepEqual(
    selectCredentialsForIntent({
      env: { TARGET_APP_SECRET: "target" },
      intent: "codex",
      codexAuthFilePath: "/host/.codex/auth.json",
    }),
    {
      env: {},
      codexAuthFilePath: "/host/.codex/auth.json",
    },
  );
});

test("publish receives only GitHub auth", () => {
  assert.deepEqual(selectCredentialsForIntent({ env, intent: "publish" }), {
    env: {
      GITHUB_TOKEN: "github",
      GH_TOKEN: "gh",
    },
  });
});
