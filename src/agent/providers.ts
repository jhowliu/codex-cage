import type { ExecutionMode } from "../config.js";
import { shellQuote } from "../shell.js";
import type { FailureCode } from "../state.js";
import { claudeExecCommand, claudeFailureCode, extractClaudeResult } from "./claude.js";
import { codexExecCommand, codexFailureCode } from "./codex.js";

export const agentProviders = ["codex", "claude"] as const;
export type AgentProvider = (typeof agentProviders)[number];

export const agentRoles = ["implement", "review"] as const;
export type AgentRole = (typeof agentRoles)[number];

export type AgentAssignment = {
  provider: AgentProvider;
  model: string;
};

export type AgentAssignments = Record<AgentRole, AgentAssignment>;

/** Agent failures that a rerun cannot fix without changing credentials or config. */
export type AgentFailureCode = Extract<
  FailureCode,
  "agent_auth_failed" | "agent_model_unavailable"
>;

export const defaultAgentModels = {
  codex: "gpt-5.4-mini",
  claude: "claude-opus-5-5",
} as const satisfies Record<AgentProvider, string>;

/** Credential env names each provider may receive; nothing else reaches it. */
export const agentCredentialEnvNames = {
  codex: ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
} as const satisfies Record<AgentProvider, readonly string[]>;

export type AgentCommandInput =
  | {
      access: "workspace-write";
      prompt: string;
      executionMode: ExecutionMode;
    }
  | {
      access: "read-only";
      prompt: string;
      executionMode: ExecutionMode;
      outputSchema: Record<string, unknown>;
    };

const codexOutputSchemaPath = "/tmp/codex-cage-review-output-schema.json";

export function agentShellCommand(
  agent: AgentAssignment,
  input: AgentCommandInput,
): string {
  switch (agent.provider) {
    case "codex":
      return codexShellCommand(agent.model, input);
    case "claude":
      return claudeExecCommand(
        input.access === "read-only"
          ? {
              access: "read-only",
              model: agent.model,
              prompt: input.prompt,
              outputSchema: input.outputSchema,
            }
          : { access: "workspace-write", model: agent.model, prompt: input.prompt },
      );
    default: {
      const exhaustiveProvider: never = agent.provider;
      return exhaustiveProvider;
    }
  }
}

/** Reduces raw agent stdout to the agent's final answer. */
export function extractAgentResult(provider: AgentProvider, stdout: string): string {
  switch (provider) {
    case "codex":
      return stdout;
    case "claude":
      return extractClaudeResult(stdout);
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

/**
 * Recognizes credential and model errors in an agent's output. Returns null
 * for every other failure, which callers report as a generic role failure.
 */
export function agentFailureCode(
  provider: AgentProvider,
  output: { stdout: string; stderr: string },
): AgentFailureCode | null {
  switch (provider) {
    case "codex":
      return codexFailureCode(`${output.stdout}\n${output.stderr}`);
    case "claude":
      return claudeFailureCode(output.stdout);
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

export function agentProvidersInUse(
  agents: Record<AgentRole, AgentProvider>,
): ReadonlySet<AgentProvider> {
  return new Set(agentRoles.map((role) => agents[role]));
}

function codexShellCommand(model: string, input: AgentCommandInput): string {
  const bypassSandbox = input.executionMode === "direct";

  switch (input.access) {
    case "workspace-write":
      return codexExecCommand({
        model,
        sandbox: "workspace-write",
        prompt: input.prompt,
        bypassSandbox,
      });
    case "read-only": {
      const writeOutputSchema = `printf %s ${shellQuote(
        JSON.stringify(input.outputSchema),
      )} > ${shellQuote(codexOutputSchemaPath)}`;
      return `${writeOutputSchema} && ${codexExecCommand({
        model,
        sandbox: "read-only",
        outputSchemaPath: codexOutputSchemaPath,
        prompt: input.prompt,
        bypassSandbox,
      })}`;
    }
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}
