import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Command } from "commander";
import { createCli } from "../src/commands.js";
import { CODEX_CAGE_EXECUTION_ENV } from "../src/config.js";

const skillUrl = new URL("../../skills/codex-cage-delegate/SKILL.md", import.meta.url);

/** The code spans and fenced code blocks of a Markdown document. */
function codeIn(markdown: string): string[] {
  const fenced = [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(
    (match) => match[1] ?? "",
  );
  const inline = [
    ...markdown.replace(/^```[\s\S]*?^```/gm, "").matchAll(/`([^`\n]+)`/g),
  ].map((match) => match[1] ?? "");
  return [...fenced, ...inline];
}

/** Each `codex-cage ...` invocation in the code, cut at the next shell operator. */
function cliInvocations(code: readonly string[]): string[][] {
  return code.flatMap((snippet) =>
    [...snippet.matchAll(/(?<![\w./-])codex-cage ([^;&|\n]*)/g)].map((match) =>
      (match[1] ?? "").trim().split(/\s+/),
    ),
  );
}

test("the delegate skill uses only codex-cage commands and options that exist", async () => {
  const skill = await readFile(skillUrl, "utf8");
  const invocations = cliInvocations(codeIn(skill));
  assert.ok(invocations.length > 0, "the skill should run codex-cage commands");

  for (const tokens of invocations) {
    let command: Command = createCli();
    const path: string[] = [];

    for (const token of tokens) {
      const subcommand = command.commands.find((candidate) => candidate.name() === token);
      if (subcommand === undefined) break;
      command = subcommand;
      path.push(token);
    }

    const invocation = `codex-cage ${tokens.join(" ")}`;
    // A command with subcommands, such as `runs`, needs one of them next.
    assert.equal(command.commands.length, 0, `unknown command in: ${invocation}`);

    for (const flag of tokens.filter((token) => token.startsWith("--"))) {
      assert.ok(
        command.options.some((option) => option.long === flag),
        `codex-cage ${path.join(" ")} has no ${flag} option, in: ${invocation}`,
      );
    }
  }
});

test("the delegate skill pins runs to Docker with the variable run reads", async () => {
  const skill = await readFile(skillUrl, "utf8");

  assert.match(skill, new RegExp(`${CODEX_CAGE_EXECUTION_ENV}=docker codex-cage run `));
});
