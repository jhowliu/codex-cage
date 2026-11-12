import assert from "node:assert/strict";
import test from "node:test";
import {
  ghAuthToken,
  ghAuthTokenArgs,
  githubAccountSetting,
  listGhAccounts,
  parseGhAccounts,
  type GhRunner,
} from "../src/github-auth.js";

const statusJson = JSON.stringify({
  hosts: {
    "github.com": [
      { state: "success", active: false, host: "github.com", login: "personal" },
      { state: "success", active: true, host: "github.com", login: "work-account" },
      { state: "error", active: false, host: "github.com", login: "expired" },
    ],
    "ghe.example.com": [
      { state: "success", active: true, host: "ghe.example.com", login: "enterprise" },
    ],
  },
});

test("parseGhAccounts lists signed-in github.com accounts and the active one", () => {
  assert.deepEqual(parseGhAccounts(statusJson), {
    logins: ["personal", "work-account"],
    active: "work-account",
  });
});

test("parseGhAccounts treats unparsable output as no accounts", () => {
  const none = { logins: [], active: null };
  assert.deepEqual(parseGhAccounts(""), none);
  assert.deepEqual(parseGhAccounts("unknown flag: --json"), none);
  assert.deepEqual(parseGhAccounts(JSON.stringify({ hosts: {} })), none);
});

test("listGhAccounts asks gh for github.com status as JSON", async () => {
  const calls: (readonly string[])[] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: statusJson };
  };

  assert.equal((await listGhAccounts(gh)).active, "work-account");
  assert.deepEqual(calls, [
    ["auth", "status", "--hostname", "github.com", "--json", "hosts"],
  ]);
});

test("ghAuthToken selects the account only when one is pinned", async () => {
  assert.deepEqual(ghAuthTokenArgs(null), ["auth", "token", "--hostname", "github.com"]);
  const setting = githubAccountSetting({ AGENT_CAGE_GH_USER: "work-account" });
  assert.equal(setting.status, "set");
  if (setting.status !== "set") return;
  assert.deepEqual(ghAuthTokenArgs(setting.login), [
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "work-account",
  ]);
});

test("ghAuthToken returns null when gh fails or prints nothing", async () => {
  assert.equal(
    await ghAuthToken(null, async () => ({ exitCode: 0, stdout: "gho_x\n" })),
    "gho_x",
  );
  assert.equal(await ghAuthToken(null, async () => ({ exitCode: 1, stdout: "" })), null);
  assert.equal(
    await ghAuthToken(null, async () => ({ exitCode: 0, stdout: "  " })),
    null,
  );
  assert.equal(
    await ghAuthToken(null, async () => ({ exitCode: undefined, stdout: "" })),
    null,
  );
});

test("githubAccountSetting distinguishes unset, valid, and invalid values", () => {
  assert.deepEqual(githubAccountSetting({}), { status: "unset" });
  assert.deepEqual(githubAccountSetting({ AGENT_CAGE_GH_USER: " " }), {
    status: "unset",
  });
  assert.deepEqual(githubAccountSetting({ AGENT_CAGE_GH_USER: "a-b1" }), {
    status: "set",
    login: "a-b1",
  });
  for (const value of ["-lead", "trail-", "two--dash", "has space", "x".repeat(40)]) {
    assert.equal(githubAccountSetting({ AGENT_CAGE_GH_USER: value }).status, "invalid");
  }
});
