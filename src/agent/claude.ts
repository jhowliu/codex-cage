import { z } from "zod";
import { shellQuote } from "../shell.js";
import type { AgentFailureCode } from "./providers.js";

// Tools the read-only reviewer may use. In print mode Claude Code denies any
// tool outside this list instead of prompting.
export const claudeReviewAllowedTools = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
] as const;

const claudeEditTools = ["Edit", "Write", "NotebookEdit"] as const;

export type ClaudeCommandInput =
  | { access: "workspace-write"; model: string; prompt: string }
  | {
      access: "read-only";
      model: string;
      prompt: string;
      outputSchema: Record<string, unknown>;
    };

/**
 * Options after `-p <prompt>`. The prompt must come first because
 * `--allowedTools`/`--disallowedTools` are variadic and would otherwise
 * swallow a trailing positional prompt.
 */
export function claudeOptionArgs(input: ClaudeCommandInput): string[] {
  // stream-json keeps output flowing during long turns, so the idle timeout
  // only fires when Claude Code is actually stuck. It requires --verbose.
  const args = ["--model", input.model, "--output-format", "stream-json", "--verbose"];

  switch (input.access) {
    case "workspace-write":
      // Claude Code has no OS-level sandbox; the Docker sandbox (or the
      // externally isolated direct-mode runner) is the isolation boundary.
      args.push("--dangerously-skip-permissions");
      return args;
    case "read-only":
      args.push(
        "--json-schema",
        JSON.stringify(input.outputSchema),
        "--disallowedTools",
        claudeEditTools.join(","),
        "--allowedTools",
        claudeReviewAllowedTools.join(","),
      );
      return args;
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}

export function claudeExecCommand(input: ClaudeCommandInput): string {
  return [
    "DISABLE_AUTOUPDATER=1 claude -p",
    shellQuote(input.prompt),
    ...claudeOptionArgs(input).map(shellQuote),
  ].join(" ");
}

const claudeResultEventSchema = z
  .object({
    type: z.literal("result"),
    is_error: z.boolean(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
  })
  .passthrough();

/**
 * Returns the final answer from Claude Code `stream-json` output: the
 * structured output when a JSON schema was requested, otherwise the result
 * text.
 */
export function extractClaudeResult(stdout: string): string {
  let resultEvent: z.infer<typeof claudeResultEventSchema> | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const event = claudeResultEventSchema.safeParse(parseJsonLine(line));
    if (event.success) {
      resultEvent = event.data;
    }
  }

  if (resultEvent === null) {
    throw new Error("Claude Code did not emit a result event.");
  }

  if (resultEvent.is_error) {
    throw new Error(`Claude Code reported an error: ${resultEvent.result ?? "unknown"}`);
  }

  if (
    resultEvent.structured_output !== undefined &&
    resultEvent.structured_output !== null
  ) {
    return JSON.stringify(resultEvent.structured_output);
  }

  return resultEvent.result ?? "";
}

// Claude Code tags API failures on stream-json events: `error` on the
// assistant/retry events, `api_error_status` on the final result event.
const claudeErrorEventSchema = z
  .object({
    error: z.string().nullable().optional(),
    api_error_status: z.number().nullable().optional(),
  })
  .passthrough();

export function claudeFailureCode(stdout: string): AgentFailureCode | null {
  for (const line of stdout.split(/\r?\n/)) {
    const event = claudeErrorEventSchema.safeParse(parseJsonLine(line));
    if (!event.success) continue;
    const { error, api_error_status: status } = event.data;
    if (error === "authentication_failed" || status === 401 || status === 403) {
      return "agent_auth_failed";
    }
    if (error === "model_not_found" || status === 404) {
      return "agent_model_unavailable";
    }
  }
  return null;
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Output can carry non-JSON lines (warnings, partial writes); those are
    // not events, and a missing result event is reported by the caller.
    return null;
  }
}
