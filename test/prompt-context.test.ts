import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPromptContext,
  formatReviewPolicyForPrompt,
} from "../src/prompt-context.js";

async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codex-cage-prompt-context-"));
}

test("buildPromptContext records present review policy without reading ignored instruction files", async () => {
  const cwd = await tempProject();

  try {
    await mkdir(join(cwd, ".codex-cage"), { recursive: true });
    await mkdir(join(cwd, ".github"), { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "Agent secret rule\n", "utf8");
    await writeFile(
      join(cwd, ".codex-cage", "instructions.md"),
      "Cage secret rule\n",
      "utf8",
    );
    await writeFile(
      join(cwd, ".codex-cage", "review-policy.md"),
      "Policy secret content\n",
      "utf8",
    );
    await writeFile(
      join(cwd, ".github", "copilot-instructions.md"),
      "Copilot secret rule\n",
      "utf8",
    );
    await writeFile(join(cwd, "CLAUDE.md"), "Claude secret rule\n", "utf8");

    const context = await buildPromptContext(cwd);
    const formatted = formatReviewPolicyForPrompt(context);

    assert.deepEqual(context.reviewPolicy, {
      path: ".codex-cage/review-policy.md",
      containerPath: "/workspace/.codex-cage/review-policy.md",
      status: "present",
    });
    assert.match(formatted, /Target review policy: present/);
    assert.match(formatted, /\/workspace\/\.codex-cage\/review-policy\.md/);
    assert.doesNotMatch(JSON.stringify(context), /Agent secret rule/);
    assert.doesNotMatch(JSON.stringify(context), /Cage secret rule/);
    assert.doesNotMatch(JSON.stringify(context), /Copilot secret rule/);
    assert.doesNotMatch(JSON.stringify(context), /Claude secret rule/);
    assert.doesNotMatch(JSON.stringify(context), /Policy secret content/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("buildPromptContext records missing review policy without failing", async () => {
  const cwd = await tempProject();

  try {
    const context = await buildPromptContext(cwd);

    assert.equal(context.reviewPolicy.status, "missing");
    assert.equal(
      formatReviewPolicyForPrompt(context),
      "Target review policy: missing. Proceed with built-in review rules.",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
