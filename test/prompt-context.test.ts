import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPromptContext,
  formatInstructionsForPrompt,
  instructionPromptLimitBytes,
} from "../src/prompt-context.js";

async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codex-cage-prompt-context-"));
}

test("buildPromptContext reads root instruction files in priority order", async () => {
  const cwd = await tempProject();

  try {
    await mkdir(join(cwd, ".codex-cage"), { recursive: true });
    await mkdir(join(cwd, ".github"), { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "Agent rules\n", "utf8");
    await writeFile(join(cwd, ".codex-cage", "instructions.md"), "Cage rules\n", "utf8");
    await writeFile(
      join(cwd, ".github", "copilot-instructions.md"),
      "Copilot rules\n",
      "utf8",
    );
    await writeFile(join(cwd, "CLAUDE.md"), "Claude rules\n", "utf8");

    const context = await buildPromptContext(cwd);

    assert.deepEqual(
      context.instructionFiles.map((file) => [file.path, file.status]),
      [
        ["AGENTS.md", "included"],
        [".codex-cage/instructions.md", "included"],
        [".github/copilot-instructions.md", "included"],
        ["CLAUDE.md", "included"],
      ],
    );
    assert.equal(
      context.instructions.indexOf("## AGENTS.md") <
        context.instructions.indexOf("## .codex-cage/instructions.md"),
      true,
    );
    assert.match(formatInstructionsForPrompt(context), /Repository instructions:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("buildPromptContext records missing files and truncates large instructions", async () => {
  const cwd = await tempProject();

  try {
    await writeFile(join(cwd, "AGENTS.md"), "a".repeat(40000), "utf8");

    const context = await buildPromptContext(cwd);

    assert.equal(context.limitBytes, instructionPromptLimitBytes);
    assert.equal(context.truncated, true);
    assert.equal(context.instructionFiles[0]?.status, "truncated");
    assert.equal(context.instructionFiles[1]?.status, "missing");
    assert.match(context.instructions, /Instruction file truncated/);
    assert.equal(Buffer.byteLength(context.instructions, "utf8") <= 32768, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
