import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initProject } from "../src/init.js";

async function tempRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codex-cage-init-"));
}

test("init creates config, env example, and gitignore entries", async () => {
  const cwd = await tempRepo();

  try {
    const result = await initProject(cwd);

    assert.deepEqual(result.created, [".codex-cage.yml", ".codex-cage.env.example"]);
    assert.deepEqual(result.updated, [".gitignore"]);

    const config = await readFile(join(cwd, ".codex-cage.yml"), "utf8");
    assert.match(config, /verify:/);
    assert.match(config, /Replace this with your real test command/);

    const envExample = await readFile(join(cwd, ".codex-cage.env.example"), "utf8");
    assert.match(envExample, /OPENAI_API_KEY=/);
    assert.match(envExample, /GITHUB_TOKEN=/);

    const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
    assert.match(gitignore, /\.codex-cage\.env/);
    assert.match(gitignore, /\.codex-cage\/runs\//);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("init refuses to overwrite existing config", async () => {
  const cwd = await tempRepo();

  try {
    await writeFile(join(cwd, ".codex-cage.yml"), "verify:\n  - npm test\n", "utf8");

    await assert.rejects(() => initProject(cwd), /\.codex-cage\.yml already exists/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("init can create optional Dockerfile", async () => {
  const cwd = await tempRepo();

  try {
    const result = await initProject(cwd, { dockerfile: true });

    assert.ok(result.created.includes(".codex-cage/Dockerfile"));
    const dockerfile = await readFile(join(cwd, ".codex-cage", "Dockerfile"), "utf8");
    assert.match(dockerfile, /FROM node:22-bookworm/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("init refuses to partially initialize when optional Dockerfile exists", async () => {
  const cwd = await tempRepo();

  try {
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n", "utf8");
    await initProject(cwd);
    await rm(join(cwd, ".codex-cage.yml"), { force: true });
    await mkdir(join(cwd, ".codex-cage"), { recursive: true });
    await writeFile(join(cwd, ".codex-cage", "Dockerfile"), "FROM custom\n", "utf8");

    await assert.rejects(
      () => initProject(cwd, { dockerfile: true }),
      /\.codex-cage\/Dockerfile already exists/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
