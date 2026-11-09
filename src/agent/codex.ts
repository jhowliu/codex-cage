import { shellQuote } from "../shell.js";

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
