export type CommandCredentialIntent =
  | "clone"
  | "setup"
  | "verify"
  | "implement"
  | "review"
  | "publish";

export type CredentialPolicyInput = {
  env: Record<string, string>;
  codexAuthFilePath?: string | null | undefined;
};

export type CommandCredentials = {
  env: Record<string, string>;
  codexAuthFilePath?: string | undefined;
};

const codexEnvNames = new Set(["OPENAI_API_KEY"]);
const githubEnvNames = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);
const issueTrackerEnvNames = new Set(["LINEAR_API_KEY"]);

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
      return codexCredentials(input);
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
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => names.has(name)),
  );
}
