import { homedir } from "node:os";
import { join } from "node:path";
import {
  agentCredentialEnvNames,
  agentProvidersInUse,
  type AgentProvider,
  type AgentRole,
} from "./agent/providers.js";
import {
  githubAccountEnvName,
  githubAccountLogin,
  githubAccountSetting,
  type GithubTokenLookup,
} from "./github-auth.js";
import { createSecretRedactor, readAgentCageEnv, readEnvFile } from "./guards.js";
import type { CommentSelection, FetchIssueContextOptions } from "./issue.js";

export type CommandCredentialIntent =
  | "clone"
  | "setup"
  | "verify"
  | "implement"
  | "review"
  | "publish";

export type AgentProviderByRole = Record<AgentRole, AgentProvider>;

export type CredentialPolicyInput = {
  env: Record<string, string>;
  agents: AgentProviderByRole;
  codexAuthFilePath?: string | null | undefined;
};

export type CommandCredentials = {
  env: Record<string, string>;
  codexAuthFilePath?: string | undefined;
};

export type RunCredentialsInput = {
  cwd: string;
  agents: AgentProviderByRole;
  readEnv: (cwd: string) => Promise<Record<string, string>>;
  findCodexAuthFile: () => Promise<string | null>;
  findGithubToken: GithubTokenLookup;
};

export class RunCredentials {
  readonly secrets: Record<string, string>;

  readonly #agents: AgentProviderByRole;

  readonly #codexAuthFilePath: string | null;

  constructor(input: {
    secrets: Record<string, string>;
    agents: AgentProviderByRole;
    codexAuthFilePath: string | null;
  }) {
    this.secrets = input.secrets;
    this.#agents = input.agents;
    this.#codexAuthFilePath = input.codexAuthFilePath;
  }

  issueOptions(comments: CommentSelection): FetchIssueContextOptions {
    const issueEnv = issueCredentialEnv(this.secrets);
    const githubToken = githubTokenFromEnv(issueEnv);
    const options: FetchIssueContextOptions = { comments };

    if (githubToken !== undefined) {
      options.githubToken = githubToken;
    }

    if (issueEnv.LINEAR_API_KEY !== undefined) {
      options.linearApiKey = issueEnv.LINEAR_API_KEY;
    }

    return options;
  }

  githubToken(): string | undefined {
    return githubTokenFromEnv(issueCredentialEnv(this.secrets));
  }

  command(intent: CommandCredentialIntent): CommandCredentials {
    return credentialsForCommand(intent, {
      env: this.secrets,
      agents: this.#agents,
      codexAuthFilePath: this.#codexAuthFilePath,
    });
  }

  redactor(): (input: string) => string {
    return createSecretRedactor(this.secrets);
  }

  injectedSecrets(): Record<string, string> {
    return this.secrets;
  }
}

const codexEnvNames: ReadonlySet<string> = new Set(agentCredentialEnvNames.codex);
const claudeEnvNames: ReadonlySet<string> = new Set(agentCredentialEnvNames.claude);
const githubEnvNames: ReadonlySet<string> = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);
const issueTrackerEnvNames: ReadonlySet<string> = new Set(["LINEAR_API_KEY"]);

export async function prepareRunCredentials(
  input: RunCredentialsInput,
): Promise<RunCredentials> {
  const env = normalizeCredentialEnv(await input.readEnv(input.cwd));
  const secrets = await withGithubToken(env, input.findGithubToken);
  const needsCodexAuthFile =
    agentProvidersInUse(input.agents).has("codex") &&
    secrets.OPENAI_API_KEY === undefined;
  const codexAuthFilePath = needsCodexAuthFile ? await input.findCodexAuthFile() : null;

  return new RunCredentials({ secrets, agents: input.agents, codexAuthFilePath });
}

/**
 * Removes the gh account setting and, when no GitHub token is configured,
 * fills GITHUB_TOKEN from `gh auth token` for the pinned (or active) account.
 */
async function withGithubToken(
  env: Record<string, string>,
  findGithubToken: GithubTokenLookup,
): Promise<Record<string, string>> {
  const setting = githubAccountSetting(env);
  if (setting.status === "invalid") {
    throw new Error(
      `${githubAccountEnvName} in .agent-cage.env must be a GitHub login, got "${setting.value}".`,
    );
  }
  const secrets = Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== githubAccountEnvName),
  );
  if (githubTokenFromEnv(secrets) !== undefined) return secrets;

  const login = githubAccountLogin(setting);
  const token = await findGithubToken(login);
  if (token !== null) return normalizeCredentialEnv({ ...secrets, GITHUB_TOKEN: token });
  if (login !== null) {
    throw new Error(
      `gh has no github.com token for ${login} (${githubAccountEnvName}); run \`gh auth login\` as ${login} or set GITHUB_TOKEN in .agent-cage.env.`,
    );
  }
  // No token anywhere: createAuthenticatedRepo reports the missing token.
  return secrets;
}

