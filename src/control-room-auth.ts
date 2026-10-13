import { readCodexCageEnv } from "./guards.js";

export type GithubAuthState = "connected" | "invalid" | "missing" | "unavailable";
export type GithubAuthSource = "codex-cage-env" | "none";

export type GithubAuthStatus = {
  provider: "github";
  status: GithubAuthState;
  source: GithubAuthSource;
  message: string;
  checkedAt: string;
};

export type GithubAuthFetcher = typeof fetch;

const githubUserEndpoint = "https://api.github.com/user";
const authCheckTimeoutMs = 5_000;

export async function readGithubAuthStatus(
  cwd: string,
  fetcher: GithubAuthFetcher = fetch,
): Promise<GithubAuthStatus> {
  const checkedAt = new Date().toISOString();
  let env: Record<string, string>;

  try {
    env = await readCodexCageEnv(cwd);
  } catch {
    return createStatus(
      "unavailable",
      "none",
      "Could not read .codex-cage.env. Check the file and try again.",
      checkedAt,
    );
  }

  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (token === undefined || token === "") {
    return createStatus(
      "missing",
      "none",
      "Add GITHUB_TOKEN to .codex-cage.env, then recheck authentication.",
      checkedAt,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), authCheckTimeoutMs);

  try {
    const response = await fetcher(githubUserEndpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return createStatus(
        "connected",
        "codex-cage-env",
        "GitHub authentication is ready for new tasks.",
        checkedAt,
      );
    }

    if (response.status === 401) {
      return createStatus(
        "invalid",
        "codex-cage-env",
        "GitHub rejected the configured token. Update .codex-cage.env, then recheck.",
        checkedAt,
      );
    }

    return createStatus(
      "unavailable",
      "codex-cage-env",
      `GitHub authentication could not be verified (${response.status}). Try again shortly.`,
      checkedAt,
    );
  } catch {
    return createStatus(
      "unavailable",
      "codex-cage-env",
      "GitHub could not be reached. Check your connection and try again.",
      checkedAt,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function createStatus(
  status: GithubAuthState,
  source: GithubAuthSource,
  message: string,
  checkedAt: string,
): GithubAuthStatus {
  return {
    provider: "github",
    status,
    source,
    message,
    checkedAt,
  };
}
