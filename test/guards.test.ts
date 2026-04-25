import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertNoGuardViolations,
  createSecretRedactor,
  formatGuardViolations,
  guardAttemptDecision,
  isSensitiveFilePath,
  parseEnvFile,
  readCodexCageEnv,
  scanDiffForGuardViolations,
} from "../src/guards.js";

async function tempRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codex-cage-guards-"));
}

test("parseEnvFile parses simple dotenv assignments without leaking examples", () => {
  assert.deepEqual(
    parseEnvFile(`
# local secrets
OPENAI_API_KEY=sk-local-secret
export GITHUB_TOKEN='ghp_local_secret'
LINEAR_API_KEY="lin-local-secret"
EMPTY=
`),
    {
      OPENAI_API_KEY: "sk-local-secret",
      GITHUB_TOKEN: "ghp_local_secret",
      LINEAR_API_KEY: "lin-local-secret",
      EMPTY: "",
    },
  );
});

test("parseEnvFile rejects malformed assignments with line numbers", () => {
  assert.throws(() => parseEnvFile("OPENAI_API_KEY=secret\nnot valid\n"), /line 2/);
});

test("readCodexCageEnv returns empty env when the local secret file is absent", async () => {
  const cwd = await tempRepo();

  try {
    assert.deepEqual(await readCodexCageEnv(cwd), {});
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("readCodexCageEnv reads local secrets from .codex-cage.env", async () => {
  const cwd = await tempRepo();

  try {
    await writeFile(join(cwd, ".codex-cage.env"), "GITHUB_TOKEN=ghp_secret\n", "utf8");

    assert.deepEqual(await readCodexCageEnv(cwd), {
      GITHUB_TOKEN: "ghp_secret",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createSecretRedactor replaces known secret values and ignores empty values", () => {
  const redact = createSecretRedactor({
    GITHUB_TOKEN: "ghp_secret",
    EMPTY: "",
  });

  assert.equal(
    redact("clone with ghp_secret but keep ordinary text"),
    "clone with [REDACTED:GITHUB_TOKEN] but keep ordinary text",
  );
});

test("scanDiffForGuardViolations detects injected secrets and high confidence tokens", () => {
  const diff = `diff --git a/src/app.ts b/src/app.ts
@@ -1,2 +1,4 @@
 export const ok = true;
+export const leaked = "known-secret-value";
+export const token = "ghp_123456789012345678901234567890123456";
`;

  const violations = scanDiffForGuardViolations(diff, {
    injectedSecrets: {
      GITHUB_TOKEN: "known-secret-value",
    },
  });

  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["injected_secret", "token_pattern"],
  );
  assert.deepEqual(
    violations.map((violation) => violation.path),
    ["src/app.ts", "src/app.ts"],
  );
});

test("scanDiffForGuardViolations detects private key material", () => {
  const diff = `diff --git a/key.pem b/key.pem
@@ -0,0 +1 @@
+-----BEGIN PRIVATE KEY-----
`;

  assert.deepEqual(
    scanDiffForGuardViolations(diff).map((violation) => violation.code),
    ["private_key"],
  );
});

test("scanDiffForGuardViolations denies real env and auth files", () => {
  const diff = `diff --git a/.env b/.env
@@ -0,0 +1 @@
+TOKEN=example
diff --git a/.config/gh/hosts.yml b/.config/gh/hosts.yml
@@ -0,0 +1 @@
+github.com: {}
`;

  assert.deepEqual(
    scanDiffForGuardViolations(diff).map((violation) => violation.code),
    ["sensitive_file", "sensitive_file"],
  );
});

test("assertNoGuardViolations blocks later phases with clear violation details", () => {
  const violations = scanDiffForGuardViolations(`diff --git a/.env b/.env
@@ -0,0 +1 @@
+TOKEN=example
`);

  assert.throws(() => assertNoGuardViolations(violations), {
    name: "GuardViolationError",
    message: /\.env \[sensitive_file\] Sensitive file/,
  });
  assert.match(formatGuardViolations(violations), /\.env \[sensitive_file\]/);
});

test("scanDiffForGuardViolations allows sample env files unless content looks secret-bearing", () => {
  const diff = `diff --git a/.env.example b/.env.example
@@ -0,0 +1,2 @@
+OPENAI_API_KEY=
+EXAMPLE_SECRET=sk-123456789012345678901234
`;

  assert.deepEqual(
    scanDiffForGuardViolations(diff).map((violation) => violation.code),
    ["token_pattern"],
  );
});

test("isSensitiveFilePath classifies auth files and sample env files", () => {
  assert.equal(isSensitiveFilePath(".codex-cage.env"), true);
  assert.equal(isSensitiveFilePath(".env"), true);
  assert.equal(isSensitiveFilePath(".env.example"), false);
  assert.equal(isSensitiveFilePath(".ssh/id_ed25519"), true);
  assert.equal(isSensitiveFilePath(".config/gh/hosts.yml"), true);
});

test("guardAttemptDecision retries within the configured bound and fails after it", () => {
  assert.deepEqual(guardAttemptDecision({ attempt: 0, maxAttempts: 2 }), {
    action: "retry",
    nextAttempt: 1,
  });
  assert.deepEqual(guardAttemptDecision({ attempt: 2, maxAttempts: 2 }), {
    action: "fail",
    attempts: 3,
  });
});
