export type CredentialIntent = "clone" | "setup" | "verify" | "codex" | "publish";

export type CommandCredentialSelection = {
  env: Record<string, string>;
  codexAuthFilePath?: string | undefined;
};

const githubCredentialNames = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);
const codexCredentialNames = new Set(["OPENAI_API_KEY"]);

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

export function selectCredentialsForIntent(input: {
  env: Record<string, string>;
  intent: CredentialIntent;
  codexAuthFilePath?: string | null | undefined;
}): CommandCredentialSelection {
  const env = filterEnvForIntent(input.env, input.intent);
  const codexAuthFilePath =
    input.intent === "codex" && env.OPENAI_API_KEY === undefined
      ? (input.codexAuthFilePath ?? undefined)
      : undefined;

  return {
    env,
    ...(codexAuthFilePath === undefined ? {} : { codexAuthFilePath }),
  };
}

function filterEnvForIntent(
  env: Record<string, string>,
  intent: CredentialIntent,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => isAllowedEnvName(name, intent)),
  );
}

function isAllowedEnvName(name: string, intent: CredentialIntent): boolean {
  if (githubCredentialNames.has(name)) {
    return intent === "clone" || intent === "publish";
  }

  if (codexCredentialNames.has(name)) {
    return intent === "codex";
  }

  return intent === "setup" || intent === "verify";
}
