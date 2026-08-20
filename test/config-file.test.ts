import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Document } from "yaml";
import {
  CODEX_CAGE_CONFIG_FILE,
  loadCodexCageConfigFile,
  updateCodexCageConfigFile,
} from "../src/config-file.js";

async function tempRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codex-cage-config-file-"));
}

test("load reports a missing optional config", async () => {
  const cwd = await tempRepo();

  try {
    const state = await loadCodexCageConfigFile(cwd);

    assert.deepEqual(state, {
      status: "missing",
      path: join(cwd, CODEX_CAGE_CONFIG_FILE),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("load returns the YAML document and parsed valid config", async () => {
  const cwd = await tempRepo();

  try {
    await writeFile(
      join(cwd, CODEX_CAGE_CONFIG_FILE),
      "# project config\nverify:\n  - npm test\nfuture_option: true\n",
      "utf8",
    );

    const state = await loadCodexCageConfigFile(cwd);

    assert.equal(state.status, "valid");
    assert.ok(state.document instanceof Document);
    assert.deepEqual(state.config.verify, ["npm test"]);
    assert.deepEqual(state.warnings, [
      'Unknown config key "future_option" is not used by this version.',
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("load distinguishes YAML and config validation failures", async () => {
  const cwd = await tempRepo();
  const path = join(cwd, CODEX_CAGE_CONFIG_FILE);

  try {
    await writeFile(path, "verify: [unterminated\n", "utf8");
    const malformed = await loadCodexCageConfigFile(cwd);
    assert.equal(malformed.status, "invalid");
    assert.ok(malformed.errors.length > 0);

    await writeFile(path, "verify: []\n", "utf8");
    const schemaInvalid = await loadCodexCageConfigFile(cwd);
    assert.equal(schemaInvalid.status, "invalid");
    assert.ok(schemaInvalid.errors.length > 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("update changes only supplied managed keys and preserves comments and unknown keys", async () => {
  const cwd = await tempRepo();
  const path = join(cwd, CODEX_CAGE_CONFIG_FILE);

  try {
    await writeFile(
      path,
      [
        "# keep this project note",
        "setup:",
        "  - npm ci",
        "verify:",
        "  - npm test",
        "# owned by a future version",
        "future_option: true # keep inline note",
        "",
      ].join("\n"),
      "utf8",
    );
    const state = await loadCodexCageConfigFile(cwd);
    assert.equal(state.status, "valid");

    const updated = await updateCodexCageConfigFile(state, {
      setup: ["npm install"],
    });
    const source = await readFile(path, "utf8");

    assert.equal(updated.status, "valid");
    assert.deepEqual(updated.config.setup, ["npm install"]);
    assert.deepEqual(updated.config.verify, ["npm test"]);
    assert.match(source, /# keep this project note/);
    assert.match(source, /# owned by a future version/);
    assert.match(source, /future_option: true # keep inline note/);
    assert.deepEqual(await readdir(cwd), [CODEX_CAGE_CONFIG_FILE]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("update validates before creating a missing config", async () => {
  const cwd = await tempRepo();

  try {
    const missing = await loadCodexCageConfigFile(cwd);
    assert.equal(missing.status, "missing");

    await assert.rejects(() => updateCodexCageConfigFile(missing, { setup: [] }));
    assert.deepEqual(await readdir(cwd), []);

    const created = await updateCodexCageConfigFile(missing, {
      verify: ["npm test"],
    });
    assert.equal(created.status, "valid");
    assert.deepEqual(created.config.verify, ["npm test"]);
    assert.deepEqual(await readdir(cwd), [CODEX_CAGE_CONFIG_FILE]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