export function normalizeCredentialEnv(
  env: Record<string, string>,
): Record<string, string> {
  const nonEmptyEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value.trim() !== ""),
  );

  if (nonEmptyEnv.GITHUB_TOKEN === undefined || nonEmptyEnv.GH_TOKEN !== undefined) {
    return nonEmptyEnv;
  }

  return {
    ...nonEmptyEnv,
    GH_TOKEN: nonEmptyEnv.GITHUB_TOKEN,
  };
}

export function credentialsForCommand(
  intent: CommandCredentialIntent,
  input: CredentialPolicyInput,
): CommandCredentials {
  switch (intent) {
    case "implement":
    case "review":
      return agentCredentials(input.agents[intent], input);
    case "publish":
      return { env: pickEnv(input.env, githubEnvNames) };
    case "clone":
      return { env: pickEnv(input.env, githubEnvNames) };
    case "setup":
    case "verify":
      return { env: nonCredentialEnv(input.env) };
  }
}

export function githubTokenFromEnv(env: Record<string, string>): string | undefined {
  return env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

export function issueCredentialEnv(env: Record<string, string>): Record<string, string> {
  return pickEnv(env, new Set([...githubEnvNames, ...issueTrackerEnvNames]));
}

export function hasAgentCredentials(
  provider: AgentProvider,
  input: { env: Record<string, string>; codexAuthFileAvailable: boolean },
): boolean {
  switch (provider) {
    case "codex":
      return input.env.OPENAI_API_KEY !== undefined || input.codexAuthFileAvailable;
    case "claude":
      return agentCredentialEnvNames.claude.some((name) => input.env[name] !== undefined);
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

/**
 * Credentials that may live in the machine-wide file. GitHub credentials stay
 * per repo so one repo never silently uses another repo's account.
 */
export const globalCredentialNames = [
  ...agentCredentialEnvNames.codex,
  ...agentCredentialEnvNames.claude,
  "LINEAR_API_KEY",
] as const;

export type CredentialSource = "repo" | "global";

export type CredentialEnv = {
  env: Record<string, string>;
  sources: Record<string, CredentialSource>;
  ignoredGlobalNames: string[];
};

export function globalCredentialsPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configHome =
    env.XDG_CONFIG_HOME === undefined || env.XDG_CONFIG_HOME === ""
      ? join(homedir(), ".config")
      : env.XDG_CONFIG_HOME;

  return join(configHome, "agent-cage", "env");
}

/**
 * Merges the machine-wide credential file with the repo's `.agent-cage.env`.
 * Repo values win per key, and empty placeholders never mask a global value.
 */
export function mergeCredentialEnv(input: {
  global: Record<string, string>;
  repo: Record<string, string>;
}): CredentialEnv {
  const allowedGlobalNames: ReadonlySet<string> = new Set(globalCredentialNames);
  const env: Record<string, string> = {};
  const sources: Record<string, CredentialSource> = {};
  const ignoredGlobalNames: string[] = [];

  for (const [name, value] of Object.entries(input.global)) {
    if (!allowedGlobalNames.has(name)) {
      ignoredGlobalNames.push(name);
      continue;
    }
    if (value.trim() === "") continue;
    env[name] = value;
    sources[name] = "global";
  }

  for (const [name, value] of Object.entries(input.repo)) {
    if (value.trim() === "") continue;
    env[name] = value;
    sources[name] = "repo";
  }

  return { env, sources, ignoredGlobalNames };
}

export async function readCredentialEnv(
  cwd: string,
  globalPath: string = globalCredentialsPath(),
): Promise<CredentialEnv> {
  const [global, repo] = await Promise.all([
    readEnvFile(globalPath),
    readAgentCageEnv(cwd),
  ]);

  return mergeCredentialEnv({ global, repo });
}

/** Default run env: repo `.agent-cage.env` layered over the global file. */
export async function readRunEnv(cwd: string): Promise<Record<string, string>> {
  return (await readCredentialEnv(cwd)).env;
}

function agentCredentials(
  provider: AgentProvider,
  input: CredentialPolicyInput,
): CommandCredentials {
  switch (provider) {
    case "codex":
      return codexCredentials(input);
    case "claude":
      return { env: pickEnv(input.env, claudeEnvNames) };
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

function codexCredentials(input: CredentialPolicyInput): CommandCredentials {
  const env = pickEnv(input.env, codexEnvNames);

  return {
    env,
    ...(input.codexAuthFilePath === null ||
    input.codexAuthFilePath === undefined ||
    env.OPENAI_API_KEY !== undefined
      ? {}
      : { codexAuthFilePath: input.codexAuthFilePath }),
  };
}

function nonCredentialEnv(env: Record<string, string>): Record<string, string> {
  const credentialNames = new Set([
    ...codexEnvNames,
    ...claudeEnvNames,
    ...githubEnvNames,
    ...issueTrackerEnvNames,
  ]);

  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !credentialNames.has(name)),
  );
}

function pickEnv(
  env: Record<string, string>,
  names: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => names.has(name)));
}
