import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { Command } from "commander";
import { createCli } from "../src/commands.js";
import { AGENT_CAGE_EXECUTION_ENV } from "../src/config.js";

const skillDirectory = new URL("../../skills/agent-cage-planner/", import.meta.url);

/** Every Markdown file of the skill, keyed by file name. */
async function readSkillFiles(): Promise<Map<string, string>> {
  const names = (await readdir(skillDirectory)).filter((name) => name.endsWith(".md"));
  const files = new Map<string, string>();
  for (const name of names) {
    files.set(name, await readFile(new URL(name, skillDirectory), "utf8"));
  }
  return files;
}

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

/** Each `agent-cage ...` invocation in the code, cut at the next shell operator. */
function cliInvocations(code: readonly string[]): string[][] {
  return code.flatMap((snippet) =>
    [...snippet.matchAll(/(?<![\w./-])agent-cage ([^;&|\n]*)/g)].map((match) =>
      (match[1] ?? "").trim().split(/\s+/),
    ),
  );
}

test("the planner skill uses only agent-cage commands and options that exist", async () => {
  const skill = [...(await readSkillFiles()).values()].join("\n");
  const invocations = cliInvocations(codeIn(skill));
  assert.ok(invocations.length > 0, "the skill should run agent-cage commands");

  for (const tokens of invocations) {
    let command: Command = createCli();
    const path: string[] = [];

    for (const token of tokens) {
      const subcommand = command.commands.find((candidate) => candidate.name() === token);
      if (subcommand === undefined) break;
      command = subcommand;
      path.push(token);
    }

    const invocation = `agent-cage ${tokens.join(" ")}`;
    // A command with subcommands, such as `runs`, needs one of them next.
    assert.equal(command.commands.length, 0, `unknown command in: ${invocation}`);

    for (const flag of tokens.filter((token) => token.startsWith("--"))) {
      assert.ok(
        command.options.some((option) => option.long === flag),
        `agent-cage ${path.join(" ")} has no ${flag} option, in: ${invocation}`,
      );
    }
  }
});

test("the planner skill pins runs and revises to Docker with the variable they read", async () => {
  const files = await readSkillFiles();

  assert.match(
    files.get("SKILL.md") ?? "",
    new RegExp(`${AGENT_CAGE_EXECUTION_ENV}=docker agent-cage run `),
  );
  assert.match(
    files.get("REVISE.md") ?? "",
    new RegExp(`${AGENT_CAGE_EXECUTION_ENV}=docker agent-cage revise `),
  );
});

test("the planner skill links only to files it ships", async () => {
  const files = await readSkillFiles();

  for (const [name, markdown] of files) {
    for (const match of markdown.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
      assert.ok(files.has(match[1] ?? ""), `${name} links to missing ${match[1]}`);
    }
  }
});
