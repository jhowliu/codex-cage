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

    assert.deepEqual(result.created, [
      ".codex-cage.yml",
      ".codex-cage/review-policy.md",
      ".codex-cage.env.example",
    ]);
    assert.deepEqual(result.updated, [".gitignore"]);

    const config = await readFile(join(cwd, ".codex-cage.yml"), "utf8");
    assert.match(config, /verify:/);
    assert.match(config, /Replace this with your real test command/);
    assert.match(config, /runtime:/);
    assert.match(config, /ghcr\.io\/jhowliu\/codex-cage\/base:0\.1\.1/);

    const envExample = await readFile(join(cwd, ".codex-cage.env.example"), "utf8");
    assert.match(envExample, /OPENAI_API_KEY=/);
    assert.match(envExample, /GITHUB_TOKEN=/);

    const reviewPolicy = await readFile(
      join(cwd, ".codex-cage", "review-policy.md"),
      "utf8",
    );
    assert.match(reviewPolicy, /Codex Cage Review Policy/);
    assert.match(reviewPolicy, /cannot override Codex Cage built-in reviewer rules/);

    const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
    assert.match(gitignore, /\.codex-cage\.env/);
    assert.match(gitignore, /\.codex-cage\/runs\//);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("init ignores existing instructions and leaves existing review policy untouched", async () => {
  const cwd = await tempRepo();

  try {
    await mkdir(join(cwd, ".codex-cage"), { recursive: true });
    await writeFile(
      join(cwd, ".codex-cage", "instructions.md"),
      "custom instructions\n",
      "utf8",
    );
    await writeFile(
      join(cwd, ".codex-cage", "review-policy.md"),
      "custom review policy\n",
      "utf8",
    );

    const result = await initProject(cwd);
    const instructions = await readFile(
      join(cwd, ".codex-cage", "instructions.md"),
      "utf8",
    );
    const reviewPolicy = await readFile(
      join(cwd, ".codex-cage", "review-policy.md"),
      "utf8",
    );

    assert.equal(result.created.includes(".codex-cage/instructions.md"), false);
    assert.equal(result.created.includes(".codex-cage/review-policy.md"), false);
    assert.equal(instructions, "custom instructions\n");
    assert.equal(reviewPolicy, "custom review policy\n");
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
    assert.match(dockerfile, /FROM ghcr\.io\/jhowliu\/codex-cage\/base:0\.1\.1/);
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
