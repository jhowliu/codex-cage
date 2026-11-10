import { shellQuote } from "../shell.js";
import type { AgentFailureCode } from "./providers.js";

export function codexExecCommand(input: {
  model: string;
  sandbox: "read-only" | "workspace-write";
  outputSchemaPath?: string | undefined;
  prompt: string;
  bypassSandbox?: boolean | undefined;
}): string {
  const args = ["codex exec", "--model", shellQuote(input.model)];

  if (input.bypassSandbox === true) {
    // Direct mode runs on an already-isolated, ephemeral runner where Codex's
    // own bubblewrap sandbox cannot create network namespaces
    // ("bwrap: loopback: ... Operation not permitted"). Skip Codex's sandbox
    // and rely on the runner's isolation. Only safe because the host is
    // externally sandboxed.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", shellQuote(input.sandbox));
  }

  if (input.outputSchemaPath !== undefined) {
    args.push("--output-schema", shellQuote(input.outputSchemaPath));
  }

  args.push(shellQuote(input.prompt));

  return args.join(" ");
}

/**
 * Codex prints the error that ended `codex exec` on lines starting with
 * `ERROR: `. Background log lines (such as model-list refreshes) carry a
 * timestamp prefix instead and are ignored.
 */
export function codexFailureCode(output: string): AgentFailureCode | null {
  const errors = output.split(/\r?\n/).filter((line) => line.startsWith("ERROR: "));
  if (
    errors.some((line) => /"code":"model_not_found"|model is not supported/.test(line))
  ) {
    return "agent_model_unavailable";
  }
  if (errors.some((line) => /\b401 Unauthorized\b|auth error: 401/.test(line))) {
    return "agent_auth_failed";
  }
  return null;
}
