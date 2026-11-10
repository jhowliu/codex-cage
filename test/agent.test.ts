import assert from "node:assert/strict";
import test from "node:test";
import { claudeExecCommand, extractClaudeResult } from "../src/agent/claude.js";
import { agentShellCommand, extractAgentResult } from "../src/agent/providers.js";

const schema = { type: "object", required: ["decision"] };

function resultLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", is_error: false, ...fields });
}

test("Claude implementation runs headless with permissions bypassed and streaming output", () => {
  const command = claudeExecCommand({
    access: "workspace-write",
    model: "claude-opus-5-5",
    prompt: "Implement it",
  });

  assert.ok(command.startsWith("DISABLE_AUTOUPDATER=1 claude -p 'Implement it' "));
  assert.match(command, /'--model' 'claude-opus-5-5'/);
  assert.match(command, /'--output-format' 'stream-json' '--verbose'/);
  assert.match(command, /'--dangerously-skip-permissions'/);
  assert.doesNotMatch(command, /--allowedTools/);
});

test("Claude review is limited to read-only tools and a JSON schema", () => {
  const command = claudeExecCommand({
    access: "read-only",
    model: "claude-opus-5-5",
    prompt: "Review it",
    outputSchema: schema,
  });

  assert.ok(command.startsWith("DISABLE_AUTOUPDATER=1 claude -p 'Review it' "));
  assert.match(
    command,
    /'--json-schema' '\{"type":"object","required":\["decision"\]\}'/,
  );
  assert.match(command, /'--disallowedTools' 'Edit,Write,NotebookEdit'/);
  assert.match(command, /'--allowedTools' 'Read,Grep,Glob,Bash\(git diff:\*\)/);
  assert.doesNotMatch(command, /dangerously/);
});

test("Codex commands keep the sandbox flag in Docker mode and bypass it in direct mode", () => {
  const codex = { provider: "codex", model: "gpt-5.4-mini" } as const;
  const docker = agentShellCommand(codex, {
    access: "workspace-write",
    prompt: "Implement it",
    executionMode: "docker",
  });
  const direct = agentShellCommand(codex, {
    access: "workspace-write",
    prompt: "Implement it",
    executionMode: "direct",
  });

  assert.match(docker, /^codex exec --model 'gpt-5\.4-mini' --sandbox 'workspace-write'/);
  assert.match(direct, /--dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(direct, /--sandbox/);
});

test("Codex review writes the output schema before running read-only", () => {
  const command = agentShellCommand(
    { provider: "codex", model: "gpt-5.4-mini" },
    {
      access: "read-only",
      prompt: "Review it",
      executionMode: "docker",
      outputSchema: schema,
    },
  );

  assert.match(
    command,
    /^printf %s '\{.*\}' > '\/tmp\/codex-cage-review-output-schema\.json' && /,
  );
  assert.match(command, /--sandbox 'read-only'/);
  assert.match(command, /--output-schema '\/tmp\/codex-cage-review-output-schema\.json'/);
});

test("extractClaudeResult prefers structured output over result text", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    "warning: not json",
    resultLine({ result: "ignored", structured_output: { decision: "pass" } }),
  ].join("\n");

  assert.equal(extractClaudeResult(stdout), '{"decision":"pass"}');
});

test("extractClaudeResult falls back to result text", () => {
  assert.equal(extractClaudeResult(`${resultLine({ result: "done" })}\n`), "done");
});

test("extractClaudeResult rejects error results and missing result events", () => {
  assert.throws(
    () => extractClaudeResult(resultLine({ is_error: true, result: "rate limited" })),
    /Claude Code reported an error: rate limited/,
  );
  assert.throws(
    () => extractClaudeResult(JSON.stringify({ type: "assistant" })),
    /did not emit a result event/,
  );
});

test("extractAgentResult passes Codex output through unchanged", () => {
  assert.equal(extractAgentResult("codex", '{"decision":"pass"}'), '{"decision":"pass"}');
  assert.equal(
    extractAgentResult("claude", resultLine({ structured_output: { decision: "pass" } })),
    '{"decision":"pass"}',
  );
});
