import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDir, "..", "src", "cli.js");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
  });
}

test("root help lists MVP commands", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: codex-cage/);
  assert.match(result.stdout, /\binit\b/);
  assert.match(result.stdout, /\brun\b/);
  assert.match(result.stdout, /\bruns\b/);
  assert.match(result.stdout, /\bcleanup\b/);
});

test("command help is available for MVP commands", () => {
  const commands = [
    ["init", "--help"],
    ["run", "--help"],
    ["runs", "list", "--help"],
    ["runs", "show", "--help"],
    ["cleanup", "--help"],
  ];

  for (const command of commands) {
    const result = runCli(command);

    assert.equal(result.status, 0, command.join(" "));
    assert.match(result.stdout, /Usage:/);
  }
});
