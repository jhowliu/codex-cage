import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialsForCommand,
  githubTokenFromEnv,
  globalCredentialsPath,
  mergeCredentialEnv,
  normalizeCredentialEnv,
  prepareRunCredentials,
} from "../src/credentials.js";

const codexAgents = { implement: "codex", review: "codex" } as const;

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

  assert.deepEqual(credentialsForCommand("setup", { env, agents: codexAgents }).env, {
    APP_ENV: "test",
  });
  assert.deepEqual(credentialsForCommand("verify", { env, agents: codexAgents }).env, {
    APP_ENV: "test",
  });
});

test("clone receives only GitHub auth", () => {
  const env = normalizeCredentialEnv({
    OPENAI_API_KEY: "openai-secret",
    GITHUB_TOKEN: "github-secret",
    APP_ENV: "test",
  });

  assert.deepEqual(credentialsForCommand("clone", { env, agents: codexAgents }).env, {
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

  assert.deepEqual(credentialsForCommand("implement", { env, agents: codexAgents }).env, {
    OPENAI_API_KEY: "openai-secret",
  });
  assert.deepEqual(credentialsForCommand("review", { env, agents: codexAgents }).env, {
    OPENAI_API_KEY: "openai-secret",
  });
});

test("implementation and review use OAuth fallback only when OPENAI_API_KEY is absent", () => {
  assert.deepEqual(
    credentialsForCommand("implement", {
      env: { OPENAI_API_KEY: "openai-secret" },
      agents: codexAgents,
      codexAuthFilePath: "/host/.codex/auth.json",
    }),
    { env: { OPENAI_API_KEY: "openai-secret" } },
  );
  assert.deepEqual(
    credentialsForCommand("review", {
      env: {},
      agents: codexAgents,
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

  assert.deepEqual(credentialsForCommand("publish", { env, agents: codexAgents }).env, {
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "github-secret",
  });
  assert.equal(githubTokenFromEnv(env), "github-secret");
});

test("prepareRunCredentials centralizes run-level credential policy", async () => {
  let codexAuthLookups = 0;
  const credentials = await prepareRunCredentials({
    cwd: "/repo",
    agents: codexAgents,
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
    findGithubToken: async () => {
      throw new Error("An explicit GITHUB_TOKEN must not consult gh.");
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
    agents: codexAgents,
    readEnv: async () => ({
      OPENAI_API_KEY: "openai-secret",
    }),
    findCodexAuthFile: async () => {
      throw new Error("OAuth lookup should not be used.");
    },
    findGithubToken: async () => null,
  });

  assert.deepEqual(credentials.command("implement"), {
    env: { OPENAI_API_KEY: "openai-secret" },
  });
});

test("each agent role receives only its own provider's credentials", () => {
  const env = normalizeCredentialEnv({
    OPENAI_API_KEY: "openai-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
    ANTHROPIC_API_KEY: "anthropic-key",
    GITHUB_TOKEN: "github-secret",
    APP_ENV: "test",
  });
  const agents = { implement: "claude", review: "codex" } as const;

  assert.deepEqual(
    credentialsForCommand("implement", {
      env,
      agents,
      codexAuthFilePath: "/host/.codex/auth.json",
    }),
    {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    },
  );
  assert.deepEqual(credentialsForCommand("review", { env, agents }), {
    env: { OPENAI_API_KEY: "openai-secret" },
  });
  assert.deepEqual(credentialsForCommand("verify", { env, agents }).env, {
    APP_ENV: "test",
  });
});

test("prepareRunCredentials skips the Codex OAuth lookup when no role uses Codex", async () => {
  const credentials = await prepareRunCredentials({
    cwd: "/repo",
    agents: { implement: "claude", review: "claude" },
    readEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token" }),
    findCodexAuthFile: async () => {
      throw new Error("OAuth lookup should not be used.");
    },
    findGithubToken: async () => null,
  });

  assert.deepEqual(credentials.command("review"), {
    env: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token" },
  });
});

test("mergeCredentialEnv layers repo values over the global agent credentials", () => {
  const merged = mergeCredentialEnv({
    global: {
      CLAUDE_CODE_OAUTH_TOKEN: "global-claude",
      OPENAI_API_KEY: "global-openai",
      GITHUB_TOKEN: "global-github",
    },
    repo: {
      OPENAI_API_KEY: "repo-openai",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      GITHUB_TOKEN: "repo-github",
    },
  });

  assert.deepEqual(merged.env, {
    CLAUDE_CODE_OAUTH_TOKEN: "global-claude",
    OPENAI_API_KEY: "repo-openai",
    GITHUB_TOKEN: "repo-github",
  });
  assert.deepEqual(merged.sources, {
    CLAUDE_CODE_OAUTH_TOKEN: "global",
    OPENAI_API_KEY: "repo",
    GITHUB_TOKEN: "repo",
  });
  assert.deepEqual(merged.ignoredGlobalNames, ["GITHUB_TOKEN"]);
});

test("globalCredentialsPath follows XDG_CONFIG_HOME", () => {
  assert.equal(globalCredentialsPath({ XDG_CONFIG_HOME: "/xdg" }), "/xdg/agent-cage/env");
  assert.match(globalCredentialsPath({}), /\/\.config\/agent-cage\/env$/);
});

test("prepareRunCredentials takes GITHUB_TOKEN from the pinned gh account", async () => {
  const lookups: (string | null)[] = [];
  const credentials = await prepareRunCredentials({
    cwd: "/repo",
    agents: codexAgents,
    readEnv: async () => ({
      OPENAI_API_KEY: "openai-secret",
      AGENT_CAGE_GH_USER: "work-account",
      APP_ENV: "test",
    }),
    findCodexAuthFile: async () => null,
    findGithubToken: async (login) => {
      lookups.push(login);
      return "gh-token";
    },
  });

  assert.deepEqual(lookups, ["work-account"]);
  assert.equal(credentials.githubToken(), "gh-token");
  assert.deepEqual(credentials.command("clone").env, {
    GITHUB_TOKEN: "gh-token",
    GH_TOKEN: "gh-token",
  });
  // The account name is a setting: it is neither passed to commands nor redacted.
  assert.deepEqual(credentials.command("setup").env, { APP_ENV: "test" });
  assert.equal("AGENT_CAGE_GH_USER" in credentials.injectedSecrets(), false);
  assert.equal(
    credentials.redactor()("work-account gh-token"),
    "work-account [REDACTED:GITHUB_TOKEN]",
  );
});

test("prepareRunCredentials uses the active gh account when none is pinned", async () => {
  const lookups: (string | null)[] = [];
  const credentials = await prepareRunCredentials({
    cwd: "/repo",
    agents: codexAgents,
    readEnv: async () => ({ OPENAI_API_KEY: "openai-secret" }),
    findCodexAuthFile: async () => null,
    findGithubToken: async (login) => {
      lookups.push(login);
      return null;
    },
  });

  assert.deepEqual(lookups, [null]);
  assert.equal(credentials.githubToken(), undefined);
});

test("prepareRunCredentials fails when the pinned gh account has no token", async () => {
  await assert.rejects(
    prepareRunCredentials({
      cwd: "/repo",
      agents: codexAgents,
      readEnv: async () => ({ AGENT_CAGE_GH_USER: "work-account" }),
      findCodexAuthFile: async () => null,
      findGithubToken: async () => null,
    }),
    /gh has no github\.com token for work-account/,
  );
});

test("prepareRunCredentials rejects a gh account that is not a GitHub login", async () => {
  await assert.rejects(
    prepareRunCredentials({
      cwd: "/repo",
      agents: codexAgents,
      readEnv: async () => ({ AGENT_CAGE_GH_USER: "not a login" }),
      findCodexAuthFile: async () => null,
      findGithubToken: async () => "gh-token",
    }),
    /AGENT_CAGE_GH_USER in \.agent-cage\.env must be a GitHub login/,
  );
});
