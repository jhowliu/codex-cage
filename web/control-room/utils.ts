import type { PageName } from "./types";

export function pageFromHash(): PageName {
  return typeof window !== "undefined" && window.location.hash === "#repositories"
    ? "repositories"
    : "runs";
}

export function runIdFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(/^#runs\/([^/]+)$/);
  if (match?.[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function issueNumber(url: string): string {
  const issue = url.match(/issues\/(\d+)/)?.[1];
  return issue === undefined ? "Work item" : `Issue #${issue}`;
}

export function isGithubIssueUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(value.trim());
}

export function normalizeGithubIssueUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^http:\/\/(github\.com\/)/i, "https://$1");
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export async function fetchJson<TValue>(
  url: string,
  options?: RequestInit,
): Promise<TValue> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : `Request failed (${response.status})`,
    );
  }
  return body as TValue;
}

export async function fetchText(url: string, options?: RequestInit): Promise<string> {
  const response = await fetch(url, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(body || `Request failed (${response.status})`);
  }
  return body;
}
