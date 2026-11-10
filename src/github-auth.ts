import { execa } from "execa";
import { z } from "zod";

/**
 * Repo-local `.codex-cage.env` key that pins the gh account a repo uses when
 * it has no GITHUB_TOKEN. It is a setting, not a secret: it never reaches
 * commands or the secret redactor.
 */
export const githubAccountEnvName = "CODEX_CAGE_GH_USER";

const githubHost = "github.com";

export type GithubLogin = string & { readonly __brand: "GithubLogin" };

export type GhAccounts = {
  logins: readonly GithubLogin[];
  active: GithubLogin | null;
};

export type GithubAccountSetting =
  | { status: "unset" }
  | { status: "set"; login: GithubLogin }
  | { status: "invalid"; value: string };

export type GhCommandResult = {
  exitCode: number | undefined;
  stdout: string;
};

export type GhRunner = (args: readonly string[]) => Promise<GhCommandResult>;

/** Looks up a github.com token from gh; `null` login means gh's active account. */
export type GithubTokenLookup = (login: GithubLogin | null) => Promise<string | null>;

export const execaGhRunner: GhRunner = async (args) => {
  const result = await execa("gh", args, { reject: false });
  return { exitCode: result.exitCode, stdout: result.stdout };
};

export function isGithubLogin(value: string): value is GithubLogin {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value);
}

export function githubAccountSetting(
  env: Readonly<Record<string, string>>,
): GithubAccountSetting {
  const value = env[githubAccountEnvName]?.trim() ?? "";
  if (value === "") return { status: "unset" };
  return isGithubLogin(value)
    ? { status: "set", login: value }
    : { status: "invalid", value };
}

export function githubAccountLogin(setting: GithubAccountSetting): GithubLogin | null {
  return setting.status === "set" ? setting.login : null;
}

const ghAuthStatusSchema = z.object({
  hosts: z.record(
    z.array(z.object({ state: z.string(), active: z.boolean(), login: z.string() })),
  ),
});

const noAccounts: GhAccounts = { logins: [], active: null };

/**
 * Parses `gh auth status --json hosts`. Output that does not match (gh not
 * installed, or a gh release without `--json`) means no usable accounts.
 */
export function parseGhAccounts(stdout: string): GhAccounts {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return noAccounts;
  }
  const parsed = ghAuthStatusSchema.safeParse(json);
  if (!parsed.success) return noAccounts;

  const accounts = (parsed.data.hosts[githubHost] ?? []).filter(
    (account) => account.state === "success",
  );
  const logins = accounts.map((account) => account.login).filter(isGithubLogin);
  const active = accounts.find((account) => account.active)?.login;

  return {
    logins,
    active: active !== undefined && isGithubLogin(active) ? active : null,
  };
}

export async function listGhAccounts(run: GhRunner): Promise<GhAccounts> {
  // With --json, gh exits 0 even when an account has auth problems.
  const result = await run([
    "auth",
    "status",
    "--hostname",
    githubHost,
    "--json",
    "hosts",
  ]);
  return parseGhAccounts(result.stdout);
}

export function ghAuthTokenArgs(login: GithubLogin | null): string[] {
  return [
    "auth",
    "token",
    "--hostname",
    githubHost,
    ...(login === null ? [] : ["--user", login]),
  ];
}

export async function ghAuthToken(
  login: GithubLogin | null,
  run: GhRunner,
): Promise<string | null> {
  const result = await run(ghAuthTokenArgs(login));
  const token = result.stdout.trim();
  return result.exitCode === 0 && token !== "" ? token : null;
}

export const ghTokenLookup: GithubTokenLookup = (login) =>
  ghAuthToken(login, execaGhRunner);
